import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WorldStore,validateWorld,encodeSave,decodeSave} from '../web/core/world.mjs';
import {admitPartyMember,deactivatePartyMember,controlPartyActor} from '../web/core/party_members.mjs';
import {allPartyRoles} from '../web/core/party_roster.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {partyFormationSlots} from '../web/core/party_formation.mjs';
import {initialEncounterState} from '../web/core/encounters.mjs';
import {migrateEquipment,withItemQuantity} from '../web/core/equipment.mjs';
import {migrateCrystalSockets,insertCrystal,crystalSocketRows} from '../web/core/crystal_sockets.mjs';
import {applyExperience} from '../web/core/battle_rewards.mjs';
import {applyNativeStoryMutation} from '../web/core/native_story_mutations.mjs';
import {effectiveSkillSource,battleSkillEligibility} from '../web/core/battle_skill_access.mjs';
import {changeSkillShortcuts,skillShortcuts,validateSourceSkillShortcuts} from '../web/core/skill_shortcuts.mjs';
import {techniqueSlots} from '../web/core/menu_techniques.mjs';
const copy=structuredClone;
const read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [seed,attributes,skills,items,rewards]=await Promise.all(['opening_seed','party_combat','party_skills','items','party_rewards'].map(read));

function setup(ids=['001','005']){
  const world=copy(seed),content=copy(runtimeContent);world.opening.status='complete';
  // Source-only roles are admitted only in this isolated native party test.
  for(const id of ids){const definition=world.source.role_definitions[id];
    content.roles[id]??={side:'player',native_slot:Number(id)-1,source:{path:definition.path,sha256:definition.sha256}};
    admitPartyMember(world,id,{content});
  }
  world.formation_slots=partyFormationSlots(world);world.encounters=initialEncounterState(world.party,0x12345678);
  return {store:new WorldStore(world),content};
}
function matureAndEquip(store){
  const itemData=copy(items);itemData.definitions['156'].runtime_enabled=true;
  store.transact(draft=>{
    const index=draft.party.findIndex(role=>role.id==='001');
    draft.party[index]=applyExperience(draft.party[index],3000,rewards,()=>0,[]).role;
    draft.party[index].hp.current=42;draft.party[index].mp.current=3;
    draft.encounters.counters['001']=57;draft.encounters.remainders['001']=7.5;
    migrateEquipment(draft,attributes,items);migrateCrystalSockets(draft);
    const def=items.definitions['156'];draft.inventory.push(withItemQuantity({instance_id:'departure:crystal',id:156,name:def.name,source_raw_hex:def.initialized_raw_hex},2));
  });
  insertCrystal({worldStore:store,attributes,itemData,roleId:'001',socketIndex:1,instanceId:'departure:crystal'});
  changeSkillShortcuts(store,skills,{roleId:'001',indices:[22,21,23]});
  store.transact(draft=>{draft.technique_bindings={version:1,roles:{'001':techniqueSlots(draft,skills,'001')}};
    applyNativeStoryMutation(draft,{mutation_type:14,mutation_index:0,mutation_bit:72});});
}

test('departure and reactivation preserve complete grown role, owned equipment, learning, commands and encounter progress across save',async()=>{
  const {store,content}=setup();matureAndEquip(store);const before=store.snapshot(),role=copy(before.party.find(row=>row.id==='001'));
  store.transact(draft=>{controlPartyActor(draft,'005',{content});deactivatePartyMember(draft,'001',{content});});
  assert.deepEqual(store.value.party.map(row=>row.id),['005']);assert.equal(store.value.leader_id,'005');
  assert.deepEqual(store.value.reserve_party,[{role,encounter_progress:{counter:57,remainder:7.5}}]);
  assert.deepEqual(store.value.formation_slots,[null,'005',null,null]);
  assert.equal(store.value.encounters.rng_state,before.encounters.rng_state);
  for(const key of ['equipment','crystal_sockets','skill_shortcuts','technique_bindings','inventory','source'])assert.deepEqual(store.value[key],before[key]);
  assert.equal(battleSkillEligibility(store.value,skills.skills.yanci).available,false);
  assert.deepEqual(skillShortcuts(store.value,skills,'005'),[19,20,21]);
  assert.doesNotThrow(()=>validateSourceSkillShortcuts(store.value,effectiveSkillSource(skills,store.value)));
  assert.doesNotThrow(()=>crystalSocketRows(store.value,attributes,items,'005'));
  const loaded=await decodeSave(await encodeSave(store.snapshot())),restored=new WorldStore(loaded);
  restored.transact(draft=>assert.equal(admitPartyMember(draft,'001',{content}).reactivated,true));
  assert.deepEqual(restored.value.party.find(row=>row.id==='001'),role);
  assert.deepEqual(restored.value.reserve_party,[]);assert.deepEqual(restored.value.formation_slots,['001','005',null,null]);
  assert.equal(restored.value.encounters.counters['001'],57);assert.equal(restored.value.encounters.remainders['001'],7.5);
  assert.equal(restored.value.encounters.rng_state,before.encounters.rng_state);
  for(const key of ['equipment','crystal_sockets','skill_shortcuts','technique_bindings','inventory','source'])assert.deepEqual(restored.value[key],before[key]);
});

test('native mode3 changes only controlled identity and cannot fabricate an inactive member',()=>{
  const {store,content}=setup(),draft=store.snapshot(),before=copy(draft);
  assert.deepEqual(controlPartyActor(draft,'005',{content}),{id:'005',previous_id:'001',controlled:true,added:false});
  before.leader_id='005';assert.deepEqual(draft,before);
  assert.throws(()=>controlPartyActor(draft,'004',{content}),/不在当前队伍/);
});

