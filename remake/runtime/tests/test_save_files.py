"""Exercise native save persistence through the real HTTP/file boundary."""
from contextlib import contextmanager
from copy import deepcopy
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from unittest.mock import patch
import hashlib
import http.client
import json
import sys
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME))
SPEC = spec_from_file_location('save_runtime_server', RUNTIME / 'serve.py')
runtime = module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)
SEED = json.loads((RUNTIME / 'web/data/opening_seed.json').read_text(encoding='utf-8'))


def envelope(name='first'):
    world = deepcopy(SEED)
    world['money'] = int(hashlib.sha256(name.encode()).hexdigest()[:4], 16)
    payload = json.dumps(world, ensure_ascii=False)
    return dict(schema='seventh-seal-save', version=1, saved_at='2026-10-23T00:00:00Z',
                payload=payload, sha256=hashlib.sha256(payload.encode()).hexdigest())


def money(value):
    return json.loads(value['payload'])['money']


class QuietHandler(runtime.RuntimeHandler):
    def log_message(self, *args):
        pass


@contextmanager
def serving(directory):
    server = runtime.RuntimeServer(('127.0.0.1', 0), QuietHandler, save_dir=directory)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def request(server, method='GET', slot='manual', value=None, headers=None, path=None):
    connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
    try:
        body = value if isinstance(value, bytes) else json.dumps(value).encode() if value is not None else None
        connection.request(method, path or f'/api/saves/{slot}', body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        value = raw if response.getheader('Content-Type') == 'application/octet-stream' else json.loads(raw) if raw else None
        return response.status, value
    finally:
        connection.close()


class SaveFileTests(unittest.TestCase):
    def test_native_slots_survive_server_restart_and_ports(self):
        with TemporaryDirectory() as directory:
            manual, quick = envelope(), envelope('quick')
            with serving(directory) as server:
                self.assertEqual(request(server)[0], 404)
                self.assertEqual(request(server, 'PUT', value=manual)[0], 200)
                self.assertEqual(request(server, 'PUT', 'quick', quick)[0], 200)
                before = request(server)[1], request(server, slot='quick')[1]
            self.assertEqual({p.name for p in Path(directory).iterdir()}, {'SaveGame0.Dat', 'Game.SAV'})
            with serving(directory) as server:
                self.assertEqual(request(server), (200, before[0]))
                self.assertEqual(request(server, slot='quick'), (200, before[1]))
                self.assertEqual(money(before[0]), money(manual))
                self.assertEqual(money(before[1]), money(quick))
                self.assertTrue(before[0]['saved_at'])
            for name in ('SaveGame0.Dat', 'Game.SAV'):
                raw = (Path(directory) / name).read_bytes()
                self.assertEqual(int.from_bytes(raw[:4], 'little'), 2)
                runtime.decode_native_save(raw)

    def test_invalid_and_failed_overwrites_preserve_previous_file(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            request(server, 'PUT', value=envelope())
            first = request(server)[1]
            path = Path(directory) / 'SaveGame0.Dat'
            before = path.read_bytes()
            self.assertEqual(request(server, 'PUT', value=envelope('other'), headers={'If-None-Match': '*'})[0], 412)
            bad = envelope('bad')
            bad['sha256'] = '0' * 64
            self.assertEqual(request(server, 'PUT', value=bad)[0], 422)
            with patch.object(runtime.os, 'replace', side_effect=OSError('disk unavailable')):
                self.assertEqual(request(server, 'PUT', value=envelope('second'))[0], 500)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(list(Path(directory).glob('*.tmp')), [])
            self.assertEqual(request(server), (200, first))

    def test_corrupt_files_do_not_look_like_empty_slots(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            (Path(directory) / 'Game.SAV').write_bytes(b'{bad')
            self.assertEqual(request(server, slot='quick')[0], 422)
            self.assertEqual(request(server)[0], 404)

    def test_fixed_paths_and_local_origin_and_body_limit(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            for slot in ['../SaveGame0.Dat', '%2e%2e/SaveGame0.Dat', 'manual/extra', 'unrecognized', '0', '20', '-1', '000', '00.json', 'decode', 'encode']:
                self.assertEqual(request(server, 'PUT', slot, envelope())[0], 404)
                self.assertEqual(request(server, slot=slot)[0], 404)
            self.assertEqual(request(server, 'PUT', value=envelope(), headers={'Origin': 'https://example.com'})[0], 403)
            self.assertEqual(request(server, headers={'Host': 'example.com'})[0], 403)
            self.assertEqual(request(server, path='/api/saves', headers={'Origin': 'https://example.com'})[0], 403)
            self.assertEqual(request(server, 'POST', value=b'bad', path='/api/saves/decode', headers={'Origin': 'https://example.com'})[0], 403)
            with patch.object(runtime, 'MAX_SAVE_BYTES', 10):
                self.assertEqual(request(server, 'PUT', value=envelope())[0], 413)
                self.assertEqual(request(server, 'POST', value=b'x' * 11, path='/api/saves/decode')[0], 413)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_all_twenty_slots_and_quick_are_independent_and_listed_once(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            status, listing = request(server, path='/api/saves')
            self.assertEqual(status, 200)
            keys = [f'{index:02}' for index in range(20)] + ['quick']
            self.assertEqual(listing, {'slots': [{'slot': key, 'envelope': None, 'error': None} for key in keys]})
            saves = {}
            for key in keys:
                value = envelope(key)
                status, saved = request(server, 'PUT', key, value)
                self.assertEqual(status, 200)
                self.assertEqual(saved['slot'], key)
                filename = 'Game.SAV' if key == 'quick' else f'SaveGame{int(key)}.Dat'
                self.assertEqual(saved['path'], f'remake/saves/{filename}')
                saves[key] = runtime.read_save_file(Path(directory) / filename)
                self.assertEqual(money(saves[key]), money(value))
            self.assertEqual(len(list(Path(directory).iterdir())), 21)
            self.assertEqual(list(Path(directory).glob('*.json')), [])
            self.assertEqual(request(server, path='/api/saves'), (200, {'slots': [
                {'slot': key, 'envelope': saves[key], 'error': None} for key in keys]}))
            for key, value in saves.items():
                self.assertEqual(request(server, slot=key), (200, value))

    def test_listing_separates_corrupt_and_unreadable_files_from_empty_slots(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            request(server, 'PUT', '01', envelope('valid'))
            current = request(server, slot='01')[1]
            (Path(directory) / 'SaveGame2.Dat').write_bytes(b'{bad')
            (Path(directory) / 'SaveGame3.Dat').mkdir()
            status, listing = request(server, path='/api/saves')
            self.assertEqual(status, 200)
            by_slot = {row['slot']: row for row in listing['slots']}
            self.assertEqual(by_slot['00'], {'slot': '00', 'envelope': None, 'error': None})
            self.assertEqual(by_slot['01'], {'slot': '01', 'envelope': current, 'error': None})
            self.assertIsNone(by_slot['02']['envelope'])
            self.assertIn('损坏', by_slot['02']['error'])
            self.assertIsNone(by_slot['03']['envelope'])
            self.assertIn('无法读取', by_slot['03']['error'])

    def test_json_files_are_ignored_without_fallback(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            for name in ('SaveGame0.json', 'SaveGame00.json', 'QuickSave.json'):
                (Path(directory) / name).write_text(json.dumps(envelope()), encoding='utf-8')
            self.assertEqual(request(server)[0], 404)
            self.assertEqual(request(server, slot='quick')[0], 404)
            self.assertTrue(all(row['envelope'] is None for row in request(server, path='/api/saves')[1]['slots']))
            self.assertEqual(request(server, 'PUT', value=envelope('new'), headers={'If-None-Match': '*'})[0], 200)
            self.assertTrue((Path(directory) / 'SaveGame0.Dat').exists())

    def test_conditional_overwrite_rejects_changed_missing_and_corrupt_slots(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            first, second, third = envelope('first'), envelope('second'), envelope('third')
            self.assertEqual(request(server, 'PUT', '04', second, {'If-Match': f'"{first["sha256"]}"'})[0], 412)
            path = Path(directory) / 'SaveGame4.Dat'
            self.assertFalse(path.exists())
            self.assertEqual(request(server, 'PUT', '04', first)[0], 200)
            headers = {'If-Match': f'"{request(server, slot="04")[1]["sha256"]}"'}
            self.assertEqual(request(server, 'PUT', '04', second, headers)[0], 200)
            self.assertEqual(request(server, 'PUT', '04', third, headers)[0], 412)
            self.assertEqual(money(request(server, slot='04')[1]), money(second))
            path.write_bytes(b'{bad')
            self.assertEqual(request(server, 'PUT', '04', third, headers)[0], 412)
            self.assertEqual(path.read_bytes(), b'{bad')

    def test_binary_import_export_converts_native_files_without_writing_slots(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            value = envelope('export')
            status, raw = request(server, 'POST', value=value, path='/api/saves/encode')
            self.assertEqual(status, 200)
            self.assertIsInstance(raw, bytes)
            self.assertEqual(int.from_bytes(raw[:4], 'little'), 2)
            status, decoded = request(server, 'POST', value=raw, path='/api/saves/decode')
            self.assertEqual(status, 200)
            self.assertEqual(money(decoded), money(value))
            self.assertEqual(list(Path(directory).iterdir()), [])
            self.assertEqual(request(server, 'POST', value=b'bad', path='/api/saves/decode')[0], 422)
            bad = dict(value, sha256='0' * 64)
            self.assertEqual(request(server, 'POST', value=bad, path='/api/saves/encode')[0], 422)
            self.assertEqual(request(server, 'POST', value=value, path='/api/saves/00')[0], 404)


if __name__ == '__main__':
    unittest.main()
