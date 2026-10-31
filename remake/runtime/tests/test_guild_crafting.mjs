// Original guild unlocks through production services, sockets and save records.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {initializeChapterItem,validateChapterItemDefinition,chapterObjectState} from '../web/core/chapter.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {chapterRoleFromDefinition} from '../web/core/party_members.mjs';
import {compileItemConfiguration} from '../web/core/item_registry.mjs';
import {applyNativeStoryMutation} from '../web/core/native_story_mutations.mjs';
import {nativeEconomyCatalog,nativeServiceRows,applyNativeServiceAction,nativeOwnedQuantity} from '../web/core/native_economy.mjs';
import {insertCrystal,removeCrystal,isSupportedCrystalDefinition} from '../web/core/crystal_sockets.mjs';
import {createPartyActors} from '../web/core/party_attributes.mjs';
import {initializeNativeStatuses,applyNativeSkillStatus,tickNativeStatuses} from '../web/core/battle_status.mjs';
import {usableItems,changeEquipment,useWorldItem,restoreActorWithItem} from '../web/core/items.mjs';
import {partyResourcesForWorld,consumePartyMp} from '../web/core/party_attributes.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {assembleForestSample} from '../web/forest_sample.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {createNativeRng,resolveAction,applyNativeDamage} from '../web/core/combat_rules.mjs';
import {commandReady} from './helpers/battle_clock.mjs';
import {innerWhiteForestSource,innerWhiteForestRunner} from './helpers/inner_white_forest_world.mjs';
import {compileNativeSequence} from '../web/core/skill_sequence.mjs';

const json=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [published,configuration,attributes,seed,statusData]=await Promise.all(
  ['items','config/items','party_combat','opening_seed','forest_status'].map(json));
const items=compileItemConfiguration(published,configuration,'debug').data,catalog=nativeEconomyCatalog(items);
const source=await readFile(new URL('../../../SYSTEM/Object.ITM',import.meta.url));
const maps=await Promise.all(['m01062','m03032'].map(async map=>{
  const bytes=await readFile(new URL(`../../../Map/${map}.TLK`,import.meta.url));
  const base=0x1a+bytes.readUInt32LE(2)*4;
  const records=Array.from({length:bytes.readUInt32LE(6)},(_,i)=>{
    const offset=base+i*0x66f,raw=bytes.subarray(offset,offset+0x66f);
    return {id:i+1,mutation_type:raw.readUInt32LE(0x23),mutation_index:raw.readUInt32LE(0x27),
      mutation_bit:raw.readUInt32LE(0x2b),offset,raw};
  });
  return {id:map.toUpperCase(),bytes,records,sha256:createHash('sha256').update(bytes).digest('hex')};
}));
const unlocks=maps.flatMap(map=>map.records.filter(r=>r.mutation_type===17&&r.mutation_bit)
  .map(record=>({map,record,id:record.mutation_bit})));
const synthesize={allowedModes:['synthesize']},forge={allowedModes:['forge']};
const options=id=>({mode:catalog[id].type===1?'forge':'synthesize',
  category:catalog[id].type===1?'weapon':catalog[id].subtype===1?'crystal':'material',id,mapId:'M03051',recordId:21});
const inventory=(id,quantity=1)=>{
  const raw=initializeChapterItem(items.definitions[id],{allowWeapon:true});new DataView(raw.buffer).setUint32(4,quantity,true);
  return {instance_id:`guild-material:${id}`,id,name:items.definitions[id].name,quantity,source_raw_hex:Buffer.from(raw).toString('hex')};
};
function world(){
  const value=structuredClone(seed);value.inventory=[];value.money=175;
  value.reserve_party=Object.entries(value.source.role_definitions).filter(([id])=>id!=='001')
    .map(([,definition])=>({role:chapterRoleFromDefinition(definition)}));
  return value;
}
function ingredients(value,id){
  // Preserve repeated source slots (262 contains two separate 265 records).
  const counts=new Map();for(const material of catalog[id].ingredients)counts.set(material,(counts.get(material)??0)+1);
  value.inventory=[...counts].map(([id,quantity])=>inventory(id,quantity));
}

