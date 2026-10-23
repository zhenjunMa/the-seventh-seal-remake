"""Independent full-PNG checks against the separate raw indexed crosscheck.

The pixel test deliberately uses neither DGP nor the exporter decoder: source
offsets and dimensions come from an independent bounded-file assessment.
"""
import hashlib
import json
from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime/tools"))
from PIL import Image
from source.combat_resources import CHR, ROOT, PROJECT

WEB = PROJECT / 'web'
EVIDENCE = PROJECT / 'evidence/source'


def digest(data):
    return hashlib.sha256(data).hexdigest()


class PresentationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((WEB / 'data/source/combat_presentation.json').read_text('utf8'))
        cls.crosscheck = json.loads((EVIDENCE / 'effect_indexed_crosscheck_20261011.json').read_text('utf8'))
        cls.verification = json.loads((EVIDENCE / 'combat_presentation_verification_20261011.json').read_text('utf8'))

    def test_all_indexed_pixels_and_sparse_holes(self):
        checked = covered = 0
        for asset in self.manifest['assets']:
            assessment = next(f for f in self.crosscheck['files'] if f['source'] == asset['source'])
            data = (ROOT / asset['source']).read_bytes()
            self.assertEqual(digest(data), assessment['source_sha256'])
            self.assertEqual(asset['source_sha256'], assessment['source_sha256'])
            self.assertEqual(asset['anchor_raw'], assessment['anchor_raw'])
            self.assertEqual(asset['blend'], 'additive')
            width, height = assessment['width'], assessment['height']
            self.assertEqual(len(asset['actions']), 1)
            action = asset['actions'][0]
            self.assertEqual(action['directions'], 1)
            with Image.open(WEB / action['sheet']) as source:
                sheet = source.convert('RGBA')
            self.assertEqual(sheet.size, (width * assessment['frame_count'], height))
            self.assertEqual(digest((WEB / action['sheet']).read_bytes()), action['sheet_sha256'])
            for frame in assessment['indexed_frames']:
                self.assertTrue(frame['indexed_eof_verified'])
                expected = bytearray(width * height * 4)
                coverage = bytearray(width * height)
                first = frame['indexed_pixels_offset']
                cursor = first
                palette = frame['palette_offset']
                samples = 0
                for y in range(height):
                    count = struct.unpack_from('<H', data, cursor)[0]
                    cursor += 2
                    if count == 65535:
                        continue
                    for _ in range(count):
                        x, size = struct.unpack_from('<HH', data, cursor)
                        cursor += 4
                        self.assertLessEqual(x + size, width)
                        for i in range(size):
                            index = data[cursor + i]
                            rgb = data[palette + index * 3:palette + index * 3 + 3]
                            # The native RGB565 contribution against a black
                            # surface, lifted by channel bit placement only.
                            q = (y * width + x + i) * 4
                            expected[q:q + 4] = bytes((rgb[0] // 8 * 8, rgb[1] // 4 * 4, rgb[2] // 8 * 8, 255))
                            coverage[y * width + x + i] = 1
                        samples += size
                        cursor += size
                self.assertEqual(cursor - first, frame['indexed_pixels_bytes'])
                self.assertEqual(samples, frame['occupied_samples'])
                self.assertEqual(digest(coverage), frame['coverage_mask_sha256'])
                i = frame['frame']
                image = sheet.crop((i * width, 0, (i + 1) * width, height))
                self.assertEqual(image.tobytes(), bytes(expected), (asset['id'], i))
                checked += 1
                covered += samples
        self.assertEqual(checked, 28)
        self.assertEqual(covered, 1157145)

    def test_skill_native_ranges_effect_fields_and_terminal_command(self):
        chr = CHR(ROOT / 'Fight_Role/001.CHR')
        for skill, key, event in zip(self.manifest['skills'], (28, 31, 32), (5, 9, 6), strict=True):
            original = chr.skills[skill['skill_index']]
            self.assertEqual(skill['name'], original['name_cp936'])
            self.assertEqual([s['action_index'] for s in skill['sequence']], [7, 11, 8, key, 9, 12, 10])
            for segment in skill['sequence']:
                raw = bytes.fromhex(original['actions'][segment['chr_record_index']]['raw_hex'])
                self.assertEqual(segment['raw']['raw_hex'], raw.hex())
                start, end = struct.unpack_from('<I', raw, 0x26)[0], struct.unpack_from('<I', raw, 0x2A)[0]
                self.assertEqual(segment['frame_sequence'], list(range(start, end)))
                self.assertTrue(segment['frame_sequence_confirmed'])
                for effect in segment['effects']:
                    offset = int(effect['filename_field'], 16)
                    filename = raw[offset:offset + 20].split(b'\0')[0].decode('ascii')
                    self.assertEqual(effect['asset_id'], Path(filename).stem)
                    self.assertEqual(effect['trigger_frame'], struct.unpack_from('<I', raw, int(effect['event_field'], 16))[0])
            key_segment = skill['sequence'][3]
            self.assertEqual(key_segment['combat_event']['frame'], event)
            self.assertEqual(key_segment['combat_event']['field'], '0x49')
            self.assertEqual(key_segment['effects'][0]['placement'], 'target')
            for i in (2, 6):
                self.assertEqual(skill['sequence'][i]['effects'][0]['asset_id'], '_DutyN')
                self.assertEqual(skill['sequence'][i]['effects'][0]['trigger_frame'], 0)
                self.assertEqual(skill['sequence'][i]['effects'][0]['placement'], 'player')
            terminal = skill['terminal_commands'][0]
            self.assertEqual((terminal['chr_record_index'], terminal['type_raw'], terminal['command_raw']), (7, 1, 11))
            self.assertEqual(skill['target_reaction'], skill['recipe']['target_reaction'])
            self.assertEqual(skill['target_reaction']['action_index'], 1)
            self.assertIsNone(skill['death_action'])

    def test_hashes_and_native_evidence_retained(self):
        for source, expected in self.manifest['source_hashes'].items():
            self.assertEqual(digest((ROOT / source).read_bytes()), expected)
        self.assertEqual(self.verification['source_hashes_before'], self.verification['source_hashes_after'])
        self.assertEqual(digest((WEB / 'data/source/combat_manifest.json').read_bytes()), self.verification['previous_combat_manifest_sha256'])
        bundle = json.loads((EVIDENCE / 'combat_presentation_native_20261011.json').read_text('utf8'))
        records = {r['evidence_id']: r for r in bundle['records']}
        for reference in self.manifest['evidence']['references'].values():
            self.assertIn(reference, records)
        self.assertEqual(self.manifest['schema'], 'seventh-seal-combat-presentation')
        self.assertEqual(self.manifest['version'], 1)


if __name__ == '__main__':
    unittest.main()
