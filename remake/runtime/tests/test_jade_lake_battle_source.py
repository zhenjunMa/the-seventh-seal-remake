"""Source admission for ordinary lake enemies, without publishing shared exports."""
from pathlib import Path
import json
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
import {selectNativeSkills} from './web/core/forest_ai.mjs';
import {compileNativeSequence,directSequence} from './web/core/skill_sequence.mjs';
import {nativeReactionTargetAvailability} from './web/core/battle_reactions.mjs';
import {BattleLifecyclePlayback} from './web/battle_lifecycle_view.mjs';
import {BattleController} from './web/core/combat.mjs';
import {NativeAssemblyOracle} from './tests/native_assembly_oracle.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8')),copy=structuredClone;let comparisons=0,aiPlans=0,reactions=0,entries=0;
for(const enemy of input.enemies){
 const {ai,actor,view,bank,life}=enemy,meta={roles:[view],effects:[]};
 // Lifecycle adds the actual landing/get-up/return/ID5 atlases; no source
 // sprite is substituted when a player sends the enemy into another pose.
 for(const action of life.actions)if(!view.actions.some(a=>a.index===action.index))view.actions.push(action);
 for(const index of ai.learned_indices){
  const skill=ai.skills[index],compiled=compileNativeSequence(meta,actor.id,directSequence(skill),[bank]);
  assert.equal(compiled.steps.filter(step=>step.event).length,1);
  assert.ok(compiled.steps.every(step=>step.pair?.source_frame===step.source_frame));
  const contact=skill.actions.find(a=>Buffer.from(a.raw_hex,'hex').readUInt32LE(0x49));
  for(const target of input.players)for(const seed of [0,1,12345,0xffffffff]){
   const attacker=copy(actor),victim=copy(target),raw=Buffer.from(contact.raw_hex,'hex');
   Object.assign(attacker,{current_skill:skill,class_raw:raw[0x24],action_mask_raw:raw[0x78]});
   const rng=createNativeRng(seed),nativeRng=createNativeRng(seed),actual=resolveAction({attacker,target:victim,skill,rng});
   const oracle=new NativeAssemblyOracle(input.assembly.functions,[attacker,victim],nativeRng),native=oracle.run(0x41d990,[0,1,0x20000000,0]);
   assert.equal(actual.native_return,native.eax);assert.equal(actual.reaction,oracle.read(0x20000000));
   assert.deepEqual(actual.trace.filter(e=>e.kind==='rng').map(e=>e.raw),native.rng_calls);assert.equal(rng.state,nativeRng.state);comparisons++;
  }
 }
 // Their actual learned type_flags are0x1, so normal CHR loading zeros
 // combination codes. Exercise all weighted rolls and fallback choices.
 for(let roll=0;roll<100;roll++)for(const fallback of [0,1]){
  const draws=[0,roll,fallback],selected=selectNativeSkills({actor:{side_raw:0,status_flags_raw:0},role:ai,rng:()=>draws.shift()});
  assert.equal(selected.kind,'single');assert.ok(selected.skill_indices.every(i=>ai.learned_indices.includes(i)));
  const compiled=compileNativeSequence(meta,actor.id,directSequence(ai.skills[selected.skill_indices[0]]),[bank]);
  assert.equal(compiled.steps.filter(step=>step.event).length,1);aiPlans++;
 }
 for(const role of Object.values(input.player_roles))for(const skill of role.skills)if(input.exposed[role.id].includes(skill.index)){
  assert.equal(nativeReactionTargetAvailability({skill,target:actor,data:{roles:{[actor.id]:enemiesRole(enemy)}}}).available,true,`${role.id}:${skill.index} -> ${actor.id}`);
 }
 function enemiesRole(enemy){return enemy.reactions;}
 for(const skill of enemy.reactions.skills.filter(skill=>[0,1,2,3,4,5,6,8,9,10,18,19].includes(skill.original_id_raw))){
  const plan=directSequence(skill);plan.allow_no_contacts=true;
  assert.ok(compileNativeSequence(meta,actor.id,plan).steps.length);reactions++;
 }
 // Test every random appearance branch at the actual source cursor. Fixed
 // mode6 consumes no RNG; pixels/progression use the real exported geometry.
 for(const draw of [0,1,2])for(const index of life.entry_skill_indices){
  const control=new BattleController({});control.state={actors:[{id:actor.id,immune_raw:1}]};let count=0;control.rng=()=>{count++;return draw;};
  const playback=new BattleLifecyclePlayback({roles:[life]},{nativeBridge:()=>({record:raw=>control.nativeSourceRecord(actor.id,raw),appearance:raw=>control.beginNativeAppearance(actor.id,raw),appearanceComplete:()=>control.completeNativeAppearance(actor.id)})});
  const event={token:'entry',actor_id:actor.id,life_epoch:0,kind:'entry',source_skill_index:index},roster=[{id:actor.id,resource_id:actor.id,side:'enemy'}],snapshot={id:'lake-entry',actors:[{id:actor.id,life_epoch:0}],lifecycle_events:[event]};
  for(let now=0;now<=20000;now+=20){playback.advance(snapshot,roster,now);if(playback.drainCompleted().length){entries++;break;}}
  assert.equal(playback.snapshot().active.length,0,`${actor.id} entry mode ${draw}`);assert.equal(control.actor(actor.id).immune_raw,0);
  assert.equal(count,actor.id==='014'?1:0);
 }
}
process.stdout.write(JSON.stringify({comparisons,aiPlans,reactions,entries}));
"""

APPEARANCE_CONTRACT = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {APPEARANCE_ALPHA_ADAPTER} from './web/battle_lifecycle_view.mjs';
import {NativeAssemblyOracle} from './tests/native_assembly_oracle.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8')),functions=Object.fromEntries(input.records.map(row=>[row.parameters.procedure,row.normalized_result.assembly]));
class RendererOracle extends NativeAssemblyOracle{external(target){if(target===0x54421c)return;super.external(target);}}
let thresholds=0,particles=0;
for(let elapsed=0;elapsed<=50;elapsed++){
 const oracle=new RendererOracle(functions,[],()=>assert.fail('appearance renderer RNG'));
 assert.equal(oracle.run(0x552437,[0x20000000,0,0,1,1,0,elapsed]).eax,Number(elapsed<APPEARANCE_ALPHA_ADAPTER.complete_elapsed_raw[7]));thresholds++;
}
for(const xs of [[],[0],[100],[100,101],[7,200,350]]){
 const oracle=new RendererOracle(functions,[],()=>assert.fail('appearance renderer RNG')),graphic=0x20000000,list=0x21000000;
 oracle.write(graphic+0xdd,list);oracle.write(graphic+0x4b,1);oracle.write(graphic+0x47,1000,2);oracle.write(graphic+0x49,1000,2);oracle.write(0x5659104,1);oracle.write(0x67c8d8,9999);
 for(const x of xs)oracle.run(0x551f03,[graphic,x,20,0x1111,-1]);
 assert.equal(oracle.read(graphic+0xc9),xs.length);
 for(let index=0;index<xs.length;index++)oracle.write(list+index*0x21+0x1d,oracle.read(list+index*0x21+0x1d)+oracle.read(0x67c8d8));
 let calls=0,active;do{active=oracle.run(0x552039,[graphic,0,0,1000,1000,0,1]).eax;calls++;}while(active&&calls<100);
 assert.equal(calls,xs.length?Math.max(1,Math.ceil((255+Math.max(...xs)-Math.min(...xs))/8)):1);particles++;
}
process.stdout.write(JSON.stringify({thresholds,particles}));
"""


