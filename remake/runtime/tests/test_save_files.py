"""Exercise the real HTTP/file boundary in an isolated directory."""
from contextlib import contextmanager
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from unittest.mock import patch
import hashlib
import http.client
import json
import unittest

SPEC = spec_from_file_location('save_runtime_server', Path(__file__).resolve().parents[1] / 'serve.py')
runtime = module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


def envelope(name='first'):
    payload = json.dumps({'schema': 'seventh-seal-world', 'version': 1, 'name': name})
    return dict(schema='seventh-seal-save', version=1, saved_at='2026-10-23T00:00:00Z',
                payload=payload, sha256=hashlib.sha256(payload.encode()).hexdigest())


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
        body = json.dumps(value).encode() if value is not None else None
        connection.request(method, path or f'/api/saves/{slot}', body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        return response.status, json.loads(raw) if raw else None
    finally:
        connection.close()


class SaveFileTests(unittest.TestCase):
    def test_slots_survive_server_restart_and_ports_and_keep_preview(self):
        with TemporaryDirectory() as directory:
            manual, quick = envelope(), envelope('quick')
            manual['preview'] = {'payload_sha256': manual['sha256'], 'png': 'retained'}
            with serving(directory) as server:
                self.assertEqual(request(server)[0], 404)
                self.assertEqual(request(server, 'PUT', value=manual)[0], 200)
                self.assertEqual(request(server, 'PUT', 'quick', quick)[0], 200)
            self.assertEqual(set(p.name for p in Path(directory).iterdir()), {'SaveGame00.json', 'QuickSave.json'})
            with serving(directory) as server:
                self.assertEqual(request(server), (200, manual))
                self.assertEqual(request(server, slot='quick'), (200, quick))

    def test_invalid_and_failed_overwrites_preserve_previous_file(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            first = envelope()
            request(server, 'PUT', value=first)
            before = (Path(directory) / 'SaveGame00.json').read_bytes()
            self.assertEqual(request(server, 'PUT', value=envelope('legacy'), headers={'If-None-Match': '*'})[0], 412)
            bad = envelope('bad')
            bad['sha256'] = '0' * 64
            self.assertEqual(request(server, 'PUT', value=bad)[0], 422)
            with patch.object(runtime.os, 'replace', side_effect=OSError('disk unavailable')):
                self.assertEqual(request(server, 'PUT', value=envelope('second'))[0], 500)
            self.assertEqual((Path(directory) / 'SaveGame00.json').read_bytes(), before)
            self.assertEqual(list(Path(directory).glob('*.tmp')), [])
            self.assertEqual(request(server), (200, first))

    def test_corrupt_files_do_not_look_like_empty_slots(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            (Path(directory) / 'QuickSave.json').write_text('{bad', encoding='utf-8')
            self.assertEqual(request(server, slot='quick')[0], 422)
            self.assertEqual(request(server)[0], 404)

    def test_fixed_paths_and_local_origin_and_body_limit(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            for slot in ['../SaveGame0.Dat', '%2e%2e/SaveGame0.Dat', 'manual/extra', 'unrecognized', '0', '20', '-1', '000', '00.json']:
                self.assertEqual(request(server, 'PUT', slot, envelope())[0], 404)
                self.assertEqual(request(server, slot=slot)[0], 404)
            self.assertEqual(request(server, 'PUT', value=envelope(), headers={'Origin': 'https://example.com'})[0], 403)
            self.assertEqual(request(server, headers={'Host': 'example.com'})[0], 403)
            self.assertEqual(request(server, path='/api/saves', headers={'Origin': 'https://example.com'})[0], 403)
            with patch.object(runtime, 'MAX_SAVE_BYTES', 10):
                self.assertEqual(request(server, 'PUT', value=envelope())[0], 413)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_all_twenty_slots_and_quick_are_independent_and_listed_in_one_response(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            status, listing = request(server, path='/api/saves')
            self.assertEqual(status, 200)
            keys = [f'{index:02}' for index in range(20)] + ['quick']
            self.assertEqual(listing, {'slots': [{'slot': key, 'envelope': None, 'error': None} for key in keys]})
            saves = {key: envelope(key) for key in keys}
            for key, value in saves.items():
                status, saved = request(server, 'PUT', key, value)
                self.assertEqual(status, 200)
                self.assertEqual(saved['slot'], key)
                filename = 'QuickSave.json' if key == 'quick' else f'SaveGame{key}.json'
                self.assertEqual(saved['path'], f'remake/saves/{filename}')
            self.assertEqual(len(list(Path(directory).glob('*.json'))), 21)
            status, listing = request(server, path='/api/saves')
            self.assertEqual(status, 200)
            self.assertEqual(listing, {'slots': [{'slot': key, 'envelope': saves[key], 'error': None} for key in keys]})
            for key, value in saves.items():
                self.assertEqual(request(server, slot=key), (200, value))

    def test_listing_keeps_corrupt_and_unreadable_files_separate_from_empty_slots(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            request(server, 'PUT', '01', envelope('valid'))
            (Path(directory) / 'SaveGame02.json').write_text('{bad', encoding='utf-8')
            (Path(directory) / 'SaveGame03.json').mkdir()
            status, listing = request(server, path='/api/saves')
            self.assertEqual(status, 200)
            by_slot = {row['slot']: row for row in listing['slots']}
            self.assertIsNone(by_slot['00']['envelope'])
            self.assertIsNone(by_slot['00']['error'])
            self.assertEqual(by_slot['01']['envelope'], envelope('valid'))
            self.assertIsNone(by_slot['01']['error'])
            self.assertIsNone(by_slot['02']['envelope'])
            self.assertIn('损坏', by_slot['02']['error'])
            self.assertIsNone(by_slot['03']['envelope'])
            self.assertIn('无法读取', by_slot['03']['error'])

    def test_old_single_file_is_only_a_slot_00_fallback_and_is_preserved(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            legacy_path = Path(directory) / 'SaveGame0.json'
            legacy = envelope('old single slot')
            legacy_path.write_text(json.dumps(legacy), encoding='utf-8')
            before = legacy_path.read_bytes()
            self.assertEqual(request(server, slot='00'), (200, legacy))
            self.assertEqual(request(server, slot='manual'), (200, legacy))
            self.assertEqual(request(server, slot='01')[0], 404)
            self.assertEqual(request(server, path='/api/saves')[1]['slots'][0]['envelope'], legacy)
            self.assertEqual(request(server, 'PUT', '00', envelope('migration'), {'If-None-Match': '*'})[0], 412)
            newer = envelope('numbered file')
            self.assertEqual(request(server, 'PUT', 'manual', newer, {'If-Match': f'"{legacy["sha256"]}"'})[0], 200)
            self.assertEqual(request(server, slot='00'), (200, newer))
            self.assertEqual(legacy_path.read_bytes(), before)
            (Path(directory) / 'SaveGame00.json').write_text('{bad', encoding='utf-8')
            self.assertEqual(request(server, slot='00')[0], 422)
            self.assertEqual(legacy_path.read_bytes(), before)

    def test_conditional_overwrite_rejects_changed_missing_and_corrupt_slots(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            first, second, third = envelope('first'), envelope('second'), envelope('third')
            headers = {'If-Match': f'"{first["sha256"]}"'}
            self.assertEqual(request(server, 'PUT', '04', second, headers)[0], 412)
            self.assertFalse((Path(directory) / 'SaveGame04.json').exists())
            self.assertEqual(request(server, 'PUT', '04', first)[0], 200)
            self.assertEqual(request(server, 'PUT', '04', second, headers)[0], 200)
            self.assertEqual(request(server, 'PUT', '04', third, headers)[0], 412)
            self.assertEqual(request(server, slot='04'), (200, second))
            (Path(directory) / 'SaveGame04.json').write_text('{bad', encoding='utf-8')
            self.assertEqual(request(server, 'PUT', '04', third, headers)[0], 412)
            self.assertEqual((Path(directory) / 'SaveGame04.json').read_text(), '{bad')


if __name__ == '__main__':
    unittest.main()
