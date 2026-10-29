"""Source-backed admission uses generated identities and original byte checks."""
from pathlib import Path
import copy
import contextlib
import io
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
import export_chapter_items as producer
import export_chapter_story as story_producer
import build_runtime as build


class ItemAdmissionExport(unittest.TestCase):
    def test_actual_kind4_true_branch_is_in_reachable_reward_closure(self):
        dat_path, tlk_path = 'Map/m01040.dat', 'Map/m01040.TLK'
        original = {name: (ROOT / name).read_bytes() for name in (dat_path, tlk_path)}
        hashes = {name: hashlib.sha256(raw).hexdigest() for name, raw in original.items()}
        dat = original[dat_path]
        table = story_producer.tlk_record(ROOT / tlk_path)
        table.update(id='M01040', map_flag_index=producer.u32(dat, 0x92),
                     map_source={'path': dat_path, 'sha256': hashes[dat_path]},
                     header_entry_tlk_raw=producer.u32(dat, 0x13a),
                     header_setup_tlk_raw=producer.u32(dat, 0x8a), objects=[], descriptors=[], npc_records=[])
        registration = {'maps': {'M01040': {'npcs': [20]}}, 'programs': []}
        def require(ok, message):
            self.assertTrue(ok, message)
        reachable, roots = producer.registered_tlk_reachability(
            {'maps': {'M01040': table}}, registration, original, hashes, require)
        self.assertEqual(roots[0]['record_id'], 102)
        self.assertIn('M01040:4', reachable)
        self.assertIn('M01040:32', reachable, 'kind4 +2F is a true branch even with zero header condition fields')
        self.assertIn('M01040:28', reachable)

    @classmethod
    def setUpClass(cls):
        cls.items = json.loads((RUNTIME / 'web/data/items.json').read_text('utf-8'))
        cls.seed = json.loads((RUNTIME / 'web/data/opening_seed.json').read_text('utf-8'))
        cls.registration = json.loads((RUNTIME / 'web/data/runtime_content.json').read_text('utf-8'))
        # Honor newly authored entrances before the shared build publishes its
        # next ledger. Re-run the official source-only prerequisite in a temp
        # tree, without filtering callers or changing shared generated files.
        cls.temporary_story = tempfile.TemporaryDirectory(prefix='item-story-source-', dir=RUNTIME / 'tests')
        cls.addClassCleanup(cls.temporary_story.cleanup)
        cls.story_root = Path(cls.temporary_story.name)
        previous = story_producer.RUNTIME
        try:
            story_producer.RUNTIME = cls.story_root
            with contextlib.redirect_stdout(io.StringIO()):
                story_producer.export()
        finally:
            story_producer.RUNTIME = previous
        cls.story = json.loads((cls.story_root / 'web/data/chapter_story.json').read_text('utf-8'))

    def source_definitions(self):
        raw = (ROOT / 'SYSTEM/Object.ITM').read_bytes()
        return {str(index): producer.catalog_fields(raw[0x61c + (index - 1) * 959:0x61c + index * 959],
                                                   index, 0x61c + (index - 1) * 959)[0]
                for index in range(1, 417)}

    def assert_current_admission(self, exported):
        admission = exported['catalog']['equipment_admission']
        legacy = [39, 40, 41, 42, 50]
        historical = [ident for ident in admission['promoted_item_ids']
            if any(row['kind'] in ('registered-player-native-initial-equipment', 'registered-story-item-grant')
                for row in admission['sources'][str(ident)])]
        self.assertEqual(historical, legacy)
        raw = bytes.fromhex(self.story['maps']['M01063']['records'][1]['raw_hex'])
        goods = [int.from_bytes(raw[0x37 + i * 2:0x39 + i * 2], 'little') for i in range(32)]
        goods = [ident for ident in goods if ident]
        self.assertEqual(goods, [60, 61, 62, 63, 65, 66, 3, 77, 78, 79, 80, 81, 82, 4, 92, 93, 94, 95, 96, 97])
        city = {int(ident) for ident, sources in admission['sources'].items()
            if any(row['kind'] == 'tlk-shop-item' and row['map_id'] == 'M01063' and row['record_id'] == 2 for row in sources)}
        self.assertEqual(city, set(goods))
        recipes = {int(ident) for ident, sources in admission['sources'].items()
            if exported['definitions'][ident]['type_raw_24'] == 1
            and any(row['kind'] == 'registered-recipe-product' for row in sources)}
        self.assertEqual(recipes, {253, 254, 256, 257})
        self.assertEqual(set(admission['promoted_item_ids']), set(legacy) | city - set(producer.IDS) | recipes)
        materials = {int(ident) for ident in admission['sources']
            if exported['definitions'][ident]['type_raw_24'] == 3 and exported['definitions'][ident]['subtype_raw_25'] == 2}
        medicine = {13, 21, *range(23, 29), *range(272, 277), *range(278, 281),
            *range(283, 286), *range(307, 312), 315, 320, 321, 323, 324, 331}
        self.assertEqual(set(exported['catalog']['item_capability_admission']['promoted_item_ids']), medicine | materials | {127, 170})
        old_enabled = {1, 4, 8, 10, 11, 12, 39, 40, 41, 42, 50, 51, 61, 127, 170, 272}
        self.assertEqual(set(exported['catalog']['default_enabled_item_ids']), old_enabled | city | recipes | medicine | materials)
        for ident in materials:
            self.assertEqual(exported['definitions'][str(ident)]['behavior']['kind'], 'crafting-material')
            self.assertNotIn('effect', exported['definitions'][str(ident)])
        # Every source-exposed commodity has an inventory/equip/use handler;
        # a source catalog row or successful purchase alone cannot admit it.
        for ident, sources in admission['sources'].items():
            if not any(source['kind'] in ('tlk-shop-item', 'registered-recipe-product') for source in sources):
                continue
            definition = exported['definitions'][ident]
            self.assertTrue(definition['availability']['enabled'], ident)
            kind = definition['behavior']['kind']
            if kind == 'equip':
                self.assertIn(definition['slot_id'], {slot['id'] for slot in exported['slots']})
            elif kind == 'crafting-material':
                self.assertIn('native-service-material-input-output', definition['behavior']['implemented_scope'])
            else:
                self.assertIn(kind, ('simple-restore', 'status-cure', 'status-attack', 'revival-item', 'status-clear'))
                self.assertIn('effect', definition)
                if kind == 'simple-restore':
                    # The original baseline restorers omit the optional flag;
                    # deriveItemConfiguration gives them the native true default.
                    self.assertTrue(definition.get('use_in_battle', True))
                else:
                    self.assertTrue(definition['use_in_battle'])

    def test_registered_initial_equipment_and_real_tlk_grants_promote_only_recovered_plain_numeric_gear(self):
        definitions = self.source_definitions()
        original = copy.deepcopy((self.seed, self.story, self.registration))
        admission = producer.admit_registered_equipment(definitions, self.seed, self.story, self.registration)
        historical = [ident for ident in admission['promoted_item_ids']
            if any(row['kind'] in ('registered-player-native-initial-equipment', 'registered-story-item-grant')
                for row in admission['sources'][str(ident)])]
        self.assertEqual(historical, [39, 40, 41, 42, 50])
        for ident in admission['promoted_item_ids']:
            row = definitions[str(ident)]
            self.assertEqual(row['behavior']['kind'], 'equip')
            self.assertTrue(row['availability']['enabled'])
            self.assertTrue(row['initialization']['deterministic'])
            payload = bytes.fromhex(row['raw_fields']['special_effect_block']['raw_hex'])
            self.assertFalse(any(payload[:0xea]))
            self.assertFalse(any(payload[0xff:]))
            self.assertLessEqual(payload[0xea], 5)
            self.assertEqual(row['raw_fields']['encounter_modifier_raw_3a7'], 0)
        self.assertEqual(admission['sources']['50'][0]['map_id'], 'M17025')
        self.assertEqual(admission['sources']['50'][0]['record_id'], 3)
        self.assertEqual(admission['sources']['39'][0]['role_id'], '003')
        for ident in [99, 272, 347]:
            self.assertFalse(definitions[str(ident)]['availability']['enabled'])
        self.assertTrue(definitions['257']['availability']['enabled'])
        self.assertEqual(admission['sources']['257'][0]['kind'], 'registered-recipe-product')
        reward = admission['sources']['331'][0]
        self.assertEqual((reward['kind'], reward['map_id'], reward['record_id'], reward['enemy_id'], reward['reward_slot']),
            ('registered-enemy-reward', 'M71013', 5, '042', 0))
        self.assertEqual(reward['source'], dict(path='Fight_Role/042.CHR', sha256=producer.sha((ROOT/'Fight_Role/042.CHR').read_bytes()),
            offset=8+0xe8, bytes=4, raw_hex='4b010000'))
        self.assertEqual((self.seed, self.story, self.registration), original)

    def test_source_drift_or_unregistered_provenance_cannot_open_an_item(self):
        definitions = self.source_definitions()
        before = copy.deepcopy(definitions)
        bad = copy.deepcopy(self.story)
        record = next(row for row in bad['maps']['M17025']['records'] if row['id'] == 3)
        record['mutation_bit'] = 99
        with self.assertRaisesRegex(ValueError, 'source|Source'):
            producer.admit_registered_equipment(definitions, self.seed, bad, self.registration)
        self.assertEqual(definitions, before, 'source failure cannot partly promote earlier rows')
        bad = copy.deepcopy(self.seed)
        row = next(row for row in bad['source']['initial_equipment'] if row['role_id'] == '003')
        row['instance_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'source|Source'):
            producer.admit_registered_equipment(self.source_definitions(), bad, self.story, self.registration)
        unregistered = copy.deepcopy(self.registration)
        unregistered['roles'].pop('003')
        admitted = self.source_definitions()
        producer.admit_registered_equipment(admitted, self.seed, self.story, unregistered)
        self.assertFalse(admitted['39']['availability']['enabled'])
        unregistered = copy.deepcopy(self.registration)
        unregistered['roles'].pop('042')
        admitted = self.source_definitions()
        acquisition = producer.admit_registered_equipment(admitted, self.seed, self.story, unregistered)
        producer.admit_registered_status_cures(admitted, acquisition)
        self.assertNotIn('331', acquisition['sources'])
        self.assertFalse(admitted['331']['availability']['enabled'])

    def test_nonzero_special_effect_or_encounter_payload_is_not_plain_numeric_admission(self):
        row = self.source_definitions()['50']
        self.assertTrue(producer.plain_equipment_supported(row))
        for change in [lambda r: r['raw_fields'].__setitem__('encounter_modifier_raw_3a7', 1),
                       lambda r: r['raw_fields'].__setitem__('animation_skill_id_raw_142', 1),
                       lambda r: r['raw_fields'].__setitem__('effect_token_raw_126', 'unrecovered'),
                       lambda r: r['raw_fields']['special_effect_block'].__setitem__('raw_hex', '01' + '00' * 278)]:
            value = copy.deepcopy(row)
            change(value)
            self.assertFalse(producer.plain_equipment_supported(value))

    def test_mode6_capability_requires_registered_source_and_preserves_exact_blocks(self):
        definitions = self.source_definitions()
        no_sources = {'sources': {}}
        capabilities = producer.admit_registered_status_cures(definitions, no_sources)
        producer.admit_registered_equipment_passives(definitions, no_sources, capabilities)
        self.assertEqual(capabilities['passive_item_ids'], [])
        for ident in (127, 170):
            self.assertTrue(producer.equipment_immunity_supported(definitions[str(ident)]))
            self.assertFalse(definitions[str(ident)]['availability']['enabled'])
        admission = producer.admit_registered_equipment(definitions, self.seed, self.story, self.registration)
        capabilities = producer.admit_registered_status_cures(definitions, admission)
        producer.admit_registered_equipment_passives(definitions, admission, capabilities)
        self.assertEqual(capabilities['passive_item_ids'], [127, 170])
        self.assertEqual(capabilities['passive_sources']['127'][0]['kind'], 'registered-map-chest-grant')
        self.assertEqual(capabilities['passive_sources']['170'][0]['map_id'], 'M70030')
        self.assertEqual(capabilities['passive_sources']['170'][0]['record_id'], 8)
        for ident in (127, 170):
            row = definitions[str(ident)]
            self.assertEqual(row['equipment_passive']['effect_raw_hex'], bytes.fromhex(row['raw_hex'])[0x2a8:0x36e].hex())

    def test_only_registered_reachable_gifts_admit_gear_not_other_npcs_in_the_same_tlk(self):
        registration = copy.deepcopy(self.registration)
        registration['maps']['M17025']['npcs'] = []
        definitions = self.source_definitions()
        admission = producer.admit_registered_equipment(definitions, self.seed, self.story, registration)
        self.assertFalse(definitions['50']['availability']['enabled'])
        self.assertNotIn('50', admission['sources'])
        # M01050's admitted NPC15 is the Fire Valley handoff. Another NPC's
        # real r122 gives pure numeric gear85; catalog export must not open it.
        if 'M01050' in self.registration['maps']:
            self.assertFalse(definitions['85']['availability']['enabled'])
            self.assertNotIn('85', admission['sources'])

    def test_items_build_declares_generated_and_original_source_dependencies_before_export(self):
        step = build.STEPS['items']
        self.assertTrue({'opening-seed', 'chapter-story'} <= set(step.depends))
        self.assertTrue({'data/opening_seed.json', 'data/chapter_story.json', 'data/runtime_content.json'} <= set(step.inputs))
        self.assertTrue({'GAME.exe', 'SYSTEM/Object.ITM', 'Map/m17025.TLK'} <= set(step.sources))
        plan = build.plan(['items'])
        self.assertLess(plan.index('chapter-story'), plan.index('items'))
        self.assertLess(plan.index('opening-seed'), plan.index('items'))
        presentation = build.STEPS['item-presentation']
        self.assertIn('data/items.json', presentation.inputs)
        self.assertIn('Fight_Role/Effect/_iReSTfz.dgp', presentation.sources)

    def test_isolated_official_export_and_real_menu_roundtrips_leave_live_data_unchanged(self):
        # Run the official producer in a disposable tree, never over published
        # assets. The Node suite also reads this exact producer output, avoiding
        # handwritten availability fixtures which could mirror the defect.
        live_paths = [RUNTIME / 'web/data/items.json', RUNTIME / 'web/data/config/items.json',
                      RUNTIME / 'evidence/chapter_items_export.json']
        before = {path: path.read_bytes() for path in live_paths}
        with tempfile.TemporaryDirectory(prefix='item-admission-', dir=RUNTIME / 'tests') as folder:
            target = Path(folder)
            for name in ['opening_seed.json', 'chapter_story.json', 'runtime_content.json', 'forest_rewards.json']:
                path = target / 'web/data' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(RUNTIME / 'web/data' / name, path)
            shutil.copyfile(self.story_root / 'web/data/chapter_story.json', target / 'web/data/chapter_story.json')
            for name in ['chapter_items_native.json', 'forest_scheduler_native_20261011.json',
                         'forest_rewards_native_20261011.json', 'fire_valley_20261024/stage12_status_apply.json',
                         'white_forest_20261026/reward_passives/native_bundle.json']:
                path = target / 'evidence' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(RUNTIME / 'evidence' / name, path)
            previous = producer.RUNTIME
            try:
                producer.RUNTIME = target
                with contextlib.redirect_stdout(io.StringIO()):
                    producer.export()
            finally:
                producer.RUNTIME = previous
            output = target / 'web/data/items.json'
            exported = json.loads(output.read_text('utf-8'))
            self.assert_current_admission(exported)
            self.assertEqual(exported['catalog']['item_capability_admission']['passive_item_ids'], [127, 170])
            self.assertEqual(exported['definitions']['272']['behavior']['kind'], 'status-cure')
            environment = dict(os.environ, SEVENTH_SEAL_ITEM_TEST_CATALOG=str(output))
            result = subprocess.run(['node', '--import', './remake/runtime/tests/preserve_history.mjs', '--test',
                'remake/runtime/tests/test_registered_item_admission.mjs',
                'remake/runtime/tests/test_item_status_cure.mjs',
                'remake/runtime/tests/test_item_status_cure_battle.mjs',
                'remake/runtime/tests/test_equipment_passives.mjs'], cwd=ROOT, env=environment,
                capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual({path: path.read_bytes() for path in live_paths}, before)

    def test_real_builder_subprocess_and_standalone_isolated_cli_resolve_only_declared_sibling_tools(self):
        live = [RUNTIME / 'web/data/items.json', RUNTIME / 'evidence/chapter_items_export.json']
        before = {path: path.read_bytes() for path in live}
        step = replace(build.STEPS['items'], depends=())  # prerequisites are copied, not regenerated here
        with tempfile.TemporaryDirectory(prefix='item-cli-root-', dir=RUNTIME / 'tests') as folder:
            root = Path(folder).resolve()
            runtime = root / 'remake/runtime'
            web, evidence = runtime / 'web', runtime / 'evidence'
            evidence.mkdir(parents=True)
            tool = runtime / 'tools' / step.tool
            tool.parent.mkdir(parents=True)
            shutil.copyfile(RUNTIME / 'tools' / step.tool, tool)
            # Copy only this producer's declared original/generated/tool inputs.
            # No test sys.path/PYTHONPATH, shared tools tree or asset symlinks can
            # accidentally make the real child process's imports succeed.
            for name in step.sources:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
            for name in step.inputs:
                source = (RUNTIME / 'web' / name).resolve()
                target = (web / name).resolve()
                self.assertTrue(target.is_relative_to(root))
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
            shutil.copyfile(self.story_root / 'web/data/chapter_story.json', web / 'data/chapter_story.json')
            with patch.multiple(build, ROOT=root, RUNTIME=runtime, WEB=web, EVIDENCE=evidence, STEPS={'items': step}):
                # run_command is deliberately omitted: execute launches the
                # actual sys.executable -B <exporter.py> subprocess and logs it.
                first = build.execute(['items'])
                self.assertTrue(first['passed'])
                self.assertEqual(first['steps'][0]['status'], 'exported')
                second = build.execute(['items'])
                self.assertEqual(second['steps'][0]['status'], 'cached')
            output = web / 'data/items.json'
            expected = output.read_bytes()
            isolated = subprocess.run([sys.executable, '-I', '-B', str(tool)], cwd=root,
                env={key: value for key, value in os.environ.items() if key.upper() != 'PYTHONPATH'},
                capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(isolated.returncode, 0, isolated.stdout + isolated.stderr)
            self.assertEqual(output.read_bytes(), expected)
            exported = json.loads(expected)
            self.assert_current_admission(exported)
        self.assertEqual({path: path.read_bytes() for path in live}, before)


if __name__ == '__main__':
    unittest.main()