class JadeLakeBattleSourceTests(unittest.TestCase):
    def test_appearance_completion_matches_original_renderer_instructions(self):
        native = json.loads((RUNTIME / 'evidence/jade_lake_battle_20261028/appearance_native.json').read_text('utf-8'))
        result = subprocess.run(['node', '--input-type=module', '-e', APPEARANCE_CONTRACT], cwd=RUNTIME,
            input=json.dumps(native), encoding='utf-8', capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), dict(thresholds=51, particles=5))

    def test_source_attack_ai_response_assets_and_every_entry_mode(self):
        player_roles, players, exposed = {}, [], {}
        for ident in ['001', '002', '003', '004', '005', '006']:
            c = CHR(enemies.ROOT / f'Fight_Role/{ident}.CHR')
            role = skills.source_role(c)
            player_roles[ident] = role
            exposed[ident] = [row['index'] for row in enemies.definition()['roles'][ident]['battle_skills']]
            combat.EXPECTED[f'Fight_Role/{ident}.CHR'] = c.sha256
            players.append(combat.actor_record(ident, 'player', c.header, c.path, 8,
                {combat.address(n): 0 for n in combat.LINK_FIELDS}, role['skills'][0]))
        prepared = []
        with tempfile.TemporaryDirectory(prefix='jade-lake-battle-source-', dir=RUNTIME) as temporary:
            runtime, web = Path(temporary), Path(temporary) / 'web'
            for ident, expected in [('014', [12, 13]), ('022', [14, 15])]:
                c, d, ai, view, blocks, primary, actor = enemies.prepare_role(ident, {})
                self.assertEqual(ai['learned_indices'], expected)
                self.assertTrue(all(ai['skills'][index]['battle_handler'] == 'direct' for index in expected))
                self.assertTrue(all(row['effect_id_raw'] == 0 for row in blocks.values()))
                sources, checks = {}, []
                with patch.multiple(skills, RUNTIME=runtime, WEB=web), patch.object(layers, 'WEB', web):
                    skills.export_role_assets(view, c, d, sources, checks, group='enemy')
                    meta = dict(roles=[view], effects=[])
                    skills.export_effect_assets(meta, sources, checks, asset_group='enemy')
                self.assertTrue(checks)
                self.assertEqual(meta['missing_effects'], [])
                with patch.multiple(lifecycle, RUNTIME=runtime, WEB=web, OUT=web / 'assets/battle_lifecycle'):
                    life = lifecycle.export_role(ident, [])
                prepared.append(dict(ai=ai, actor=actor, view=view, reactions=skills.source_role(c), life=life,
                    bank=json.loads((web / f'data/enemy_role_layers_{ident}.json').read_text('utf-8'))))
            result = subprocess.run(['node', '--input-type=module', '-e', CONTRACT], cwd=RUNTIME,
                input=json.dumps(dict(enemies=prepared, players=players, player_roles=player_roles, exposed=exposed,
                    assembly=json.loads((RUNTIME / 'evidence/turn_rules_assembly_20261011.json').read_text('utf-8')))),
                encoding='utf-8', capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), dict(comparisons=96, aiPlans=400, reactions=22, entries=6))


if __name__ == '__main__':
    unittest.main()
