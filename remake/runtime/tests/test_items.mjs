import {commandReady} from './helpers/battle_clock.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {ChapterRunner,chapterRoleFromDefinition,initializeChapterItem} from '../web/core/chapter.mjs';
import {createPartyActors,partyResourcesForWorld,consumePartyMp} from '../web/core/party_attributes.mjs';
import {withItemQuantity} from '../web/core/equipment.mjs';
import {useWorldItem,changeEquipment,restoreActorWithItem,canEquipItem} from '../web/core/items.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {assembleForestSample} from '../web/forest_sample.mjs';
import {createNativeRng,resolveAction,applyNativeDamage} from '../web/core/combat_rules.mjs';
globalThis.crypto??=webcrypto;
const read=p=>JSON.parse(fs.readFileSync(new URL('../web/data/'+p,import.meta.url),'utf8'));
const attributes=read('party_combat.json'),data=read('items.json'),story=read('chapter_story.json');
async function fixture(){
  const seed=read('opening_seed.json');seed.opening.status='complete';seed.location={map_id:'M17026',x:400,y:320,direction:0};
  seed.party.push(chapterRoleFromDefinition(seed.source.role_definitions['002']));seed.flags[51]|=1;
  const world=new WorldStore(seed,['M17026','M72061','M70010']);
  const runner=new ChapterRunner({world,data:story,objectData:read('chapter_map_resources.json').interactive_objects,say:async()=>{},animate:async()=>{},objectAnimation:async()=>{}});
  await runner.runObject({mapId:'M17026',objectIndex:9});await runner.runTlk({mapId:'M17026',recordId:14});return world;
}
test('Naturally awarded tea restores MP, updates raw quantity, and round-trips through a v1 save',async()=>{
  const world=await fixture(),tea=world.value.inventory.find(r=>r.id===12),beforeSource=structuredClone(world.value.source);
  const result=useWorldItem(world,attributes,data,{instanceId:tea.instance_id,targetId:'002'});
  assert.deepEqual(result.changes.mp,{before:0,after:40});assert.equal(world.value.party[1].mp.current,40);
  const retained=world.value.inventory.find(r=>r.id===12);assert.equal(retained.quantity,4);assert.equal(Buffer.from(retained.source_raw_hex,'hex').readUInt32LE(4),4);
  assert.deepEqual(world.value.source,beforeSource);assert.deepEqual(await decodeSave(await encodeSave(world.snapshot()),world.mapIds),world.snapshot());
});
test('Slot and character constraints move one equipment instance, restore it on removal, and preserve source',async()=>{
  const world=await fixture(),source=structuredClone(world.value.source),ring=world.value.inventory.find(r=>r.id===4),slot=data.definitions['4'].slot_id;
  const beforeActors=createPartyActors(world.snapshot(),attributes,{},data);
  changeEquipment(world,attributes,data,{roleId:'001',slotId:slot,instanceId:ring.instance_id});
  assert.equal(world.value.inventory.find(r=>r.id===4).quantity,1);assert.equal(world.value.equipment.roles['001'].find(r=>r.slot_id===slot).id,4);
  // The ring's flat20 also participates in the initial sword's5% speed bonus.
  const equipped=createPartyActors(world.snapshot(),attributes,{},data);assert.equal(equipped[0].linked_by_address['0x04f990a4']-beforeActors[0].linked_by_address['0x04f990a4'],21);
  const loaded=await decodeSave(await encodeSave(world.snapshot()),world.mapIds);assert.deepEqual(createPartyActors(loaded,attributes,{},data),equipped);
  changeEquipment(world,attributes,data,{roleId:'001',slotId:slot});assert.equal(world.value.inventory.find(r=>r.id===4).quantity,2);assert.deepEqual(world.value.source,source);
  assert.equal(data.definitions['51'].slot_id,data.definitions['61'].slot_id);
  assert.equal(canEquipItem(data.definitions['51'],'001','head'),false);assert.equal(canEquipItem(data.definitions['51'],'002','head'),true);
  assert.equal(canEquipItem(data.definitions['61'],'001','head'),true);assert.equal(canEquipItem(data.definitions['61'],'002','head'),false);
  const crown=world.value.inventory.find(r=>r.id===51),pearl=world.value.inventory.find(r=>r.id===61),unchanged=world.snapshot();
  assert.throws(()=>changeEquipment(world,attributes,data,{roleId:'001',slotId:'head',instanceId:crown.instance_id}),/角色或部位/);
  assert.throws(()=>changeEquipment(world,attributes,data,{roleId:'002',slotId:'head',instanceId:pearl.instance_id}),/角色或部位/);assert.deepEqual(world.snapshot(),unchanged);
  changeEquipment(world,attributes,data,{roleId:'002',slotId:'head',instanceId:crown.instance_id});
  changeEquipment(world,attributes,data,{roleId:'001',slotId:'head',instanceId:pearl.instance_id});
  assert.equal(world.value.equipment.roles['002'].filter(r=>r.slot_id==='head').length,1);
  assert.equal(world.value.equipment.roles['001'].find(r=>r.slot_id==='head').id,61);
  assert.equal(canEquipItem(data.definitions['1'],'001',data.definitions['1'].slot_id),true);assert.equal(canEquipItem(data.definitions['1'],'002',data.definitions['1'].slot_id),false);
});
test('Wrong slot, wrong actor, stale revision and invalid instances reject without changing the world',async()=>{
  const world=await fixture(),ring=world.value.inventory.find(r=>r.id===4),before=world.snapshot();
  assert.throws(()=>changeEquipment(world,attributes,data,{roleId:'001',slotId:'missing',instanceId:ring.instance_id}));
  assert.throws(()=>useWorldItem(world,attributes,data,{targetId:'002',instanceId:ring.instance_id}));
  assert.throws(()=>changeEquipment(world,attributes,data,{roleId:'001',slotId:data.definitions['4'].slot_id,instanceId:ring.instance_id,expectedRevision:world.value.revision-1}));
  assert.deepEqual(world.snapshot(),before);
  world.transact(draft=>{draft.inventory.find(r=>r.id===4).source_raw_hex='ff'.repeat(229);});const corrupt=world.snapshot();
  assert.throws(()=>changeEquipment(world,attributes,data,{roleId:'001',slotId:data.definitions['4'].slot_id,instanceId:ring.instance_id}));assert.deepEqual(world.snapshot(),corrupt);
});
test('Battle medicine consumes one scheduled action and commits once on exit',async()=>{
  const world=await fixture(),skills=read('party_skills.json');
  world.transact(draft=>{draft.party[0].mp.current=0;});
  const sample=assembleForestSample(createPartySample(world.snapshot(),attributes,skills,null,data),read('forest_combat.json'),{map_id:'M70010',members:[{id:'013'}]},
    {...read('battle_scheduler.json'),idle_skills:{...read('battle_scheduler.json').idle_skills,...skills.idle_skills}},read('forest_ai.json'),read('party_rewards.json'),read('party_reactions.json'),read('forest_status.json'));
  let now=0;const events=[];
  const battle=new BattleController({world,itemData:data,resolveAction,applyDamage:applyNativeDamage,resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,
    now:()=>now,waitTick:async()=>{now+=20;},log:e=>events.push(e),playAction:async()=>{},playSequence:async(result,hooks)=>{
      for(const record of result.plan.records){hooks.onRecord({...record,source_skill_index:record.source_skill_index});}
    }});
  // A real native scheduler and enemy AI run; presentation hooks resolve source
  // contacts immediately so this test measures state, not preview wall time.
  battle.playSequence=async(result,hooks)=>{const records=result.plan.records??result.plan.steps??[];
    if(!records.length){const skill=battle.skills[result.skill_id];const contact=skill.actions.find(r=>r.contact_u32_raw_0x49);hooks.onContact({source:contact,source_skill_index:skill.original_skill_index,contact_key:result.action_id,effect_contact:false});return;}
    for(const step of records){hooks.onRecord(step);if(step.source?.contact_u32_raw_0x49||step.contact_u32_raw_0x49)hooks.onContact({...step,source:step.source??step,contact_key:`${result.action_id}:${step.index}`,effect_contact:false});}
  };
  // Force only the turn arbitration, keeping native charge/debt and effect
  // conversion, while other suites cover complete enemy contact playback.
  battle.start({...sample,rng:createNativeRng(12345)});for(const enemy of battle.state.actors.filter(a=>a.side==='enemy'))enemy.charge.delay=1000000;
  const tea=battle.items().find(r=>r.id===12),before=world.snapshot();
  await commandReady(battle,'001');battle.selectPlayer('001');const queued=battle.chooseItem(tea.instance_id,'001');await assert.rejects(battle.chooseItem(tea.instance_id,'001'),/行动/);await queued;
  assert.equal(battle.state.phase,'charging');assert.equal(battle.state.round,2);assert.equal(battle.state.action_count,1);
  assert.equal(battle.actor('001').charge.gauge,-battle.state.scheduler.threshold);assert.equal(battle.items().find(r=>r.id===12).quantity,4);
  assert.equal(battle.actor('001').charge.delay,0);assert.equal(events.find(e=>e.type==='battle-item-used').charge.effective_delay,0);
  assert.equal(battle.actor('001').mp.current,56);assert.deepEqual(world.snapshot(),before);
  const done=battle.finish(),after=world.snapshot();assert.equal(after.inventory.find(r=>r.id===12).quantity,4);assert.equal(after.party[0].mp.current,50);
  assert.deepEqual(battle.finish(),done);assert.deepEqual(world.snapshot(),after);assert.equal(events.filter(e=>e.type==='battle-item-used').length,1);
});
test('Field medicine accepts depleted and full actors; battle rejects KO and immunity; gear preserves signed raw resources',async()=>{
  const world=await fixture(),tea=world.value.inventory.find(r=>r.id===12);
  useWorldItem(world,attributes,data,{instanceId:tea.instance_id,targetId:'001'});
  assert.equal(world.value.inventory.find(r=>r.id===12).quantity,4);
  world.transact(draft=>{draft.party[0].hp.current=(-88)>>>0;draft.party[0].mp.current=(-6)>>>0;});
  const actor=createPartyActors(world.snapshot(),attributes,{},data)[0];assert.equal(actor.hp.current,0);
  assert.throws(()=>restoreActorWithItem(actor,tea,data),/倒下或免疫/);
  const restored=useWorldItem(world,attributes,data,{instanceId:tea.instance_id,targetId:'001'});assert.equal(restored.actor.hp.current,0);assert.equal(restored.actor.mp.current,50);
  assert.throws(()=>restoreActorWithItem({...restored.actor,hp:{...restored.actor.hp,current:1},state_raw:0,immune_raw:1},tea,data),/免疫/);
  changeEquipment(world,attributes,data,{roleId:'001',slotId:'weapon'});assert.equal(world.value.party[0].hp.current,(-88)>>>0);
  const loaded=await decodeSave(await encodeSave(world.snapshot()),world.mapIds);
  assert.equal(createPartyActors(loaded,attributes,{},data)[0].hp.current,0);assert.equal(createPartyActors(loaded,attributes,{},data)[0].effective_hp_raw,-88);
  const weapon=world.value.inventory.find(r=>r.id===1);changeEquipment(world,attributes,data,{roleId:'001',slotId:'weapon',instanceId:weapon.instance_id});
  assert.equal(createPartyActors(world.snapshot(),attributes,{},data)[0].hp.current,0);assert.equal(world.value.party[0].hp.current,(-88)>>>0);
});
