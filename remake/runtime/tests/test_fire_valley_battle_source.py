"""Read-only admission checks for the actual Fire Valley scripted battle sources.

Verifies source closure, exact source graphics, native loaded-slot damage,
complete carrier contacts and periodic response/death execution. Temporary
exports stay isolated and original resources are never modified.
"""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
import export_party_combat as combat_export
import export_party_skills as skills_export
import export_skill_layers as layers_export
import export_combat_sample as combat
import export_enemy_content as enemy_export
from export_battle_view import sequence
from export_battle_stages import prepare_stage
from source.combat_resources import CHR
from source.dgp import DGP


NODE_CONTRACT = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runtimeContent} from './web/core/content_registry.mjs';
import {createPartyActors} from './web/core/party_attributes.mjs';
import {admitPartyMember} from './web/core/party_members.mjs';
import {compileNativeSequence,directSequence} from './web/core/skill_sequence.mjs';
import {resolveAction,createNativeRng} from './web/core/combat_rules.mjs';
import {NativeAssemblyOracle} from './tests/native_assembly_oracle.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8')),world=structuredClone(input.seed),content=structuredClone(runtimeContent);
const definition=world.source.role_definitions['004'];
content.roles['004']={side:'player',native_slot:3,source:{path:definition.path,sha256:definition.sha256},
 battle_skills:[{index:18,id:'004_18',handler:'direct'}],primary_skill:18};
assert.equal(admitPartyMember(world,'004',{definitions:world.source.role_definitions,content}).added,true);
const skill=input.skill,actors=createPartyActors(world,input.attributes,{'004':skill},null,content);
const template=actors.find(actor=>actor.id==='004'),compiled=compileNativeSequence({roles:[input.view],effects:[]},'004',directSequence(skill),[input.bank]);
assert.equal(compiled.steps.filter(step=>step.event).length,1);
assert.ok(compiled.steps.every(step=>step.pair?.source_frame===step.source_frame));
const contact=skill.actions.find(action=>action.contact_u32_raw_0x49);let comparisons=0;
for(const seed of [0,1,12345,0x20261024,0x7fffffff,0xffffffff]){
 const attacker=structuredClone(template),target=structuredClone(input.enemy);
 Object.assign(attacker,{current_skill:skill,class_raw:contact.class_raw,action_mask_raw:contact.action_mask_raw});
 const actual=resolveAction({attacker,target,skill,rng:createNativeRng(seed)});
 const oracle=new NativeAssemblyOracle(input.assembly.functions,[attacker,target],createNativeRng(seed));
 const native=oracle.run(0x41d990,[0,1,0x20000000,0]);
 assert.equal(actual.native_return,native.eax);assert.equal(actual.reaction,oracle.read(0x20000000));
 assert.deepEqual(actual.trace.filter(row=>row.kind==='rng').map(row=>row.raw),native.rng_calls);comparisons++;
}
process.stdout.write(JSON.stringify({comparisons,contacts:1}));
"""


NODE_BOSS_CONTRACT = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {compileNativeSequence,directSequence} from './web/core/skill_sequence.mjs';
import {resolveAction,createNativeRng,nativeEffectContextForTarget,validateNativeEffectBinding} from './web/core/combat_rules.mjs';
import {NativeAssemblyOracle} from './tests/native_assembly_oracle.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8')),getter=input.magic.records.find(r=>r.operation==='procedure_assembly'&&r.parameters.procedure==='0x501930');
const functions={...input.assembly.functions,'0x501930':getter.normalized_result.trim().split('\n')};
let comparisons=0,contacts=[];
for(const index of input.ai.learned_indices){
 const skill=input.ai.skills[index],compiled=compileNativeSequence(input.meta,'032',directSequence(skill),[input.bank]);
 contacts.push(compiled.steps.filter(step=>step.effect_contact).length);
 assert.ok(compiled.steps.filter(step=>step.command_raw===undefined).every(step=>step.pair?.source_frame===step.source_frame));
 validateNativeEffectBinding(skill,input.roles);
 if(index===11){
  assert.equal(Buffer.from(skill.fixed_raw_hex,'hex')[0x24],1);
  const controls=compiled.steps.filter(step=>step.visibility&&!step.visibility_end);
  assert.deepEqual(controls.map(s=>[s.command_raw,s.visibility.mode,s.visibility.complete_ticks,s.visibility.clock_ms,s.duration_ms]),[[8,9,39,80,3120],[7,1,7,60,420]]);
 }
 for(const template of input.players)for(const seed of [0,1,12345,0xffffffff]){
  const attacker=structuredClone(input.enemy),target=structuredClone(template),contact=Buffer.from(skill.actions.find(a=>a.type_raw===1&&a.u32_at_0x01_raw===4&&Buffer.from(a.raw_hex,'hex').readUInt32LE(0x49)).raw_hex,'hex');
  attacker.current_skill=skill;attacker.class_raw=contact[0x24];attacker.action_mask_raw=contact[0x78];
  // The currently playing target pose deliberately differs from slot7..11.
  const context=nativeEffectContextForTarget(skill,target,input.roles);
  assert.equal(context.effect_target_skill.fixed_raw_hex,input.roles[target.id].skills[index].fixed_raw_hex);
  assert.notEqual(context.effect_target_skill.fixed_raw_hex,target.current_skill.fixed_raw_hex);
  const rng=createNativeRng(seed),nativeRng=createNativeRng(seed),actual=resolveAction({attacker,target,skill,rng,context});
  const oracle=new NativeAssemblyOracle(functions,[attacker,target],nativeRng);oracle.write(0x55e3fec,index);
  for(const [slot,actor]of [attacker,target].entries()){
   const table=0x23000000+slot*0x100000;oracle.write(0x524a9dc+slot*0x30274,table);
   const raw=Buffer.from(slot===0?skill.fixed_raw_hex:input.roles[target.id].skills[index].fixed_raw_hex,'hex');
   raw.forEach((value,at)=>oracle.write(table+index*0x421+at,value,1));
  }
  const native=oracle.run(0x41d990,[0,1,0x20000000,1]);
  assert.equal(actual.native_return,native.eax,`${index}/${target.id}/${seed}`);assert.equal(actual.reaction,oracle.read(0x20000000));
  assert.equal(actual.after_settled_raw,oracle.read(0x521f69d+0x30274,1));
  assert.deepEqual(actual.trace.filter(row=>row.kind==='rng').map(row=>row.raw),native.rng_calls);assert.equal(rng.state,nativeRng.state);comparisons++;
 }
}
assert.deepEqual(contacts,[1,1,1,1,18]);process.stdout.write(JSON.stringify({comparisons,contacts}));
"""


