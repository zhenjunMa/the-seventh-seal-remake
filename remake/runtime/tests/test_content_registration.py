"""Registration-driven exporter selection, using read-only original records."""
from pathlib import Path
import copy
import json
import sys
import unittest
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
import content_registration as content


class ContentRegistrationTests(unittest.TestCase):
    def test_declared_skills_preserve_existing_source_indices(self):
        registration = content.registration()
        commands = json.loads((RUNTIME / 'web/data/party_skills.json').read_text(encoding='utf-8'))
        self.assertEqual(set(content.role_ids('player')), set(commands['roles']))
        for field, key in [(False, 'skills'), (True, 'field_skills')]:
            bindings = content.skill_bindings(field=field)
            for ident, rows in bindings.items():
                for index, runtime_id in rows.items():
                    self.assertEqual(commands[key][runtime_id]['actor_id'], ident)
                    self.assertEqual(commands[key][runtime_id]['original_skill_index'], index)
        self.assertEqual(registration['party_limit'], 4)

    def test_new_role_is_selected_without_an_exporter_id_branch(self):
        registration = copy.deepcopy(content.registration())
        registration['roles']['003'] = dict(side='player', primary_skill=7,
            battle_skills=[dict(index=7, id='003_7', handler='direct')])
        with patch.object(content, 'registration', return_value=registration):
            self.assertIn('003', content.role_ids('player'))
            self.assertEqual(content.skill_bindings()['003'], {7: '003_7'})
            registration['roles']['003']['battle_skills'][0]['handler'] = 'unknown'
            with self.assertRaises(AssertionError):
                content.skill_bindings()

    def test_registered_animation_handlers_preserve_current_source_sequences(self):
        from export_party_skills import enrich_sequence
        from combat_resources import CHR
        from dgp import DGP
        root = RUNTIME.parents[1]
        meta = json.loads((RUNTIME / 'web/data/party_battle_view.json').read_text(encoding='utf-8'))
        for ident, bindings in content.skill_bindings().items():
            chr_file, sprites = CHR(root / f'Fight_Role/{ident}.CHR'), DGP(root / f'Fight_Role/{ident}.dgp')
            role = next(row for row in meta['roles'] if row['id'] == ident)
            views = [role['skill'], *role.get('alternate_skills', [])]
            for index, runtime_id in bindings.items():
                current = next(row for row in views if row['runtime_skill_id'] == runtime_id)
                generated = enrich_sequence(chr_file, sprites, index, runtime_id)
                self.assertEqual(generated['segments'], current['segments'])
                self.assertEqual(generated.get('command_effects'), current.get('command_effects'))


if __name__ == '__main__':
    unittest.main()
