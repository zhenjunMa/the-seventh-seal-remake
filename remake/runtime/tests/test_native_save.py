"""Original-format records and meaningful remake progress through the file codec."""
from copy import deepcopy
from pathlib import Path
import hashlib
import json
import struct
import sys
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME))
from native_save import decode_native_save, encode_native_save, complete_layout, resources


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
        self.assertEqual(loaded['party'][0]['combat_progress'], world['party'][0]['combat_progress'])
        self.assertEqual(loaded['inventory'], [])
        self.assertEqual(encode_native_save(decode_native_save(raw)), raw)

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
