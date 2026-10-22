import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WorldStore,encodeSave,decodeSave,validateWorld} from '../web/core/world.mjs';
import {skillShortcuts,changeSkillShortcuts,validateSourceSkillShortcuts,battleMenuSkillOrder} from '../web/core/skill_shortcuts.mjs';
import {createPartySample} from '../web/party_sample.mjs';
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
test('unsupported source defaults are retained without invented actions; forged saves are rejected at the source boundary',()=>{
  assert.deepEqual(battleMenuSkillOrder(initial,source,source.skills,'001'),['yanci','yantu','001_23','yancui']);
  const unsupported=structuredClone(initial);unsupported.skill_shortcuts={version:1,roles:{'001':[21,22,25]}};
  assert.equal(battleMenuSkillOrder(unsupported,source,source.skills,'001').includes('001_25'),false);
  const forged=structuredClone(initial);forged.skill_shortcuts={version:1,roles:{'001':[21,22,48]}};
  assert.throws(()=>createPartySample(forged,attributes,source,null,items),/未学会/);
  forged.skill_shortcuts.roles['003']=[21,22,23];assert.throws(()=>validateWorld(forged),/角色或槽位/);
});
