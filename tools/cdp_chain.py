#!/usr/bin/env python3
"""查 __eb_mask / __eb_qr / __eb_tip 的父链与存在性。"""
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
        print(ev("""
            (function(){
                function chain(id){
                    var el = document.getElementById(id);
                    if (!el) return id + ': 不存在';
                    var parts = [];
                    var n = el;
                    while (n && n.tagName) {
                        parts.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : ''));
                        n = n.parentElement;
                    }
                    return id + ' -> ' + parts.join(' < ');
                }
                return [chain('__eb_mask'), chain('__eb_qr'), chain('__eb_tip')].join('\\n');
            })()
        """))
        print("=== 抖音登录面板（按尺寸找大白块） ===")
        print(ev("""
            (function(){
                var out = [];
                document.querySelectorAll('#root *').forEach(function(el){
                    var r = el.getBoundingClientRect();
                    var cs = getComputedStyle(el);
                    if (r.width > 300 && r.height > 400 && cs.position === 'fixed'
                            && cs.display !== 'none' && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
                        out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
                            + '.' + (typeof el.className === 'string' ? el.className.slice(0, 40) : '')
                            + ' z' + cs.zIndex + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
                            + ' bg=' + cs.backgroundColor);
                    }
                });
                return out.slice(0, 8).join('\\n') || '没找到';
            })()
        """))
        break
    ws.close()