NODE_BOSS_CONTROLLER = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {BattleController} from './web/core/combat.mjs';
import {applyNativeSkillStatus} from './web/core/battle_status.mjs';
import {selectNativeNormalReaction,finalizeNativeDeath} from './web/core/battle_reactions.mjs';
import {compileNativeSequence,directSequence} from './web/core/skill_sequence.mjs';
import {resolveAction,applyNativeDamage,createNativeRng} from './web/core/combat_rules.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8')),copy=structuredClone;
const roles=input.reactions.roles;Object.assign(roles,input.roles);input.reactions.party_native_bundle={path:'source CHR fixture'};
const active=input.players,enemy=copy(input.enemy);enemy.id='enemy-0';enemy.resource_id='032';
const skills=Object.fromEntries(active.map(a=>{const s=copy(input.roles[a.id].skills[0]);s.id=`${a.id}_fixture`;s.evidence=[input.reactions.evidence['0x51c640']];s.mp_cost=0;return [s.id,s];}));
const tables={'enemy-0':{}};
for(const index of input.ai.roles['032'].learned_indices){const s=copy(input.ai.roles['032'].skills[index]);s.id=`enemy-0_skill_${index}`;s.actor_id='enemy-0';skills[s.id]=s;tables['enemy-0'][index]=s.id;}
for(const a of active){const idle=copy(skills[`${a.id}_fixture`]);input.scheduler.idle_skills[a.id]=idle;}
let frameAt=0,sourceContacts=[];
const battle=new BattleController({world:{value:{revision:0,party:active.map(a=>({id:a.id}))}},id:()=> 'stage12-controller',now:()=>0,
 resolveAction,applyDamage:applyNativeDamage,playSequence:async (action,callbacks)=>{
  const compiled=compileNativeSequence(input.meta,'032',action.plan);let record=-1;
  for(const step of compiled.steps){
   if(step.plan_record_index!==record||step.visibility_end){callbacks.onRecord(step);record=step.plan_record_index;}
   if(step.event)sourceContacts.push(callbacks.onContact({...step,actor_id:action.actor_id,target_id:action.target_id,contact_key:`source:${step.index}`,presentation_time_ms:frameAt}));
   frameAt+=step.duration_ms??65;
  }
  callbacks.onPrimaryEnd(frameAt);return {completed:true};
 }});
