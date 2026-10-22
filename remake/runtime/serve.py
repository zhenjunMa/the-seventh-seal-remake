"""Local formal runtime; both static mounts exclude original game files."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote
import argparse

ROOT = Path(__file__).resolve().parent
MOUNTS = {'/prototype/': ROOT.parent / 'prototype' / 'web', '/': ROOT / 'web'}

class RuntimeHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        decoded = unquote(urlsplit(path).path)
        prefix = '/prototype/' if decoded.startswith('/prototype/') else '/'
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

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8767)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), RuntimeHandler)
    print(f'Seventh Seal runtime: http://127.0.0.1:{args.port}/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
