"""Independent immutable-byte raster audit; every output stays in a temp tree."""
from pathlib import Path
import hashlib
import json
import struct
import sys
import tempfile
import unittest
import shutil
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
from PIL import Image
import export_map_effects as exporter
from source.dgp import DGP, DGPError
from source.map_objects import MapObjects


class FileRaster:
    """Locate sparse rows without DGP/SourceAudit or export decoder helpers."""
    def __init__(self, data):
        self.data = data
        assert data[0] == 9
        geometry = 67 + data[2] * 172
        self.width, self.height, self.count = struct.unpack_from('<HHI', data, geometry)
        self.payload, size = struct.unpack_from('<II', data, geometry + 32)
        extra = geometry + 42
        position = extra + 48 + data[geometry + 13] * 18
        self.frames = [struct.unpack_from('<5I', data, position + i * 20)[3:]
                       for i in range(self.count)]
        position += self.count * 20
        volume = struct.unpack_from('<III', data, extra)
        if all(volume):
            position += volume[0] * volume[1] * volume[2]
        if data[5]:
            position += self.width * self.height * self.count
        if data[6]:
            for _ in range(self.count):
                count, = struct.unpack_from('<I', data, position)
                position += 4 + count * 8
        if data[geometry + 41]:
            for _ in range(self.count):
                count, = struct.unpack_from('<I', data, position)
                position += 4 + count
        self.indexed = []
        if data[19]:
            for _ in range(self.count):
                active = data[position]
                position += 1
                entry = None
                if active:
                    count, = struct.unpack_from('<I', data, position)
                    entry = (position + 772, count, data[position + 4:position + 772])
                    position += 772 + count
                self.indexed.append(entry)
        assert position == self.payload
        assert sum(length for _, length in self.frames) == size
        assert len(data) == self.payload + size * (1 if data[21] else 2)

    def pixels(self, index, intrinsic=False):
        rgba = bytearray(self.width * self.height * 4)
        if intrinsic:
            entry = self.indexed[index] if self.indexed else None
            if entry is None:
                return bytes(rgba)
            position, size, palette = entry
        else:
            offset, size = self.frames[index]
            position, palette = self.payload + offset, None
        end = position + size
        for y in range(self.height):
            spans, = struct.unpack_from('<H', self.data, position)
            position += 2
            if spans == 65535:
                continue
            previous = 0
            for _ in range(spans):
                x, length = struct.unpack_from('<HH', self.data, position)
                position += 4
                assert x >= previous and x + length <= self.width
                previous = x + length
                for dx in range(length):
                    if intrinsic:
                        offset = self.data[position] * 3
                        position += 1
                        color = [palette[offset] & 248, palette[offset + 1] & 252,
                                 palette[offset + 2] & 248, 255]
                    else:
                        pixel, = struct.unpack_from('<H', self.data, position)
                        position += 2
                        r, g, b = pixel >> 11, pixel // 32 % 64, pixel % 32
                        color = [r * 8 + r // 4, g * 4 + g // 16, b * 8 + b // 4, 255]
                    dest = ((y * self.width) + x + dx) * 4
                    assert rgba[dest + 3] == 0
                    rgba[dest:dest + 4] = bytes(color)
        assert position == end
        return bytes(rgba)


class CF1MapPixels(unittest.TestCase):
    def test_complete_export_entry_covers_all_registered_cf1_objects_without_writing_live_assets_or_evidence(self):
        observed = [RUNTIME / 'web/data/map_effects.json', RUNTIME / 'evidence/map_effects_20261021/export.json']
        before = [path.read_bytes() for path in observed]
        with tempfile.TemporaryDirectory() as folder:
            runtime = Path(folder)
            web = runtime / 'web'
            shutil.copytree(RUNTIME / 'web/data/maps', web / 'data/maps')
            for name in ['opening_map_resources.json', 'chapter_map_resources.json']:
                shutil.copyfile(RUNTIME / 'web/data' / name, web / 'data' / name)
            evidence = runtime / 'evidence/fire_valley_20261025'
            evidence.mkdir(parents=True)
            for name in ['object_queue.json', 'object_queue_assembly.json', 'object_tick_4137c0_assembly.json']:
                shutil.copyfile(RUNTIME / 'evidence/fire_valley_20261025' / name, evidence / name)
            with patch.object(exporter, 'RUNTIME', runtime), patch.object(exporter, 'WEB', web), \
                 patch('export_map_shadows.export'):
                exporter.export()
            manifest = json.loads((web / 'data/map_effects.json').read_text('utf-8'))
            report = json.loads((runtime / 'evidence/map_effects_20261021/export.json').read_text('utf-8'))
            regional = {key: value for key, value in manifest['maps'].items() if key.startswith('M17')}
            self.assertEqual(sum(len(row['objects']) for row in regional.values()), 32)
            # Keep the established region/baseline scope intact. The minimal
            # M01050 caller and outer forest scenery have their own source sets.
            baseline_maps = {'M01010', 'M01030'} | set(regional)
            self.assertEqual(sum(obj['behavior_raw_cf'] == 1
                                 for map_id, row in manifest['maps'].items() if map_id in baseline_maps
                                 for obj in row['objects']), 56)
            city = manifest['maps']['M01050']['objects']
            table = MapObjects(ROOT / 'Map/m01050.dat')
            expected = []
            for obj in table.objects:
                raw = bytes.fromhex(obj['raw_hex'])
                source = ROOT / table.resource_source(struct.unpack_from('<I', raw, 0x1e)[0])
                if raw[0xcf] == 1 and source.read_bytes()[2]:
                    expected.append(obj['index'])
            self.assertEqual(expected, list(range(9, 22)))
            self.assertEqual([obj['index'] for obj in city], expected)
            city_banks = {obj['bank'] for obj in city}
            self.assertEqual({manifest['object_banks'][key]['source']['path'] for key in city_banks},
                             {'mapm/m01050/010.dgp', 'mapm/m01050/011.dgp'})
            for obj in city:
                original = table.objects[obj['index']]
                self.assertEqual(obj['source_record_raw_hex'], original['raw_hex'])
                self.assertEqual(obj['source_record_offset'], original['offset'])
                self.assertEqual(obj['map_id'], 'M01050')
                self.assertEqual(obj['behavior_raw_cf'], 1)
            # Independently rasterize all four added physical frames, including
            # their transparent intrinsic streams, rather than raising a total.
            added_frames = 0
            for key in city_banks:
                bank = manifest['object_banks'][key]
                source = ROOT / bank['source']['path']
                self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), bank['source']['sha256'])
                raster = FileRaster(source.read_bytes())
                self.assertEqual(raster.count, 2)
                self.assertEqual(len(bank['actions']), 1)
                action = bank['actions'][0]
                self.assertEqual((action['first_frame'], action['frame_count'], action['directions']), (0, 2, 1))
                for channel in ['main', 'intrinsic']:
                    atlas = Image.open(web / action[channel + '_sheet'].lstrip('/')).convert('RGBA')
                    self.assertEqual(atlas.size, (raster.width * raster.count, raster.height))
                    for frame in range(raster.count):
                        actual = atlas.crop((frame * raster.width, 0,
                                             (frame + 1) * raster.width, raster.height)).tobytes()
                        self.assertEqual(actual, raster.pixels(frame, intrinsic=channel == 'intrinsic'))
                added_frames += raster.count
            legacy_sources = {bank['source']['path'] for bank in manifest['roles'].values()}
            legacy_sources.update(manifest['object_banks'][obj['bank']]['source']['path']
                                  for obj in manifest['maps']['M70010']['objects'])
            self.assertEqual(sum(row['source'] in legacy_sources for row in report['frame_checks']), 147)
            city_checks = [row for row in report['cf1_frame_checks'] if row['source'].startswith('mapm/m01050/')]
            baseline_cf1_sources = {manifest['object_banks'][obj['bank']]['source']['path']
                                    for map_id in baseline_maps for obj in manifest['maps'][map_id]['objects']
                                    if obj['behavior_raw_cf'] == 1}
            baseline_checks = [row for row in report['cf1_frame_checks'] if row['source'] in baseline_cf1_sources]
            self.assertEqual(len(baseline_checks), 120)
            self.assertEqual(len(city_checks), added_frames)
            self.assertEqual(added_frames, 4)
            # Verify every one of the 39 new placements against its actual DAT
            # entry, then rasterize both channels of all four source banks.
            # These are separate from the retained 56-object/120-frame baseline.
            forest_counts = {'M70010': 0, 'M70020': 0, 'M70030': 9,
                             'M70040': 13, 'M70050': 5, 'M70060': 12}
            forest_banks = set()
            for map_id, count in forest_counts.items():
                table = MapObjects(ROOT / f'Map/{map_id.lower()}.dat')
                expected = []
                for obj in table.objects:
                    raw = bytes.fromhex(obj['raw_hex'])
                    relative = table.resource_source(struct.unpack_from('<I', raw, 0x1e)[0])
                    if raw[0xcf] == 1 and (ROOT / relative).read_bytes()[2]:
                        expected.append(obj['index'])
                actual = [obj for obj in manifest['maps'][map_id]['objects'] if obj['behavior_raw_cf'] == 1]
                self.assertEqual(len(expected), count, map_id)
                self.assertEqual([obj['index'] for obj in actual], expected, map_id)
                for obj in actual:
                    original = table.objects[obj['index']]
                    self.assertEqual(obj['source_record_raw_hex'], original['raw_hex'])
                    self.assertEqual(obj['source_record_offset'], original['offset'])
                    self.assertEqual(obj['map_id'], map_id)
                    raw = bytes.fromhex(original['raw_hex'])
                    self.assertEqual(manifest['object_banks'][obj['bank']]['source']['path'],
                                     table.resource_source(struct.unpack_from('<I', raw, 0x1e)[0]))
                    forest_banks.add(obj['bank'])
            self.assertEqual(sum(forest_counts.values()), 39)
            forest_sources = {manifest['object_banks'][key]['source']['path'] for key in forest_banks}
            self.assertEqual(forest_sources, {'mapm/m70030/015.dgp', 'mapm/m70040/016.dgp',
                                             'mapm/m70050/013.dgp', 'mapm/m70060/017.dgp'})
            forest_frames = 0
            for key in forest_banks:
                bank = manifest['object_banks'][key]
                source = ROOT / bank['source']['path']
                before_source = source.read_bytes()
                self.assertEqual(hashlib.sha256(before_source).hexdigest(), bank['source']['sha256'])
                raster = FileRaster(before_source)
                self.assertEqual(raster.count, 2)
                self.assertEqual(len(bank['actions']), 1)
                action = bank['actions'][0]
                self.assertEqual(action['source_action_raw_hex'], before_source[67:239].hex())
                self.assertEqual((action['first_frame'], action['frame_count'], action['directions']), (0, 2, 1))
                checks = [row for row in report['cf1_frame_checks'] if row['source'] == bank['source']['path']]
                self.assertEqual([row['frame'] for row in checks], [0, 1])
                for channel in ['main', 'intrinsic']:
                    atlas = Image.open(web / action[channel + '_sheet'].lstrip('/')).convert('RGBA')
                    self.assertEqual(atlas.size, (raster.width * raster.count, raster.height))
                    for frame in range(raster.count):
                        expected = raster.pixels(frame, intrinsic=channel == 'intrinsic')
                        actual = atlas.crop((frame * raster.width, 0,
                                             (frame + 1) * raster.width, raster.height)).tobytes()
                        self.assertEqual(actual, expected, (bank['source']['path'], frame, channel))
                        self.assertEqual(checks[frame][channel]['covered_pixels'],
                                         sum(bool(expected[i]) for i in range(3, len(expected), 4)))
                        if channel == 'main':
                            self.assertEqual(checks[frame][channel]['rgba_sha256'], hashlib.sha256(expected).hexdigest())
                forest_frames += raster.count
                self.assertEqual(source.read_bytes(), before_source)
            self.assertEqual(forest_frames, 8)
            forest_checks = [row for row in report['cf1_frame_checks'] if row['source'] in forest_sources]
            self.assertEqual(len(forest_checks), forest_frames)
            self.assertEqual(len(report['cf1_frame_checks']), len(baseline_checks) + len(city_checks) + len(forest_checks))
            self.assertNotIn('M17030', manifest['maps'], 'the zero-action static crystal is not animated/collectable')
            for map_id, data in regional.items():
                for row in data['objects']:
                    self.assertEqual(row['map_id'], map_id)
                    self.assertEqual(len(bytes.fromhex(row['source_record_raw_hex'])), 274)
                    self.assertEqual(row['fixed_clock_raw_b4'], 0)
                    self.assertEqual(row['behavior_raw_cf'], 1)
                    bank = manifest['object_banks'][row['bank']]
                    for action in bank['actions']:
                        self.assertTrue((web / action['main_sheet'].lstrip('/')).is_file())
                        self.assertTrue((web / action['intrinsic_sheet'].lstrip('/')).is_file())
        self.assertEqual([path.read_bytes() for path in observed], before)

    def test_all_cf1_source_frames_export_main_without_indexed_stream_and_audit_transparent_intrinsic(self):
        audit = json.loads((RUNTIME / 'evidence/fire_valley_20261025/object_closure_audit.json').read_text('utf-8'))
        paths = sorted({row['resource'] for row in audit['objects'] if row['cf'] == 1 and row['action_count']})
        self.assertEqual(len(paths), 9)
        frames = visible = 0
        with tempfile.TemporaryDirectory() as folder:
            for index, relative in enumerate(paths):
                path = ROOT / relative
                before = path.read_bytes()
                self.assertEqual(hashlib.sha256(before).hexdigest(), audit['animated_resources'][relative]['sha256'])
                raw = FileRaster(before)
                checks, outputs = [], {}
                bank = exporter.export_bank(DGP(path), relative, f'cf1_{index}', True,
                                            force_main=True, web=folder, checks=checks, outputs=outputs)
                action = bank['actions'][0]
                self.assertEqual(action['source_action_raw_hex'], before[67:239].hex())
                self.assertEqual(len(checks), raw.count)
                expected_hashes = set()
                for channel in ['main', 'intrinsic']:
                    atlas = Image.open(Path(folder) / action[channel + '_sheet'].lstrip('/')).convert('RGBA')
                    self.assertEqual(atlas.size, (raw.width * raw.count, raw.height))
                    for frame in range(raw.count):
                        expected = raw.pixels(frame, intrinsic=channel == 'intrinsic')
                        actual = atlas.crop((frame * raw.width, 0, (frame + 1) * raw.width, raw.height)).tobytes()
                        self.assertEqual(actual, expected, (relative, frame, channel))
                        self.assertEqual(checks[frame][channel]['covered_pixels'],
                                         sum(bool(expected[i]) for i in range(3, len(expected), 4)))
                        if channel == 'main':
                            expected_hashes.add(hashlib.sha256(expected).hexdigest())
                        else:
                            self.assertEqual(actual, bytes(len(actual)), 'actual CF1 files have no indexed stream')
                frames += raw.count
                visible += len(expected_hashes) > 1
                self.assertEqual(path.read_bytes(), before)
        self.assertEqual((frames, visible), (66, 5))

    def test_legacy_147_pixel_baseline_stays_identical_in_isolated_export(self):
        manifest = json.loads((RUNTIME / 'web/data/map_effects.json').read_text('utf-8'))
        legacy = [(f'role_{key}', bank, False) for key, bank in manifest['roles'].items()]
        legacy += [(row['bank'], manifest['object_banks'][row['bank']], True)
                   for row in manifest['maps']['M70010']['objects']]
        checks = []
        with tempfile.TemporaryDirectory() as folder:
            for key, source, main in legacy:
                path = ROOT / source['source']['path']
                raw = FileRaster(path.read_bytes())
                bank = exporter.export_bank(DGP(path), source['source']['path'], key, main, web=folder, checks=checks)
                for action in bank['actions']:
                    for channel in (['main', 'intrinsic'] if main else ['intrinsic']):
                        relative = action[channel + '_sheet'].lstrip('/')
                        self.assertEqual((Path(folder) / relative).read_bytes(), (RUNTIME / 'web' / relative).read_bytes())
                        atlas = Image.open(Path(folder) / relative).convert('RGBA')
                        for direction in range(action['directions']):
                            for frame in range(action['frame_count']):
                                physical = action['first_frame'] + direction * action['frame_count'] + frame
                                self.assertEqual(atlas.crop((frame * raw.width, direction * raw.height,
                                    (frame + 1) * raw.width, (direction + 1) * raw.height)).tobytes(),
                                    raw.pixels(physical, intrinsic=channel == 'intrinsic'))
        self.assertEqual(len(checks), 147, 'keep all original pixel assertions, excluding new CF1 coverage')

    def test_unsupported_cf1_shape_is_rejected_before_output(self):
        path = ROOT / 'mapm/m17023/004.dgp'
        for offset, value in [(0, 1), (13, 0), (1, 1), (0x56, 65), (0x84, 1), (0x72, 1)]:
            dgp = DGP(path)
            changed = bytearray(dgp.raw_actions[0])
            changed[offset] = value
            dgp.raw_actions[0] = bytes(changed)
            with tempfile.TemporaryDirectory() as folder:
                with self.assertRaises(DGPError):
                    exporter.export_bank(dgp, 'mapm/m17023/004.dgp', 'invalid', True, force_main=True, web=folder)
                self.assertEqual(list(Path(folder).rglob('*')), [])
        dgp = DGP(path)
        dgp.raw_actions.append(dgp.raw_actions[0])
        with self.assertRaises(DGPError):
            exporter.validate_cf1_action(dgp)


if __name__ == '__main__':
    unittest.main()
