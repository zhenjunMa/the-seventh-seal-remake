"""The actual M01065 CF7's complete two-action main/light source pixels."""
import hashlib
import json
from pathlib import Path
import unittest
from PIL import Image
from test_cf1_map_effect_pixels import FileRaster

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]


class CF7MapPixels(unittest.TestCase):
    def test_m01065_cf7_all_sixteen_source_frames_in_both_published_channels(self):
        manifest = json.loads((RUNTIME / 'web/data/map_effects.json').read_text('utf-8'))
        row = next(row for row in manifest['maps']['M01065']['objects'] if row['index'] == 1)
        self.assertEqual(row['behavior_raw_cf'], 7)
        bank = manifest['object_banks'][row['bank']]
        self.assertEqual(bank['source']['path'], 'mapm/m01065/002.dgp')
        path = ROOT / bank['source']['path']
        source = path.read_bytes()
        self.assertEqual(hashlib.sha256(source).hexdigest(), 'eaf1807950fd9a319e3c25ea3489e0b8cb84da438727c1ef7c987766092788af')
        self.assertEqual(bank['source']['sha256'], hashlib.sha256(source).hexdigest())
        raster = FileRaster(source)
        self.assertEqual((raster.width, raster.height, raster.count), (90, 140, 16))
        self.assertEqual([(a['first_frame'], a['frame_count'], a['interval_raw']) for a in bank['actions']], [(0, 6, 130), (6, 10, 150)])
        checked = 0
        for action in bank['actions']:
            self.assertEqual(action['source_action_raw_hex'], source[67 + action['index'] * 172:67 + (action['index'] + 1) * 172].hex())
            self.assertEqual(action['logical_frames'], list(range(action['frame_count'])))
            for channel in ['main', 'intrinsic']:
                atlas = Image.open(RUNTIME / 'web' / action[channel + '_sheet'].lstrip('/')).convert('RGBA')
                self.assertEqual(atlas.size, (90 * action['frame_count'], 140))
                for frame in range(action['frame_count']):
                    physical = action['first_frame'] + frame
                    actual = atlas.crop((frame * 90, 0, (frame + 1) * 90, 140)).tobytes()
                    self.assertEqual(actual, raster.pixels(physical, intrinsic=channel == 'intrinsic'), (physical, channel))
                    checked += 1
        self.assertEqual(checked, 32)
        self.assertEqual(path.read_bytes(), source)


if __name__ == '__main__':
    unittest.main()
