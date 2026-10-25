#!/usr/bin/env python3
"""Dump body 子节点 + style 标签概览。"""
import json
import urllib.request

import websocket

with urllib.request.urlopen("http://localhost:9222/json") as r:
    pages = json.load(r)

for p in pages:
    if p.get("type") != "page":
        continue
    try:
        ws = websocket.create_connection(p["webSocketDebuggerUrl"], timeout=20,
                                         suppress_origin=True)
    except Exception:
        continue
    mid = [0]

    def ev(expr):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": "Runtime.evaluate",
                            "params": {"expression": expr, "returnByValue": True}}))
        while True:
            m = json.loads(ws.recv())
            if m.get("id") == mid[0]:
                res = m.get("result", {})
                if "exceptionDetails" in res:
                    return "<EXC> " + str(res["exceptionDetails"].get("text"))
                return res.get("result", {}).get("value")

    if ev("!!document.getElementById('__eb_mask')") is True:
        print("URL:", p["url"][:60])
        print("=== body 直接子节点 ===")
        print(ev("""
            (function(){
                var out = [];
                Array.prototype.forEach.call(document.body.children, function(n){
                    var cs = getComputedStyle(n);
                    var r = n.getBoundingClientRect();
                    var t = '';
                    try { t = (n.textContent||'').trim().slice(0,36).replace(/[\\n\\r]+/g,'/'); } catch(e){}
                    out.push(n.tagName.toLowerCase() + (n.id?'#'+n.id:'')
                        + ' [' + cs.display + ',' + cs.visibility
                        + ' z' + cs.zIndex + ' '
                        + Math.round(r.width)+'x'+Math.round(r.height) + ']'
                        + (t?' "'+t+'"':''));
                });
                return out.join('\\n');
            })()
        """))
        print("=== style 标签 ===")
        print(ev("""
            Array.prototype.map.call(document.querySelectorAll('style'), function(s){
                var t = s.textContent || '';
                return t.length + 'B | ' + t.slice(0, 70).replace(/[\\n\\r]+/g, ' ');
            }).join('\\n')
        """))
        break
    ws.close()
