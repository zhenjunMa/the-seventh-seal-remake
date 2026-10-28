"""Every aid-carrier primary and indexed pixel survives the shared export.

The expected RGBA below is decoded directly from immutable file bytes. It uses
neither DGP nor SourceAudit nor indexed_contribution to form expected pixels.
All writes are isolated temporary atlases, never runtime or retained evidence.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
from PIL import Image
import export_party_skills as exporter
from source.combat_resources import CHR


def digest(value):
    return hashlib.sha256(value).hexdigest()


class FilePixels:
    def __init__(self, path):
        self.data = data = path.read_bytes()
        assert data[0] == 9
        geometry = 67 + data[2] * 172
        self.width, self.height, self.count = struct.unpack_from('<HHI', data, geometry)
        self.anchor = struct.unpack_from('<III', data, geometry + 42 + 16)
        self.payload, payload_bytes = struct.unpack_from('<II', data, geometry + 32)
        self.action = data[67:239]
        frame_table = geometry + 42 + 48 + data[geometry + 13] * 18
        self.primary = [struct.unpack_from('<5I', data, frame_table + f * 20)[3:]
                        for f in range(self.count)]
        position = frame_table + self.count * 20
        # These actual sources contain no volume, mask or per-frame records.
        # Consume the independent shadow blob records without treating them as
        # either color layer.
        assert not all(struct.unpack_from('<III', data, geometry + 42))
        assert (data[5], data[6], data[19]) == (0, 0, 1)
        self.shadows = []
        if data[geometry + 41]:
            for _ in range(self.count):
                size, = struct.unpack_from('<I', data, position)
                self.shadows.append((position + 4, size))
                position += 4 + size
        self.indexed = []
        for _ in range(self.count):
            active = data[position]
            position += 1
            if active:
                size, = struct.unpack_from('<I', data, position)
                palette = data[position + 4:position + 772]
                start = position + 772
                self.indexed.append((start, size, palette))
                position = start + size
            else:
                self.indexed.append(None)
        assert position == self.payload
        assert sum(size for _, size in self.primary) == payload_bytes
        running = 0
        for offset, size in self.primary:
            assert offset == running
            running += size
        assert self.payload + payload_bytes * (1 if data[21] else 2) == len(data)

    def decode(self, frame, indexed):
        if indexed:
            entry = self.indexed[frame]
            if entry is None:
                return bytes(self.width * self.height * 4), 0
            position, size, palette = entry
        else:
            offset, size = self.primary[frame]
            position, palette = self.payload + offset, None
        end, count = position + size, 0
        rgba = bytearray(self.width * self.height * 4)
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
                    if indexed:
                        p = self.data[position] * 3
                        position += 1
                        color = [palette[p] & 248, palette[p + 1] & 252, palette[p + 2] & 248, 255]
                    else:
                        pixel, = struct.unpack_from('<H', self.data, position)
                        position += 2
                        r, g, b = pixel >> 11, (pixel >> 5) & 63, pixel & 31
                        color = [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2), 255]
                    q = ((y * self.width) + x + dx) * 4
                    assert rgba[q + 3] == 0
                    rgba[q:q + 4] = bytes(color)
                    count += 1
        assert position == end
        return bytes(rgba), count

    def shadow(self, frame):
        rgba = bytearray(self.width * self.height * 4)
        if not self.shadows:
            return bytes(rgba), 0
        position, size = self.shadows[frame]
        end, count = position + size, 0
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
                    q = ((y * self.width) + x + dx) * 4
                    assert rgba[q + 3] == 0
                    rgba[q:q + 4] = bytes((0, 0, 0, 128))
                    count += 1
        assert position == end
        return bytes(rgba), count


def metadata(tokens):
    return {'effects': [], 'roles': [{'skill': {'segments': [], 'command_effects': [
        {'command_raw': 4, 'effect_asset_id': token, 'raw_hex': '00' * 176}
        for token in tokens]}, 'alternate_skills': [], 'response_skills': []}]}


class EffectLayerTests(unittest.TestCase):
    def test_all_aid_source_pixels_survive_party_and_enemy_shared_export(self):
        expected = {'cvt_p001': (24, 82031, 400674, 25525), 'cvt_p002': (23, 58430, 607659, 26370)}
        before = {name: (ROOT / f'Fight_Role/Effect/{name}.dgp').read_bytes() for name in expected}
        for group in ('party', 'enemy'):
            with self.subTest(group=group), tempfile.TemporaryDirectory() as temporary:
                web = Path(temporary)
                meta, sources, checks = metadata(expected), {}, []
                with patch.object(exporter, 'WEB', web):
                    exporter.export_effect_assets(meta, sources, checks, asset_group=group)
                for effect in meta['effects']:
                    name = effect['id']
                    raw = FilePixels(ROOT / f'Fight_Role/Effect/{name}.dgp')
                    self.assertEqual((effect['frame_width'], effect['frame_height']), (639, 478))
                    self.assertEqual(effect['frame_count'], expected[name][0])
                    self.assertEqual(effect['frames'], list(range(raw.count)))
                    self.assertEqual(effect['interval_ms'], 80)
                    self.assertEqual(effect['anchor'], dict(x=raw.anchor[0], y=raw.anchor[1]))
                    self.assertEqual(effect['layer_order'], ['shadow', 'main', 'intrinsic'])
                    self.assertEqual((effect['main_blend'], effect['intrinsic_blend']), ('source-over', 'lighter'))
                    self.assertEqual((effect['shadow_blend'], effect['shadow_alpha']), ('source-over', 128))
                    self.assertEqual((effect['sheet'], effect['sha256'], effect['blend']),
                                     (effect['intrinsic_sheet'], effect['intrinsic_sha256'], 'lighter'))
                    totals = []
                    images = []
                    for layer in ('main', 'intrinsic', 'shadow'):
                        path = web / effect[f'{layer}_sheet'][1:]
                        self.assertEqual(digest(path.read_bytes()), effect[f'{layer}_sha256'])
                        with Image.open(path) as stored:
                            image = stored.convert('RGBA')
                        self.assertEqual(digest(image.tobytes()), effect[f'{layer}_rgba_sha256'])
                        self.assertEqual(image.size, (raw.width * raw.count, raw.height))
                        images.append(image)
                        total = 0
                        for frame in range(raw.count):
                            rgba, count = raw.shadow(frame) if layer == 'shadow' else raw.decode(frame, layer == 'intrinsic')
                            crop = image.crop((frame * raw.width, 0, (frame + 1) * raw.width, raw.height))
                            self.assertEqual(crop.tobytes(), rgba, f'{name}/{layer}/{frame}')
                            row = next(r for r in checks if r['effect_id'] == name and r['source_frame'] == frame)
                            self.assertEqual(row[layer]['covered_pixels'], count)
                            self.assertEqual(row[layer]['rgba_sha256'], digest(rgba))
                            total += count
                        totals.append(total)
                    self.assertEqual(tuple(totals), expected[name][1:])
                    # Both streams really cover some identical pixels. Dropping
                    # either one or flattening before a colored background loses
                    # the source-over-then-additive contract.
                    main, intrinsic = (image.tobytes() for image in images[:2])
                    self.assertTrue(any(main[q] and intrinsic[q] for q in range(3, len(main), 4)))
                    self.assertEqual(sources[effect['source']], digest(before[name]))
        for name, original in before.items():
            self.assertEqual((ROOT / f'Fight_Role/Effect/{name}.dgp').read_bytes(), original)

    def test_legacy_intrinsic_only_effect_keeps_every_old_contribution_pixel(self):
        with tempfile.TemporaryDirectory() as temporary:
            web = Path(temporary)
            meta, checks = metadata(['_DutyN', '_DutyN']), []
            with patch.object(exporter, 'WEB', web):
                exporter.export_effect_assets(meta, {}, checks)
            self.assertEqual(len(meta['effects']),1)
            effect = meta['effects'][0]
            raw = FilePixels(ROOT / 'Fight_Role/Effect/_DutyN.dgp')
            with Image.open(web / effect['sheet'][1:]) as stored:
                image = stored.convert('RGBA')
                for frame in range(raw.count):
                    self.assertEqual(image.crop((frame * raw.width, 0, (frame + 1) * raw.width, raw.height)).tobytes(), raw.decode(frame, True)[0])
            self.assertEqual(sum(row['main']['covered_pixels'] for row in checks), 0)
            self.assertEqual(sum(row['intrinsic']['covered_pixels'] for row in checks), 163009)
            paths=[web/effect[f'{layer}_sheet'][1:] for layer in ('main','intrinsic','shadow')]
            before={path:path.stat().st_mtime_ns for path in paths}
            again, cached_checks=metadata(['_DutyN']), []
            with patch.object(exporter,'WEB',web), patch.object(exporter,'DGP',side_effect=AssertionError('Unchanged effect decoded again')):
                exporter.export_effect_assets(again,{},cached_checks)
            self.assertEqual(again['effects'],meta['effects'])
            self.assertEqual(cached_checks,checks)
            self.assertEqual(before,{path:path.stat().st_mtime_ns for path in paths})
            shared=metadata(['_DutyN'])
            with patch.object(exporter,'WEB',web), patch.object(exporter,'DGP',side_effect=AssertionError('Shared effect decoded again')):
                exporter.export_effect_assets(shared,{},[],asset_group='enemy')
            self.assertEqual(shared['effects'],meta['effects'])
            self.assertFalse((web/'assets/enemy_effects').exists())
            damaged=paths[0]; damaged.write_bytes(b'broken')
            with patch.object(exporter,'WEB',web):
                repaired=metadata(['_DutyN']); exporter.export_effect_assets(repaired,{},[])
            self.assertEqual(repaired['effects'],meta['effects'])
            self.assertEqual({path:before[path] for path in paths[1:]},
                             {path:path.stat().st_mtime_ns for path in paths[1:]})

    def test_actual_five_type3_reward_actions_reference_both_multilayer_carriers(self):
        seen = set()
        for ident, indices in {'001': [35, 36], '002': [30, 31], '003': [33]}.items():
            source = CHR(ROOT / f'Fight_Role/{ident}.CHR')
            for index in indices:
                skill = source.skills[index]
                fixed = bytes.fromhex(skill['fixed_raw_hex'])
                self.assertEqual(struct.unpack_from('<I', fixed, 0x32)[0] & 15, 3)
                for action in skill['actions']:
                    raw = bytes.fromhex(action['raw_hex'])
                    if raw[0] == 1 and struct.unpack_from('<I', raw, 1)[0] == 4:
                        self.assertEqual(raw[0x1d], 0)
                        token = raw[9:29].split(b'\0')[0].decode('ascii')
                        seen.add(token)
                        self.assertIn(token, ['cvt_p001.dgp', 'cvt_p002.dgp'])
        self.assertEqual(seen, {'cvt_p001.dgp', 'cvt_p002.dgp'})

    def test_native_carrier_passes_copy_primary_before_indexed_additive(self):
        evidence = RUNTIME / 'evidence/fire_valley_20261025'
        carrier = json.loads((evidence / 'aid_render_515fb0.json').read_text('utf-8'))
        main = json.loads((evidence / 'aid_render_54f456.json').read_text('utf-8'))
        indexed = json.loads((evidence / 'aid_render_5458cd_assembly.json').read_text('utf-8'))
        body = carrier['normalized_result']['pseudocode']
        self.assertLess(body.index('uStack_188 = 0x51729a;'), body.index('uStack_188 = 0x517321;'))
        self.assertIn('*param_2 = *param_3;', main['normalized_result']['pseudocode'])
        self.assertIn('0x545b0f: MOV EAX, dword ptr [EDX + ECX*0x1 + 0x305]', indexed['normalized_result'])
        self.assertTrue(all(record['subject']['digest']['sha256'] == 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'
                            for record in (carrier, main, indexed)))


if __name__ == '__main__':
    unittest.main()
