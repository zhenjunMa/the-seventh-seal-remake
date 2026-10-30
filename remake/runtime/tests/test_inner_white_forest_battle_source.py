"""Source admission for the sealed-forest024/041 group; temporary media only."""
from pathlib import Path
import json
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
import export_enemy_content as enemies
import export_party_skills as skills
import export_skill_layers as layers
import export_battle_lifecycle as lifecycle
import export_combat_sample as combat
from source.combat_resources import CHR


CONTRACT = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolveAction,createNativeRng} from './web/core/combat_rules.mjs';
import {compileNativeSequence,directSequence} from './web/core/skill_sequence.mjs';
import {nativeReactionTargetAvailability} from './web/core/battle_reactions.mjs';
import {selectNativeSkills,selectNativeTarget} from './web/core/forest_ai.mjs';
import {NativeAssemblyOracle} from './tests/native_assembly_oracle.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8')),copy=structuredClone;let comparisons=0,admissions=0;
for(const role of input.enemies){
 for(const index of role.ai.learned_indices){
  const skill=role.ai.skills[index],compiled=compileNativeSequence(role.meta,role.ai.id,directSequence(skill),[role.bank]);
  assert.equal(compiled.steps.filter(step=>step.event).length,role.ai.id==='041'&&[15,16,17].includes(index)?2:1,`${role.ai.id}:${index}`);
  if(skill.battle_handler==='native-support'){
   assert.equal(index,21);assert.equal(skill.effect_context,undefined);
   const draws=[99,90],selected=selectNativeSkills({actor:{side_raw:0,status_flags_raw:0},role:role.ai,rng:()=>draws.shift()});
   assert.deepEqual(selected.skill_indices,[21]);assert.equal(selected.target_side_raw,1);
   const roster=[...input.players,role.actor,{...copy(role.actor),id:'other-enemy'},
    {...copy(role.actor),id:'dead-enemy',state_raw:5}];
   const choice=selectNativeTarget({actors:roster.map(actor=>({...actor,reaction_busy_raw:0,status_flags_raw:0})),actor_id:role.actor.id,target_side_raw:1,rng:()=>1});
   assert.deepEqual(choice.candidates.map(row=>row.id),[role.actor.id,'other-enemy']);
   assert.equal(choice.target_id,'other-enemy');continue;
  }
  const contacts=skill.actions.filter(action=>action.type_raw===0&&Buffer.from(action.raw_hex,'hex').readUInt32LE(0x49));
  for(const template of input.players){
   assert.equal(nativeReactionTargetAvailability({skill,target:template,data:input.reactions}).available,true);admissions++;
   for(const contact of contacts)for(const seed of [0,1,12345,0xffffffff]){
    const raw=Buffer.from(contact.raw_hex,'hex');
    const attacker=copy(role.actor),target=copy(template);
    Object.assign(attacker,{current_skill:skill,class_raw:raw[0x24],action_mask_raw:raw[0x78]});
    const rng=createNativeRng(seed),nativeRng=createNativeRng(seed),actual=resolveAction({attacker,target,skill,rng});
    const oracle=new NativeAssemblyOracle(input.assembly.functions,[attacker,target],nativeRng),native=oracle.run(0x41d990,[0,1,0x20000000,0]);
    assert.equal(actual.native_return,native.eax,`${role.ai.id}:${index}/${target.id}/${seed}`);
    assert.equal(actual.reaction,oracle.read(0x20000000));
    assert.deepEqual(actual.trace.filter(row=>row.kind==='rng').map(row=>row.raw),native.rng_calls);
    assert.equal(rng.state,nativeRng.state);comparisons++;
   }
  }
 }
}
process.stdout.write(JSON.stringify({comparisons,admissions}));
"""


class InnerWhiteForestBattleSourceTests(unittest.TestCase):
    def test_literal_sealed_forest_group_retains_empty_source_slots(self):
        story = enemies.read('chapter_story')
        record = next(row for row in story['maps']['M70078_2']['records'] if row['id'] == 6)
        raw = bytes.fromhex(record['raw_hex'])
        tokens = [raw[0x37 + index * 20:0x37 + (index + 1) * 20].split(b'\0')[0].decode('ascii') for index in range(7)]
        self.assertEqual(tokens, ['stage03.scn', '041.dgp', '', '041.dgp', '', '024.dgp', ''])

    def test_024_landing_uses_chr_range_beyond_declared_explicit_count(self):
        c = CHR(enemies.ROOT / 'Fight_Role/024.CHR')
        d = enemies.DGP(enemies.ROOT / 'Fight_Role/024.dgp')
        raw = d.raw_actions[4]
        self.assertEqual((raw[0xd], struct.unpack_from('<I', raw, 0x12)[0], raw[0xe]), (0, 2, 5))
        result = lifecycle.export_sequence(c, d, c.skills[4])
        self.assertEqual(result['segments'][0]['frames'], [0, 0, 0, 0, 0])
        self.assertEqual([step['source_frame'] for step in result['timeline']], [37] * 5)
        script = r"""
