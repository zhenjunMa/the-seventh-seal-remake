"""Independent original-byte CF2 volume and main-atlas audit in a temp tree."""
from pathlib import Path
import hashlib
import json
import struct
import sys
import tempfile
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
from PIL import Image
import export_map_effects as exporter
from source.dgp import DGP
from test_cf1_map_effect_pixels import FileRaster


class CF2TerrainTests(unittest.TestCase):
    def test_vine_and_gate_keep_exact_sparse_physical_frame_terrain_and_all_main_pixels(self):
        for map_id, index, resource_id, origin, counts, values in (
                ('M72050', 11, 7, (53, 33), [25] * 20, [1] * 19 + [2]),
                ('M72061', 0, 1, (30, 25), [0] + [25] * 19, [0] + [2] * 19)):
            with self.subTest(map=map_id), tempfile.TemporaryDirectory() as temporary:
                dat_path = ROOT / f'Map/{map_id.lower()}.dat'
                dat = dat_path.read_bytes()
                width, height = struct.unpack_from('<II', dat, 0x146)
                descriptor_size = 0x42 if struct.unpack_from('<I', dat, 0x18)[0] == 1 else 0x2b
                object_start = 0x172 + width * height * 64 + 32 * (0x2a + descriptor_size + 0x1b + 0x110)
                obj = dat[object_start + index * 0x112:object_start + (index + 1) * 0x112]
                self.assertEqual(obj[0xcf], 2)
                self.assertEqual(struct.unpack_from('<I', obj, 0x1e)[0], resource_id)
                shift = dat[0x142] or 3
                self.assertEqual(tuple(value >> shift for value in struct.unpack_from('<2i', obj, 0x26)), origin)
                base = dat[0x14e:0x16e].split(b'\0')[0].decode('ascii').replace('\\', '/').removeprefix('./').rstrip('/').lower()
                relative = f'{base}/{resource_id:03}.dgp'
                path = ROOT / relative
                original = path.read_bytes()
                self.assertEqual(original[0], 9)
                geometry = 67 + original[2] * 172
                extra = geometry + 42
                frame_count, = struct.unpack_from('<I', original, geometry + 4)
                volume_count, volume_width, volume_height = struct.unpack_from('<3I', original, extra)
                self.assertEqual((volume_count, volume_width, volume_height), (frame_count, 5, 5))
                offset = extra + 48 + original[geometry + 13] * 18 + frame_count * 20
                volume = original[offset:offset + volume_count * volume_width * volume_height]
                expected = []
                for frame in range(frame_count):
                    frame_bytes = volume[frame * 25:(frame + 1) * 25]
                    expected.append([[cell % 5, cell // 5, value]
                                     for cell, value in enumerate(frame_bytes) if value])
                    self.assertEqual(set(frame_bytes), {values[frame]})
                checks = []
                bank = exporter.export_bank(DGP(path), relative, map_id.lower(), True,
                    force_main=True, behavior_raw_cf=2, web=temporary, checks=checks)
                self.assertEqual(bank['terrain_frames'], expected)
                self.assertEqual([len(frame) for frame in bank['terrain_frames']], counts)
                self.assertEqual((bank['terrain_width_cells'], bank['terrain_height_cells']), (5, 5))
                self.assertEqual(bank['source'], dict(path=relative, sha256=hashlib.sha256(original).hexdigest()))
                self.assertEqual(bank['terrain_source'], dict(offset=offset, bytes=len(volume),
                    sha256=hashlib.sha256(volume).hexdigest(), extra_header_raw_hex=original[extra:extra + 48].hex(),
                    evidence=exporter.TERRAIN_EVIDENCE))
                raster = FileRaster(original)
                action = bank['actions'][0]
                self.assertEqual(action['logical_frames'], list(range(20)))
                atlas = Image.open(Path(temporary) / action['main_sheet'].lstrip('/')).convert('RGBA')
                self.assertEqual(len(checks), 20)
                for frame in range(frame_count):
                    actual = atlas.crop((frame * raster.width, 0,
                                         (frame + 1) * raster.width, raster.height)).tobytes()
                    pixels = raster.pixels(frame)
                    self.assertEqual(actual, pixels, (relative, frame))
                    self.assertEqual(checks[frame]['main']['rgba_sha256'], hashlib.sha256(pixels).hexdigest())
                self.assertEqual(path.read_bytes(), original)
                self.assertEqual(dat_path.read_bytes(), dat)

    def test_all_three_ff_switch_resources_have_no_collision_volume(self):
        for relative in ['mapm/m72040/020.dgp', 'mapm/m72040-1/017.dgp', 'mapm/m72050/006.dgp']:
            with self.subTest(source=relative), tempfile.TemporaryDirectory() as temporary:
                path = ROOT / relative
                original = path.read_bytes()
                extra = 67 + original[2] * 172 + 42
                self.assertEqual(struct.unpack_from('<3I', original, extra), (0, 1, 1))
                bank = exporter.export_bank(DGP(path), relative, Path(relative).parent.name, True,
                    behavior_raw_cf=9, web=temporary)
                self.assertEqual(len(bank['actions']), 3)
                self.assertNotIn('terrain_frames', bank)
                self.assertEqual(path.read_bytes(), original)

    def test_terrain_rules_retain_matching_native_executable_evidence(self):
        bundle = json.loads((RUNTIME / 'evidence/inner_white_forest_20261029/native_objects_bundle.json').read_text('utf-8'))
        record = next(row for row in bundle['records'] if row['evidence_id'] == exporter.TERRAIN_EVIDENCE)
        self.assertEqual(record['subject']['digest']['sha256'], hashlib.sha256((ROOT / 'GAME.exe').read_bytes()).hexdigest())
        function = next(row for row in record['normalized_result']['items'] if row['address'].lower() == '0x411420')
        self.assertEqual(function['status'], 'ok')
        self.assertIn("== '\\x02'", function['pseudocode'])
        self.assertIn('+ 0x20 +', function['pseudocode'])
        self.assertIn('+ 0x14 +', function['pseudocode'])


if __name__ == '__main__':
    unittest.main()