test('all60 actual guild unlocks retain original IDs, recipe slots and acquisition provenance',()=>{
  assert.equal(createHash('sha256').update(source).digest('hex'),published.source_hashes['SYSTEM/Object.ITM']);
  assert.equal(unlocks.length,60);assert.equal(new Set(unlocks.map(row=>row.id)).size,60);
  for(const {map,record,id}of unlocks){
    const definition=items.definitions[id],offset=0x61c+(id-1)*0x3bf,raw=source.subarray(offset,offset+0x3bf);
    assert.equal(definition.raw_hex,raw.toString('hex'));assert.equal(definition.initialization.deterministic,true);
    assert.equal(definition.availability.enabled,true,`${id} ${definition.name} must be usable after acquisition`);
    assert.notEqual(definition.behavior.kind,'source-only');
    const provenance=published.catalog.equipment_admission.sources[id].find(row=>
      row.kind==='registered-recipe-product'&&row.map_id===map.id&&row.record_id===record.id);
    assert.ok(provenance,`${map.id}:${record.id} actual recipe root`);
    assert.equal(provenance.source.sha256,map.sha256);assert.equal(provenance.source.offset,record.offset);
    assert.deepEqual(catalog[id].ingredients,Array.from({length:raw[0x392]},(_,i)=>raw.readUInt32LE(0x393+i*4)).filter(Boolean));
  }
  const floating=maps[1].records;
  assert.equal(floating.find(row=>row.id===60).mutation_bit,205,'preserve the actual205, not dialogue174');
  assert.deepEqual(catalog[205].ingredients,[],'the original unlocked crystal has no material slots');
  assert.deepEqual(catalog[165].ingredients,[159,331,231,278]);
  assert.deepEqual(catalog[176].ingredients,[156,252,331,230,274]);
  assert.deepEqual(catalog[262].ingredients,[204,265,265,238,392]);
});

test('all guild products are made from exact original material slots without a money fee',async()=>{
  for(const {record,id}of unlocks){
    const value=world();ingredients(value,id);
    applyNativeStoryMutation(value,record);const inventoryBefore=structuredClone(value.inventory);
    assert.equal(applyNativeStoryMutation(value,record).changed,false,'recipe learning is idempotent');
    assert.deepEqual(value.inventory,inventoryBefore,'learning a recipe never grants its product');
    const opts=options(id),service=opts.mode==='forge'?forge:synthesize;
    const row=nativeServiceRows(service,value,catalog,opts).find(row=>row.item_id===id);
    assert.equal(row?.enabled,true,`${id} ${catalog[id].name}`);
    const result=applyNativeServiceAction(value,service,catalog,opts);
    assert.equal(result.changed,true);assert.equal(result.item_id,id);assert.equal(value.money,175);
    for(const material of new Set(catalog[id].ingredients))assert.equal(nativeOwnedQuantity(value,material),0);
    assert.equal(nativeOwnedQuantity(value,id),1);
    assert.deepEqual(await decodeSave(await encodeSave(value)),value);
  }
});

