// PC-01 reward rules use formal exports and original source bytes only.
// Explicit handoff flags/base materials below are fixtures, not a claim that a
// player naturally travelled the campaign or fought a rendered encounter.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import {ChapterRunner,initializeChapterItem,chapterObjectState} from '../web/core/chapter.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {admitPartyMember} from '../web/core/party_members.mjs';
import {readNativeService,nativeEconomyCatalog,nativeOwnedQuantity,applyNativeServiceAction} from '../web/core/native_economy.mjs';
import {createRewardLedger,collectEnemyDefeat,planVictoryRewards} from '../web/core/battle_rewards.mjs';
import {changeEquipment} from '../web/core/items.mjs';
import {createPartyActors} from '../web/core/party_attributes.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';

globalThis.crypto??=webcrypto;
const json=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [items,story,seed,attributes,rewards,encounters]=await Promise.all(
  ['items','chapter_story','opening_seed','party_combat','party_rewards','encounters'].map(json));
const catalog=nativeEconomyCatalog(items),mapIds=Object.keys(runtimeContent.maps),copy=structuredClone;
const original=path=>readFile(new URL(`../../../${path}`,import.meta.url));
const quantity=(world,id)=>nativeOwnedQuantity(world.value,id);
const npc=(runner,mapId,slot)=>runner.runTlk({mapId,
  recordId:story.maps[mapId].index_nonzero.find(row=>row.slot===slot).record,
  context:{steps:0,explicitInteraction:true,npcMapId:mapId,npcSlot:slot}});
function fixture(mapId){
  const value=copy(seed);value.opening.status='complete';value.location={map_id:mapId,x:400,y:320,direction:0};
  return new WorldStore(value,mapIds);
}
function handoffMaterial(id){
  const raw=initializeChapterItem(catalog[id],{allowWeapon:true});new DataView(raw.buffer).setUint32(4,1,true);
  return {id,name:catalog[id].name,quantity:1,instance_id:`pc01-material-handoff:${id}`,source_raw_hex:Buffer.from(raw).toString('hex')};
}
async function reload(world){
  const before=world.snapshot();world.replace(await decodeSave(await encodeSave(before),mapIds));
  assert.deepEqual(world.snapshot(),before);
}

test('247 admission comes from an actual registered STG member and exact CHR drop slot/rate',async()=>{
  const provenance=items.catalog.item_capability_admission.sources['247'];
  assert.equal(items.definitions['247'].availability.enabled,true);
  assert.equal(items.definitions['247'].behavior.kind,'crafting-material');
  const rows=provenance.filter(row=>row.kind==='registered-encounter-enemy-reward'&&row.enemy_id==='022');
  assert.ok(rows.length>0,'No admitted random-encounter source for high-purity amethyst ore');
  for(const row of rows){
    assert.equal(row.reward_slot,2);assert.equal(row.source.offset,8+0xe8+2*4);
    assert.ok(encounters.maps[row.map_id].members.some(member=>member.id==='022'));
    const chr=await original(row.source.path),itm=await original(row.drop_rate_source.path);
    assert.equal(createHash('sha256').update(chr).digest('hex'),row.source.sha256);
    assert.equal(chr.readInt32LE(row.source.offset),247);
    assert.equal(itm.readInt32LE(row.drop_rate_source.offset),row.drop_rate);
    assert.equal(row.drop_rate,0,'Native zero rate is an unconditional drop after its RNG call');
    const stg=await original(row.pool_member_source.path);
    assert.equal(createHash('sha256').update(stg).digest('hex'),row.pool_member_source.sha256);
    assert.equal(stg.subarray(row.pool_member_source.filename_offset,row.pool_member_source.filename_offset+20)
      .toString('ascii').split('\0')[0].toLowerCase(),'022.dgp');
  }
  assert.ok(!provenance.some(row=>row.enemy_id==='016'),'An unregistered CHR must not admit its drops');
});

test('source shop purchase pays for354, detective consumes it once for333, and wind chest keeps its key',async()=>{
  const world=fixture('M01041');
  // Independent old-commission handoff: merchant restock and detective request
  // preconditions are explicit; neither the silk nor the wind key is injected.
  world.transact(draft=>{
    draft.money=10000;draft.flags[428]|=1<<2;draft.flags[33]|=1<<1;
    draft.flags[3]|=1<<2;draft.flags[5]|=1<<30;
  });
  const services=[];
  const runner=new ChapterRunner({world,data:story,content:runtimeContent,say:async()=>{},choose:async()=>0,
    objectAnimation:async()=>{},service:async({mapId,record,table,draft})=>{
      services.push(record.id);
      assert.equal(applyNativeServiceAction(draft,readNativeService(record,table),catalog,
        {mode:'buy',id:354,quantity:1,mapId,recordId:record.id}).changed,true);
    }});
  await npc(runner,'M01041',12);
  assert.deepEqual(services,[48]);assert.equal(quantity(world,354),1);assert.equal(world.value.money,9000);
  world.transact(draft=>{draft.location.map_id='M01030';});
  await npc(runner,'M01030',19);assert.equal(quantity(world,333),0);
  await npc(runner,'M01030',19);
  assert.equal(quantity(world,354),0);assert.equal(quantity(world,333),1);assert.ok(world.value.flags[3]&(1<<4));
  const awarded=world.snapshot();await npc(runner,'M01030',19);
  assert.deepEqual(world.value.inventory,awarded.inventory);assert.deepEqual(world.value.flags,awarded.flags);
  await reload(world);
  world.transact(draft=>{draft.location.map_id='M70040';});
  assert.equal((await runner.runObject({mapId:'M70040',objectIndex:11})).already_done,false);
  assert.equal(quantity(world,354),1);assert.equal(quantity(world,333),1);
  assert.equal(chapterObjectState(world.value,'M70040',11,story),3);
  await reload(world);const opened=world.snapshot();
  assert.equal((await runner.runObject({mapId:'M70040',objectIndex:11})).already_done,true);
  assert.deepEqual(world.snapshot(),opened);
});

