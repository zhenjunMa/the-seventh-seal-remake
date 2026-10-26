"""Bounded, independent raw-DAT/DGP oracle for the six outer White Forest maps.

No exporter or production DGP decoder is imported. The optional --report path
writes only a new evidence report; ordinary unittest execution is read-only.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from functools import lru_cache
from io import BytesIO
import hashlib
import json
from pathlib import Path
import re
import struct
import sys
import unittest

from PIL import Image

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
IDS = ('M70010', 'M70020', 'M70030', 'M70040', 'M70050', 'M70060')
GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'
REPORT = RUNTIME / 'evidence/white_forest_20261026/map_source_validation.json'


def sha(value):
    return hashlib.sha256(value).hexdigest()


def u32(value, offset):
    return struct.unpack_from('<I', value, offset)[0]


def i32(value, offset):
    return struct.unpack_from('<i', value, offset)[0]


def cstring(value):
    return value.split(b'\0')[0].decode('ascii', 'strict')


class FileLedger:
    def __init__(self, root):
        self.root = root
        self.files = {}

    def read(self, name):
        name = str(name).replace('\\', '/').removeprefix('/')
        assert '..' not in name.split('/') and not Path(name).is_absolute()
        key = name.lower()
        if key not in self.files:
            path = self.root / name
            value = path.read_bytes()
            self.files[key] = {'path': name, 'bytes': value, 'sha256': sha(value)}
        return self.files[key]['bytes']

    def checked_rows(self):
        rows = []
        for row in self.files.values():
            assert sha((self.root / row['path']).read_bytes()) == row['sha256'], row['path']
            rows.append({'path': row['path'], 'sha256': row['sha256'], 'bytes': len(row['bytes']), 'unchanged': True})
        return sorted(rows, key=lambda row: row['path'].lower())


class RawDat:
    """Explicit offsets, including both source descriptor record widths."""
    def __init__(self, name, files):
        self.name = name
        self.path = f'Map/{name.lower()}.dat'
        self.raw = files.read(self.path)
        b = self.raw
        assert len(b) >= 0x172 and u32(b, 0x14) == 6 and b[0x88] == 1
        self.width, self.height = struct.unpack_from('<II', b, 0x146)
        assert self.width > 0 and self.height > 0 and b[0x145] == 1
        self.grid_end = 0x172 + self.width * self.height * 64
        self.descriptor_bytes = 0x42 if u32(b, 0x18) == 1 else 0x2B
        self.descriptor_start = self.grid_end + 32 * 0x2A
        self.object_start = self.descriptor_start + 32 * (self.descriptor_bytes + 0x1B + 0x110)
        self.object_count = u32(b, 0x82)
        self.object_end = self.object_start + self.object_count * 0x112
        assert self.object_end <= len(b)
        self.refs = defaultdict(list)
        self.markers = defaultdict(list)
        for y in range(self.height):
            for x in range(self.width):
                offset = self.cell_offset(x, y)
                ident = u32(b, offset + 0x38)
                if ident:
                    assert 1 <= ident <= 32
                    self.refs[ident].append({'x': x, 'y': y})
                marker = b[offset + 0x21]
                if marker:
                    self.markers[marker].append({'x': x, 'y': y, 'offset': offset})
        self.descriptors = {}
        for ident in range(1, 33):
            offset = self.descriptor_start + (ident - 1) * self.descriptor_bytes
            raw = b[offset:offset + self.descriptor_bytes]
            assert len(raw) == self.descriptor_bytes
            fields = list(raw[0x26:0x29]) if self.descriptor_bytes == 0x2B else [u32(raw, at) for at in (0x26, 0x2A, 0x2E)]
            self.descriptors[ident] = {'id': ident, 'offset': offset, 'bytes': self.descriptor_bytes,
                'state_raw': raw[0], 'filename_raw': cstring(raw[0x11:0x26]),
                'field_26_raw': fields[0], 'field_2a_raw': fields[1], 'field_2e_raw': fields[2],
                'descriptor_hex': raw.hex(), 'cells': self.refs.get(ident, []),
                'path_gate': raw[0] == 0 and raw[0x11] != 0}

    def cell_offset(self, x, y):
        return 0x172 + (y * self.width + x) * 64


class RawDgp:
    """Independent geometry/optional-block parser and RGB565 sparse-row reader."""
    def __init__(self, path, files):
        self.path = path
        self.raw = b = files.read(path)
        assert b[0] in (8, 9)
        self.version = b[0]
        at = 0x43 + b[2] * (0xAC if b[0] == 9 else 0x90)
        self.geometry = g = b[at:at + 0x2A]
        self.extra = b[at + 0x2A:at + 0x2A + 0x30]
        assert len(g) == 0x2A and len(self.extra) == 0x30
        self.width, self.height = struct.unpack_from('<HH', g)
        self.count = u32(g, 4)
        assert 0 < self.width <= 8192 and 0 < self.height <= 8192 and 0 < self.count <= 100000
        cursor = at + 0x2A + 0x30 + g[13] * 18
        self.frames = [struct.unpack_from('<5I', b, cursor + index * 20) for index in range(self.count)]
        cursor += self.count * 20

        def take(size):
            nonlocal cursor
            assert size >= 0 and cursor + size <= len(b), (path, cursor, size)
            value = b[cursor:cursor + size]
            cursor += size
            return value

        volume = [u32(self.extra, pos) for pos in (0, 4, 8)]
        if all(volume):
            take(volume[0] * volume[1] * volume[2])
        if b[5]:
            take(self.width * self.height * self.count)
        if b[6]:
            for _ in self.frames:
                take(u32(take(4), 0) * 8)
        if g[41]:
            for _ in self.frames:
                take(u32(take(4), 0))
        if b[19]:
            for _ in self.frames:
                if take(1)[0]:
                    size = u32(take(4), 0)
                    take(0x300)
                    take(size)
        self.payload_start, self.payload_bytes = u32(g, 32), u32(g, 36)
        assert cursor == self.payload_start, (path, cursor, self.payload_start)
        expected = 0
        for _, _, _, offset, size in self.frames:
            assert offset == expected
            expected += size
        assert expected == self.payload_bytes
        take(self.payload_bytes * (1 if b[21] else 2))
        assert cursor == len(b), (path, cursor, len(b))
        self.cache = {}
        self.retained_rows = {}

    def frame(self, index):
        assert 0 <= index < self.count
        if index in self.cache:
            return self.cache[index]
        _, _, _, offset, size = self.frames[index]
        raw = self.raw[self.payload_start + offset:self.payload_start + offset + size]
        rgba = bytearray(self.width * self.height * 4)
        cursor = y = 0
        while y < self.height or cursor < len(raw):
            assert y < 8192 and cursor + 2 <= len(raw)
            count = struct.unpack_from('<H', raw, cursor)[0]
            cursor += 2
            last_x = 0
            if count != 0xFFFF:
                assert count <= self.width
                for _ in range(count):
                    assert cursor + 4 <= len(raw)
                    x, length = struct.unpack_from('<HH', raw, cursor)
                    cursor += 4
                    assert last_x <= x <= x + length <= self.width
                    end = cursor + length * 2
                    assert end <= len(raw)
                    if y < self.height:
                        output = b''.join(RGB565[value] for (value,) in struct.iter_unpack('<H', raw[cursor:end]))
                        at = (y * self.width + x) * 4
                        rgba[at:at + len(output)] = output
                    last_x, cursor = x + length, end
            y += 1
        assert cursor == len(raw)
        self.retained_rows[index] = y - self.height
        result = Image.frombytes('RGBA', (self.width, self.height), bytes(rgba))
        self.cache[index] = result
        return result


RGB565 = tuple(bytes((((v >> 11) << 3) | ((v >> 11) >> 2),
                       (((v >> 5) & 63) << 2) | (((v >> 5) & 63) >> 4),
                       ((v & 31) << 3) | ((v & 31) >> 2), 255)) for v in range(65536))


@lru_cache(maxsize=1)
def verify_sources():
    source, outputs = FileLedger(ROOT), FileLedger(WEB)
    assert sha(source.read('GAME.exe')) == GAME_SHA
    raw_maps = {ident: RawDat(ident, source) for ident in IDS}
    maps = {ident: json.loads(outputs.read(f'data/maps/{ident.lower()}.json')) for ident in IDS}
    resources = json.loads(outputs.read('data/chapter_map_resources.json'))
    story = json.loads(outputs.read('data/chapter_story.json'))
    source_index = json.loads(outputs.read('data/library/white_forest.json'))
    dgps = {}

    def dgp(path):
        if path.lower() not in dgps:
            dgps[path.lower()] = RawDgp(path, source)
        return dgps[path.lower()]

    def png(path):
        assert path.startswith('/') and '..' not in path.split('/')
        return Image.open(BytesIO(outputs.read(path))).convert('RGBA')

    checks, edges = [], []
    for ident in IDS:
        raw_map, exported = raw_maps[ident], maps[ident]
        b, w, h = raw_map.raw, raw_map.width, raw_map.height
        assert exported['id'] == ident
        assert exported['source']['path'].lower() == raw_map.path.lower()
        assert exported['source']['sha256'] == sha(b) == source_index['maps'][ident]['source']['sha256']
        assert exported['source']['bytes'] == len(b)
        assert (exported['width'], exported['height']) == (w * 16, h * 16)
        movement = exported['movement']
        assert (movement['width'], movement['height'], movement['cell_size']) == (w, h, 16)
        triggers = {(row['x'], row['y']): row for row in movement['triggers']}
        assert len(triggers) == len(movement['triggers'])
        expected_refs = 0
        for y in range(h):
            assert len(movement['terrain_rows'][y]) == w
            for x in range(w):
                offset = raw_map.cell_offset(x, y)
                assert movement['terrain_rows'][y][x] == str(b[offset + 0x20])
                ref = u32(b, offset + 0x38)
                assert bool(ref) == ((x, y) in triggers)
                if ref:
                    expected_refs += 1
                    row, descriptor = triggers[x, y], raw_map.descriptors[ref]
                    for field in ('id', 'state_raw', 'path_gate', 'descriptor_hex'):
                        assert row[field] == descriptor[field], (ident, x, y, field)
        for row in resources['trigger_regions'].get(ident, []):
            expected = raw_map.descriptors[row['id']]
            for field in ('id', 'offset', 'bytes', 'state_raw', 'filename_raw', 'field_26_raw', 'field_2a_raw', 'field_2e_raw', 'descriptor_hex', 'cells'):
                assert row[field] == expected[field], (ident, row['id'], field)
        for row in story['maps'][ident].get('descriptors', []):
            expected = raw_map.descriptors[row['id']]
            assert row['raw_hex'] == expected['descriptor_hex']
            assert row['source']['offset'] == expected['offset'] and row['source']['sha256'] == sha(b)
            for field in ('state_raw', 'filename_raw', 'field_26_raw', 'field_2a_raw', 'field_2e_raw'):
                assert row[field] == expected[field]

        count = u32(b, 0x96)
        names = [cstring(b[0x9A + i * 20:0x9A + (i + 1) * 20]) for i in range(count)]
        background_dgps = [dgp(name) for name in names]
        assert all((item.width, item.height) == (32, 32) for item in background_dgps)
        assert [row['path'].lower() for row in exported['background']['sources']] == [name.lower() for name in names]
        for row, item in zip(exported['background']['sources'], background_dgps):
            assert row['sha256'] == sha(item.raw)
        background = png(exported['background']['image'])
        assert background.size == (w * 16, h * 16)
        assert exported['background']['image_sha256'] == sha(outputs.read(exported['background']['image']))
        tiles, blank, distinct = 0, 0, set()
        for y in range(0, h, 2):
            for x in range(0, w, 2):
                frame, resource = struct.unpack_from('<ii', b, raw_map.cell_offset(x, y))
                width, height = min(32, (w - x) * 16), min(32, (h - y) * 16)
                actual = background.crop((x * 16, y * 16, x * 16 + width, y * 16 + height))
                if frame == 999999:
                    expected = bytes(width * height * 4)
                    blank += 1
                else:
                    assert 0 <= resource < len(background_dgps)
                    expected = background_dgps[resource].frame(frame).crop((0, 0, width, height)).tobytes()
                    distinct.add((resource, frame))
                assert actual.tobytes() == expected, (ident, x, y, resource, frame)
                tiles += 1
        assert exported['background']['assembly']['referenced_frames'] == len(distinct)
        assert exported['background']['assembly']['empty_blocks'] == blank

        base_raw = cstring(b[0x14E:0x16E])
        base = base_raw.replace('\\', '/').removeprefix('./').removesuffix('/').lower()
        assert re.fullmatch(r'mapm/[a-z0-9_-]+', base)
        # M70010 is still owned by the historical route producer, whose source
        # metadata predates these two optional fields. Every object's actual
        # resource path is checked against the independent header base below.
        for key, value in [('object_resource_base_raw', base_raw), ('object_resource_base', base)]:
            if key in exported['source']:
                assert exported['source'][key] == value
            else:
                assert ident == 'M70010'
        assert exported['source']['object_table_start'] == raw_map.object_start
        assert exported['source']['object_table_end'] == raw_map.object_end
        assert len(exported['objects']) == raw_map.object_count
        object_pixels = 0
        for index, obj in enumerate(exported['objects']):
            at = raw_map.object_start + index * 0x112
            raw = b[at:at + 0x112]
            assert len(raw) == 0x112 and raw[0xB3] == 0 and raw[0xCE] < 4 and raw[0xE2] == 0
            resource_id = i32(raw, 0x1E)
            assert resource_id > 0
            filename = f'{resource_id:03d}.DGP'
            path = f'{base}/{filename.lower()}'
            image = dgp(path)
            frame = i32(raw, 0x3C)
            x, y = i32(raw, 0x26), i32(raw, 0x2A)
            anchor_x, anchor_y = i32(image.extra, 16), i32(image.extra, 20)
            width, height = u32(image.extra, 4), u32(image.extra, 8)
            expected = {'index': index, 'resource_filename': filename, 'source': path, 'resource_sha256': sha(image.raw),
                'initial_frame': frame, 'frame': frame, 'x_native': x, 'y_native': y, 'x_world': x * 2, 'y_world': y * 2,
                'anchor_x': anchor_x, 'anchor_y': anchor_y, 'draw_x': x * 2 - anchor_x, 'draw_y': y * 2 - anchor_y,
                'frame_width': image.width, 'frame_height': image.height, 'width_cells': width, 'height_cells': height,
                'cell_x': x >> 3, 'cell_y': y >> 3, 'kind_raw': raw[0xCE], 'layer': raw[0xCE],
                'sort_x': x * 2 + (width - height) * 32, 'sort_y': y * 2 + (width + height) * 16}
            for key, value in expected.items():
                assert obj[key] == value, (ident, index, key, obj[key], value)
            actual = png(obj['image'])
            assert actual.size == (image.width, image.height)
            assert actual.tobytes() == image.frame(frame).tobytes(), (ident, index, path, frame)
            assert obj['image_sha256'] == sha(outputs.read(obj['image']))
            object_pixels += image.width * image.height

        physical = [row for row in raw_map.descriptors.values() if row['cells'] and row['state_raw'] == 0 and row['filename_raw']]
        actual_exits = resources['exits_by_map'][ident]
        assert len(actual_exits) == len(physical)
        for descriptor in physical:
            target_id = descriptor['filename_raw'].removesuffix('.dat').upper()
            assert target_id in raw_maps, (ident, target_id)
            target = raw_maps[target_id]
            marker, code = descriptor['field_26_raw'], descriptor['field_2a_raw']
            scanned = target.markers[marker][:4]
            assert scanned
            placement, direction = list(scanned), 2
            if code in (2, 6):
                placement.sort(key=lambda cell: -cell['y'])
                direction = 6 + int(code == 6)
            elif code in (3, 7):
                placement.sort(key=lambda cell: cell['x'])
                direction = 4 + int(code == 7)
            elif code in (4, 8):
                placement.sort(key=lambda cell: -cell['x'])
                direction = int(code == 8)
            else:
                assert code in (0, 1, 5)
            cell = placement[0]
            entry = next(row for row in actual_exits if row['id'] == descriptor['id'])
            assert entry['target_map'] == target_id and entry['state'] == 'ready'
            assert entry['cells'] == descriptor['cells'] and entry['conditions'] == []
            for key, value in {'x': cell['x'] * 16, 'y': cell['y'] * 16, 'direction': direction,
                    'cell_x': cell['x'], 'cell_y': cell['y'], 'native_x': cell['x'] << 3, 'native_y': cell['y'] << 3}.items():
                assert entry['entry'][key] == value
            provenance = entry['source']
            assert provenance['descriptor_offset'] == descriptor['offset'] and provenance['descriptor_bytes'] == raw_map.descriptor_bytes
            assert provenance['descriptor_hex'] == descriptor['descriptor_hex']
            assert provenance['sha256'] == sha(b) and provenance['target_sha256'] == sha(target.raw)
            assert provenance['target_entry_marker'] == marker and provenance['entry_sort_code'] == code
            assert provenance['entry_scan_cells'] == scanned
            assert provenance['entry_sorted_cells'] == [{'x': row['x'], 'y': row['y']} for row in placement]
            terrain = target.raw[cell['offset'] + 0x20]
            assert provenance['entry_terrain_raw'] == terrain
            assert provenance['entry_trigger_raw'] == u32(target.raw, cell['offset'] + 0x38)
            # Source 4A5110 does not inspect terrain. The one terrain1 marker
            # must be retained, never moved or rewritten to satisfy this audit.
            assert maps[target_id]['movement']['terrain_rows'][cell['y']][cell['x']] == str(terrain)
            edges.append({'from_map': ident, 'descriptor_id': descriptor['id'], 'descriptor_bytes': raw_map.descriptor_bytes,
                'target_map': target_id, 'marker': marker, 'sort_code': code, 'entry': entry['entry'], 'terrain_raw': terrain,
                'source_cells': len(descriptor['cells']), 'source_sha256': sha(b), 'target_sha256': sha(target.raw)})
        checks.append({'map_id': ident, 'source_sha256': sha(b), 'source_bytes': len(b), 'terrain_cells': w * h,
            'descriptor_bytes': raw_map.descriptor_bytes, 'descriptors_scanned': 32,
            'referenced_descriptors': len(raw_map.refs), 'trigger_cells': expected_refs,
            'background_tiles': tiles, 'background_distinct_source_frames': len(distinct), 'background_pixels': w * h * 256,
            'background_rgba_sha256': sha(background.tobytes()), 'background_empty_tiles': blank,
            'background_resources': names, 'object_resource_base': base, 'object_initial_frames_and_anchors': raw_map.object_count,
            'object_pixels': object_pixels, 'physical_exits': len(physical)})

    # A real compact DAT exercises byte expansion independently. This is a
    # parser regression only; Hellway is not part of the White Forest scope.
    compact = RawDat('Hellway-e01', source)
    assert compact.descriptor_bytes == 0x2B
    compact_expected = [(1, 'Hellway-b01.dat', 1, 2, 0), (2, 'Hellway-i01.dat', 2, 4, 0)]
    compact_checks = []
    for ident, filename, marker, code, extra in compact_expected:
        row = compact.descriptors[ident]
        assert (row['filename_raw'], row['field_26_raw'], row['field_2a_raw'], row['field_2e_raw']) == (filename, marker, code, extra)
        assert row['cells'] and row['bytes'] == 43
        compact_checks.append({'id': ident, 'filename': filename, 'marker': marker, 'sort_code': code,
            'extra': extra, 'raw_hex': row['descriptor_hex'], 'offset': row['offset'], 'cells': len(row['cells'])})
    ghost = raw_maps['M70050'].descriptors[2]
    assert ghost['state_raw'] == 2 and ghost['field_26_raw'] == 1 and not ghost['cells']
    assert not any(row['id'] == 2 for row in resources['trigger_regions'].get('M70050', []))
    assert not any(row['id'] == 2 for row in resources['exits_by_map']['M70050'])
    assert sum(row['object_initial_frames_and_anchors'] for row in checks) == 96
    assert sum(row['background_tiles'] for row in checks) == 6960
    assert len(edges) == 10
    blocked = [row for row in edges if row['terrain_raw'] == 1]
    assert len(blocked) == 1 and (blocked[0]['from_map'], blocked[0]['target_map'], blocked[0]['marker']) == ('M70020', 'M70010', 2)
    assert (blocked[0]['entry']['x'], blocked[0]['entry']['y']) == (288, 288)
    return {'schema': 'seventh-seal-white-forest-map-source-validation', 'version': 1, 'passed': True,
        'scope': 'Static original-DAT/DGP conformance for the six outer White Forest maps. All source background tile pixels and all96 initial object main RGBA frames/anchors are compared against published assets.',
        'oracle': {'implementation': 'This file parses DAT tables, DGP geometry/optional blocks and RGB565 sparse rows independently; no map exporter or production DGP decoder is imported.',
            'source_game_sha256': GAME_SHA, 'script_sha256': sha(Path(__file__).read_bytes())},
        'limitations': ['Static source evidence; no GAME.exe execution, natural traversal, camera/timing or complete story-phase gameplay is claimed.',
            'Object checks cover the initial main RGBA raster and source anchors. Animation, shadow and intrinsic blending are separate runtime checks.',
            'All six actual White Forest DATs use0x42 descriptors. A real outside-region compact0x2B DAT is included only as an independent parser regression.'],
        'totals': {'maps': len(checks), 'terrain_cells': sum(row['terrain_cells'] for row in checks),
            'background_tiles': sum(row['background_tiles'] for row in checks),
            'background_pixels': sum(row['background_pixels'] for row in checks),
            'object_initial_frames_and_anchors': sum(row['object_initial_frames_and_anchors'] for row in checks),
            'object_pixels': sum(row['object_pixels'] for row in checks), 'physical_exits': len(edges),
            'white_forest_full_descriptors_scanned': 32 * len(IDS), 'white_forest_compact_descriptors': 0,
            'distinct_dgp_sources': len(dgps)},
        'maps': checks, 'physical_exit_checks': edges, 'original_blocked_marker_preserved': blocked[0],
        'unreferenced_descriptor_not_opened': {'map_id': 'M70050', 'descriptor_id': 2, 'state_raw': 2, 'record': 1, 'source_cells': 0},
        'compact_parser_regression': {'outside_region': True, 'path': compact.path, 'sha256': sha(compact.raw), 'checks': compact_checks},
        'source_inputs': source.checked_rows(), 'outputs_under_test': outputs.checked_rows()}


MATERIALS = [(ROOT / f'Map/{ident.lower()}.dat') for ident in IDS] + [ROOT / 'GAME.exe', ROOT / 'Map/Hellway-e01.dat']
AVAILABLE = all(path.is_file() for path in MATERIALS) and all((WEB / f'data/maps/{ident.lower()}.json').is_file() for ident in IDS)


@unittest.skipUnless(AVAILABLE, 'Local original map/DGP materials or generated map assets are unavailable')
class WhiteForestMapSourceTests(unittest.TestCase):
    def test_all_six_source_maps_backgrounds_and_initial_objects(self):
        report = verify_sources()
        self.assertEqual(report['totals']['maps'], 6)
        self.assertEqual(report['totals']['background_tiles'], 6960)
        self.assertEqual(report['totals']['object_initial_frames_and_anchors'], 96)
        self.assertTrue(all(row['unchanged'] for row in report['source_inputs']))

    def test_source_descriptor_widths_ten_exits_and_original_blocked_landing(self):
        report = verify_sources()
        self.assertEqual(report['totals']['physical_exits'], 10)
        self.assertEqual(report['totals']['white_forest_full_descriptors_scanned'], 192)
        self.assertEqual(report['original_blocked_marker_preserved']['terrain_raw'], 1)
        self.assertEqual(len(report['compact_parser_regression']['checks']), 2)
        self.assertEqual(report['unreferenced_descriptor_not_opened']['source_cells'], 0)


if __name__ == '__main__':
    if len(sys.argv) == 2 and sys.argv[1] == '--report':
        report = verify_sources()
        serialized = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
        if REPORT.exists():
            assert json.loads(REPORT.read_text(encoding='utf-8')) == report, 'Preserve the existing report and select a new version for changed inputs.'
        else:
            REPORT.write_text(serialized, encoding='utf-8')
        print(json.dumps({'passed': report['passed'], 'totals': report['totals'], 'report': str(REPORT)}, ensure_ascii=True, indent=2))
    else:
        unittest.main()
