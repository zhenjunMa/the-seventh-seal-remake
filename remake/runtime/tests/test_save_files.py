"""Exercise native save persistence through the real HTTP/file boundary."""
from contextlib import contextmanager
from copy import deepcopy
from base64 import b64decode
from datetime import datetime, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from unittest.mock import patch
import hashlib
import http.client
import json
import os
import struct
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
            self.assertEqual(listing, {'slots': [{'slot': key, 'summary': None, 'error': None} for key in keys]})
            saves, summaries = {}, {}
            for key in keys:
                value = envelope(key)
                status, saved = request(server, 'PUT', key, value)
                self.assertEqual(status, 200)
                self.assertEqual(saved['slot'], key)
                filename = 'Game.SAV' if key == 'quick' else f'SaveGame{int(key)}.Dat'
                self.assertEqual(saved['path'], f'remake/saves/{filename}')
                summaries[key] = saved['summary']
                saves[key] = runtime.read_save_file(Path(directory) / filename)
                self.assertEqual(money(saves[key]), money(value))
            self.assertEqual(len(list(Path(directory).iterdir())), 21)
            self.assertEqual(list(Path(directory).glob('*.json')), [])
            self.assertEqual(request(server, path='/api/saves'), (200, {'slots': [
                {'slot': key, 'summary': summaries[key], 'error': None} for key in keys]}))
            for key, value in saves.items():
                self.assertEqual(request(server, slot=key), (200, value))

    def test_listing_separates_corrupt_and_unreadable_files_from_empty_slots(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            request(server, 'PUT', '01', envelope('valid'))
            current = runtime.read_save_summary(Path(directory) / 'SaveGame1.Dat')
            (Path(directory) / 'SaveGame2.Dat').write_bytes(b'{bad')
            (Path(directory) / 'SaveGame3.Dat').mkdir()
            status, listing = request(server, path='/api/saves')
            self.assertEqual(status, 200)
            by_slot = {row['slot']: row for row in listing['slots']}
            self.assertEqual(by_slot['00'], {'slot': '00', 'summary': None, 'error': None})
            self.assertEqual(by_slot['01'], {'slot': '01', 'summary': current, 'error': None})
            self.assertIsNone(by_slot['02']['summary'])
            self.assertIn('损坏', by_slot['02']['error'])
            self.assertIsNone(by_slot['03']['summary'])
            self.assertIn('无法读取', by_slot['03']['error'])

    def test_json_files_are_ignored_without_fallback(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            for name in ('SaveGame0.json', 'SaveGame00.json', 'QuickSave.json'):
                (Path(directory) / name).write_text(json.dumps(envelope()), encoding='utf-8')
            self.assertEqual(request(server)[0], 404)
            self.assertEqual(request(server, slot='quick')[0], 404)
            self.assertTrue(all(row['summary'] is None for row in request(server, path='/api/saves')[1]['slots']))
            self.assertEqual(request(server, 'PUT', value=envelope('new'), headers={'If-None-Match': '*'})[0], 200)
            self.assertTrue((Path(directory) / 'SaveGame0.Dat').exists())

    def test_conditional_overwrite_rejects_changed_missing_and_corrupt_slots(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            first, second, third = envelope('first'), envelope('second'), envelope('third')
            self.assertEqual(request(server, 'PUT', '04', second, {'If-Match': f'"{first["sha256"]}"'})[0], 412)
            path = Path(directory) / 'SaveGame4.Dat'
            self.assertFalse(path.exists())
            self.assertEqual(request(server, 'PUT', '04', first)[0], 200)
            headers = {'If-Match': f'"{request(server, path="/api/saves")[1]["slots"][4]["summary"]["sha256"]}"'}
            self.assertEqual(request(server, 'PUT', '04', second, headers)[0], 200)
            self.assertEqual(request(server, 'PUT', '04', third, headers)[0], 412)
            self.assertEqual(money(request(server, slot='04')[1]), money(second))
            path.write_bytes(b'{bad')
            self.assertEqual(request(server, 'PUT', '04', third, headers)[0], 412)
            self.assertEqual(path.read_bytes(), b'{bad')

    def test_file_save_date_uses_server_clock_and_survives_changed_filesystem_time(self):
        saved_at = datetime(2026, 11, 2, 12, 34, 56, 789000, timezone.utc)
        expected = '2026-11-02T20:34:56.789+08:00'
        with TemporaryDirectory() as directory, serving(directory) as server:
            with patch.object(runtime, 'datetime') as clock:
                clock.now.return_value = saved_at
                clock.fromtimestamp.side_effect = datetime.fromtimestamp
                status, saved = request(server, 'PUT', '00', envelope())
                self.assertEqual(status, 200)
                self.assertEqual(saved['summary']['saved_at'], expected)
                self.assertEqual(saved['summary']['saved_at_source'], 'save')
                status, exported = request(server, 'POST', value=envelope(), path='/api/saves/encode')
                self.assertEqual(status, 200)
            path = Path(directory) / 'SaveGame0.Dat'
            self.assertEqual(struct.unpack_from('<8H', path.read_bytes(), 0x6D), (2026, 11, 1, 2, 20, 34, 56, 789))
            os.utime(path, (0, 0))
            for value in (request(server)[1], request(server, path='/api/saves')[1]['slots'][0]['summary']):
                self.assertEqual(value['saved_at'], expected)
                self.assertEqual(value['saved_at_source'], 'save')
            self.assertEqual(request(server, 'POST', value=exported, path='/api/saves/decode')[1]['saved_at'], expected)

    def test_summary_reuses_saved_pixels_and_cache_without_decoding_game_state(self):
        with TemporaryDirectory() as directory, serving(directory) as server:
            path = Path(directory) / 'SaveGame0.Dat'
            raw = bytearray(runtime.encode_native_save(envelope()))
            raw[0x4D:0x61] = '预览地图'.encode('cp936').ljust(20, b'\0')
            path.write_bytes(raw)
            with patch.object(runtime, 'decode_native_save', side_effect=AssertionError('列表不应完整解码')):
                with patch.object(runtime, 'native_save_summary', wraps=runtime.native_save_summary) as summarize:
                    first = request(server, path='/api/saves')[1]['slots'][0]['summary']
                    self.assertEqual(request(server, path='/api/saves')[1]['slots'][0]['summary'], first)
                    self.assertEqual(summarize.call_count, 1)
                    self.assertNotIn('payload', first)
                    self.assertEqual(first['saved_at_source'], 'file')
                    self.assertEqual(first['location'], dict(map_id=SEED['location']['map_id'], map_name='预览地图'))
                    self.assertEqual(first['party'], [{'name': role['name']} for role in SEED['party']])
                    bitmap = b64decode(first['thumbnail'].split(',', 1)[1])
                    self.assertEqual(bitmap[66:], raw[0x3C5:0x3C5 + 104 * 76 * 2])
                    self.assertEqual(struct.unpack_from('<ii', bitmap, 18), (104, -76))
                    # Replacing a file with preserved mtime still invalidates the cache.
                    stamp = path.stat().st_mtime_ns
                    changed = bytearray(raw)
                    struct.pack_into('<I', changed, 0x7D, 1234)
                    other = Path(directory) / 'replacement'
                    other.write_bytes(changed)
                    os.utime(other, ns=(stamp, stamp))
                    os.replace(other, path)
                    second = request(server, path='/api/saves')[1]['slots'][0]['summary']
                    self.assertEqual(second['play_time_ms'], 123400)
                    self.assertNotEqual(first['sha256'], second['sha256'])
                    self.assertEqual(summarize.call_count, 2)
                    # Missing thumbnails stay empty; no fallback image is produced.
                    struct.pack_into('<I', changed, 0x3C1, 0)
                    del changed[0x3C5:0x3C5 + 104 * 76 * 2]
                    path.write_bytes(changed)
                    self.assertIsNone(request(server, path='/api/saves')[1]['slots'][0]['summary']['thumbnail'])
            status, loaded = request(server)
            self.assertEqual(status, 200)
            self.assertNotIn('preview', loaded)
            path.unlink()
            self.assertIsNone(request(server, path='/api/saves')[1]['slots'][0]['summary'])

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
