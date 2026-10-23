"""Serve only the generated preview on loopback. No original file or write endpoints."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import argparse

PROJECT = Path(__file__).resolve().parent
RUNTIME_WEB = PROJECT.parent / 'runtime/web'


class PreviewHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        decoded = unquote(urlsplit(path).path)
        name = decoded.lstrip('/')
        if name in {'manifest.json', 'combat_manifest.json', 'combat_presentation.json'}:
            return str(RUNTIME_WEB / 'data/source' / name)
        if decoded.startswith('/runtime/'):
            root, relative = RUNTIME_WEB, decoded[len('/runtime/'):]
        elif decoded.startswith('/assets/'):
            root, relative = RUNTIME_WEB / 'assets', decoded[len('/assets/'):]
        else:
            root, relative = PROJECT / 'web', name
        parts = relative.split('/')
        target = root.joinpath(*parts).resolve()
        if any(part in ('.', '..') or '\\' in part or ':' in part for part in parts) or not target.is_relative_to(root.resolve()):
            return str(PROJECT / '__denied__')
        return str(target)

    def list_directory(self, path):
        self.send_error(404, 'Directory listing disabled')

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    directory = PROJECT / 'web'
    if not (RUNTIME_WEB / 'data/source/manifest.json').is_file():
        raise SystemExit('Run ../runtime/tools/extract.py first to produce data/source/manifest.json')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(PreviewHandler, directory=str(directory)))
    print(f'Seventh Seal preview: http://127.0.0.1:{args.port}/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