test('each crafted guild crystal sockets, links actual values and installs its native immunity',async()=>{
  const applicableSkills=Object.values(statusData.skills).filter(skill=>![1,3,5,6].includes(skill.mode_raw));
  for(const {record,id}of unlocks.filter(({id})=>catalog[id].type===3&&catalog[id].subtype===1)){
    assert.equal(isSupportedCrystalDefinition(items.definitions[id]),true);
    const value=world();ingredients(value,id);applyNativeStoryMutation(value,record);
    applyNativeServiceAction(value,synthesize,catalog,options(id));
    const store=new WorldStore(value),created=store.value.inventory.find(row=>row.id===id);
    const socket={worldStore:store,attributes,itemData:items,roleId:'001',socketIndex:1};
    insertCrystal({...socket,instanceId:created.instance_id});
    const actor=createPartyActors(store.snapshot(),attributes,{},items)[0],raw=Buffer.from(created.source_raw_hex,'hex');
    for(const offset of [0x45,0x65,0x69,0x6d,0x71,0x75,0x79]){
      const initial=Buffer.from(seed.source.initial_equipment.find(row=>row.role_id==='001').source_raw_hex,'hex');
      assert.equal(actor.equipment.item_sums_by_offset[`0x${offset.toString(16).padStart(2,'0')}`],raw.readInt32LE(offset)+initial.readInt32LE(offset));
    }
    let calls=0;const initialized=initializeNativeStatuses(actor,statusData,undefined,()=>{calls++;return 0;});
    assert.equal(calls,1);assert.deepEqual(actor.equipment_passives.map(row=>row.item_id),[id]);
    const statusId=items.definitions[id].equipment_passive.effect_id_raw;
    assert.deepEqual(initialized.native_status_slots.filter(row=>parseInt(row.raw_hex.slice(2,4),16))
      .map(row=>[parseInt(row.raw_hex.slice(2,4),16),parseInt(row.raw_hex.slice(22,24),16)]),[[statusId,6]]);
    const incoming=applicableSkills.find(skill=>skill.effect_id_raw===statusId);
    if(incoming){
      const blocked=applyNativeSkillStatus({actor:initialized,skill:incoming,data:statusData,rng:()=>0,now:0});
      assert.equal(blocked.reason,'effect-immunity',`${id} blocks actual source skill ${incoming.actor_id}:${incoming.original_skill_index}`);
      assert.equal(blocked.applied,false);
    }
    assert.equal(tickNativeStatuses({actor:initialized,threshold:1,now:100000,data:statusData,rng:()=>assert.fail('mode6 must not tick')}).ticks,0);
    const before=store.snapshot();assert.deepEqual(await decodeSave(await encodeSave(before)),before);
    removeCrystal(socket);assert.equal(nativeOwnedQuantity(store.value,id),1);
    assert.deepEqual(createPartyActors(store.snapshot(),attributes,{},items)[0].equipment_passives,[]);
  }
});

test('forging every highest-tier weapon replaces its owner weapon while preserving sockets and stored resources',async()=>{
  for(const id of [259,260,261,262,263]){
    const value=world(),owner=String(Math.log2(catalog[id].allowed_role_mask_raw_13e)+1).padStart(3,'0');
    value.crystal_sockets={version:1,roles:{[owner]:[inventory(156),null,null,null,null,null]}};
    const sockets=structuredClone(value.crystal_sockets),roles=structuredClone([value.party,value.reserve_party]);
    ingredients(value,id);value.recipe_unlock_indices=[id-1];
    const old=value.source.initial_equipment.find(row=>row.role_id===owner).item_id;
    const result=applyNativeServiceAction(value,forge,catalog,options(id));assert.equal(result.changed,true);
    const weapon=value.equipment.roles[owner].find(row=>row.slot_id==='weapon');assert.equal(weapon.id,id);
    assert.equal(nativeOwnedQuantity(value,old),0,'native47BFF0 overwrites, without returning the former weapon');
    assert.deepEqual(value.crystal_sockets,sockets);assert.deepEqual([value.party,value.reserve_party],roles);
    const initialized=initializeChapterItem(items.definitions[id],{allowWeapon:true});new DataView(initialized.buffer).setUint32(4,1,true);
    assert.equal(weapon.source_raw_hex,Buffer.from(initialized).toString('hex'),'new weapon does not inherit old numeric rolls');
    assert.deepEqual(await decodeSave(await encodeSave(value)),value);
  }
});

