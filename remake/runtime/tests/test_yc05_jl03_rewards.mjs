// Source-bound reward/use checks. Keys, money, role003 and the three explicitly
// named advanced recipe materials are handoffs; no chest/loot/weapon is injected.
// In particular, this does not claim natural crafting of255 in this phase.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import {ChapterRunner,initializeChapterItem,chapterObjectState} from '../web/core/chapter.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {admitPartyMember} from '../web/core/party_members.mjs';
import {deriveItemConfiguration,compileItemConfiguration} from '../web/core/item_registry.mjs';
import {nativeEconomyCatalog,nativeOwnedQuantity,readNativeService,applyNativeServiceAction} from '../web/core/native_economy.mjs';
import {changeEquipment} from '../web/core/items.mjs';
import {insertCrystal,removeCrystal,socketEquipmentRows} from '../web/core/crystal_sockets.mjs';
import {createPartyActors} from '../web/core/party_attributes.mjs';
import {createRewardLedger,collectEnemyDefeat,planVictoryRewards,validatePartyRewards} from '../web/core/battle_rewards.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
globalThis.crypto??=webcrypto;
const copy=structuredClone,json=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [source,story,seed,attributes,rewards]=await Promise.all(['items','chapter_story','opening_seed','party_combat','party_rewards'].map(json));
const items=compileItemConfiguration(source,deriveItemConfiguration(source),'original').data,catalog=nativeEconomyCatalog(items);
const mapIds=Object.keys(runtimeContent.maps),quantity=(world,id)=>nativeOwnedQuantity(world.value,id);
function fixture(mapId='M71010'){
  const value=copy(seed);value.opening.status='complete';value.location={map_id:mapId,x:400,y:320,direction:0};
  return new WorldStore(value,mapIds);
}
function handoff(id){
  const raw=initializeChapterItem(catalog[id],{allowWeapon:true});new DataView(raw.buffer).setUint32(4,1,true);
  return {id,name:catalog[id].name,quantity:1,instance_id:`yc05-material-handoff:${id}`,source_raw_hex:Buffer.from(raw).toString('hex')};
}
async function reload(world){const before=world.snapshot();world.replace(await decodeSave(await encodeSave(before),mapIds));assert.deepEqual(world.snapshot(),before);}
const npc=(runner,mapId,slot)=>runner.runTlk({mapId,recordId:story.maps[mapId].index_nonzero.find(row=>row.slot===slot).record,
  context:{steps:0,explicitInteraction:true,npcMapId:mapId,npcSlot:slot}});
const boxes=[['M71010',18,158],['M71010',19,157],['M71020',3,158],['M71030',3,227],
  ['M71030',4,159],['M71030',5,157],['M71030',6,352],['M71040',3,161],['M71040',4,159],['M71040',5,157],
  ['M71050',6,341],['M71050',7,348],['M71050',8,352],['M71060',8,158]];

test('all14 admitted lake chests keep exact DAT slots, keys, one reward and completed reload state',async()=>{
  const world=fixture();world.transact(draft=>{draft.inventory.push(...[333,334,335,337].map(handoff));});
  let saleTarget;
  const runner=new ChapterRunner({world,data:story,content:runtimeContent,say:async()=>{},choose:async()=>0,
    objectAnimation:async()=>{},objectInteraction:async()=>{},service:async({record,table,draft})=>{
      assert.equal(record.id,46,'The ordinary early goods branch is sufficient to sell materials');
      assert.equal(applyNativeServiceAction(draft,readNativeService(record,table),catalog,
        {mode:'sell',category:'items',id:saleTarget}).changed,true);
    }});
  for(const [mapId,index,id]of boxes){
    const table=story.maps[mapId],object=table.objects.find(row=>row.index===index),raw=await readFile(new URL(`../../../${object.source.path}`,import.meta.url));
    assert.equal(createHash('sha256').update(raw).digest('hex'),object.source.sha256);
    const at=object.source.offset;assert.equal(raw.readUInt32LE(at+0x54),id);assert.equal(raw.readUInt32LE(at+0xf6),0);
    world.transact(draft=>{draft.location.map_id=mapId;});const before=quantity(world,id);
    await runner.runObject({mapId,objectIndex:index});assert.equal(quantity(world,id),before+1);
    assert.equal(chapterObjectState(world.value,mapId,index,story),3);await reload(world);
    const complete=world.snapshot();assert.equal((await runner.runObject({mapId,objectIndex:index})).already_done,true);
    assert.deepEqual(world.snapshot(),complete);
  }
  for(const id of [333,334,335,337])assert.equal(quantity(world,id),1,'Native keys are retained');
  for(const [mapId,index]of [['M71010',20],['M71020',4],['M71060',9]])
    assert.ok(!runtimeContent.maps[mapId].objects.some(row=>row.index===index),'Independent unsupported reward box remains closed');
  for(const id of [157,158,159,161]){
    const row=world.value.inventory.find(row=>row.id===id),options={worldStore:world,attributes,itemData:items,roleId:'001',socketIndex:1};
    insertCrystal({...options,instanceId:row.instance_id});assert.equal(socketEquipmentRows(world.value,attributes,items,'001')[0].item_id,id);
    const linked=createPartyActors(world.snapshot(),attributes,{},items);await reload(world);
    assert.deepEqual(createPartyActors(world.snapshot(),attributes,{},items),linked);removeCrystal(options);await reload(world);
    insertCrystal({...options,instanceId:world.value.inventory.find(row=>row.id===id).instance_id});removeCrystal(options);
  }
  // These late crafting inputs have no newly unlocked matching recipe in
  // this phase. Their source material sale is a real usable economy path.
  world.transact(draft=>{draft.location.map_id='M01041';});
  for(const id of [341,348,352]){
    const row=world.value.inventory.find(row=>row.id===id),before=world.value.money;
    saleTarget=row.instance_id;await npc(runner,'M01041',12);
    assert.equal(world.value.money,before+(catalog[id].price>>1));await reload(world);
  }
});

