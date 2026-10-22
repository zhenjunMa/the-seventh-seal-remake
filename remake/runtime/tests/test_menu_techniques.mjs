import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {techniqueSlots,sourceTechniqueSlot,techniqueCandidates,changeTechniqueSlot,validateTechniqueBindingsState,TECHNIQUE_COMMANDS,createTechniqueCombination,renameTechniqueCombination,deleteTechniqueCombination,techniqueCombinations,techniqueCombinationName} from '../web/core/menu_techniques.mjs';
const load=n=>JSON.parse(readFileSync(new URL(`../web/data/${n}.json`,import.meta.url),'utf8'));
const source=load('party_skills');
const initial=JSON.parse(JSON.parse(readFileSync(new URL('../evidence/chapter_systems_home_save.json',import.meta.url),'utf8')).payload);
const store=()=>({value:structuredClone(initial),transact(fn){const draft=structuredClone(this.value);fn(draft);draft.revision++;this.value=draft;}});

test('native default seven slots and legacy three-slot saves are read without mutation',()=>{
  const value=structuredClone(initial),before=JSON.stringify(value),slots=techniqueSlots(value,source,'001');
  assert.deepEqual(slots.map(s=>[s.type,s.index_one_based]),[[0,22],[0,23],[0,24],[2,1],[2,2],[2,3],[2,4]]);
  assert.deepEqual(TECHNIQUE_COMMANDS,['使用招式','使用物品','防御','逃跑']);
  assert.equal(JSON.stringify(value),before);
  value.skill_shortcuts={version:1,roles:{'001':[22,24,37]}};
  assert.deepEqual(techniqueSlots(value,source,'001').slice(0,3).map(s=>s.index_one_based),[23,25,38]);
});
test('confirm commits any of seven slots; duplicate binding is preserved and old direct fields synchronize',()=>{
  const world=store(),before=structuredClone(world.value);
  changeTechniqueSlot(world,source,{roleId:'001',slotIndex:6,type:0,indexOneBased:38});
  changeTechniqueSlot(world,source,{roleId:'001',slotIndex:0,type:0,indexOneBased:23});
  assert.deepEqual(world.value.skill_shortcuts.roles['001'],[22,22,23]);
  assert.equal(techniqueSlots(world.value,source,'001')[6].index_one_based,38);
  assert.equal(techniqueSlots(world.value,source,'001')[1].index_one_based,23);
  const retained=JSON.parse(JSON.stringify(world.value));validateTechniqueBindingsState(retained.technique_bindings,retained.party);
  assert.deepEqual(techniqueSlots(retained,source,'001'),techniqueSlots(world.value,source,'001'));
  for(const key of ['party','inventory','equipment','source','flags','encounters'])assert.deepEqual(world.value[key],before[key]);
});
test('forged source bytes, unlearned, composed or stale updates reject atomically',()=>{
  const world=store(),before=JSON.stringify(world.value);
  for(const options of [{slotIndex:7,type:0,indexOneBased:22},{slotIndex:0,type:0,indexOneBased:20},{slotIndex:0,type:1,indexOneBased:1},{slotIndex:0,type:2,indexOneBased:5},{slotIndex:0,type:0,indexOneBased:22,expectedRevision:-1}])assert.throws(()=>changeTechniqueSlot(world,source,{roleId:'001',...options}));
  assert.equal(JSON.stringify(world.value),before);
  world.value.technique_bindings={version:1,roles:{'001':techniqueSlots(world.value,source,'001')}};
  world.value.technique_bindings.roles['001'][0].icon=5;
  assert.throws(()=>techniqueSlots(world.value,source,'001'),/原来源/);
});
test('composition and setting list gates use learned flags, equipped capacity and native category fields',()=>{
  assert.deepEqual(techniqueCandidates(initial,source,'001',1,{capacity:0}),[]);
  const set=techniqueCandidates(initial,source,'001',1,{capacity:7});
  assert.deepEqual(set.map(s=>s.index),[37,41]);
  const compile=techniqueCandidates(initial,source,'001',1,{capacity:7,action:'compose'});
  assert.deepEqual(compile.map(s=>s.index),[37]);
  assert.equal(techniqueCandidates(initial,source,'001',4,{action:'compose',capacity:7}).length,0);
  assert.equal(techniqueCandidates(initial,source,'001',4,{action:'set',capacity:0}).length,4);
  assert.deepEqual(sourceTechniqueSlot(source,'001',2,4),{type:2,index_one_based:4,icon:3,color:0});
});
test('composed records round-trip their native fields; naming and deleting repair references without resource changes',()=>{
  const world=store(),before=structuredClone(world.value),charset=load('operation_techniques').name_charset;
  const first=createTechniqueCombination(world,source,{roleId:'001',indices:[21,22],nameCodes:[1,7,45],icon:9,capacity:7});
  assert.equal(first.index_one_based,1);assert.equal(first.record.native_raw_hex.length,72);assert.equal(first.record.native_raw_hex.slice(48,54),'020215');
  assert.equal(techniqueCombinationName(first.record,charset),'火炎斩');
  createTechniqueCombination(world,source,{roleId:'001',indices:[23],nameCodes:[2],icon:1,capacity:7});
  changeTechniqueSlot(world,source,{roleId:'001',slotIndex:0,type:1,indexOneBased:1});
  changeTechniqueSlot(world,source,{roleId:'001',slotIndex:1,type:1,indexOneBased:1});
  changeTechniqueSlot(world,source,{roleId:'001',slotIndex:6,type:1,indexOneBased:2});
  renameTechniqueCombination(world,source,{roleId:'001',indexOneBased:1,nameCodes:[7],icon:5});
  assert.equal(techniqueCombinations(world.value,source,'001')[0].total_units,2);
  assert.deepEqual(techniqueCombinations(world.value,source,'001')[0].indices,[21,22]);
  assert.equal(techniqueSlots(world.value,source,'001')[0].icon,9);
  deleteTechniqueCombination(world,source,{roleId:'001',indexOneBased:1});
  const slots=techniqueSlots(world.value,source,'001');assert.equal(slots[0].type,2);assert.equal(slots[1].type,2);assert.equal(slots[6].index_one_based,1);
  assert.deepEqual(techniqueCombinations(JSON.parse(JSON.stringify(world.value)),source,'001').map(r=>r.indices),[[23]]);
  for(const key of ['party','inventory','equipment','source','flags','encounters'])assert.deepEqual(world.value[key],before[key]);
});
test('composition rejects duplicate skills, over-capacity, unlearned actions and forged native records',()=>{
  const world=store(),before=JSON.stringify(world.value);
  for(const options of [{indices:[21,21],capacity:7},{indices:[21,22],capacity:1},{indices:[20],capacity:7},{indices:[21],capacity:7,nameCodes:[]},{indices:[21],capacity:7,icon:66}])assert.throws(()=>createTechniqueCombination(world,source,{roleId:'001',indices:[21],nameCodes:[1],icon:0,capacity:7,...options}));
  assert.equal(JSON.stringify(world.value),before);
});
