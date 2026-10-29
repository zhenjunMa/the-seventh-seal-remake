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
        definitions = {str(index): producer.catalog_fields(cls.itm[0x61c + (index - 1) * 959:0x61c + index * 959],
            index, 0x61c + (index - 1) * 959)[0] for index in range(1, 417)}
        # The official export separately authors the three baseline recovery
        # effects; re-admit new acquisitions without duplicating that logic.
        for ident in producer.SIMPLE_RESTORE_IDS:
            definitions[str(ident)] = copy.deepcopy(cls.catalog['definitions'][str(ident)])
        cls.catalog['definitions'] = definitions
        admission = producer.admit_registered_equipment(definitions, seed, story, registration)
        cls.capability = producer.admit_registered_status_cures(definitions, admission)
        cls.expected_items = {8, 11, 12, 13, 21, *range(23, 29), *range(272, 277), *range(278, 281),
            *range(283, 286), *range(307, 312), 315, 320, 321, 323, 324, 331}
        cls.effect_tokens = {presentation.token(cls.itm[0x61c + (ident - 1) * 959:0x61c + ident * 959], 0x126)
            for ident in cls.expected_items} - {''}

    def test_visual_admission_follows_registered_effects_and_exact_item_source_bytes(self):
        items = presentation.item_presentations(self.catalog, self.itm)
        self.assertEqual(set(map(int, items)), self.expected_items)
        self.assertTrue(self.expected_items - {8, 11, 12} <= set(self.capability['promoted_item_ids']))
        self.assertEqual(items['272']['effect_token_raw_126'], '_iReSTfz.dgp')
        self.assertEqual(items['272']['animation_skill_id_raw_142'], 17)
        for ident in ('279', '331'):
            self.assertEqual(items[ident]['effect_token_raw_126'], '')
            self.assertIsNone(items[ident]['effect_id'])
        changed = copy.deepcopy(self.catalog)
        changed['definitions']['272']['raw_hex'] = '01' + changed['definitions']['272']['raw_hex'][2:]
        with self.assertRaises(AssertionError):
            presentation.item_presentations(changed, self.itm)
        unsupported = copy.deepcopy(self.catalog)
        unsupported['definitions']['14']['effect'] = {}
        with self.assertRaises(AssertionError):
            presentation.item_presentations(unsupported, self.itm)

    def test_all_cure_pixels_and_unchanged_recovery_pixels_are_independently_audited_and_used_by_the_real_view(self):
        paths = [ROOT / 'SYSTEM/Object.ITM', RUNTIME / 'web/data/items.json', RUNTIME / 'web/data/item_presentation.json',
                 *[ROOT / f'Fight_Role/Effect/{name}' for name in sorted(self.effect_tokens)]]
        before = {path: path.read_bytes() for path in paths}
        with tempfile.TemporaryDirectory(prefix='item-effect-', dir=RUNTIME / 'tests') as temporary:
            web = Path(temporary)
            checks, generated, previews = [], [], []
            with patch.object(presentation, 'WEB', web):
                items = presentation.item_presentations(self.catalog, self.itm)
                effects = [presentation.export_item_effect(name, checks, generated, previews)
                           for name in sorted(self.effect_tokens)]
            # A warm cache for one output root must never supply paths for a
            # different export root, even when both live under runtime/tests.
            with tempfile.TemporaryDirectory(prefix='item-effect-other-', dir=RUNTIME/'tests') as other:
                alternate=Path(other)
                with patch.object(presentation,'WEB',alternate):
                    copied=presentation.export_item_effect('_iReHP.dgp',[],[],[])
                self.assertTrue((alternate/copied['sheet'].lstrip('/')).is_file())
            self.assertEqual({effect['source'].rsplit('/', 1)[1] for effect in effects}, self.effect_tokens)
            self.assertEqual(len(checks), sum(effect['frame_count'] for effect in effects))
            for effect in effects:
                original = DGP(ROOT / effect['source'])
                audit = SourceAudit(original.data)
                self.assertEqual(effect['frame_count'], original.frame_count)
                self.assertEqual(effect['interval_raw'], original.actions[0]['interval_raw'])
                self.assertEqual(effect['native_raw_hex'], original.raw_actions[0].hex())
                image = Image.open(web / effect['sheet'].lstrip('/')).convert('RGBA')
                for frame in range(original.frame_count):
                    expected, _ = audit.sparse(frame, True)
                    actual = image.crop((frame * original.width, 0, (frame + 1) * original.width, original.height))
                    self.assertEqual(actual.tobytes(), expected, (effect['id'], frame))
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