test('original repeated material slots preserve partial native consumption on a failed second removal',()=>{
  const value=world();ingredients(value,262);value.inventory.find(row=>row.id===265).quantity=1;
  value.inventory.find(row=>row.id===265).source_raw_hex=inventory(265).source_raw_hex;
  value.recipe_unlock_indices=[261];
  // 438F60 checks existence independently for each slot;4397F0 removes in order.
  assert.equal(nativeServiceRows(forge,value,catalog,options(262))[0].enabled,true);
  const result=applyNativeServiceAction(value,forge,catalog,options(262));
  assert.equal(result.changed,true);assert.equal(result.item_id,undefined);assert.match(result.message,/未能合成/);
  assert.equal(nativeOwnedQuantity(value,204),0);assert.equal(nativeOwnedQuantity(value,265),0);
  assert.equal(nativeOwnedQuantity(value,238),1);assert.equal(nativeOwnedQuantity(value,392),1);
  assert.equal(nativeOwnedQuantity(value,262),0);assert.equal(value.money,175);
});

test('recipe materials may be consumed from an equipped crystal before native weapon replacement',()=>{
  const value=world();ingredients(value,259);value.inventory=value.inventory.filter(row=>row.id!==205);
  value.crystal_sockets={version:1,roles:{'001':[inventory(205),null,null,null,null,null]}};
  value.recipe_unlock_indices=[258];
  assert.equal(nativeServiceRows(forge,value,catalog,options(259))[0].enabled,true);
  applyNativeServiceAction(value,forge,catalog,options(259));
  assert.equal(value.crystal_sockets.roles['001'][0],null);
  assert.equal(value.equipment.roles['001'][0].id,259);assert.equal(nativeOwnedQuantity(value,205),0);
});

test('085 actual wind feather reward equips, supplies source effect34 immunity and returns without changing permanent resources',async()=>{
  const provenance=published.catalog.item_capability_admission.passive_sources[136].find(row=>
    row.kind==='registered-enemy-reward'&&row.map_id==='M71080'&&row.enemy_id==='085');
  assert.ok(provenance);const chr=await readFile(new URL('../../../Fight_Role/085.CHR',import.meta.url));
  assert.equal(createHash('sha256').update(chr).digest('hex'),provenance.source.sha256);
  assert.equal(chr.readUInt32LE(provenance.source.offset),136);
  const value=world();value.inventory=[inventory(136)];const store=new WorldStore(value),before=store.snapshot();
  changeEquipment(store,attributes,items,{roleId:'001',slotId:'special',instanceId:'guild-material:136'});
  const actor=createPartyActors(store.snapshot(),attributes,{},items)[0];
  assert.deepEqual(actor.equipment_passives.map(row=>row.item_id),[136]);
  const initialized=initializeNativeStatuses(actor,statusData,undefined,()=>0);
  assert.equal(parseInt(initialized.native_status_slots[0].raw_hex.slice(2,4),16),34);
  const incoming=Object.values(statusData.skills).find(row=>row.effect_id_raw===34&&row.mode_raw===0);
  assert.ok(incoming);assert.equal(applyNativeSkillStatus({actor:initialized,skill:incoming,data:statusData,rng:()=>0,now:0}).reason,'effect-immunity');
  assert.deepEqual(await decodeSave(await encodeSave(store.snapshot())),store.snapshot());
  changeEquipment(store,attributes,items,{roleId:'001',slotId:'special'});
  assert.deepEqual(createPartyActors(store.snapshot(),attributes,{},items)[0].equipment_passives,[]);
  assert.deepEqual(store.value.party,before.party);assert.equal(nativeOwnedQuantity(store.value,136),1);
});

