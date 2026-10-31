"""Read supplied original saves without editing them or launching GAME.exe."""
from pathlib import Path
import json
import sys
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME))
from native_save import decode_native_save, encode_native_save


class NativeSourceTests(unittest.TestCase):
    def test_all_three_original_samples_are_lossless_and_restore_different_progress(self):
        expected = [('M01060', 20, 344, ['001', '002']),
                    ('M17010', 169, 2955, ['001', '002', '003']),
                    ('M17010', 0, 71, ['001', '002'])]
        for index, (map_id, bag, events, party) in enumerate(expected):
            with self.subTest(slot=index):
                raw = (ROOT / f'SaveGame{index}.Dat').read_bytes()
                envelope = decode_native_save(raw)
                world = json.loads(envelope['payload'])
                self.assertEqual(world['location']['map_id'], map_id)
                self.assertEqual(len(world['inventory']), bag)
                self.assertEqual(sum(map(len, world['event_records'])), events)
                self.assertEqual([role['id'] for role in world['party']], party)
                self.assertEqual(encode_native_save(envelope), raw)


if __name__ == '__main__':
    unittest.main()
