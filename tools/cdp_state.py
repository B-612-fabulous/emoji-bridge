#!/usr/bin/env python3
"""查 __eb_qr / __eb_tip 显示状态 + 截图里白面板的真实元素。"""
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
        print("=== eb_qr / eb_tip 状态 ===")
        print(ev("""
            (function(){
                function st(id){
                    var el = document.getElementById(id);
                    if (!el) return id + ': 不存在';
                    var cs = getComputedStyle(el);
                    var r = el.getBoundingClientRect();
                    return id + ' [' + cs.display + ',' + cs.visibility + ' z' + cs.zIndex
                        + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
                        + ' pos=' + cs.position + ']';
                }
                return [st('__eb_qr'), st('__eb_tip')].join('\\n');
            })()
        """))
        print("=== 白面板（浅色背景大块，全文档） ===")
        print(ev("""
            (function(){
                var out = [];
                document.querySelectorAll('body *').forEach(function(el){
                    var r = el.getBoundingClientRect();
                    var cs = getComputedStyle(el);
                    if (r.width > 250 && r.height > 300 && cs.display !== 'none'
                            && cs.visibility !== 'hidden') {
                        var bg = cs.backgroundColor;
                        // 浅色（白/近白）背景
                        var m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
                        if (m && (+m[1] > 230 && +m[2] > 230 && +m[3] > 230)) {
                            out.push(el.tagName.toLowerCase()
                                + (el.id ? '#' + el.id : '')
                                + '.' + (typeof el.className === 'string' ? el.className.slice(0, 30) : '')
                                + ' z' + cs.zIndex + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
                                + ' ' + cs.position);
                        }
                    }
                });
                return out.slice(0, 6).join('\\n') || '没找到浅色大块';
            })()
        """))
        print("=== 页面里所有含二维码 img 的元素 ===")
        print(ev("""
            (function(){
                var out = [];
                document.querySelectorAll('img').forEach(function(img){
                    var r = img.getBoundingClientRect();
                    var cs = getComputedStyle(img);
                    var src = (img.src || '').slice(0, 30);
                    if (src.indexOf('data:image') === 0 || img.alt.indexOf('二维码') >= 0) {
                        out.push(Math.round(r.width) + 'x' + Math.round(r.height)
                            + ' [' + cs.display + ',' + cs.visibility + '] ' + src);
                    }
                });
                return out.slice(0, 6).join('\\n') || '没找到';
            })()
        """))
        break
    ws.close()