test('actual unique guild loot20 applies its whole-side HP maximum status once and clears on battle exit',async()=>{
  const definition=items.definitions[20],raw=source.subarray(0x61c+19*959,0x61c+20*959);
  assert.equal(definition.raw_hex,raw.toString('hex'));assert.equal(raw[0x14b],1);
  assert.deepEqual([raw[0x156],raw[0x157],raw[0x2a9],raw[0x2b3],raw[0x2b8]],[1,1,20,0,0]);
  assert.equal(raw.readInt32LE(0x2a8+2),-1);
  assert.equal(raw.readInt32LE(0x2a8+0x27),5000);assert.equal(definition.behavior.kind,'status-support');
  assert.equal(definition.availability.enabled,true);assert.equal(usableItems([inventory(20)],items,'field').length,0);
  const value=world(),second=value.reserve_party.find(entry=>entry.role.id==='003');
  value.party.push(second.role);value.reserve_party=value.reserve_party.filter(entry=>entry!==second);
  value.inventory=[inventory(20,2)];value.opening.status='complete';
  const store=new WorldStore(value),before=store.snapshot();
  const [skills,forest,scheduler,ai,rewards,reactions,viewMeta]=await Promise.all(
    ['party_skills','forest_combat','battle_scheduler','forest_ai','party_rewards','party_reactions','party_battle_view'].map(json));
  const sample=assembleForestSample(createPartySample(store.snapshot(),attributes,skills,null,items),forest,
    {map_id:'M70010',members:[{id:'013'}]},
    {...scheduler,idle_skills:{...scheduler.idle_skills,...skills.idle_skills}},ai,rewards,reactions,statusData);
  let now=0;const events=[];
  const battle=new BattleController({world:store,itemData:items,resolveAction,applyDamage:applyNativeDamage,
    resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,
    now:()=>now,waitTick:async()=>{now+=20;},log:event=>events.push(event),playAction:async()=>{},
    // Advance the real waiting source records directly; this fixture verifies
    // native contacts and state without claiming a browser render clock.
    playSequence:async(event,hooks)=>{
      const compiled=compileNativeSequence(viewMeta,battle.actor(event.actor_id).resource_id,event.plan);
      for(const step of compiled.steps){
        hooks.onRecord(step);
        if(step.event)hooks.onContact({...step,contact_key:`${event.action_id}:${step.index}`});
      }
    }});
  battle.start({...sample,rng:createNativeRng(123)});
  for(const enemy of battle.state.actors.filter(actor=>actor.side==='enemy'))enemy.charge.delay=1000000;
  for(let attempt=0;attempt<2;attempt++){
    await commandReady(battle,'001');battle.selectPlayer('001');
    await battle.chooseItem('guild-material:20','001');
    assert.equal(battle.state.inventory.find(row=>row.id===20).quantity,1,'duplicate status does not consume a second feather');
    for(const actor of battle.players()){
      assert.equal(actor.status_by_address['0x0521f555'],5000);
      const slots=actor.native_status_slots.filter(row=>parseInt(row.raw_hex.slice(2,4),16)===20);
      assert.equal(slots.length,1);assert.ok(Buffer.from(slots[0].raw_hex,'hex').readInt32LE(2)<0,
        '509E10 decrements a negative duration too; only exactly zero removes the perpetual status');
    }
  }
  const used=events.filter(event=>event.type==='battle-item-used');assert.equal(used.length,2);
  assert.equal(used[0].result.group_results.length,2);assert.equal(used[1].result.item_used,false);
  const target=battle.actor('001'),hpBefore=target.hp.current,rawMaximum=target.raw_hp_maximum;
  await commandReady(battle,'001');battle.selectPlayer('001');await battle.choose('yannuan','001');
  assert.equal(target.hp.current,hpBefore+300,'actual41E950 healing may exceed the former raw HP maximum');
  assert.ok(target.hp.current>target.hp.maximum);assert.equal(target.raw_hp_maximum,rawMaximum);
  const healedRaw=target.raw_hp;
  battle.finish();
  assert.ok(battle.players().every(actor=>actor.status_by_address['0x0521f555']===0));
  for(const role of store.value.party)assert.equal(role.hp.maximum,before.party.find(row=>row.id===role.id).hp.maximum,
    'temporary C6 growth must not become permanent character HP maximum');
  assert.equal(store.value.party[0].hp.current,healedRaw,'clearing the temporary status does not invent a native HP clamp');
  assert.equal(store.value.inventory.find(row=>row.id===20).quantity,1);
  assert.deepEqual(await decodeSave(await encodeSave(store.snapshot())),store.snapshot());
});

