#!/usr/bin/env python3
"""通过 CDP 连接真机 WebView：查状态 / 点元素 / 截图。

为什么不用 adb input tap：HyperOS 无线调试下 INJECT_EVENTS 被禁。
CDP 的 Input.dispatchMouseEvent 走 WebView 内部合成器，不需要系统权限。
"""
import json
import sys
import time
import urllib.request

import websocket

BASE = "http://localhost:9222"


def list_pages():
    with urllib.request.urlopen(BASE + "/json") as r:
        return json.load(r)


def connect(ws_url):
    ws = websocket.create_connection(ws_url, timeout=30, suppress_origin=True)
    return ws


_msg_id = [0]


def cdp(ws, method, **params):
    _msg_id[0] += 1
    mid = _msg_id[0]
    ws.send(json.dumps({"id": mid, "method": method, "params": params}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == mid:
            return msg


def evaluate(ws, expr):
    r = cdp(ws, "Runtime.evaluate", expression=expr, returnByValue=True)
    res = r.get("result", {}).get("result", {})
    if "value" in res:
        return res["value"]
    return r.get("result", {}).get("exceptionDetails", {}).get("text", "<no value>")


def main():
    pages = list_pages()
    # 找注入了遮罩的主 frame
    target = None
    for p in pages:
        if p.get("type") != "page":
            continue
        ws = connect(p["webSocketDebuggerUrl"])
        try:
            has = evaluate(ws, "!!document.getElementById('__eb_mask')")
        except Exception:
            has = False
        if has is True:
            target = (p, ws)
            break
        ws.close()
    if not target:
        print("没找到注入了遮罩的页面。所有 target：")
        for p in pages:
            print(" -", p.get("type"), p.get("url", "")[:70])
        return
    page, ws = target
    print("连上：", page["url"][:70])

    # 看看遮罩当前状态：引导按钮？二维码卡片？
    state = evaluate(ws, """
        (function(){
            var mask = document.getElementById('__eb_mask');
            var qr = document.getElementById('__eb_qr');
            var btn = document.querySelector('[data-act="go"], .ebgo, #__eb_go');
            return JSON.stringify({
                mask: !!mask,
                qr: !!qr,
                qrVisible: qr ? getComputedStyle(qr).display !== 'none' : false,
                btnText: btn ? (btn.innerText||'').trim() : '',
                bodyClass: document.body.className,
                title: document.title
            });
        })()
    """)
    print("遮罩状态：", state)

    # 找引导页大红按钮。先打印遮罩里所有可点元素的文案和位置，供确认
    info = evaluate(ws, """
        (function(){
            var mask = document.getElementById('__eb_mask');
            if (!mask) return 'no mask';
            var out = [];
            mask.querySelectorAll('*').forEach(function(el){
                var r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0 && el.offsetParent !== null) {
                    var t = (el.innerText||'').trim().slice(0, 20);
                    if (t && el.children.length === 0) {
                        out.push(t + ' @' + Math.round(r.left + r.width/2) + ',' + Math.round(r.top + r.height/2));
                    }
                }
            });
            return out.join(' | ');
        })()
    """)
    print("遮罩可点元素：", info)

    ws.close()


if __name__ == "__main__":
    main()
