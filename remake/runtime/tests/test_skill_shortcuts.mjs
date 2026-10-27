import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WorldStore,encodeSave,decodeSave,validateWorld} from '../web/core/world.mjs';
import {skillShortcuts,changeSkillShortcuts,validateSourceSkillShortcuts,battleMenuSkillOrder} from '../web/core/skill_shortcuts.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {effectiveSkillSource} from '../web/core/battle_skill_access.mjs';
import {admitPartyMember} from '../web/core/party_members.mjs';
const load=n=>JSON.parse(readFileSync(new URL(`../web/data/${n}.json`,import.meta.url),'utf8'));
const source=load('party_skills'),attributes=load('party_combat'),items=load('items');
const initial=JSON.parse(JSON.parse(readFileSync(new URL('../evidence/chapter_systems_home_save.json',import.meta.url),'utf8')).payload);

test('legacy progress retains exact source defaults without a migration write',()=>{
  const before=JSON.stringify(initial);
  assert.deepEqual(skillShortcuts(initial,source,'001'),[21,22,23]);
  assert.deepEqual(skillShortcuts(initial,source,'002'),[19,20,21]);
  assert.equal(JSON.stringify(initial),before);assert.equal(initial.skill_shortcuts,undefined);
});
test('role-owned shortcut changes affect the next actual party command order and round-trip save',async()=>{
  const store=new WorldStore(initial);changeSkillShortcuts(store,source,{roleId:'002',indices:[23,22,19]});
  const sample=createPartySample(store.snapshot(),attributes,source,null,items);
  assert.deepEqual(sample.source.player_command_order['002'].slice(0,3),['kai_duanyan','kai_liyan','kai_mieyan']);
  assert.deepEqual(skillShortcuts(store.value,source,'001'),[21,22,23]);
  const restored=await decodeSave(await encodeSave(store.value));
  assert.deepEqual(restored,store.value);validateSourceSkillShortcuts(restored,source);
  for(const key of ['inventory','equipment','party','source','flags','encounters'])assert.deepEqual(store.value[key],initial[key]);
});
test('unlearned, foreign and stale edits reject atomically; native repeated bindings remain allowed',()=>{
  const store=new WorldStore(initial),before=store.snapshot();
  assert.throws(()=>changeSkillShortcuts(store,source,{roleId:'001',indices:[19,22,21]}),/未学会/);
  assert.throws(()=>changeSkillShortcuts(store,source,{roleId:'001',indices:[21,22,48]}),/未学会/);
  assert.throws(()=>changeSkillShortcuts(store,source,{roleId:'001',indices:[21,22,37],expectedRevision:0}),/进度已变化/);
  assert.deepEqual(store.snapshot(),before);
  changeSkillShortcuts(store,source,{roleId:'001',indices:[22,22,22]});
  assert.deepEqual(skillShortcuts(store.value,source,'001'),[22,22,22]);
  assert.equal(battleMenuSkillOrder(store.value,source,source.skills,'001').filter(id=>id==='yantu').length,1);
});
test('new source commands enter shortcut order while named type0 and empty records cannot become commands through saved learned markers',()=>{
  assert.deepEqual(battleMenuSkillOrder(initial,source,source.skills,'001'),['yanci','yantu','001_23','yancui','001_24','001_25','yannuan']);
  const supported=structuredClone(initial);supported.skill_shortcuts={version:1,roles:{'001':[21,22,25]}};
  assert.deepEqual(battleMenuSkillOrder(supported,source,source.skills,'001').slice(0,3),['yanci','yantu','001_25']);
  for(const [roleId,index,slots]of [['001',0,[21,22,0]],['005',30,[19,20,30]]]){
    const unsupported=load('opening_seed');if(roleId!=='001')admitPartyMember(unsupported,roleId);
    unsupported.party.find(role=>role.id===roleId).skill_progress={version:1,learned_indices:[index]};
    const effective=effectiveSkillSource(source,unsupported),record=effective.roles[roleId].skills[index];
    assert.equal(record.learned_raw,1);assert.equal(record.type_raw,0);assert.equal(Boolean(record.name),roleId==='005');
    const sample=createPartySample(unsupported,attributes,source,null,items);
    assert.ok(!Object.values(sample.skills).some(skill=>skill.actor_id===roleId&&skill.original_skill_index===index));
    unsupported.skill_shortcuts={version:1,roles:{[roleId]:slots}};const before=structuredClone(unsupported);
    assert.throws(()=>battleMenuSkillOrder(unsupported,effective,sample.skills,roleId),/未学会|来源/);
    assert.throws(()=>createPartySample(unsupported,attributes,source,null,items),/未学会|来源/);
    assert.deepEqual(unsupported,before);
  }
  const forged=structuredClone(initial);forged.skill_shortcuts={version:1,roles:{'001':[21,22,48]}};
  assert.throws(()=>createPartySample(forged,attributes,source,null,items),/未学会/);
  forged.skill_shortcuts.roles['003']=[21,22,23];assert.throws(()=>validateWorld(forged),/角色或槽位/);
});
