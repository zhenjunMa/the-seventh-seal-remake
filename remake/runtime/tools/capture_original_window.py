"""Read only: capture the visible original-game window through desktop GDI."""
from pathlib import Path
from ctypes import wintypes
import ctypes
import hashlib
import json
import sys
from PIL import ImageGrab

root = Path(__file__).resolve().parents[3]
expected = root / 'remake/observation/original_window_20261011/game/SealObservation.exe'
user32 = ctypes.WinDLL('user32', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
user32.GetForegroundWindow.restype = wintypes.HWND
user32.SetProcessDPIAware()
matches = []

@ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
def collect(hwnd, _):
    title = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, title, len(title))
    if title.value != '第七封印' or not user32.IsWindowVisible(hwnd):
        return True
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    handle = kernel32.OpenProcess(0x1000, False, pid.value)
    if handle:
        try:
            path = ctypes.create_unicode_buffer(32768)
            size = wintypes.DWORD(len(path))
            if kernel32.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size)) and Path(path.value).resolve() == expected.resolve():
                matches.append((hwnd, pid.value, path.value))
        finally:
            kernel32.CloseHandle(handle)
    return True

user32.EnumWindows(collect, 0)
assert len(matches) == 1, f'Expected one verified observation-game window, found {len(matches)}'
hwnd, pid, executable = matches[0]
assert not user32.IsIconic(hwnd), 'Game window is minimized'
assert user32.GetForegroundWindow() == hwnd, 'Game must be foreground for visible desktop capture'
rect = wintypes.RECT()
assert user32.GetWindowRect(hwnd, ctypes.byref(rect))
bbox = (rect.left, rect.top, rect.right, rect.bottom)
assert bbox[2] > bbox[0] and bbox[3] > bbox[1]
name = sys.argv[1] if len(sys.argv) > 1 else 'original_game_desktop_capture_20261011'
assert name.replace('_', '').replace('-', '').isalnum()
output = root / 'remake/runtime/evidence' / (name + '.png')
assert not output.exists(), 'Refuse to overwrite captured evidence'
image = ImageGrab.grab(bbox=bbox, all_screens=True)
image.save(output)
report = dict(method='Pillow ImageGrab desktop GDI, target-window rectangle only', window_title='第七封印', pid=pid, executable=executable, window_rect=bbox, image_size=image.size, screenshot=str(output), sha256=hashlib.sha256(output.read_bytes()).hexdigest(), input_sent=False)
output.with_suffix('.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps(report, ensure_ascii=True))