test('source256 recipe and real022 reward feed the existing forge, equip004, and survive unequip/reload',async()=>{
  const world=fixture('M70030');
  // Only the four base materials for225 and service eligibility are handed in.
  // 170 is earned from its source NPC;247 comes from the formal reward planner;
  // 225 is synthesized;227 is bought. No256 instance is handed to the fixture.
  world.transact(draft=>{
    draft.money=1000000;draft.flags[386]|=(1<<1)|(1<<5);
    draft.flags[428]|=1<<2;draft.flags[33]|=1<<1;draft.flags[215]|=1;
    draft.inventory.push(...[213,216,223,229].map(handoffMaterial));
    admitPartyMember(draft,'004',{definitions:story.role_definitions,content:runtimeContent});
  });
  let action=null;
  const runner=new ChapterRunner({world,data:story,content:runtimeContent,say:async()=>{},choose:async()=>0,
    service:async({mapId,record,table,draft})=>{
      assert.ok(action,'Unexpected service');
      assert.equal(applyNativeServiceAction(draft,readNativeService(record,table),catalog,
        {...action,mapId,recordId:record.id}).changed,true);
    }});
  await npc(runner,'M70030',10);assert.equal(quantity(world,170),1);
  const actors=[{id:'001',side:'player',hp:{current:1},immune_raw:0,state_raw:0},
    {id:'pc01-022',resource_id:'022',side:'enemy',hp:{current:0}}];
  const ledger=createRewardLedger('pc01-source-022-reward',actors);
  collectEnemyDefeat(ledger,actors[1],{data:rewards});
  const plan=planVictoryRewards({world:world.snapshot(),ledger,data:rewards,actors,rng:()=>99});
  const oreRoll=plan.trace.find(row=>row.type==='drop-roll'&&row.id===247);
  assert.deepEqual([oreRoll.raw,oreRoll.threshold,oreRoll.success],[99,0,true]);
  world.transact(draft=>{Object.assign(draft,plan.world_patch);(draft.reward_records??=[]).push(plan.reward_record);});
  assert.equal(quantity(world,247),1);
  assert.equal(planVictoryRewards({world:world.snapshot(),ledger,data:rewards,actors,
    rng:()=>assert.fail('Repeated reward consumed RNG')}).applied,false);
  world.transact(draft=>{draft.location.map_id='M01062';});
  action={mode:'synthesize',category:'material',id:225};await npc(runner,'M01062',10);
  assert.equal(quantity(world,225),1);
  for(const id of [213,216,223,229])assert.equal(quantity(world,id),0);
  world.transact(draft=>{draft.location.map_id='M01041';});
  action={mode:'buy',id:227,quantity:1};await npc(runner,'M01041',12);assert.equal(quantity(world,227),1);
  // This is the exact initial room conversation invoked by m03039-1.
  world.transact(draft=>{draft.location.map_id='M03039';});
  await runner.runTlk({mapId:'M03039',recordId:2});
  assert.ok(world.value.recipe_unlock_indices.includes(255));
  assert.deepEqual(catalog[256].ingredients,[170,247,225,227]);assert.equal(catalog[256].allowed_role_mask_raw_13e,8);
  await reload(world);
  world.transact(draft=>{draft.location.map_id='M01042';});
  const before=world.snapshot(),raw004=copy(world.value.party.find(role=>role.id==='004'));
  action={mode:'forge',category:'weapon',id:256};await npc(runner,'M01042',10);
  assert.equal(world.value.money,before.money);
  assert.equal(world.value.equipment.roles['004'].find(row=>row.slot_id==='weapon').id,256);
  assert.deepEqual(world.value.party.find(role=>role.id==='004'),raw004);
  for(const id of [170,247,225,227])assert.equal(quantity(world,id),0);
  const equipped=createPartyActors(world.snapshot(),attributes,{},items).find(role=>role.id==='004');
  await reload(world);assert.deepEqual(createPartyActors(world.snapshot(),attributes,{},items).find(role=>role.id==='004'),equipped);
  changeEquipment(world,attributes,items,{roleId:'004',slotId:'weapon'});
  const staff=world.value.inventory.find(row=>row.id===256);assert.ok(staff);
  await reload(world);
  changeEquipment(world,attributes,items,{roleId:'004',slotId:'weapon',instanceId:staff.instance_id});
  const reequipped=createPartyActors(world.snapshot(),attributes,{},items).find(role=>role.id==='004');
  assert.deepEqual(reequipped.raw_by_address,equipped.raw_by_address);
  assert.deepEqual(reequipped.linked_by_address,equipped.linked_by_address);
  assert.deepEqual(reequipped.equipment,equipped.equipment);
  await reload(world);
});
