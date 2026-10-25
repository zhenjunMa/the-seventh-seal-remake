"""Source-backed expansion and first-export dependency regression."""
from pathlib import Path
import copy
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
import content_registration as content
import export_chapter_maps as maps
import export_chapter_story as story
import export_enemy_content as enemies
import export_battle_lifecycle as lifecycle
from source.combat_resources import CHR
from source.dgp import DGP
from export_skill_layers import SourceAudit


class ContentExporterTests(unittest.TestCase):
    def test_lifecycle_native_retention_accepts_exact_bundle_and_single_record_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            with patch.object(lifecycle,'RUNTIME',root),patch.object(lifecycle,'EVIDENCE',root/'evidence'):
                reference=lifecycle.retained_native()
            retained=json.loads((root/reference['path']).read_text('utf-8'))
            rows={row['topic']:row['record'] for row in retained['records']}
            self.assertEqual(set(rows),set(lifecycle.NATIVE))
            for topic,(_,ident) in lifecycle.NATIVE.items():
                self.assertEqual(rows[topic]['evidence_id'],ident)
                self.assertEqual(rows[topic]['subject']['digest']['sha256'],lifecycle.GAME_SHA256)

    def test_lifecycle_selection_retains_registered_hit_air_landing_getup_return_and_mode3_sources(self):
        selected={}
        for ident in content.role_ids():
            character=CHR(enemies.ROOT/f'Fight_Role/{ident}.CHR')
            graphics=DGP(enemies.ROOT/f'Fight_Role/{ident}.dgp')
            wanted, skills=lifecycle.lifecycle_skills(character)
            self.assertEqual(wanted,(1,2,3,4,5,6,8,10,11,12,14))
            expected={skill['index'] for skill in character.skills
                if skill['id_raw'] in wanted or bytes.fromhex(skill['fixed_raw_hex'])[0x23c]==3}
            self.assertEqual({skill['index'] for skill in skills},expected)
            for skill in skills:
                exported=lifecycle.export_sequence(character,graphics,skill)
                self.assertEqual(exported['fixed_raw_hex'],skill['fixed_raw_hex'])
                self.assertEqual([record['source']['raw_hex'] for record in exported['records']],
                    [record['raw_hex'] for record in skill['actions']])
                for step in exported['timeline']:
                    self.assertEqual(step['raw_hex'],skill['actions'][step['chr_record_index']]['raw_hex'])
                    self.assertEqual(step['source']['offset'],skill['actions'][step['chr_record_index']]['offset'])
                if skill['id_raw']==5:
                    commands=[record for record in exported['records'] if record.get('command_raw')==3]
                    self.assertEqual(len(commands),2)
                    for command in commands:
                        raw=bytes.fromhex(command['raw_hex'])
                        self.assertEqual(command['vertical_mode_raw'],raw[0x47])
                        self.assertEqual(command['vertical_acceleration_raw'],raw[0x23])
                        self.assertEqual(command['vertical_wait_raw'],raw[0x1d])
                        self.assertEqual(command['vertical_speed_raw'],int.from_bytes(raw[5:9],'little'))
                        self.assertEqual(command['vertical_height_multiplier_raw'],int.from_bytes(raw[0x1e:0x22],'little'))
            selected[ident]=expected
        self.assertTrue({40,41}.issubset(selected['004']))
        self.assertTrue({1,4}.issubset(selected['032']))

    def test_lifecycle_cross_group_atlases_keep_source_pool_and_exact_pixels(self):
        # The actual ID5 -> landing/get-up closure crosses nominal DGP groups.
        # Export only these two roles to an isolated directory; compare to the
        # independent byte decoder and the existing nominal party atlas prefix.
        from PIL import Image
        import hashlib
        expected={'004':{10:(1,3)},'005':{9:(5,6),12:(1,2)}}
        party=json.loads((RUNTIME/'web/data/party_battle_view.json').read_text('utf-8'))
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            with patch.object(lifecycle,'RUNTIME',root),patch.object(lifecycle,'WEB',root/'web'),patch.object(lifecycle,'OUT',root/'web/assets/battle_lifecycle'):
                for ident, expanded in expected.items():
                    graphics=DGP(enemies.ROOT/f'Fight_Role/{ident}.dgp')
                    original_hash=hashlib.sha256(graphics.path.read_bytes()).hexdigest()
                    row=lifecycle.export_role(ident,[])
                    self.assertEqual(row['source_frame_pool_count'],graphics.frame_count)
                    bank=json.loads((root/'web'/row['layer_bank']['path'].lstrip('/')).read_text('utf-8'))
                    self.assertEqual(bank['source_frame_pool_count'],graphics.frame_count)
                    self.assertEqual(bank['source_hashes'][row['source_dgp']],original_hash)
                    pairs={pair['source_frame']:pair for pair in bank['frames']}
                    audit=SourceAudit(graphics.data)
                    for index,(nominal,count) in expanded.items():
                        action=next(action for action in row['actions'] if action['index']==index)
                        self.assertEqual((action['source_frame_count'],action['frame_count']),(nominal,count))
                        self.assertEqual(action['native_raw_hex'],graphics.raw_actions[index].hex())
                        self.assertEqual(action['first_frame'],graphics.actions[index]['first_frame'])
                        sheet=Image.open(root/'web'/action['sheet'].lstrip('/')).convert('RGBA')
                        self.assertEqual(sheet.size,(graphics.width*count,graphics.height))
                        for frame in range(count):
                            physical=action['first_frame']+frame
                            self.assertLess(physical,graphics.frame_count)
                            main,_=audit.sparse(physical,False)
                            intrinsic,_=audit.sparse(physical,True)
                            self.assertEqual(sheet.crop((frame*graphics.width,0,(frame+1)*graphics.width,graphics.height)).tobytes(),main)
                            for name,pixels in [('main',main),('intrinsic',intrinsic)]:
                                image=Image.open(root/'web'/pairs[physical][name]['path']).convert('RGBA')
                                self.assertEqual(image.tobytes(),pixels)
                        old=next(action for role in party['roles'] if role['id']==ident for action in role['actions'] if action['index']==index)
                        old_sheet=Image.open(RUNTIME/'web'/old['sheet'].lstrip('/')).convert('RGBA')
                        self.assertEqual(old_sheet.tobytes(),sheet.crop((0,0,old_sheet.width,old_sheet.height)).tobytes())
                    self.assertEqual(hashlib.sha256(graphics.path.read_bytes()).hexdigest(),original_hash)

    def test_first_export_selection_needs_no_generated_outputs(self):
        value = copy.deepcopy(content.definition())
        value['maps']['M70020'] = {}
        value['roles']['014'] = {'side': 'enemy'}
        value['programs'].append('m70020-2')
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'runtime_content.json'
            path.write_text(json.dumps(value), 'utf-8')
            with patch.object(content, 'REGISTRATION', path), patch.object(content.subprocess, 'run', side_effect=AssertionError('Generated content resolver called')):
                self.assertIn('M70020', content.map_ids('assets'))
                self.assertIn('M70020', content.map_ids('story'))
                self.assertIn('014', content.role_ids('enemy'))
                self.assertIn('m70020-2', content.program_ids())
                self.assertNotIn('M17020', content.map_ids('assets'))
                self.assertIn('M17020', content.map_ids('story'))

    def test_invalid_paths_and_export_policies_fail(self):
        value = copy.deepcopy(content.definition())
        value['maps']['../Map'] = {}
        with self.assertRaisesRegex(ValueError, 'map identity'):
            content.map_exports(value)
        del value['maps']['../Map']
        value['maps']['M17026']['export'] = {'assets': 'unknown'}
        with self.assertRaisesRegex(ValueError, 'export policy'):
            content.map_exports(value)

    def test_native_map_variants_keep_distinct_source_identities(self):
        value = copy.deepcopy(content.definition())
        for ident in ('M17030', 'M17030-1', 'M17030-2'):
            value['maps'][ident] = {}
        selected = content.map_exports(value)
        self.assertTrue(all(ident in selected for ident in ('M17030', 'M17030-1', 'M17030-2')))
        for ident in ('M17030-', 'M17030-x', 'M17030-1-2', 'M17030-1/../M17020', '../M17030-1'):
            invalid = copy.deepcopy(value)
            invalid['maps'][ident] = {}
            with self.subTest(ident=ident), self.assertRaisesRegex(ValueError, 'map identity'):
                content.map_exports(invalid)

    def test_passage_without_tlk_has_no_fabricated_dialogue(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(maps, 'ROOT', Path(temporary)), patch.object(maps, 'tlk_record') as parse:
                self.assertIsNone(maps.optional_map_tlk('M17016', {'assets': 'chapter', 'story': False}))
                parse.assert_not_called()
                with self.assertRaisesRegex(FileNotFoundError, 'Story map M17016 has no TLK source'):
                    maps.optional_map_tlk('M17016', {'assets': 'chapter', 'story': True})
                parse.assert_not_called()

    def test_optional_tlk_still_retains_existing_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'Map').mkdir()
            path = root / 'Map/m17030-2.TLK'
            path.write_bytes(b'original table')
            table = {'path': 'Map/m17030-2.TLK', 'index_nonzero': []}
            with patch.object(maps, 'ROOT', root), patch.object(maps, 'tlk_record', return_value=table) as parse:
                self.assertIs(maps.optional_map_tlk('M17030-2', {'assets': 'chapter', 'story': False}), table)
                parse.assert_called_once_with(path)

    def test_native_edges_are_selected_without_an_edge_list(self):
        descriptors = [dict(id=1, state_raw=0, filename_raw='M70020.DAT'),
                       dict(id=2, state_raw=2, filename_raw='M70020.DAT'),
                       dict(id=3, state_raw=0, filename_raw='M79999.DAT')]
        with patch.object(maps, 'transition_descriptors', return_value=(descriptors, [])):
            self.assertEqual(maps.physical_edges(['M70010'], {'M70010': object()}, ['M70010', 'M70020']),
                             [('M70010', 1, 'M70020')])

    def test_anm_control_map_comes_from_commands(self):
        commands = [dict(opcode=10, u32_plus5=0, filename='M70020.DAT')]
        self.assertEqual(story.program_control_map(commands, {'M70020': {}}, 'arbitrary-program-name'), 'M70020')
        with self.assertRaisesRegex(ValueError, 'unregistered control map'):
            story.program_control_map(commands, {}, 'arbitrary-program-name')
        commands.append(dict(opcode=10, u32_plus5=0, filename='M70010.DAT'))
        context = story.program_map_context(commands, {'M70010': {}, 'M70020': {}}, 'multi-map')
        self.assertEqual(context['control_maps'], ['M70020', 'M70010'])
        self.assertEqual(context['control_map'], 'M70010')
        self.assertEqual(context['caller_maps'], [])

    def test_no_load_anm_uses_actual_tlk_caller_without_filename_guess(self):
        tables = {'M17010': {'records': [dict(kind=1, id=91, text_raw='m17010-6.anm', source={'offset': 100})]}}
        context = story.program_map_context([], tables, 'm17010-6')
        self.assertEqual(context['maps'], ['M17010'])
        self.assertEqual(context['control_maps'], [])
        self.assertEqual(context['caller_maps'], ['M17010'])
        self.assertEqual(context['context_sources']['caller_records'][0]['record_id'], 91)
        with self.assertRaisesRegex(ValueError, 'one actual registered caller map'):
            story.program_map_context([], {'M17010': {}}, 'm17010-6')
        tables['M17020'] = tables['M17010']
        with self.assertRaisesRegex(ValueError, 'one actual registered caller map'):
            story.program_map_context([], tables, 'm17010-6')

    def test_real_no_map_anm_context_comes_from_tlk91(self):
        root = RUNTIME.parents[1]
        table = story.tlk_record(root / 'Map/m17010.TLK')
        native = story.anm_record(root / 'Animate/m17010-6.anm')
        commands = [dict(index=record['index'], opcode=record['opcode_raw']) for record in native['records']]
        context = story.program_map_context(commands, {'M17010': table}, 'm17010-6')
        self.assertEqual(context['control_maps'], [])
        self.assertEqual(context['control_map'], 'M17010')
        self.assertEqual(context['caller_maps'], ['M17010'])
        self.assertEqual(context['context_sources']['caller_records'][0]['record_id'], 91)

    def test_real_new_enemy_source_has_different_learned_indices(self):
        c, d, ai, view, blocks, primary, actor = enemies.prepare_role('014', enemies.read('forest_status'))
        self.assertEqual(ai['learned_indices'], [12, 13])
        self.assertEqual([v['chr_skill_index'] for v in [view['skill'], *view['alternate_skills']]], [12, 13])
        self.assertEqual(primary['original_skill_index'], 12)
        self.assertEqual(actor['source']['sha256'], c.sha256)
        self.assertEqual(set(blocks), {'014:12', '014:13'})
        self.assertEqual(view['idle']['interval_raw'], d.actions[view['idle']['action_index']]['interval_raw'])

    def test_new_enemy_unsupported_recovery_targeting_is_not_silently_enabled(self):
        # Generic mode0 status38 now shares the recovered source aggregator.
        # Its later allied recovery carrier still has no enemy dispatch path;
        # reject that actual unsupported operation before exporting any art.
        with self.assertRaisesRegex(ValueError, r'017 skill 18: unsupported carrier recovery targeting'):
            enemies.prepare_role('017', enemies.read('forest_status'))

    def test_existing_enemy_frame_order_timing_and_contacts_are_preserved(self):
        baseline = enemies.read('forest_full_battle_view')
        status = enemies.read('forest_status')
        for old in baseline['roles']:
            if old['id'] not in content.role_ids('enemy'): continue
            current = enemies.prepare_role(old['id'], status)[3]
            self.assertEqual(current['mirror'], old['mirror'])
            for pose in ('idle', 'reaction'):
                for field in ('frames', 'interval_raw', 'action_index'):
                    self.assertEqual(current[pose][field], old[pose][field])
            previous = {v['chr_skill_index']: v for v in [old['skill'], *old.get('alternate_skills', [])]}
            for view in [current['skill'], *current['alternate_skills']]:
                expected = previous[view['chr_skill_index']]
                self.assertEqual(len(view['segments']), len(expected['segments']))
                for segment, original in zip(view['segments'], expected['segments']):
                    for field in ('frames', 'interval_raw', 'action_index', 'event', 'movement_step_raw'):
                        self.assertEqual(segment[field], original[field])

    def test_sprite_without_indexed_channel_has_transparent_intrinsic(self):
        audit = SourceAudit((RUNTIME.parents[1] / 'Fight_Role/012.dgp').read_bytes())
        self.assertEqual(audit.indexed, [])
        raw, check = audit.sparse(0, True)
        self.assertEqual(raw, bytes(audit.width * audit.height * 4))
        self.assertEqual(check['covered_pixels'], 0)
        self.assertFalse(check['active'])


if __name__ == '__main__': unittest.main()
