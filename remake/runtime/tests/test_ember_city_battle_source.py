"""Isolated source closure for the actual Xiaoji rescue enemy042.

Exports into a temporary tree only. The source ID5 contact is followed through
each player's actual airborne/landing/get-up records, rather than merely
checking the enemy's CHR registration or replacing the normal damage rule.
"""
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
from source.dgp import DGP


CONTRACT = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolveAction,createNativeRng} from './web/core/combat_rules.mjs';
import {selectNativeSkills} from './web/core/forest_ai.mjs';
import {compileNativeSequence,directSequence} from './web/core/skill_sequence.mjs';
import {nativeReactionTargetAvailability,selectNativeNormalReaction} from './web/core/battle_reactions.mjs';
import {BattleController} from './web/core/combat.mjs';
import {BattleLifecyclePlayback} from './web/battle_lifecycle_view.mjs';
import {NativeAssemblyOracle} from './tests/native_assembly_oracle.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8')),copy=structuredClone;
let comparisons=0,aiPlans=0,admissions=0,currentPoses=0,landings=0;
const {ai,actor,meta,bank}=input;
for(const index of ai.learned_indices){
 const skill=ai.skills[index],compiled=compileNativeSequence(meta,'042',directSequence(skill),[bank]);
 assert.equal(compiled.steps.filter(step=>step.event).length,1);
 assert.ok(compiled.steps.every(step=>step.command_raw!==undefined||step.pair?.source_frame===step.source_frame));
 const contact=skill.actions.find(action=>Buffer.from(action.raw_hex,'hex').readUInt32LE(0x49)),raw=Buffer.from(contact.raw_hex,'hex');
 assert.equal(raw[0x62],index===19?5:1);
 for(const template of input.players){
  assert.equal(nativeReactionTargetAvailability({skill,target:template,data:input.reactions}).available,true);admissions++;
  for(const seed of [0,1,12345,0xffffffff]){
   const attacker=copy(actor),target=copy(template);
   Object.assign(attacker,{current_skill:skill,class_raw:raw[0x24],action_mask_raw:raw[0x78]});
   const rng=createNativeRng(seed),nativeRng=createNativeRng(seed),actual=resolveAction({attacker,target,skill,rng});
   const oracle=new NativeAssemblyOracle(input.assembly.functions,[attacker,target],nativeRng),native=oracle.run(0x41d990,[0,1,0x20000000,0]);
   assert.equal(actual.native_return,native.eax,`${index}/${target.id}/${seed}`);
   assert.equal(actual.reaction,oracle.read(0x20000000));
   assert.deepEqual(actual.trace.filter(row=>row.kind==='rng').map(row=>row.raw),native.rng_calls);
   assert.equal(rng.state,nativeRng.state);comparisons++;
  }
 }
}
// The learned type0 ID19 counter is not a normal AI command. Normal loading
// clears the CHR combination codes, including the source flags0x31 skills.
for(let roll=0;roll<100;roll++)for(const fallback of [0,1,2]){
 const draws=[0,roll,fallback],selection=selectNativeSkills({actor:{side_raw:0,status_flags_raw:0},role:ai,rng:()=>draws.shift()});
 assert.equal(selection.kind,'single');assert.ok([15,16,19].includes(selection.skill_indices[0]));
 if(roll<20)assert.equal(selection.skill_indices[0],15);
 else if(roll<40)assert.equal(selection.skill_indices[0],16);
 else if(roll<50)assert.equal(selection.skill_indices[0],19);
 else assert.equal(selection.skill_indices[0],[15,16,19][fallback]);
 assert.equal(compileNativeSequence(meta,'042',directSequence(ai.skills[selection.skill_indices[0]]),[bank]).steps.filter(step=>step.event).length,1);aiPlans++;
}
// Every exposed player command can also reach the hunter's actual response.
for(const [id,role]of Object.entries(input.playerRoles))for(const index of input.exposed[id]){
 assert.equal(nativeReactionTargetAvailability({skill:role.skills[index],target:actor,data:{roles:{'042':input.enemyRole}}}).available,true,`${id}:${index} -> 042`);admissions++;
}
// First select ID5 from the enemy's actual +62 contact under every possible
// current player pose, then execute the complete source timeline via the
// shared controller bridge and lifecycle owner. No height/HP/RNG is injected.
for(const template of input.players){
 const role=input.playerRoles[template.id];
 for(const current of role.skills){
  const target={...copy(template),current_skill:copy(current),native_active:false,state_raw:0,immune_raw:0,
   reaction_special_gate_raw:0,native_z_raw:0,current_target_id:null,status_flags_raw:0};
  const response=selectNativeNormalReaction({actor:target,ident:5,data:input.reactions,rng:()=>0});
  assert.equal(response.skill.original_id_raw,5);currentPoses++;
 }
 let clock=0,draws=0;
 const target={...copy(template),native_active:false,state_raw:0,immune_raw:0,settled_raw:0,reaction_inhibit_raw:0,
  reaction_special_gate_raw:0,reaction_busy_raw:0,status_flags_raw:0,native_z_raw:0,life_epoch:0,current_target_id:null,
  native_x_raw:140,native_y_raw:200,native_home_x_raw:140,native_home_y_raw:200,charge:{gauge:0,delay:0,recovery:0,recovery_ticks:0}};
 const response=selectNativeNormalReaction({actor:target,ident:5,data:input.reactions,rng:()=>0});Object.assign(target,response.after);
 const core=Object.create(BattleController.prototype);
 Object.assign(core,{state:{id:'hunter-launch',phase:'action',actors:[target],lifecycle_events:[],scheduler:{threshold:10000}},
  schedulerData:input.scheduler,reactionData:input.reactions,lifecycleEnabled:true,lifecycleSequence:0,verticalClocks:new Map(),
  rng:()=>{draws++;return 0;},log(){},now:()=>clock,publish(){},refreshCommandState(){}});
 core.queueLifecycle(target,response);
 const life=new BattleLifecyclePlayback({roles:input.playerLives},{nativeBridge:()=>({
  record:raw=>core.nativeSourceRecord(target.id,raw),begin:(raw,at)=>core.beginNativeVertical(target.id,raw,at),
  advance:at=>core.advanceNativeVerticals(at),state:()=>core.nativeVerticalFor(target.id)})});
 const roster=[{id:target.id,resource_id:target.id,side:'player'}],seen=[],z=[];
 for(let tick=0;tick<2000&&core.state.lifecycle_events.length;tick++,clock+=20){
  const before=target.current_skill.original_id_raw;if(seen.at(-1)!==before)seen.push(before);
  core.advanceNativeVerticals(clock);
  life.advance({id:'hunter-launch',actors:[target],lifecycle_events:core.state.lifecycle_events},roster,clock);
  z.push(target.native_z_raw);
  for(const completed of life.drainCompleted())core.ackLifecycle(completed);
 }
 assert.deepEqual(seen,[5,8,4,6],template.id);assert.ok(z.some(height=>height<0),template.id);
 assert.equal(target.native_z_raw,0);assert.equal(target.native_active,false);assert.equal(Buffer.from(target.current_skill.fixed_raw_hex,'hex')[0],0);
 assert.equal(core.state.lifecycle_events.length,0);assert.equal(draws,4);landings++;
}
process.stdout.write(JSON.stringify({comparisons,aiPlans,admissions,currentPoses,landings}));
"""


class EmberCityBattleSourceTests(unittest.TestCase):
    def test_literal_rescue_battle_and_original_rewards(self):
        source = enemies.read('chapter_story')
        row = next(row for row in source['maps']['M71013']['records'] if row['id'] == 5)
        raw = bytes.fromhex(row['raw_hex'])
        tokens = [raw[0x37 + index * 20:0x37 + (index + 1) * 20].split(b'\0')[0].decode('ascii') for index in range(7)]
        self.assertEqual(tokens, ['stage07.scn', '042.dgp', '', '', '', '', ''])
        c = CHR(enemies.ROOT / 'Fight_Role/042.CHR')
        self.assertEqual(c.name, '猎杀者')
        self.assertEqual(c.sha256, 'e6165e6a8c0099485543a521e978e8943aef7f9c5b17711c64a7d4c7fc8c169b')
        self.assertEqual(struct.unpack_from('<i', c.header, 0x28)[0], 450)
        self.assertEqual(struct.unpack_from('<6i', c.header, 0xe8), (331, 0, 0, 0, 0, 0))
        item = (enemies.ROOT / 'SYSTEM/Object.ITM').read_bytes()[0x61c + 330 * 0x3bf:0x61c + 331 * 0x3bf]
        self.assertEqual((item[0x24], item[0x14b], struct.unpack_from('<i', item, 0x158)[0]), (5, 0, 10))

    def test_source_skills_ai_pixels_audio_and_six_player_lifecycle_closure(self):
        c, d, ai, view, blocks, primary, actor = enemies.prepare_role('042', {})
        self.assertEqual(ai['learned_indices'], [14, 15, 16, 19])
        self.assertEqual(actor['hp'], dict(current=7200, maximum=7200))
        self.assertTrue(all(ai['skills'][index]['battle_handler'] == 'direct' for index in ai['learned_indices']))
        self.assertEqual([blocks[f'042:{index}']['effect_id_raw'] for index in ai['learned_indices']], [0, 0, 0, 49])
        player_roles, players, exposed, player_lives = {}, [], {}, []
        for ident in ('001', '002', '003', '004', '005', '006'):
            character = CHR(enemies.ROOT / f'Fight_Role/{ident}.CHR')
            graphics = DGP(enemies.ROOT / f'Fight_Role/{ident}.dgp')
            role = skills.source_role(character)
            player_roles[ident] = role
            exposed[ident] = [row['index'] for row in enemies.definition()['roles'][ident]['battle_skills']]
            combat.EXPECTED[f'Fight_Role/{ident}.CHR'] = character.sha256
            players.append(combat.actor_record(ident, 'player', character.header, character.path, 8,
                {combat.address(name): 0 for name in combat.LINK_FIELDS}, role['skills'][0]))
            player_lives.append(dict(id=ident, side='player', skills=[lifecycle.export_sequence(character, graphics, source)
                for source in lifecycle.lifecycle_skills(character)[1]]))
        sound_tokens = [raw[0x56:0x6a].split(b'\0')[0].decode('ascii') for raw in d.raw_actions]
        self.assertEqual(len([token for token in sound_tokens if token]), 15)
        self.assertTrue(all((enemies.ROOT / 'sound' / token).is_file() for token in sound_tokens if token))
        with tempfile.TemporaryDirectory(prefix='ember-battle-source-', dir=RUNTIME) as temporary:
            runtime, web = Path(temporary), Path(temporary) / 'web'
            sources, checks = {}, []
            meta = dict(roles=[view], effects=[])
            with patch.multiple(skills, RUNTIME=runtime, WEB=web), patch.object(layers, 'WEB', web):
                skills.export_role_assets(view, c, d, sources, checks, group='enemy')
                skills.export_effect_assets(meta, sources, checks, asset_group='enemy')
            self.assertTrue(checks)
            self.assertEqual([row['id'] for row in meta['missing_effects']], ['DutyEg'])
            self.assertFalse(meta['missing_effects'][0]['source_exists'])
            self.assertTrue((enemies.ROOT / 'Fight_Role/Effect/_DutyEg.dgp').exists())
            reactions = enemies.read('party_reactions')
            # Source selection for the player targets needs no registration of
            # the attacker; use the complete currently registered reaction table.
            reactions['roles'].update(player_roles)
            scheduler = enemies.read('battle_scheduler')
            scheduler['idle_skills'].update(enemies.read('party_skills')['idle_skills'])
            result = subprocess.run(['node', '--input-type=module', '-e', CONTRACT], cwd=RUNTIME,
                input=json.dumps(dict(ai=ai, actor=actor, meta=meta, players=players,
                    bank=json.loads((web / 'data/enemy_role_layers_042.json').read_text('utf-8')),
                    enemyRole=skills.source_role(c), playerRoles=player_roles, playerLives=player_lives,
                    exposed=exposed, reactions=reactions, scheduler=scheduler,
                    assembly=json.loads((RUNTIME / 'evidence/turn_rules_assembly_20261011.json').read_text('utf-8')))),
                encoding='utf-8', capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            actual = json.loads(result.stdout)
            self.assertEqual(actual, dict(comparisons=96, aiPlans=300,
                admissions=24 + sum(map(len, exposed.values())), currentPoses=sum(role['skill_count'] for role in player_roles.values()), landings=6))


if __name__ == '__main__':
    unittest.main()
