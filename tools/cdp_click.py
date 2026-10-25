#!/usr/bin/env python3
"""CDP 点击真机 WebView：点遮罩里的「登录抖音」按钮，然后持续截图看二维码。

流程：
  1. 连上注入了遮罩的主 frame
  2. 找到引导页大红按钮的坐标
  3. Input.dispatchMouseEvent 派发真实鼠标事件（走 WebView 合成器，
     不需要系统的 INJECT_EVENTS 权限，绕开 HyperOS 对 input tap 的封杀）
  4. 轮询遮罩状态：面板是否打开、扫码 tab、二维码是否出现
  5. 每一步截图（adb screencap）
"""
import json
import subprocess
import sys
import time
import urllib.request

import websocket

BASE = "http://localhost:9222"
ADB = ["/Users/zhangxiaojie/Library/Android/sdk/platform-tools/adb"]
PKG = "com.example.emojibridge"
SHOT_DIR = "/tmp/eb_shots"


def adb(*args):
    return subprocess.run(ADB + list(args), capture_output=True, text=True)


def shot(name):
    adb("shell", "screencap", "-p", "/sdcard/%s.png" % name)
    adb("pull", "/sdcard/%s.png" % name, "%s/%s.png" % (SHOT_DIR, name))
    print("[截图] %s/%s.png" % (SHOT_DIR, name))


def list_pages():
    with urllib.request.urlopen(BASE + "/json", timeout=10) as r:
        return json.load(r)


def connect(ws_url):
    # suppress_origin：devtools 拒绝带 Origin 头的 WS 握手（403）
    return websocket.create_connection(ws_url, timeout=30, suppress_origin=True)


_msg_id = [0]


def cdp(ws, method, **params):
    _msg_id[0] += 1
    mid = _msg_id[0]
    ws.send(json.dumps({"id": mid, "method": method, "params": params}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == mid:
            return msg


def ev(ws, expr):
    r = cdp(ws, "Runtime.evaluate", expression=expr, returnByValue=True)
    res = r.get("result", {}).get("result", {})
    return res.get("value")


STATE_JS = """
    (function(){
        var mask = document.getElementById('__eb_mask');
        if (!mask) return {mask:false};
        var qr = document.getElementById('__eb_qr');
        var img = document.querySelector('#__eb_qr img');
        var btn = null;
        mask.querySelectorAll('*').forEach(function(el){
            var t = (el.innerText||'').trim();
            if (t === '登录抖音' && el.children.length === 0) btn = el;
        });
        return {
            mask: true,
            btnText: btn ? '登录抖音' : '',
            qr: !!qr,
            qrShown: qr ? getComputedStyle(qr).display !== 'none' : false,
            qrImg: img ? (img.src||'').slice(0, 40) : '',
            qrSize: img ? img.naturalWidth + 'x' + img.naturalHeight : '',
            tip: (document.getElementById('__eb_tip')||{}).innerText || ''
        };
    })()
"""


def find_mask_ws():
    for p in list_pages():
        if p.get("type") != "page":
            continue
        try:
            ws = connect(p["webSocketDebuggerUrl"])
            if ev(ws, "!!document.getElementById('__eb_mask')") is True:
                return p, ws
            ws.close()
        except Exception as e:
            print("  target 连接失败:", p.get("url", "")[:40], e)
    return None, None


def click(ws, x, y):
    for etype in ("mousePressed", "mouseReleased"):
        cdp(ws, "Input.dispatchMouseEvent", type=etype, x=x, y=y,
            button="left", clickCount=1)


def main():
    subprocess.run(["mkdir", "-p", SHOT_DIR], check=True)

    page, ws = find_mask_ws()
    if not ws:
        print("找不到遮罩页面，先确认登录页开着")
        return
    print("连上遮罩页面:", page["url"][:70])

    print("初始状态:", ev(ws, STATE_JS))

    # 找「登录抖音」按钮坐标（页面 CSS 像素）。必须过滤不可见元素：
    # 登录页退到后台后遮罩会收起，按钮 display:none、rect 全 0，点了不算。
    box = ev(ws, """
        (function(){
            var mask = document.getElementById('__eb_mask');
            var btn = null;
            mask.querySelectorAll('*').forEach(function(el){
                var t = (el.innerText||'').trim();
                if (t === '登录抖音' && el.children.length === 0) {
                    var r = el.getBoundingClientRect();
                    var cs = getComputedStyle(el);
                    if (r.width > 10 && r.height > 10
                            && cs.display !== 'none' && cs.visibility !== 'hidden') {
                        btn = el;
                    }
                }
            });
            if (!btn) return null;
            var r = btn.getBoundingClientRect();
            return {x: r.left + r.width/2, y: r.top + r.height/2,
                    w: r.width, h: r.height};
        })()
    """)
    if not box:
        print("没找到「登录抖音」按钮，可能页面状态已变。当前状态:", ev(ws, STATE_JS))
        ws.close()
        return
    print("按钮坐标:", box)

    shot("01_before_click")
    print("点击「登录抖音」...")
    click(ws, box["x"], box["y"])
    time.sleep(2)
    shot("02_after_click_2s")

    # 轮询：抖音面板 → 扫码 tab → 二维码（8~12 秒风控挑战）
    t0 = time.time()
    seen_qr_at = None
    while time.time() - t0 < 60:
        st = ev(ws, STATE_JS)
        el = int(time.time() - t0)
        print("t+%02ds %s" % (el, json.dumps(st, ensure_ascii=False)))
        if st.get("qrShown") and st.get("qrSize") and st["qrSize"] != "0x0":
            if seen_qr_at is None:
                seen_qr_at = time.time() - t0
                shot("03_qr_appeared")
                print(">>> 二维码出现了！耗时 %.1f 秒" % seen_qr_at)
                break
        time.sleep(2)

    if seen_qr_at is None:
        shot("04_timeout")
        print(">>> 60 秒内没看到二维码，拍了定格图")

    print("最终状态:", ev(ws, STATE_JS))
    ws.close()


if __name__ == "__main__":
    main()
