import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {applyNativeStoryMutation,applyPendingNativeSkillUnlocks,validateNativeStoryMutation} from '../web/core/native_story_mutations.mjs';
import {admitPartyMember} from '../web/core/party_members.mjs';
import {WorldStore,validateWorld,encodeSave,decodeSave} from '../web/core/world.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
const seed=JSON.parse(await readFile(new URL('../web/data/opening_seed.json',import.meta.url),'utf8'));
const copy=structuredClone;
async function sourceRecord(mapId,id){
  const bytes=await readFile(new URL(`../../../Map/${mapId}.TLK`,import.meta.url));
  const base=0x1a+bytes.readUInt32LE(2)*4,raw=bytes.subarray(base+(id-1)*0x66f,base+id*0x66f);
  assert.equal(raw.readUInt32LE(0x13),id);
  return {id,mutation_type:raw.readUInt32LE(0x23),mutation_index:raw.readUInt32LE(0x27),mutation_bit:raw.readUInt32LE(0x2b)};
}

test('real aid unlock finds source skill72, preserves growth and never registers a handler',async()=>{
  const record=await sourceRecord('m17010',93),value=copy(seed),definition=value.source.role_definitions['001'];
  assert.deepEqual([record.mutation_type,record.mutation_index,record.mutation_bit],[14,0,72]);
  const source=definition.skills.find(skill=>skill.id===72);assert.equal(source.index,36);
  value.party[0].skill_progress={version:2,learned_indices:[26],records:[{index:22,level:2,experience:50}]};
  const registration=copy(runtimeContent),beforeSource=copy(definition);
  assert.equal(applyNativeStoryMutation(value,record).changed,true);
  assert.deepEqual(value.party[0].skill_progress,{version:2,learned_indices:[26,36],records:[{index:22,level:2,experience:50}]});
  assert.equal(applyNativeStoryMutation(value,record).changed,false);
  assert.deepEqual(definition,beforeSource);assert.deepEqual(runtimeContent,registration);
  const supplied=copy(definition);supplied.skills.push({...source,index:37});
  const fresh=copy(seed);applyNativeStoryMutation(fresh,record,{roleDefinitions:{'001':supplied}});
  assert.deepEqual(fresh.party[0].skill_progress.learned_indices,[36]);
});

test('future source role005 retains one unlock through save and applies it upon later admission',async()=>{
  const record=await sourceRecord('m17010',95),value=copy(seed);
  assert.equal(record.mutation_index,4);assert.equal(value.party.some(role=>role.id==='005'),false);
  assert.equal(applyNativeStoryMutation(value,record).pending,true);
  assert.equal(applyNativeStoryMutation(value,record).changed,false);
  assert.deepEqual(value.native_pending_skill_unlocks,[{role_id:'005',source_skill_id:72}]);
  const loaded=await decodeSave(await encodeSave(value));
  assert.deepEqual(loaded.native_pending_skill_unlocks,value.native_pending_skill_unlocks);
  const content=copy(runtimeContent),definition=loaded.source.role_definitions['005'];
  content.roles['005']={side:'player',native_slot:4,source:{path:definition.path,sha256:definition.sha256}};
  assert.equal(admitPartyMember(loaded,'005',{content}).added,true);
  const added=loaded.party.find(role=>role.id==='005');
  assert.deepEqual(added.skill_progress,{version:1,learned_indices:[30]});
  assert.deepEqual(loaded.native_pending_skill_unlocks,[]);
  const progress=copy(added.skill_progress);
  assert.equal(admitPartyMember(loaded,'005',{content}).added,false);assert.deepEqual(added.skill_progress,progress);
  validateWorld(loaded);
});

