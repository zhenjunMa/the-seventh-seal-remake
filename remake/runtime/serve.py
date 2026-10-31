"""Local runtime with fixed save slots; static mounts exclude original files."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlsplit, unquote
import argparse
import json
import os
import sys
import tempfile
import threading
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from native_save import decode_native_save, encode_native_save

MOUNTS = {'/': ROOT / 'web'}
SAVE_FILES = {**{f'{index:02}': f'SaveGame{index}.Dat' for index in range(20)}, 'quick': 'Game.SAV'}
MAX_SAVE_BYTES = 8_000_000


def normalize_save_slot(slot):
    slot = '00' if slot == 'manual' else slot
    return slot if slot in SAVE_FILES else None


def read_save_file(path):
    if path.is_symlink():
        raise ValueError('存档路径无效')
    raw = path.read_bytes()
    if len(raw) > MAX_SAVE_BYTES:
        raise ValueError('存档文件超过当前版本上限')
    value = decode_native_save(raw)
    value['saved_at'] = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
    return value

class RuntimeHandler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def json_response(self, status, value):
        raw = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def binary_response(self, raw):
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def save_slot(self):
        path = urlsplit(self.path).path
        if path == '/api/saves':
            return ''
        return path[len('/api/saves/'):] if path.startswith('/api/saves/') else None

    def local_request(self):
        port = self.server.server_port
        hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
        origin = self.headers.get('Origin')
        return (self.headers.get('Host') in hosts
                and self.headers.get('Sec-Fetch-Site') != 'cross-site'
                and (origin is None or origin in {f'http://{host}' for host in hosts}))

    def do_GET(self):
        slot = self.save_slot()
        if slot is None:
            return super().do_GET()
        if not self.local_request():
            return self.json_response(403, {'error': '存档接口仅供本地游戏访问'})
        if slot == '':
            slots = []
            with self.server.save_lock:
                for key in SAVE_FILES:
                    row = {'slot': key, 'envelope': None, 'error': None}
                    try:
                        row['envelope'] = read_save_file(self.server.save_dir / SAVE_FILES[key])
                    except FileNotFoundError:
                        pass
                    except (ValueError, UnicodeError):
                        row['error'] = '存档文件损坏，当前进度已保留'
                    except OSError:
                        row['error'] = '无法读取 remake/saves 中的存档'
                    slots.append(row)
            return self.json_response(200, {'slots': slots})
        slot = normalize_save_slot(slot)
        if slot is None:
            return self.json_response(404, {'error': '存档槽不存在'})
        try:
            with self.server.save_lock:
                value = read_save_file(self.server.save_dir / SAVE_FILES[slot])
        except FileNotFoundError:
            return self.json_response(404, {'error': '此存档槽尚未保存进度'})
        except (ValueError, UnicodeError):
            return self.json_response(422, {'error': '存档文件损坏，当前进度已保留'})
        except OSError:
            return self.json_response(500, {'error': '无法读取 remake/saves 中的存档'})
        self.json_response(200, value)

    def do_PUT(self):
        # Reject unread request bodies by closing this HTTP/1.1 connection.
        self.close_connection = True
        if not self.local_request():
            return self.json_response(403, {'error': '存档接口仅供本地游戏访问'})
        slot = normalize_save_slot(self.save_slot())
        if slot is None:
            return self.json_response(404, {'error': '存档槽不存在'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if self.headers.get('Transfer-Encoding') or not 0 < length <= MAX_SAVE_BYTES:
            return self.json_response(413, {'error': '存档文件大小无效或超过当前版本上限'})
        raw = self.rfile.read(length)
        try:
            if len(raw) != length:
                raise ValueError('存档数据不完整')
            raw = encode_native_save(json.loads(raw))
        except (ValueError, UnicodeError) as error:
            return self.json_response(422, {'error': str(error)})
        temporary = None
        try:
            with self.server.save_lock:
                self.server.save_dir.mkdir(parents=True, exist_ok=True)
                path = self.server.save_dir / SAVE_FILES[slot]
                existing = path
                if self.headers.get('If-None-Match') == '*' and (existing.exists() or existing.is_symlink()):
                    return self.json_response(412, {'error': '此存档槽已有文件，保留现有进度'})
                expected = self.headers.get('If-Match')
                if expected is not None:
                    try:
                        current = read_save_file(existing)
                    except (ValueError, UnicodeError, OSError):
                        return self.json_response(412, {'error': '此存档槽已发生变化，请重新选择后确认覆盖'})
                    if expected != f'"{current["sha256"]}"':
                        return self.json_response(412, {'error': '此存档槽已发生变化，请重新选择后确认覆盖'})
                if path.is_symlink():
                    raise OSError('Invalid save path')
                with tempfile.NamedTemporaryFile(dir=self.server.save_dir, suffix='.tmp', delete=False) as stream:
                    temporary = Path(stream.name)
                    stream.write(raw)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, path)
        except OSError:
            return self.json_response(500, {'error': '无法写入 remake/saves，原存档已保留'})
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        self.json_response(200, {'slot': slot, 'path': f'remake/saves/{SAVE_FILES[slot]}'})

    def do_POST(self):
        self.close_connection = True
        if not self.local_request():
            return self.json_response(403, {'error': '存档接口仅供本地游戏访问'})
        action = urlsplit(self.path).path
        if action not in ('/api/saves/decode', '/api/saves/encode'):
            return self.json_response(404, {'error': '存档操作不存在'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if self.headers.get('Transfer-Encoding') or not 0 < length <= MAX_SAVE_BYTES:
            return self.json_response(413, {'error': '存档文件大小无效或超过当前版本上限'})
        raw = self.rfile.read(length)
        try:
            if len(raw) != length:
                raise ValueError('存档数据不完整')
            if action == '/api/saves/decode':
                value = decode_native_save(raw)
            else:
                value = encode_native_save(json.loads(raw))
        except (ValueError, UnicodeError) as error:
            return self.json_response(422, {'error': str(error)})
        if action == '/api/saves/decode':
            return self.json_response(200, value)
        self.binary_response(value)

    def translate_path(self, path):
        decoded = unquote(urlsplit(path).path)
        prefix = '/'
        root = MOUNTS[prefix].resolve()
        parts = decoded[len(prefix):].split('/')
        if any(part in ('.', '..') or '\\' in part or ':' in part for part in parts):
            return str(ROOT / '__denied__')
        target = root.joinpath(*parts).resolve()
        if not target.is_relative_to(root):
            return str(ROOT / '__denied__')
        return str(target)
    def list_directory(self, path):
        self.send_error(404, 'Directory listing disabled')
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

class RuntimeServer(ThreadingHTTPServer):
    # ES module graphs and map atlases request many files concurrently.
    request_queue_size = 128

    def __init__(self, *args, save_dir=None, **kwargs):
        self.save_dir = Path(save_dir) if save_dir is not None else ROOT.parent / 'saves'
        self.save_lock = threading.Lock()
        super().__init__(*args, **kwargs)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8767)
    parser.add_argument('--save-dir', type=Path, help='独立验收存档目录；默认使用 remake/saves')
    args = parser.parse_args()
    server = RuntimeServer(('127.0.0.1', args.port), RuntimeHandler, save_dir=args.save_dir)
    print(f'Seventh Seal runtime: http://127.0.0.1:{args.port}/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
