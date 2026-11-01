"""Read supplied original saves without editing them or launching GAME.exe."""
from pathlib import Path
import json
import struct
import sys
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME))
from native_save import decode_native_save, encode_native_save, complete_layout, resources


class NativeSourceTests(unittest.TestCase):
    def test_supplied_samples_restore_actual_progress_and_healthy_sources_are_lossless(self):
        healthy = 0
        names = {int(key): value['name'] for key, value in resources()[2].items()}
        for index in range(3):
            with self.subTest(slot=index):
                raw = (ROOT / f'SaveGame{index}.Dat').read_bytes()
                layout = complete_layout(raw, names)
                sections = {row['section']: row for row in layout['sections'] if row['section'] != 'role'}
                envelope = decode_native_save(raw)
                world = json.loads(envelope['payload'])
                self.assertEqual(world['location']['map_id'], raw[0x39:0x4D].split(b'\0')[0].decode('ascii').upper().removesuffix('.DAT'))
                self.assertEqual(len(world['inventory']), sections['inventory']['count'])
                self.assertEqual(sum(map(len, world['event_records'])), sections['events']['event_total'])
                expected_party = [f'{role["role_index"] + 1:03}' for role in layout['characters'] if role['state_byte']]
                self.assertEqual([role['id'] for role in world['party']], expected_party)
                # The user may replace slot0 while testing. Only genuine healthy
                # native records carry the identities consumed by GAME.exe.
                named = [role for role in layout['characters'] if role['name']]
                if all(struct.unpack_from('<I', raw, role['header_offset'] + 0x2FF)[0] == role['role_index'] + 1 for role in named):
                    healthy += 1
                    self.assertEqual(encode_native_save(envelope), raw)
        self.assertGreater(healthy, 0, '至少需要一份角色身份完整的原版样本进行无损检查')


if __name__ == '__main__':
    unittest.main()