test('unmapped pending source IDs stay available until definitions exist; known missing IDs do nothing',()=>{
  const value=copy(seed);delete value.source.role_definitions['005'];
  const record={mutation_type:14,mutation_index:4,mutation_bit:72};
  assert.equal(applyNativeStoryMutation(value,record).pending,true);
  const role={id:'005'};
  assert.deepEqual(applyPendingNativeSkillUnlocks(value,role),{role_id:'005',learned_indices:[]});
  assert.equal(value.native_pending_skill_unlocks.length,1);
  applyPendingNativeSkillUnlocks(value,role,{roleDefinitions:seed.source.role_definitions});
  assert.deepEqual(role.skill_progress.learned_indices,[30]);assert.deepEqual(value.native_pending_skill_unlocks,[]);
  const known=copy(seed),noMatch={mutation_type:14,mutation_index:0,mutation_bit:255};
  assert.equal(applyNativeStoryMutation(known,noMatch).matched,false);assert.deepEqual(known,seed);
});

test('native mutation16 is a no-effect command; mutation17 unlocks synthesis without adding items',async()=>{
  const noEffect=await sourceRecord('m17028',18),recipe=await sourceRecord('m17014',19),value=copy(seed),before=copy(value);
  assert.deepEqual([noEffect.mutation_type,noEffect.mutation_index,noEffect.mutation_bit],[16,4,71]);
  assert.deepEqual(applyNativeStoryMutation(value,noEffect),{mutation_type:16,changed:false,native_effect:'none'});
  assert.deepEqual(value,before);
  assert.deepEqual([recipe.mutation_type,recipe.mutation_bit],[17,257]);
  assert.deepEqual(applyNativeStoryMutation(value,recipe),{mutation_type:17,index:256,changed:true});
  assert.equal(applyNativeStoryMutation(value,recipe).changed,false);
  assert.equal(applyNativeStoryMutation(value,{...recipe,mutation_bit:0}).changed,false);
  assert.deepEqual(value.recipe_unlock_indices,[256]);assert.deepEqual(value.inventory,before.inventory);
  assert.deepEqual(await decodeSave(await encodeSave(value)),value);
});

test('all native story writes roll back together and optional save fields reject corrupt identities',()=>{
  const store=new WorldStore(copy(seed)),before=store.snapshot();
  assert.throws(()=>store.transact(draft=>{
    applyNativeStoryMutation(draft,{mutation_type:14,mutation_index:0,mutation_bit:72});
    applyNativeStoryMutation(draft,{mutation_type:14,mutation_index:4,mutation_bit:72});
    applyNativeStoryMutation(draft,{mutation_type:17,mutation_index:0,mutation_bit:257});
    throw Error('cancel fixture story');
  }),/cancel fixture/);
  assert.deepEqual(store.snapshot(),before);
  for(const row of [{role_id:'000',source_skill_id:72},{role_id:'005',source_skill_id:256},
    {role_id:'005',source_skill_id:72,extra:true}]){
    const invalid=copy(seed);invalid.native_pending_skill_unlocks=[row];assert.throws(()=>validateWorld(invalid),/技能源/);
  }
  const duplicate=copy(seed);duplicate.native_pending_skill_unlocks=[{role_id:'005',source_skill_id:72},{role_id:'005',source_skill_id:72}];
  assert.throws(()=>validateWorld(duplicate),/重复/);
  for(const indices of [[256,256],[-1],[416],['256']]){
    const invalid=copy(seed);invalid.recipe_unlock_indices=indices;assert.throws(()=>validateWorld(invalid),/合成解锁/);
  }
  assert.throws(()=>validateNativeStoryMutation({mutation_type:14,mutation_index:10,mutation_bit:72}),/角色槽/);
});

test('legacy saves acquire neither unlock arrays nor learned progress during round trip',async()=>{
  const value=await decodeSave(await encodeSave(seed));assert.deepEqual(value,seed);
  assert.equal(value.native_pending_skill_unlocks,undefined);assert.equal(value.recipe_unlock_indices,undefined);
  assert.equal(value.party[0].skill_progress,undefined);
});
