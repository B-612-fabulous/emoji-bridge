#!/usr/bin/env python3
"""Dump 遮罩 DOM 结构 + 关键状态，定位二维码卡片为什么没弹。"""
import json
import urllib.request

import websocket

BASE = "http://localhost:9222"


def cdp_conn():
    with urllib.request.urlopen(BASE + "/json") as r:
        pages = json.load(r)
    for p in pages:
        if p.get("type") != "page":
            continue
        try:
            ws = websocket.create_connection(
                p["webSocketDebuggerUrl"], timeout=20, suppress_origin=True)
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
                    return m.get("result", {}).get("result", {}).get("value")
        if ev("!!document.getElementById('__eb_mask')") is True:
            return ws, ev
        ws.close()
    return None, None


ws, ev = cdp_conn()
if not ws:
    print("没连上遮罩页面")
    raise SystemExit

out = ev(r"""
    (function(){
        function desc(el, depth) {
            if (depth > 4) return '';
            var pad = '  '.repeat(depth);
            var s = pad + el.tagName.toLowerCase();
            if (el.id) s += '#' + el.id;
            if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().replace(/\s+/g, '.');
            var cs = getComputedStyle(el);
            var r = el.getBoundingClientRect();
            s += ' [' + cs.display + ',' + cs.visibility + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ']';
            if (el.children.length === 0) {
                var t = (el.innerText||'').trim().slice(0, 30);
                if (t) s += ' "' + t + '"';
            }
            var lines = [s];
            for (var i = 0; i < el.children.length && i < 12; i++) {
                lines.push(desc(el.children[i], depth + 1));
            }
            return lines.join('\n');
        }
        var mask = document.getElementById('__eb_mask');
        return desc(mask, 0);
    })()
""")
print("=== 遮罩 DOM ===")
print(out)

print("\n=== 全局状态 ===")
print(ev(r"""
    (function(){
        var g = window;
        return JSON.stringify({
            ebDark: g.__ebDark,
            popupLayerOn: g.__ebPopupLayerOn,
            session: !!g.__ebSession,
            maskClass: document.getElementById('__eb_mask').className,
            bodyClass: document.body.className,
            ebStyles: Array.from(document.querySelectorAll('style')).map(function(s){
                return (s.textContent||'').slice(0, 80);
            }).filter(function(t){ return t.indexOf('__eb') >= 0 || t.indexOf('hidden') >= 0; })
        }, null, 1);
    })()
"""))

print("\n=== 抖音面板 ===")
print(ev(r"""
    (function(){
        var panel = document.querySelector('#login-full-panel, [class*="login-full-panel"], [class*="login-panel"]');
        if (!panel) return 'no panel';
        var r = panel.getBoundingClientRect();
        var cs = getComputedStyle(panel);
        return JSON.stringify({cls: panel.className, display: cs.display,
            visibility: cs.visibility, z: cs.zIndex,
            size: Math.round(r.width) + 'x' + Math.round(r.height)});
    })()
"""))

ws.close()