test('real underground CF4 reward31 draws once, persists its attack roll and permanently changes current attack in field and battle',async()=>{
  const source=await innerWhiteForestSource(),mapId='M71076-4-34',objectIndex=12;
  const object=source.story.maps[mapId].objects.find(row=>row.index===objectIndex),definition=items.definitions[31];
  assert.equal(object.behavior_raw_cf,4);assert.equal(definition.behavior.kind,'permanent-stat-source');
  assert.deepEqual(definition.initialization.variable_fields,[{instance_offset:0x1d,definition_offset:0x19e,minimum:1,maximum:5}]);
  assert.equal(definition.initialization.runtime_random_initialization_supported,true);
  assert.deepEqual(definition.value_ranges.filter(row=>row.minimum||row.maximum).map(row=>
    [row.instance_offset,row.minimum,row.maximum]),[[0x1d,1,5],[0x41,5,5]],'all32 initialized fields are audited');
  validateChapterItemDefinition(definition);assert.throws(()=>initializeChapterItem(definition),/随机源/);
  for(const [draw,expected]of [[0,1],[1,2],[3,4],[4,1],[32767,4]]){
    let calls=0;const raw=initializeChapterItem(definition,{rng:()=>{calls++;return draw;}});
    assert.equal(new DataView(raw.buffer).getInt32(0x1d,true),expected);assert.equal(calls,1);
  }
  let fixedCalls=0;initializeChapterItem(items.definitions[20],{rng:()=>{fixedCalls++;return 123;}});assert.equal(fixedCalls,0);
  // Explicit source-map handoff tests the real CF4 handler; no campaign route is inferred.
  const value=structuredClone(source.seed);value.inventory=[];value.opening.status='complete';
  value.location={map_id:mapId,x:object.x_native*2,y:object.y_native*2,direction:0};
  const store=new WorldStore(value,source.mapIds);let pending;
  const {runner}=innerWhiteForestRunner(source,store,{objectAnimation:async({draft})=>{pending=draft;}});
  const expectedRng=createNativeRng(0x20261011),expectedRoll=1+expectedRng()%4;
  const unopened=store.snapshot();
  await assert.rejects(runner.runObject({mapId,objectIndex,playback:{check(){
    if(pending?.inventory.some(row=>row.id===31))throw Error('lotus interrupted');
  }}}),/lotus interrupted/);
  assert.equal(pending.encounters.rng_state,expectedRng.state,'the interrupted transaction really drew the native value');
  assert.deepEqual(store.snapshot(),unopened,'interruption rolls the chest, item and RNG state back together');
  await runner.runObject({mapId,objectIndex});const granted=store.value.inventory.find(row=>row.id===31);
  assert.ok(granted);assert.equal(Buffer.from(granted.source_raw_hex,'hex').readInt32LE(0x1d),expectedRoll);
  assert.equal(store.value.encounters.rng_state,expectedRng.state);
  assert.equal(chapterObjectState(store.value,mapId,objectIndex,source.story),3);
  const earned=store.snapshot();assert.deepEqual(await decodeSave(await encodeSave(earned),source.mapIds),earned);
  assert.equal((await runner.runObject({mapId,objectIndex})).already_done,true);assert.deepEqual(store.snapshot(),earned);
  const before=structuredClone(store.value.party[0].attributes_stored);
  const flat=before.attack.current+expectedRoll,expectedAttack=Math.min(999,flat+Math.trunc(flat*5/100));
  useWorldItem(store,attributes,items,{instanceId:granted.instance_id,targetId:'001'});
  assert.equal(store.value.inventory.some(row=>row.id===31),false);
  assert.deepEqual(store.value.party[0].attributes_stored.attack,{current:expectedAttack,base:before.attack.base});
  assert.deepEqual(store.value.party[0].attributes_stored.defense,before.defense);
  assert.equal(createPartyActors(store.snapshot(),attributes,{},items)[0].raw_by_address['0x0524a711'],expectedAttack);
  assert.deepEqual(await decodeSave(await encodeSave(store.snapshot()),source.mapIds),store.snapshot());

  const battleWorld=new WorldStore(earned,source.mapIds);
  const [skills,forest,scheduler,ai,rewards,reactions]=await Promise.all(
    ['party_skills','forest_combat','battle_scheduler','forest_ai','party_rewards','party_reactions'].map(json));
  const sample=assembleForestSample(createPartySample(battleWorld.snapshot(),attributes,skills,null,items),forest,
    {map_id:'M70010',members:[{id:'013'}]},
    {...scheduler,idle_skills:{...scheduler.idle_skills,...skills.idle_skills}},ai,rewards,reactions,statusData);
  let now=0;const battle=new BattleController({world:battleWorld,itemData:items,resolveAction,applyDamage:applyNativeDamage,
    resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,
    now:()=>now,waitTick:async()=>{now+=20;},playAction:async()=>{},playSequence:async()=>{}});
  battle.start({...sample,rng:createNativeRng(123)});
  for(const enemy of battle.state.actors.filter(actor=>actor.side==='enemy'))enemy.charge.delay=1000000;
  await commandReady(battle,'001');battle.selectPlayer('001');await battle.chooseItem(granted.instance_id,'001');
  assert.equal(battle.actor('001').raw_by_address['0x0524a711'],expectedAttack);
  battle.finish();assert.deepEqual(battleWorld.value.party[0].attributes_stored,store.value.party[0].attributes_stored);
  assert.equal(createPartyActors(battleWorld.snapshot(),attributes,{},items)[0].raw_by_address['0x0524a711'],expectedAttack);
  assert.deepEqual(await decodeSave(await encodeSave(battleWorld.snapshot()),source.mapIds),battleWorld.snapshot());

  // Parameter tuning maps the retained roll; it does not rewrite or reroll the saved instance.
  const tunedConfiguration=structuredClone(configuration);
  tunedConfiguration.entries[31].parameters.attributes={attack_flat:{minimum:0,maximum_exclusive:0},attack_percent:{minimum:0,maximum_exclusive:0}};
  const tuned=compileItemConfiguration(published,tunedConfiguration,'debug').data;
  const actor=createPartyActors(earned,attributes,{},items)[0],unchanged=restoreActorWithItem(actor,granted,tuned,{scope:'field'});
  assert.equal(unchanged.applied,false);assert.equal(unchanged.actor.raw_by_address['0x0524a711'],before.attack.current);
  assert.equal(granted.source_raw_hex,earned.inventory.find(row=>row.id===31).source_raw_hex);
  for(const [current,expected]of [[19,[21,22,23,24]],[949,[997,998,999,999]],[-20,[0,0,0,0]]]){
    for(let roll=1;roll<=4;roll++){
      const target=structuredClone(actor),header=Buffer.from(target.header_raw_hex,'hex');header.writeInt32LE(current,0x40);
      target.header_raw_hex=header.toString('hex');target.raw_by_address['0x0524a711']=current;
      const raw=initializeChapterItem(definition,{rng:()=>roll-1});new DataView(raw.buffer).setUint32(4,1,true);
      const result=restoreActorWithItem(target,{...granted,source_raw_hex:Buffer.from(raw).toString('hex')},items,{scope:'field'});
      assert.equal(result.actor.raw_by_address['0x0524a711'],expected[roll-1]);
      assert.equal(Buffer.from(result.actor.header_raw_hex,'hex').readInt32LE(0x44),before.attack.base);
    }
  }
});