test('ambush rewards skip internal347, equip113/114, socket204/206 and survive repeated reload',async()=>{
  validatePartyRewards(rewards);
  const world=fixture('M01050'),actors=[{id:'001',side:'player',hp:{current:1},immune_raw:0,state_raw:0},
    ...['031A1','031B2'].map(id=>({id,side:'enemy',hp:{current:0}}))];
  const ledger=createRewardLedger('yc05-source-ambush-loot',actors);
  for(const actor of actors.slice(1))collectEnemyDefeat(ledger,actor,{data:rewards});
  const plan=planVictoryRewards({world:world.snapshot(),ledger,data:rewards,actors,rng:()=>0});
  assert.deepEqual(plan.trace.filter(row=>row.type==='drop-skipped').map(row=>row.id),[347]);
  assert.deepEqual(plan.summary.drops.map(row=>row.id),[113,206,114,204]);
  world.transact(draft=>{Object.assign(draft,plan.world_patch);(draft.reward_records??=[]).push(plan.reward_record);});
  assert.equal(quantity(world,347),0);await reload(world);
  assert.equal(planVictoryRewards({world:world.snapshot(),ledger,data:rewards,actors,rng:()=>assert.fail('Duplicate reward consumes RNG')}).applied,false);
  for(const id of [113,114]){
    const row=world.value.inventory.find(row=>row.id===id),slotId=items.definitions[id].slot_id;
    assert.equal(items.definitions[id].runtime_enabled,true);
    const equipped=changeEquipment(world,attributes,items,{roleId:'001',slotId,instanceId:row.instance_id});await reload(world);
    changeEquipment(world,attributes,items,{roleId:'001',slotId});await reload(world);
    const restored=changeEquipment(world,attributes,items,{roleId:'001',slotId,instanceId:world.value.inventory.find(row=>row.id===id).instance_id});
    assert.deepEqual(restored.linked_by_address,equipped.linked_by_address);await reload(world);
  }
  for(const id of [204,206]){
    const options={worldStore:world,attributes,itemData:items,roleId:'001',socketIndex:1};
    insertCrystal({...options,instanceId:world.value.inventory.find(row=>row.id===id).instance_id});await reload(world);
    removeCrystal(options);await reload(world);insertCrystal({...options,instanceId:world.value.inventory.find(row=>row.id===id).instance_id});removeCrystal(options);
  }
});

test('source255 recipe plus real227 chest and material handoffs forge the role003 weapon',async()=>{
  const world=fixture('M71030');world.transact(draft=>{
    // 228 is only on the later M01041:r58 goods branch, gated by428:3,
    // 33:2 and215:1. Its last gate is written by rebirth-a01:r10.
    // 174/251 also have external acquisition chains. Supply only materials;
    // the naturally unlocked recipe and original forge create the weapon.
    draft.money=1000000;draft.inventory.push(...[334,174,251,228].map(handoff));
    admitPartyMember(draft,'003',{definitions:story.role_definitions,content:runtimeContent});
  });
  let action=null;
  const runner=new ChapterRunner({world,data:story,content:runtimeContent,say:async()=>{},choose:async()=>0,
    objectAnimation:async()=>{},objectInteraction:async()=>{},service:async({record,table,mapId,draft})=>{
      assert.ok(action);assert.equal(applyNativeServiceAction(draft,readNativeService(record,table),catalog,{...action,mapId,recordId:record.id}).changed,true);
    }});
  await runner.runObject({mapId:'M71030',objectIndex:3});assert.equal(quantity(world,227),1);
  world.transact(draft=>{draft.location.map_id='M01022-1';});
  await runner.runTlk({mapId:'M01022-1',recordId:17});assert.ok(world.value.recipe_unlock_indices.includes(254));
  assert.deepEqual(catalog[255].ingredients,[174,251,228,227]);assert.equal(catalog[255].type,1);assert.equal(catalog[255].allowed_role_mask_raw_13e,4);
  await reload(world);world.transact(draft=>{draft.location.map_id='M01042';});
  // NPC10 root8 takes the original nonmember r1 -> r9 >=500000 route.
  // No386:2 basic membership or386:6 iron-drill membership is supplied.
  assert.equal(world.value.flags[386]&((1<<1)|(1<<5)),0);
  action={mode:'forge',category:'weapon',id:255};await npc(runner,'M01042',10);
  assert.equal(world.value.equipment.roles['003'].find(row=>row.slot_id==='weapon').id,255);
  for(const id of catalog[255].ingredients)assert.equal(quantity(world,id),0);
  const equipped=createPartyActors(world.snapshot(),attributes,{},items).find(row=>row.id==='003');await reload(world);
  changeEquipment(world,attributes,items,{roleId:'003',slotId:'weapon'});await reload(world);
  changeEquipment(world,attributes,items,{roleId:'003',slotId:'weapon',instanceId:world.value.inventory.find(row=>row.id===255).instance_id});
  assert.deepEqual(createPartyActors(world.snapshot(),attributes,{},items).find(row=>row.id==='003').linked_by_address,equipped.linked_by_address);await reload(world);
});