battle.start({actors:[...active,enemy],skills,order:[...active.map(a=>a.id),enemy.id],enemy_skill_ids:{[enemy.id]:'enemy-0_skill_7'},rng:createNativeRng(0x20261025),
 source:{kind:'source-stage12'},scheduler_data:input.scheduler,enemy_ai_data:input.ai,enemy_skill_tables:tables,complete_contacts:true,reaction_data:input.reactions,status_data:input.status});
await battle.performSequence(battle.actor('enemy-0'),battle.actor('001'),battle.skills['enemy-0_skill_11'],directSequence(battle.skills['enemy-0_skill_11']));
assert.equal(sourceContacts.length,18);assert.ok(sourceContacts.every(result=>result.group_results.length===4));
const contacts=battle.state.history[0].contacts;assert.equal(contacts.length,72);
assert.deepEqual(contacts.map(c=>c.source.target_id),Array.from({length:18},()=>['001','002','004','005']).flat());
assert.equal(battle.actor('enemy-0').immune_raw,0);assert.equal(battle.actor('enemy-0').native_visibility.kind,'appear');assert.equal(battle.actor('enemy-0').native_visibility.complete,true);
assert.equal(new Set(contacts.map(c=>c.key)).size,72);assert.equal(battle.state.phase,'charging');

const pulseBattle=new BattleController({world:{value:{revision:0,party:active.map(a=>({id:a.id}))}},id:()=> 'stage12-periodic',now:()=>0,resolveAction,applyDamage:applyNativeDamage});
pulseBattle.start({actors:[...active,enemy],skills,order:[...active.map(a=>a.id),enemy.id],enemy_skill_ids:{[enemy.id]:'enemy-0_skill_7'},rng:createNativeRng(12345),source:{kind:'source-stage12'},
 scheduler_data:input.scheduler,reaction_data:input.reactions,status_data:input.status,lifecycle_enabled:true});
