"""Original-format records and meaningful remake progress through the file codec."""
from copy import deepcopy
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import hashlib
import json
import os
import struct
import sys
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME))
from native_save import decode_native_save, encode_native_save, complete_layout, resources, native_camera_position
from tools import repair_native_saves


def envelope(world):
    payload = json.dumps(world, ensure_ascii=False, separators=(',', ':'))
    return dict(schema='seventh-seal-save', version=1, payload=payload,
                sha256=hashlib.sha256(payload.encode()).hexdigest())


class NativeSaveTests(unittest.TestCase):
    def test_new_game_is_complete_native_v2_without_a_save_template(self):
        world = deepcopy(resources()[0])
        raw = encode_native_save(envelope(world))
        self.assertEqual(struct.unpack_from('<I', raw)[0], 2)
        self.assertNotIn(b'seventh-seal-save', raw)
        layout = complete_layout(raw, {int(k): v['name'] for k, v in resources()[2].items()})
        self.assertTrue(layout['reaches_eof'])
        self.assertEqual(len(layout['characters']), 10)
        block = next(row for row in layout['sections'] if row['section'] == 'global_block')
        for area in resources()[4]:
            for destination in area['destinations']:
                at = block['offset'] + area['id'] * 0xEC + 6 + destination['index'] * 0x17
                self.assertEqual(raw[at:at + 0x17], bytes.fromhex(destination['source']['raw_hex']))
        loaded = json.loads(decode_native_save(raw)['payload'])
        self.assertEqual(loaded['location'], world['location'])
        self.assertEqual(loaded['money'], 50)
        initial_head = bytearray.fromhex(world['party'][0]['combat_progress']['header_raw_hex'])
        struct.pack_into('<I', initial_head, 0x2FF, 1)
        struct.pack_into('<I', initial_head, 0x303, 0)
        self.assertEqual(loaded['party'][0]['combat_progress']['header_raw_hex'], initial_head.hex())
        self.assertEqual(loaded['inventory'], [])
        self.assertEqual(encode_native_save(decode_native_save(raw)), raw)

    def test_native_identity_formation_npc_layer_settings_and_elapsed_time_bytes(self):
        seed, skills, items, maps, _ = resources()
        world = deepcopy(seed)
        world['opening']['status'] = 'complete'
        world['location'] = dict(map_id='M01060', x=464, y=1328, direction=0)
        world['formation_slots'] = [None, None, '001', None]
        world['play_time_ms'] = ((3 * 60 + 4) * 60 + 5) * 1000
        raw = encode_native_save(envelope(world))
        layout = complete_layout(raw, {int(k): v['name'] for k, v in items.items()})
        for role in layout['characters']:
            if not role['name']:
                continue
            at, index = role['header_offset'], role['role_index']
            # Independent native offsets: 445190/445B10 consume +2FF/+303.
            self.assertEqual(struct.unpack_from('<I', raw, at + 0x2FF)[0], index + 1)
            initial = bytes.fromhex(skills[f'{index + 1:03}']['header_raw_hex'])
            self.assertEqual(raw[at + 0x2B3:at + 0x2B7], initial[0x2B3:0x2B7])
            if index == 0:
                self.assertEqual(struct.unpack_from('<I', raw, at + 0x303)[0], 2)
        actors = next(row for row in layout['sections'] if row['section'] == 'map_objects')
        self.assertEqual(struct.unpack_from('<I', raw, 0x34)[0], 2048 + actors['map_npc_count'])
        current = actors['offset'] + 8 + 10 * 0x4C5
        key = struct.unpack_from('<I', bytes.fromhex(maps['M01060']['header_raw_hex']), 0x92)[0]
        self.assertEqual(key, 6)
        for slot in range(10, 10 + actors['map_npc_count']):
            self.assertEqual(struct.unpack_from('<I', raw, current + slot * 0x4C5 + 0x93)[0], 6)
        crystal = current + 19 * 0x4C5
        self.assertEqual(struct.unpack_from('<2I', raw, crystal + 0x30), (232, 664))
        self.assertEqual(struct.unpack_from('<2I', raw, crystal + 0x5B), (232, 664))
        self.assertEqual(struct.unpack_from('<I', raw, crystal + 0xD6)[0], 80)
        self.assertEqual(struct.unpack_from('<I', raw, crystal + 0x30B)[0], 10)
        self.assertEqual(raw[0x3A9:0x3B1], bytes((64, 64, 64, 1, 1, 1, 1, 0)))
        self.assertEqual(struct.unpack_from('<3H', raw, 0x75), (3, 4, 5))
        self.assertEqual(json.loads(decode_native_save(raw)['payload'])['play_time_ms'], world['play_time_ms'])

    def test_native_original_time_words_and_legitimate_muted_settings_are_preserved(self):
        raw = bytearray(encode_native_save(envelope(resources()[0])))
        # Original saves have large cumulative hours and retain unrelated words.
        struct.pack_into('<8H', raw, 0x6D, 0, 0, 0, 17, 10611, 37, 30, 888)
        raw[0x3A9:0x3B1] = bytes((32, 48, 64, 1, 1, 0, 1, 0))
        raw = bytes(raw)
        loaded = decode_native_save(raw)
        world = json.loads(loaded['payload'])
        self.assertEqual(world['play_time_ms'], ((10611 * 60 + 37) * 60 + 30) * 1000)
        self.assertTrue(world['game_settings']['audio']['music']['muted'])
        self.assertEqual(encode_native_save(loaded), raw)
        candidate, report = repair_native_saves.repair_save(raw)
        self.assertEqual(candidate, raw)
        self.assertFalse(report['changed'])
        all_muted = bytearray(raw)
        all_muted[0x3A9:0x3B1] = bytes(8)
        candidate, report = repair_native_saves.repair_save(bytes(all_muted))
        self.assertEqual(candidate, all_muted)
        self.assertFalse(report['changed'])

    def test_native_camera_header_bytes_match_original_viewport_coordinates(self):
        for map_id, x_native, y_native, expected in (
                ('M17010', 676, 694, (508, 552)),
                ('M01060', 222, 670, (54, 542))):
            with self.subTest(map_id=map_id):
                world = deepcopy(resources()[0])
                world['opening']['status'] = 'complete'
                world['location'] = dict(map_id=map_id, x=x_native * 2, y=y_native * 2, direction=0)
                raw = encode_native_save(envelope(world))
                self.assertEqual(struct.unpack_from('<2I', raw, 0x61), expected)
        header = bytearray.fromhex(resources()[3]['M01060']['header_raw_hex'])
        struct.pack_into('<I', header, 0x88, 0)
        self.assertEqual(native_camera_position(header, resources()[3]['M01060']['native_camera_extent_cells'], 222, 670), (222, 670))

    def test_repair_changes_only_known_bug_fields_and_preserves_unrelated_progress(self):
        world = deepcopy(resources()[0])
        world['location'] = dict(map_id='M01060', x=464, y=1328, direction=0)
        world['opening']['status'] = 'complete'
        world['formation_slots'] = [None, None, '001', None]
        world['money'] = 9876
        world['flags'][51] = 0x80000001
        world['play_time_ms'] = 3723456
        healthy = encode_native_save(envelope(world))
        posed = json.loads(decode_native_save(healthy)['payload'])
        crystal = next(actor for actor in posed['map_npc_state']['actors'] if actor['slot'] == 19)
        crystal.update(x=500, y=1400, direction=2, hidden=True, frame=12)
        healthy = encode_native_save(envelope(posed))
        bad = bytearray(healthy)
        layout = complete_layout(healthy, {int(k): v['name'] for k, v in resources()[2].items()})
        for role in layout['characters']:
            if role['name']:
                struct.pack_into('<I', bad, role['header_offset'] + 0x2FF, 0)
                if role['role_index'] == 0:
                    struct.pack_into('<I', bad, role['header_offset'] + 0x2B3, 2)
                    struct.pack_into('<I', bad, role['header_offset'] + 0x303, 0)
        actors = next(row for row in layout['sections'] if row['section'] == 'map_objects')
        crystal_offset = actors['offset'] + 8 + (10 + 19) * 0x4C5
        struct.pack_into('<I', bad, crystal_offset + 0x485, 17)
        healthy = bytearray(healthy)
        struct.pack_into('<I', healthy, crystal_offset + 0x485, 17)
        healthy = bytes(healthy)
        for slot in range(10, 10 + actors['map_npc_count']):
            struct.pack_into('<I', bad, actors['offset'] + 8 + (10 + slot) * 0x4C5 + 0x93, 0)
        bad[0x3A9:0x3B1] = bytes(8)
        struct.pack_into('<I', bad, 0x34, 0)
        struct.pack_into('<2I', bad, 0x61, 0, 0)
        repaired, report = repair_native_saves.repair_save(bytes(bad))
        self.assertTrue(report['changed'])
        self.assertEqual(repaired, healthy)
        self.assertTrue(all(row['unrelated_progress_equal'] for row in report['domains']))
        permitted = {at for row in report['allowed_byte_ranges'] for at in range(row['offset'], row['offset'] + row['bytes'])}
        self.assertTrue(all(a == b or index in permitted for index, (a, b) in enumerate(zip(bad, repaired))))
        first_header = layout['characters'][0]['header_offset']
        struct.pack_into('<I', bad, first_header + 0x2B3, 99)
        preserved, _ = repair_native_saves.repair_save(bytes(bad))
        self.assertEqual(struct.unpack_from('<I', preserved, first_header + 0x2B3)[0], 99)

    def test_repair_preview_and_apply_preserve_custom_slot_name_and_mtime(self):
        raw = bytearray(encode_native_save(envelope(resources()[0])))
        layout = complete_layout(raw, {int(k): v['name'] for k, v in resources()[2].items()})
        for role in layout['characters']:
            if role['name']:
                struct.pack_into('<I', raw, role['header_offset'] + 0x2FF, 0)
        raw[0x3A9:0x3B1] = bytes(8)
        with TemporaryDirectory() as directory:
            root = Path(directory)
            saves = root / 'saves'
            saves.mkdir()
            path = saves / 'SaveGame31.Dat'
            path.write_bytes(raw)
            os.utime(path, ns=(1234567890000000000, 1234567890123456700))
            original_mtime = path.stat().st_mtime_ns
            for apply, backup in ((False, root / 'preview'), (True, root / 'installed')):
                argv = ['repair_native_saves.py', '--save-dir', str(saves), '--backup-dir', str(backup)]
                if apply:
                    argv.append('--apply')
                with patch.object(sys, 'argv', argv), redirect_stdout(StringIO()):
                    repair_native_saves.main()
                self.assertEqual({p.name for p in saves.iterdir()}, {'SaveGame31.Dat'})
                self.assertEqual(path.stat().st_mtime_ns, original_mtime)
                self.assertEqual((backup / 'inputs/SaveGame31.Dat').read_bytes(), raw)
                staged = (backup / 'repaired/SaveGame31.Dat').read_bytes()
                self.assertEqual(path.read_bytes(), staged if apply else raw)
                self.assertNotEqual(staged, raw)

    def test_repair_backup_matches_the_read_snapshot_when_player_saves_again(self):
        raw = bytearray(encode_native_save(envelope(resources()[0])))
        layout = complete_layout(raw, {int(k): v['name'] for k, v in resources()[2].items()})
        for role in layout['characters']:
            if role['name']:
                struct.pack_into('<I', raw, role['header_offset'] + 0x2FF, 0)
        original_repair = repair_native_saves.repair_save
        with TemporaryDirectory() as directory:
            root = Path(directory)
            saves, backup = root / 'saves', root / 'backup'
            saves.mkdir()
            path = saves / 'SaveGame0.Dat'
            path.write_bytes(raw)
            newer = bytearray(raw)
            struct.pack_into('<I', newer, 0x81, 999)
            def player_saves_again(snapshot):
                result = original_repair(snapshot)
                path.write_bytes(newer)
                return result
            argv = ['repair_native_saves.py', '--save-dir', str(saves), '--backup-dir', str(backup)]
            with patch.object(sys, 'argv', argv), patch.object(repair_native_saves, 'repair_save', side_effect=player_saves_again), redirect_stdout(StringIO()):
                repair_native_saves.main()
            self.assertEqual((backup / 'inputs/SaveGame0.Dat').read_bytes(), raw)
            self.assertEqual(path.read_bytes(), newer)
            self.assertEqual(struct.unpack_from('<I', (backup / 'repaired/SaveGame0.Dat').read_bytes(), 0x81)[0], 50)

    def test_flags_bag_equipment_skill_compose_formation_and_recipe_survive(self):
        seed, skills, items, _, _ = resources()
        world = deepcopy(seed)
        world['opening']['status'] = 'complete'
        world['location'] = dict(map_id='M17010', x=1016, y=1104, direction=2)
        world['flags'][51] = 0x80000001
        world['event_records'][55] = ['0300010002000300040005000600']
        world['money'] = 12345
        item = deepcopy(seed['source']['initial_equipment'][0])
        world['equipment'] = {'version': 1, 'roles': {'001': [dict(id=item['item_id'],
            slot_id='weapon', source_raw_hex=item['source_raw_hex'])]}}
        raw_item = bytearray(229)
        struct.pack_into('<II', raw_item, 0, 8, 12)
        world['inventory'] = [dict(id=8, quantity=12, source_raw_hex=raw_item.hex())]
        world['formation_slots'] = [None, '001', None, None]
        world['recipe_unlock_indices'] = [7, 33]
        world['party'][0]['skill_progress'] = {'version': 2, 'learned_indices': [21],
            'records': [dict(index=21, level=2, experience=37)]}
        composed = bytes.fromhex('0900000001072d0000000000000000000000000000000000020215160000000000000000')
        world['technique_combinations'] = {'version': 1, 'roles': {'001': [dict(native_raw_hex=composed.hex())]}}
        world['encounters'] = {'rng_state': 123, 'counters': {'001': 39}, 'remainders': {'001': 0}}
        raw = encode_native_save(envelope(world))
        loaded = json.loads(decode_native_save(raw)['payload'])
        for key in ['location', 'flags', 'event_records', 'money', 'formation_slots', 'recipe_unlock_indices']:
            self.assertEqual(loaded[key], world[key], key)
        self.assertEqual(loaded['inventory'][0]['quantity'], 12)
        self.assertEqual(loaded['equipment']['roles']['001'][0]['source_raw_hex'], item['source_raw_hex'])
        self.assertEqual(loaded['technique_combinations']['roles']['001'][0]['native_raw_hex'], composed.hex())
        self.assertEqual(loaded['encounters']['counters']['001'], 39)
        self.assertIn(dict(index=21, level=2, experience=37), loaded['party'][0]['skill_progress']['records'])
        self.assertEqual(encode_native_save(decode_native_save(raw)), raw)

    def test_corrupt_binary_and_invalid_envelope_are_rejected_at_entry(self):
        raw = encode_native_save(envelope(resources()[0]))
        for truncated in (raw[:3], raw[:960], raw[:-1]):
            with self.assertRaises(ValueError):
                decode_native_save(truncated)
        bad = envelope(resources()[0])
        bad['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, '校验失败'):
            encode_native_save(bad)


if __name__ == '__main__':
    unittest.main()
