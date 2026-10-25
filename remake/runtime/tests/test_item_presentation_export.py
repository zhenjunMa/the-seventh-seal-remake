"""Registered ITM visuals and actual cure pixels, isolated from shared outputs."""
from pathlib import Path
from unittest.mock import patch
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from PIL import Image

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
import export_item_presentation as presentation
import export_chapter_items as producer
from source.dgp import DGP
from export_skill_layers import SourceAudit


class ItemPresentationExport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.itm = (ROOT / 'SYSTEM/Object.ITM').read_bytes()
        cls.catalog = json.loads((RUNTIME / 'web/data/items.json').read_text('utf-8'))
        seed = json.loads((RUNTIME / 'web/data/opening_seed.json').read_text('utf-8'))
        story = json.loads((RUNTIME / 'web/data/chapter_story.json').read_text('utf-8'))
        registration = json.loads((RUNTIME / 'web/data/runtime_content.json').read_text('utf-8'))
        definitions = cls.catalog['definitions']
        admission = producer.admit_registered_equipment(definitions, seed, story, registration)
        capability = producer.admit_registered_status_cures(definitions, admission)
        assert capability['promoted_item_ids'] == [272]

    def test_visual_admission_follows_registered_effects_and_exact_item_source_bytes(self):
        items = presentation.item_presentations(self.catalog, self.itm)
        self.assertEqual(sorted(map(int, items)), [8, 11, 12, 272])
        self.assertEqual(items['272']['effect_token_raw_126'], '_iReSTfz.dgp')
        self.assertEqual(items['272']['animation_skill_id_raw_142'], 17)
        changed = copy.deepcopy(self.catalog)
        changed['definitions']['272']['raw_hex'] = '01' + changed['definitions']['272']['raw_hex'][2:]
        with self.assertRaises(AssertionError):
            presentation.item_presentations(changed, self.itm)
        unsupported = copy.deepcopy(self.catalog)
        unsupported['definitions']['273']['effect'] = {}
        with self.assertRaises(AssertionError):
            presentation.item_presentations(unsupported, self.itm)

    def test_all_cure_pixels_and_unchanged_recovery_pixels_are_independently_audited_and_used_by_the_real_view(self):
        paths = [ROOT / 'SYSTEM/Object.ITM', RUNTIME / 'web/data/items.json', RUNTIME / 'web/data/item_presentation.json',
                 *[ROOT / f'Fight_Role/Effect/{name}' for name in ['_iReHP.dgp', '_iReMP.dgp', '_iReSTfz.dgp']]]
        before = {path: path.read_bytes() for path in paths}
        with tempfile.TemporaryDirectory(prefix='item-effect-', dir=RUNTIME / 'tests') as temporary:
            web = Path(temporary)
            checks, generated, previews = [], [], []
            with patch.object(presentation, 'WEB', web):
                items = presentation.item_presentations(self.catalog, self.itm)
                effects = [presentation.export_item_effect(name, checks, generated, previews)
                           for name in sorted({item['effect_token_raw_126'] for item in items.values()})]
            self.assertEqual(len(checks), 3 * 19)
            for effect in effects:
                original = DGP(ROOT / effect['source'])
                audit = SourceAudit(original.data)
                self.assertEqual(effect['frame_count'], 19)
                self.assertEqual(effect['interval_raw'], 80)
                self.assertEqual(effect['native_raw_hex'], original.raw_actions[0].hex())
                image = Image.open(web / effect['sheet'].lstrip('/')).convert('RGBA')
                for frame in range(19):
                    expected, _ = audit.sparse(frame, True)
                    actual = image.crop((frame * original.width, 0, (frame + 1) * original.width, original.height))
                    self.assertEqual(actual.tobytes(), expected, (effect['id'], frame))
                if effect['id'] != '_iReSTfz':
                    self.assertEqual((web / effect['sheet'].lstrip('/')).read_bytes(),
                                     (RUNTIME / 'web' / effect['sheet'].lstrip('/')).read_bytes())
            manifest = json.loads((RUNTIME / 'web/data/item_presentation.json').read_text('utf-8'))
            manifest['items'], manifest['effects'] = items, effects
            target = web / 'data/item_presentation.json'
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(manifest, ensure_ascii=False), 'utf-8')
            result = subprocess.run(['node', '--import', (RUNTIME / 'tests/preserve_history.mjs').as_uri(), '--test', 'tests/test_item_status_cure_presentation.mjs'], cwd=RUNTIME,
                env=dict(os.environ, SEVENTH_SEAL_ITEM_TEST_PRESENTATION=str(web)),
                capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual({path: path.read_bytes() for path in paths}, before)


if __name__ == '__main__':
    unittest.main()