test('source full formation and absent departure have no state writes while unknown role and invalid source still reject',()=>{
  const {store,content}=setup(['001','002','003','004','005']);
  // The fifth source role was not admitted when four slots were occupied.
  assert.deepEqual(store.value.party.map(role=>role.id),['001','002','003','004']);
  const draft=store.snapshot(),before=copy(draft);
  assert.deepEqual(admitPartyMember(draft,'005',{content}),{id:'005',added:false,reason:'formation-full'});
  assert.deepEqual(deactivatePartyMember(draft,'005',{content}),{id:'005',removed:false});assert.deepEqual(draft,before);
  assert.throws(()=>admitPartyMember(draft,'099',{content}),/尚未接入/);
  const wrong=copy(content);wrong.roles['005'].source.sha256='0'.repeat(64);
  assert.throws(()=>admitPartyMember(draft,'005',{content:wrong}),/缺少已登记/);assert.deepEqual(draft,before);
  const reserved=setup();reserved.store.transact(next=>{
    next.encounters.counters['005']=61;next.encounters.remainders['005']=9;
    next.skill_shortcuts={version:1,roles:{'005':[19,20,21]}};
    deactivatePartyMember(next,'005',{content:reserved.content});
    for(const id of ['002','003','004']){const definition=next.source.role_definitions[id];
      reserved.content.roles[id]??={side:'player',native_slot:Number(id)-1,source:{path:definition.path,sha256:definition.sha256}};
      admitPartyMember(next,id,{content:reserved.content});}
  });
  const reserveDraft=reserved.store.snapshot(),reserveBefore=copy(reserveDraft);
  assert.equal(admitPartyMember(reserveDraft,'005',{content:reserved.content}).reason,'formation-full');
  assert.deepEqual(reserveDraft,reserveBefore,'full formation preserves inactive instance, bindings, counters and global RNG');
});

test('learning a departed source role updates its retained record and failed party edits cannot leak from the transaction',()=>{
  const {store,content}=setup();store.transact(draft=>deactivatePartyMember(draft,'005',{content}));
  store.transact(draft=>applyNativeStoryMutation(draft,{mutation_type:14,mutation_index:4,mutation_bit:72}));
  assert.ok(store.value.reserve_party[0].role.skill_progress.learned_indices.includes(30));
  assert.equal(store.value.native_pending_skill_unlocks,undefined);
  const before=store.snapshot();assert.throws(()=>store.transact(draft=>{admitPartyMember(draft,'005',{content});controlPartyActor(draft,'005',{content});throw Error('later scene failed');}),/later scene failed/);
  assert.deepEqual(store.snapshot(),before);
});

test('reserve save validation rejects duplicate identity, corrupt growth, encounter fields and duplicated owned items',async()=>{
  const {store,content}=setup();matureAndEquip(store);store.transact(draft=>{controlPartyActor(draft,'005',{content});deactivatePartyMember(draft,'001',{content});});
  const before=store.snapshot();
  for(const mutate of [
    draft=>draft.reserve_party.push(copy(draft.reserve_party[0])),
    draft=>draft.reserve_party[0].role.level++,
    draft=>draft.reserve_party[0].encounter_progress.counter=256,
    draft=>draft.reserve_party[0].encounter_progress.remainder=16,
    draft=>draft.reserve_party[0].extra=true,
    draft=>draft.inventory.push({...copy(draft.equipment.roles['001'][0]),quantity:1})
  ]){const bad=copy(before);mutate(bad);assert.throws(()=>validateWorld(bad));}
  assert.deepEqual(await decodeSave(await encodeSave(before)),before);
  const legacy=copy(seed);assert.equal(legacy.reserve_party,undefined);assert.deepEqual(await decodeSave(await encodeSave(legacy)),legacy);
});

test('real Fire Valley party command operands replay admission/control/departure without deleting source state',async()=>{
  for(const [name,ids,expected,departed]of [
    ['m17010-3',['001','002','004'],['001','002','005'],'004'],
    ['m17030-1',['001','002','005'],['001','002','005','004'],null]
  ]){
    const {store,content}=setup(ids),bytes=await readFile(new URL(`../../../Animate/${name}.anm`,import.meta.url)),commands=[];
    for(let index=0;index<bytes.readUInt32LE(2);index++){const at=67+index*74,opcode=bytes[at];if([36,37].includes(opcode))commands.push({opcode,actorSlot:bytes.readUInt32LE(at+5),modeRaw:bytes[at+29]});}
    store.transact(draft=>{for(const command of commands){const id=String(command.actorSlot+1).padStart(3,'0');
      if(!content.roles[id]){const definition=draft.source.role_definitions[id];content.roles[id]={side:'player',native_slot:command.actorSlot,source:{path:definition.path,sha256:definition.sha256}};}
      if(command.opcode===37)deactivatePartyMember(draft,id,{content});
      else if(command.modeRaw===3)controlPartyActor(draft,id,{content});else admitPartyMember(draft,id,{content});
    }});
    assert.deepEqual(store.value.party.map(role=>role.id),expected);assert.equal(store.value.leader_id,'001');
    if(departed)assert.equal(store.value.reserve_party[0].role.id,departed);
    assert.equal(new Set(allPartyRoles(store.value).map(role=>role.id)).size,allPartyRoles(store.value).length);
  }
});
