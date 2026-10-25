"""Cursor heights are source fields, independent of roster order or sprite anchors."""
from pathlib import Path
import json
import hashlib
import struct
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]


class BattleCursorExportTests(unittest.TestCase):
    def test_packed_role_manifests_include_current_cursor_heights(self):
        packs = json.loads((RUNTIME / 'web/data/battle_packs.json').read_text('utf-8'))
        for path, entry in packs['manifests'].items():
            if entry['value'].get('schema') != 'seventh-seal-battle-view':
                continue
            with self.subTest(manifest=path):
                raw = (RUNTIME / 'web' / path.lstrip('/')).read_bytes()
                self.assertEqual(entry['sha256'], hashlib.sha256(raw).hexdigest())
                current = json.loads(raw)
                self.assertEqual(entry['value'], current)
                self.assertTrue(all('cursor_height_raw' in role for role in current['roles']))

    def test_all_view_heights_match_original_dgp_bytes(self):
        for name in ('battle_view', 'forest_battle_view', 'forest_full_battle_view',
                     'enemy_battle_view', 'party_battle_view'):
            meta = json.loads((RUNTIME / f'web/data/{name}.json').read_text('utf-8'))
            for role in meta['roles']:
                with self.subTest(view=name, role=role['id']):
                    raw = (ROOT / f"Fight_Role/{role['id']}.dgp").read_bytes()
                    # Independently seek past the source action table and geometry.
                    extra = 0x43 + raw[2] * (0xac if raw[0] == 9 else 0x90) + 0x2a
                    self.assertEqual(role['cursor_height_raw'], struct.unpack_from('<i', raw, extra + 12)[0])


if __name__ == '__main__':
    unittest.main()
