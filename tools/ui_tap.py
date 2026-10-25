#!/usr/bin/env python3
"""按文字找按钮并点击 —— 用 uiautomator 拿真实坐标，杜绝像素猜测点偏。

用法: ui_tap.py <设备序列号> <按钮文字> [额外等待秒数]
例:   ui_tap.py emulator-5554 查看我的表情
"""
import re
import subprocess
import sys
import time


def sh(*args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def bounds_center(bounds):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return (x1 + x2) // 2, (y1 + y2) // 2


def find_and_tap(device, text, wait_extra=0):
    """dump 当前界面，找 text/content-desc 含目标文字的节点，点它的中心。"""
    for attempt in range(6):
        sh("adb", "-s", device, "shell", "uiautomator", "dump", "/sdcard/eb_ui.xml")
        xml = sh("adb", "-s", device, "shell", "cat", "/sdcard/eb_ui.xml")
        # 逐节点解析：<node ... text="..." ... bounds="..." />
        for m in re.finditer(r"<node\b[^>]*/?>", xml):
            tag = m.group(0)
            t = re.search(r'text="([^"]*)"', tag)
            d = re.search(r'content-desc="([^"]*)"', tag)
            b = re.search(r'bounds="([^"]*)"', tag)
            if not b:
                continue
            label = (t.group(1) if t else "") + " " + (d.group(1) if d else "")
            if text in label:
                c = bounds_center(b.group(1))
                if c:
                    print(f"attempt {attempt}: 找到「{text}」bounds={b.group(1)} 中心={c}")
                    sh("adb", "-s", device, "shell", "input", "tap", str(c[0]), str(c[1]))
                    if wait_extra:
                        time.sleep(wait_extra)
                    return True
        print(f"attempt {attempt}: 没找到「{text}」，2s 后重试")
        time.sleep(2)
    return False


if __name__ == "__main__":
    dev = sys.argv[1] if len(sys.argv) > 1 else "emulator-5554"
    txt = sys.argv[2]
    extra = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    ok = find_and_tap(dev, txt, extra)
    sys.exit(0 if ok else 1)