import assert from 'node:assert/strict';import fs from 'node:fs';
import {compileNativeSequence,directSequence} from './web/core/skill_sequence.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8')),plan=directSequence(input.skill);plan.allow_no_contacts=true;
const compiled=compileNativeSequence({roles:[input.role],effects:[]},'024',plan);
assert.deepEqual(compiled.steps.map(step=>step.source_frame),[37,37,37,37,37]);
"""
        action = dict(index=4, first_frame=37, frame_count=5, native_raw_hex=raw.hex())
        process = subprocess.run(['node', '--input-type=module', '-e', script], cwd=RUNTIME,
            input=json.dumps(dict(skill=skills.source_role(c)['skills'][4], role=dict(id='024', actions=[action]))),
            encoding='utf-8', capture_output=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        retained = json.loads((RUNTIME / 'evidence/forest_scheduler_native_20261011.json').read_text('utf-8'))
        proof = next(row for row in retained['records'] if row['evidence_id'] == 'ev_66f82c795bc2c5392a4af502e71da424a6f4e6b2c796a8bcc66a61f2d38eec29')
        self.assertIn('0x16 +', proof['normalized_result'])
        self.assertNotIn('0x12 +', proof['normalized_result'])

    def test_enemy_pixels_audio_all_commands_and_native_direct_damage(self):
        players, reactions, prepared = [], enemies.read('party_reactions'), []
        for ident in ('001', '002', '003', '004', '005', '006'):
            character = CHR(enemies.ROOT / f'Fight_Role/{ident}.CHR')
            role = skills.source_role(character)
            reactions['roles'][ident] = role
            combat.EXPECTED[f'Fight_Role/{ident}.CHR'] = character.sha256
            players.append(combat.actor_record(ident, 'player', character.header, character.path, 8,
                {combat.address(name): 0 for name in combat.LINK_FIELDS}, role['skills'][0]))
        with tempfile.TemporaryDirectory(prefix='inner-forest-battle-source-', dir=RUNTIME) as temporary:
            runtime, web = Path(temporary), Path(temporary) / 'web'
            for ident, maximum, learned, experience, drops in [
                    ('024', 15000, [14, 15, 17, 18], 800, (331, 399, 268, 0, 0, 0)),
                    ('041', 5000, [14, 15, 16, 17, 21], 500, (331, 0, 0, 0, 0, 0))]:
                c, d, ai, view, blocks, _, actor = enemies.prepare_role(ident, {})
                self.assertEqual(ai['learned_indices'], learned)
                self.assertEqual(actor['hp'], dict(current=maximum, maximum=maximum))
                self.assertEqual(struct.unpack_from('<i', c.header, 0x28)[0], experience)
                self.assertEqual(struct.unpack_from('<6i', c.header, 0xe8), drops)
                self.assertTrue(all(row['effect_id_raw'] == 0 for row in blocks.values()))
                for source in lifecycle.lifecycle_skills(c)[1]:
                    lifecycle.export_sequence(c, d, source)
                for raw in d.raw_actions:
                    token = raw[0x56:0x6a].split(b'\0')[0].decode('ascii')
                    if token:
                        self.assertTrue((enemies.ROOT / 'sound' / token).is_file(), token)
                meta, sources, checks = dict(roles=[view], effects=[]), {}, []
                with patch.multiple(skills, RUNTIME=runtime, WEB=web), patch.object(layers, 'WEB', web):
                    skills.export_role_assets(view, c, d, sources, checks, group='enemy')
                    skills.export_effect_assets(meta, sources, checks, asset_group='enemy')
                self.assertTrue(checks)
                self.assertEqual([row['id'] for row in meta['missing_effects']], ['SLLN_Nm'] if ident == '041' else [])
                self.assertTrue(all(not row['source_exists'] for row in meta['missing_effects']))
                prepared.append(dict(ai=ai, actor=actor, meta=meta,
                    bank=json.loads((web / f'data/enemy_role_layers_{ident}.json').read_text('utf-8'))))
            result = subprocess.run(['node', '--input-type=module', '-e', CONTRACT], cwd=RUNTIME,
                input=json.dumps(dict(enemies=prepared, players=players, reactions=reactions,
                    assembly=json.loads((RUNTIME / 'evidence/turn_rules_assembly_20261011.json').read_text('utf-8')))),
                encoding='utf-8', capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), dict(comparisons=264, admissions=48))


if __name__ == '__main__':
    unittest.main()
