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
from export_skill_layers import SourceAudit


class ContentExporterTests(unittest.TestCase):
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
        with self.assertRaisesRegex(ValueError, 'one registered control map'):
            story.program_control_map(commands, {}, 'arbitrary-program-name')
        commands.append(dict(opcode=10, u32_plus5=0, filename='M70010.DAT'))
        with self.assertRaises(ValueError): story.program_control_map(commands, {'M70010': {}, 'M70020': {}}, 'multi-map')

    def test_real_new_enemy_source_has_different_learned_indices(self):
        c, d, ai, view, blocks, primary, actor = enemies.prepare_role('014', enemies.read('forest_status'))
        self.assertEqual(ai['learned_indices'], [12, 13])
        self.assertEqual([v['chr_skill_index'] for v in [view['skill'], *view['alternate_skills']]], [12, 13])
        self.assertEqual(primary['original_skill_index'], 12)
        self.assertEqual(actor['source']['sha256'], c.sha256)
        self.assertEqual(set(blocks), {'014:12', '014:13'})
        self.assertEqual(view['idle']['interval_raw'], d.actions[view['idle']['action_index']]['interval_raw'])

    def test_new_enemy_unsupported_status_is_not_silently_enabled(self):
        with self.assertRaisesRegex(ValueError, r'017 skill 15: unsupported status handler 38'):
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
