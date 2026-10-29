"""Original town-service MNU identity, controls and complete exported pixels."""
from pathlib import Path
import hashlib
import json
import struct
import sys
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
sys.path.insert(0, str(RUNTIME / 'tests/helpers'))
from PIL import Image
from mnu_pixel_oracle import render


@unittest.skipUnless((ROOT / 'SYSTEM/boss_main.mnu').is_file(), 'Original service MNU unavailable')
class NativeServicesSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((RUNTIME / 'web/data/native_services.json').read_text('utf-8'))

    def test_all_menus_and_source_controls_keep_original_offsets_and_rectangles(self):
        self.assertEqual(len(self.data['menus']), 9)
        self.assertEqual(sum(len(menu['images']) for menu in self.data['menus']), 143)
        for menu in self.data['menus']:
            raw = (ROOT / menu['source']).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), menu['source_sha256'])
            self.assertEqual(struct.unpack_from('<II', raw, 78), (menu['width'], menu['height']))
            for widget in menu['widgets']:
                offset = widget['source_offset']
                self.assertEqual(bytes.fromhex(widget['raw_hex']), raw[offset:offset + 473])
                self.assertEqual(struct.unpack_from('<4i', raw, offset + 41), tuple(widget['rect'].values()))
        self.assertEqual(self.data['origins']['listing'], dict(x=10, y=50))

    def test_every_exported_service_image_matches_independent_source_span_renderer(self):
        for menu in self.data['menus']:
            raw = (ROOT / menu['source']).read_bytes()
            for record in menu['images']:
                with self.subTest(menu=menu['id'], frame=record['index']):
                    image = Image.open(RUNTIME / 'web' / record['image']).convert('RGBA')
                    self.assertEqual(image.tobytes(), render(raw, record).tobytes())

    def test_native_services_is_in_the_single_content_build(self):
        import build_runtime as build
        self.assertIn('native-services', build.plan(['content']))
        self.assertEqual(build.STEPS['native-services'].tool, 'export_native_services.py')


if __name__ == '__main__':
    unittest.main()
