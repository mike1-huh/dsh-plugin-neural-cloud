"""
微信「文件传输助手」红点监测 → 唤醒 DSH agent

前提：在微信里把「文件传输助手」置顶（右键 → 置顶），它就固定在会话列表第一行。
原理：每 3 秒截一次微信窗口左上角（第一项头像区域），数红色像素（未读红点）。
      红点出现 → POST /neural-cloud/wake → 插件调 agent.followup 叫醒我。
用法：python scripts/wechat-watch.py  （或 pythonw 后台跑）
"""
import ctypes
import time
import sys
import json
import urllib.request

try:
    from PIL import ImageGrab
except ImportError:
    print('need pillow: pip install pillow', flush=True)
    sys.exit(1)

WAKE_URL = 'http://127.0.0.1:60063/neural-cloud/wake'
INTERVAL = 5.0
COOLDOWN = 30.0

user32 = ctypes.windll.user32


def find_wechat():
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if buf.value == '微信':
            found.append(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    return found[0] if found else None


def window_rect(hwnd):
    class RECT(ctypes.Structure):
        _fields_ = [('left', ctypes.c_long), ('top', ctypes.c_long),
                    ('right', ctypes.c_long), ('bottom', ctypes.c_long)]
    r = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def count_red(x0, y0, x1, y1):
    img = ImageGrab.grab(bbox=(x0, y0, x1, y1))
    px = img.load()
    red = 0
    for y in range(img.height):
        for x in range(img.width):
            p = px[x, y]
            if isinstance(p, tuple) and len(p) >= 3:
                r, g, b = p[0], p[1], p[2]
                if r > 190 and g < 95 and b < 95:
                    red += 1
    return red


def wake(text):
    try:
        data = json.dumps({'text': text}).encode('utf-8')
        req = urllib.request.Request(WAKE_URL, data=data, headers={'content-type': 'application/json'})
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.read().decode('utf-8', 'ignore')
    except Exception as e:
        return f'wake failed: {e}'


def main():
    hwnd = find_wechat()
    if not hwnd:
        print('微信窗口没找到，先打开微信', flush=True)
        return 1
    print(f'watch start: hwnd={hwnd} url={WAKE_URL}', flush=True)
    last_wake = 0.0
    while True:
        try:
            l, t, w, h = window_rect(hwnd)
            if w <= 0:
                time.sleep(INTERVAL)
                continue
            # 第一项（置顶的文件传输助手）头像右上角 + 右侧名字区
            box = (l + 60, t + 60, min(l + 330, l + w), t + 120)
            red = count_red(*box)
            now = time.time()
            if red >= 10 and now - last_wake > COOLDOWN:
                out = wake('文件传输助手有新消息（红点），去微信读一下并按指令办事。')
                last_wake = now
                print(f'[{time.strftime("%H:%M:%S")}] red={red} -> {out}', flush=True)
        except Exception as e:
            print('loop error:', e, flush=True)
        time.sleep(INTERVAL)


if __name__ == '__main__':
    sys.exit(main())
