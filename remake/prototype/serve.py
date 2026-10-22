"""Serve only the generated preview on loopback. No original file or write endpoints."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse


class PreviewHandler(SimpleHTTPRequestHandler):
    def list_directory(self, path):
        self.send_error(404, 'Directory listing disabled')

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    directory = Path(__file__).resolve().parent / 'web'
    if not (directory / 'manifest.json').is_file():
        raise SystemExit('Run tools/extract.py first to produce manifest.json')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(PreviewHandler, directory=str(directory)))
    print(f'Seventh Seal preview: http://127.0.0.1:{args.port}/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