pulseBattle.scheduleReady=()=>null;
for(const event of copy(pulseBattle.state.lifecycle_events))assert.equal(pulseBattle.ackLifecycle(event),true);
const victim=pulseBattle.actor('001'),applied=applyNativeSkillStatus({actor:victim,skill:pulseBattle.skills['enemy-0_skill_8'],data:input.status,rng:pulseBattle.rng,now:0});
Object.assign(victim,applied.actor);
function forcePulse(){const slot=victim.native_status_slots.find(slot=>Buffer.from(slot.raw_hex,'hex')[1]===15),raw=Buffer.from(slot.raw_hex,'hex');raw.writeInt32LE(pulseBattle.state.scheduler.threshold,0x1b);slot.raw_hex=raw.toString('hex');}
forcePulse();const hpBefore=victim.raw_hp,expectedRng=createNativeRng(pulseBattle.rng.state),reaction=selectNativeNormalReaction({actor:copy(victim),ident:1,data:input.reactions,rng:expectedRng});
for(const now of [20,40,60,80])assert.equal(pulseBattle.advanceClock(now),true);assert.equal(victim.raw_hp,hpBefore-100);assert.equal(pulseBattle.rng.state,expectedRng.state);
assert.equal(pulseBattle.state.lifecycle_events.length,1);assert.equal(pulseBattle.state.lifecycle_events[0].kind,'response');assert.equal(pulseBattle.state.lifecycle_events[0].source_skill_index,reaction.source_skill_index);
assert.equal(victim.native_active,true);assert.equal(pulseBattle.ackLifecycle(pulseBattle.state.lifecycle_events[0]),true);assert.equal(victim.native_active,false);
victim.raw_hp=50;victim.raw_by_address['0x0524a701']=50;victim.hp.current=50;forcePulse();
const dead=copy(victim);dead.state_raw=4;const expectedDeathRng=createNativeRng(pulseBattle.rng.state);finalizeNativeDeath({actor:dead,data:input.reactions,rng:expectedDeathRng});
for(const now of [100,120,140,160])assert.equal(pulseBattle.advanceClock(now),true);assert.equal(victim.state_raw,5);assert.equal(victim.raw_hp,0);assert.equal(pulseBattle.rng.state,expectedDeathRng.state);
assert.ok(victim.native_status_slots.every(slot=>Buffer.from(slot.raw_hex,'hex')[1]===0));assert.equal(pulseBattle.state.lifecycle_events[0].kind,'death');
process.stdout.write(JSON.stringify({carrier_contacts:18,target_contacts:72,actor_order:['001','002','004','005'],visibility_completed:true}));
"""


@unittest.skipUnless((ROOT / 'Fight_Role/032.CHR').exists(), 'Original scripted battle sources unavailable')
class FireValleyBattleSource(unittest.TestCase):
    def test_tlk31_has_one_literal_enemy_and_no_invented_battle_seed_or_stg(self):
        source = json.loads((RUNTIME / 'web/data/chapter_story.json').read_text('utf-8'))
        row = next(row for row in source['maps']['M17030-2']['records'] if row['id'] == 31)
        raw = bytes.fromhex(row['raw_hex'])
        self.assertEqual(raw[0], 5)
        tokens = [raw[0x37 + i * 20:0x37 + (i + 1) * 20].split(b'\0')[0].decode('ascii') for i in range(7)]
        self.assertEqual(tokens, ['stage12.scn', '032.dgp', '', '', '', '', ''])
        self.assertTrue(any(raw[0x60:0x73]), 'Empty C strings retain historical tail bytes')
        self.assertEqual((row['mutation_type'], row['mutation_index'], row['mutation_bit'], row['if_true'], row['next']), (0, 0, 0, 0, 0))
        self.assertEqual(row['speaker'], 500)
        native = json.loads((RUNTIME / 'evidence/chapter_native.json').read_text('utf-8'))
        proof = next(row for row in native['records'] if row['evidence_id'] == 'ev_b461c69890cc7ddb06ce338bd8ef964a076d7203851a685b3a5c68a55af12198')
        self.assertIn('local_1f4[1] < 6', proof['normalized_result'])
        self.assertIn('thunk_FUN_004451c0()', proof['normalized_result'])

    def test_source_stage12_layers_decode_and_fit_the_recovered_projection(self):
        stage = prepare_stage('stage12', {'schema': 'seventh-seal-battle-stage'})
        self.assertEqual(stage['horizon'], 175)
        self.assertEqual([row['id'] for row in stage['rows']], ['FS12A', 'FG12A', 'FB12A2', 'FB12A'])
        self.assertEqual([row['graphics'].frame_count for row in stage['rows']], [1, 1, 1, 1])
        for row in stage['rows']:
            graphics, audit = row['graphics'], row['audit']
            for index in range(graphics.frame_count):
                rgba, _ = audit.sparse(index, False)
                self.assertEqual(graphics.decode(index).tobytes(), rgba)

    def test_boss_source_reward_and_defeat_contracts_retain_the_original_scripted_battle_rules(self):
        role = CHR(ROOT / 'Fight_Role/032.CHR')
        self.assertEqual(role.name, '唯爱拉')
        self.assertEqual(struct.unpack_from('<I', role.header, 0x34)[0], 220000)
        self.assertEqual(struct.unpack_from('<I', role.header, 0x20A)[0], 0)
        self.assertEqual(struct.unpack_from('<i', role.header, 0x28)[0], 100000)
        self.assertEqual(struct.unpack_from('<6i', role.header, 0xE8), (347, 0, 0, 0, 0, 0))
        item = (ROOT / 'SYSTEM/Object.ITM').read_bytes()[0x61C + 346 * 0x3BF:0x61C + 347 * 0x3BF]
        self.assertEqual((item[0x24], item[0x14B], struct.unpack_from('<i', item, 0x158)[0]), (6, 0, -1))
        learned = [(s['index'], bytes.fromhex(s['fixed_raw_hex'])) for s in role.skills if bytes.fromhex(s['fixed_raw_hex'])[0x23]]
        self.assertEqual([index for index, _ in learned], [7, 8, 9, 10, 11])
        self.assertEqual([(raw[0x16C], raw[0x176]) for _, raw in learned], [(2, 2), (15, 0), (30, 0), (48, 0), (6, 0)])

    def test_004_source_direct_staff_and_responses_export_with_exact_pixels_and_native_damage(self):
        c, d = CHR(ROOT / 'Fight_Role/004.CHR'), DGP(ROOT / 'Fight_Role/004.dgp')
        skill = {**skills_export.source_skill(c, c.skills[18]), 'id': '004_18', 'battle_handler': 'direct'}
        self.assertEqual((skill['type_raw'], skill['learned_raw'], skill['mp_cost'], skill['target_side_raw']), (2, 1, 0, 0))
        self.assertEqual(bytes.fromhex(skill['fixed_raw_hex'])[0x16B:0x231], bytes(0xC6))
        response_indices = [i for i, source in enumerate(c.skills) if source['id_raw'] in (0, *skills_export.RESPONSE_IDS)]
        views = {i: sequence(c, d, i) for i in {*response_indices, 18}}
        views[18]['runtime_skill_id'] = '004_18'
        role = dict(id='004', name=c.name, frame_width=d.width, frame_height=d.height,
                    anchor=dict(x=d.anchor_raw[0], y=d.anchor_raw[1]), mirror=False, direction=0,
                    idle=views[0]['segments'][0], reaction=views[1]['segments'][0], skill=views[18],
                    alternate_skills=[], response_skills=[views[i] for i in response_indices if i != 0])
        boss = CHR(ROOT / 'Fight_Role/032.CHR')
        # Numeric attack input only. It does not register or execute the boss's
        # spell/status commands through the current direct enemy handler.
        source_skill = skills_export.source_skill(boss, boss.skills[7])
        combat.EXPECTED['Fight_Role/032.CHR'] = boss.sha256
        enemy = combat.actor_record('032', 'enemy', boss.header, boss.path, 8,
                                    {combat.address(n): 0 for n in combat.LINK_FIELDS}, source_skill)
        with tempfile.TemporaryDirectory(prefix='fire-valley-battle-source-', dir=RUNTIME) as temporary:
            runtime, web = Path(temporary), Path(temporary) / 'web'
            (web / 'data').mkdir(parents=True)
            (runtime / 'evidence').mkdir()
            seed = RUNTIME / 'web/data/opening_seed.json'
            shutil.copyfile(seed, web / 'data/opening_seed.json')
            for filename, _, _ in combat_export.EVIDENCE_REQUESTS.values():
                shutil.copyfile(RUNTIME / 'evidence' / filename, runtime / 'evidence' / filename)
            with patch.object(combat_export, 'RUNTIME', runtime), patch.object(combat_export, 'role_ids', return_value=('001', '004')), redirect_stdout(io.StringIO()):
                combat_export.export()
            sources, checks = {}, []
            with patch.multiple(skills_export, RUNTIME=runtime, WEB=web), patch.object(layers_export, 'WEB', web):
                skills_export.export_role_assets(role, c, d, sources, checks)
            self.assertTrue(checks)
            payload = dict(seed=json.loads(seed.read_text('utf-8')), skill=skill, view=role, enemy=enemy,
                           bank=json.loads((web / 'data/party_role_layers_004.json').read_text('utf-8')),
                           attributes=json.loads((web / 'data/party_combat.json').read_text('utf-8')),
                           assembly=json.loads((RUNTIME / 'evidence/turn_rules_assembly_20261011.json').read_text('utf-8')))
            result = subprocess.run(['node', '--input-type=module', '-e', NODE_CONTRACT], cwd=RUNTIME,
                                    input=json.dumps(payload), encoding='utf-8', capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), dict(comparisons=6, contacts=1))


    def test_032_all_carriers_exact_source_layers_same_index_damage_and_visibility_waits(self):
        c, d, ai, role, blocks, primary, enemy = enemy_export.prepare_role('032', {})
        self.assertEqual(ai['learned_indices'], [7, 8, 9, 10, 11])
        self.assertTrue(all(ai['skills'][index]['battle_handler'] == 'effect-carrier' for index in ai['learned_indices']))
        self.assertEqual(primary['effect_context']['effect_lookup'], 'same-index-source-table')
        roles, players = {}, []
        for ident in ['001', '002', '004', '005']:
            character = CHR(ROOT / f'Fight_Role/{ident}.CHR')
            roles[ident] = skills_export.source_role(character)
            idle = skills_export.source_skill(character, character.skills[0])
            combat.EXPECTED[f'Fight_Role/{ident}.CHR'] = character.sha256
            players.append(combat.actor_record(ident, 'player', character.header, character.path, 8,
                {combat.address(n): 0 for n in combat.LINK_FIELDS}, idle))
        with tempfile.TemporaryDirectory(prefix='fire-valley-boss-source-', dir=RUNTIME) as temporary:
            runtime, web = Path(temporary), Path(temporary) / 'web'
            sources, checks = {}, []
            meta = dict(roles=[role], effects=[])
            with patch.multiple(skills_export, RUNTIME=runtime, WEB=web), patch.object(layers_export, 'WEB', web):
                skills_export.export_role_assets(role, c, d, sources, checks, group='enemy')
                skills_export.export_effect_assets(meta, sources, checks, asset_group='enemy')
            self.assertTrue(checks)
            self.assertTrue({'_Blank68', '_m64fir1', 'm32Awz01', 'm32Awz02', 'm32Awz03', 'm32Awz04'}.issubset({effect['id'] for effect in meta['effects']}))
            payload = dict(ai=ai, roles=roles, players=players, enemy=enemy, meta=meta,
                bank=json.loads((web / 'data/enemy_role_layers_032.json').read_text('utf-8')),
                assembly=json.loads((RUNTIME / 'evidence/turn_rules_assembly_20261011.json').read_text('utf-8')),
                magic=json.loads((RUNTIME / 'evidence/party_magic_native.json').read_text('utf-8')))
            result = subprocess.run(['node', '--input-type=module', '-e', NODE_BOSS_CONTRACT], cwd=RUNTIME,
                input=json.dumps(payload), encoding='utf-8', capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), dict(comparisons=80, contacts=[1, 1, 1, 1, 18]))
        paths = enemy_export.source_files()
        self.assertTrue(all(f'Fight_Role/Status/{ident:03d}.dgp' in paths for ident in [2, 6, 15, 30, 48]))


    def test_032_controller_replays_all_18_carriers_in_roster_order_and_restores_visibility(self):
        c, d, ai, role, blocks, primary, enemy = enemy_export.prepare_role('032', {})
        status = enemy_export.read('forest_status')
        status['skills'].update(blocks)
        skills_export.extend_status_descriptors(status, blocks, {})
        roles, players = {}, []
        for ident in ['001', '002', '003', '004', '005', '006']:
            character = CHR(ROOT / f'Fight_Role/{ident}.CHR')
            roles[ident] = skills_export.source_role(character)
            if ident not in ['001', '002', '004', '005']:
                continue
            combat.EXPECTED[f'Fight_Role/{ident}.CHR'] = character.sha256
            players.append(combat.actor_record(ident, 'player', character.header, character.path, 8,
                {combat.address(n): 0 for n in combat.LINK_FIELDS}, roles[ident]['skills'][0]))
        roles['032'] = skills_export.source_role(c)
        role['actions'] = [dict(index=index, first_frame=action['first_frame'], frame_count=action['frames_per_direction'],
            native_raw_hex=d.raw_actions[index].hex()) for index, action in enumerate(d.actions)]
        effects = {}
        for source_skill in c.skills[7:12]:
            for action in source_skill['actions']:
                raw = bytes.fromhex(action['raw_hex'])
                if raw[0] != 1 or struct.unpack_from('<I', raw, 1)[0] != 4:
                    continue
                token = raw[9:29].split(b'\0')[0].decode('ascii')
                graphics = DGP(ROOT / f'Fight_Role/Effect/{token}')
                effects[Path(token).stem] = dict(id=Path(token).stem, native_raw_hex=graphics.raw_actions[0].hex(), frames=list(range(graphics.frame_count)))
        full_ai = enemy_export.read('forest_ai')
        full_ai['roles']['032'] = ai
        result = subprocess.run(['node', '--input-type=module', '-e', NODE_BOSS_CONTROLLER], cwd=RUNTIME,
            input=json.dumps(dict(roles=roles, players=players, enemy=enemy, status=status, ai=full_ai,
                scheduler=enemy_export.read('battle_scheduler'), reactions=enemy_export.read('party_reactions'), meta=dict(roles=[role], effects=list(effects.values())))),
            encoding='utf-8', capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), dict(carrier_contacts=18, target_contacts=72, actor_order=['001', '002', '004', '005'], visibility_completed=True))


if __name__ == '__main__':
    unittest.main()
