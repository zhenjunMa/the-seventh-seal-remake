// Shared YC-04 production rules replay and named handoffs for browser checks.
// Checkpoints retain earned state; positioning for a browser check is separate.
import assert from 'node:assert/strict';
import {WorldStore,encodeSave,decodeSave} from '../../web/core/world.mjs';
import {chapterObjectState} from '../../web/core/chapter.mjs';
import {planRouteExit} from '../../web/core/route.mjs';
import {applyWorldMapCommandToDraft} from '../../web/core/world_map.mjs';
import {compileItemConfiguration} from '../../web/core/item_registry.mjs';
import {insertCrystal,removeCrystal,socketEquipmentRows} from '../../web/core/crystal_sockets.mjs';
import {StoryPlayback} from '../../web/core/story_playback.mjs';
import {nativeEconomyCatalog,readNativeService,applyNativeServiceAction} from '../../web/core/native_economy.mjs';
import {nativeKeyedChest} from '../../web/core/native_map_chests.mjs';
import {innerWhiteForestComplete,innerWhiteForestRunner,innerWhiteForestRoute,
  innerWhiteForestSelect} from './inner_white_forest_world.mjs';

export async function innerWhiteForestSealComplete(source,{checkpoint=async()=>{}}={}){
  const quantity=(world,id)=>world.value.inventory.filter(row=>row.id===id).reduce((n,row)=>n+row.quantity,0);
  const bit=(world,index,number)=>Boolean(world.value.flags[index]&(1<<(number-1)));
  const npc=(runner,mapId,slot,playback)=>runner.runTlk({mapId,playback,recordId:source.story.maps[mapId].index_nonzero.find(row=>row.slot===slot).record,
    context:{steps:0,explicitInteraction:true,npcMapId:mapId,npcSlot:slot}});
  const restore=async world=>{const saved=world.snapshot();world.replace(await decodeSave(await encodeSave(saved),source.mapIds));assert.deepEqual(world.snapshot(),saved);};
  const trigger=(runner,mapId,id,record)=>runner.runTlk({mapId,triggerId:id,recordId:record});

  // Establish the old route prerequisites with their real writers. Starting
  // at the Kai encounter and handing off to the city are explicit rule-fixture
  // positions; this does not claim the earlier campaign or cross-region walk.
  const prepared=structuredClone(source.seed);prepared.opening.status='complete';
  prepared.location={map_id:'M17029',x:640,y:480,direction:0};
  const entryWorld=new WorldStore(prepared,source.mapIds),entry=innerWhiteForestRunner(source,entryWorld);
  await trigger(entry.runner,'M17029',31,25);
  assert.equal(bit(entryWorld,51,1),true);assert.deepEqual(entryWorld.value.party.map(row=>row.id),['001','002']);
  innerWhiteForestRoute(source,entryWorld,'M17020','M17026');
  await entry.runner.runObject({mapId:'M17026',objectIndex:9});assert.equal(bit(entryWorld,48,1),true);
  await restore(entryWorld);await checkpoint('route_prerequisites_earned',entryWorld);
  entryWorld.transact(draft=>{draft.location={map_id:'M01051',x:424,y:334,direction:3};});
  const world=await innerWhiteForestComplete(source,{world:entryWorld}),initial=world.snapshot();
  let failBattle=false,cancelAnimationMap=null,cancelPlayback;
  await checkpoint('jute_end',world);
  const {runner,trace}=innerWhiteForestRunner(source,world,{battle:async({draft})=>{
    assert.equal(quantity({value:draft},298),0);assert.equal(chapterObjectState(draft,'M70078_2',23,source.story),2);
    if(failBattle){draft.party[0].hp.current=1;throw Error('YC-04 seal battle defeated');}
    return {outcome:'victory'};
  },animationHooks:{map:async({mapId})=>{
    if(mapId===cancelAnimationMap)cancelPlayback.cancel();
  }}});
  const materialIds=[];
  const collectChest=async(mapId,objectIndex)=>{
    const object=source.story.maps[mapId].objects.find(row=>row.index===objectIndex),chest=nativeKeyedChest(object);
    const owned=chest.rewards.map(row=>quantity(world,row.id));
    await runner.runObject({mapId,objectIndex});await restore(world);
    for(const [j,reward]of chest.rewards.entries()){
      assert.equal(quantity(world,reward.id),owned[j]+1);
      if(![295,296,297].includes(reward.id))materialIds.push(reward.id);
    }
    assert.equal((await runner.runObject({mapId,objectIndex})).already_done,true);
  };
  assert.equal(world.location.map_id,'M17014');assert.equal(bit(world,16,1),true);
  assert.deepEqual(world.value.party.map(row=>row.id),['001','002','005']);
  innerWhiteForestRoute(source,world,'M17010');
  const departure=planRouteExit(world.value,'M17010',48,source.story.maps,source.content);assert.equal(departure.denied,undefined);
  world.transact(draft=>{for(const command of departure.commands)applyWorldMapCommandToDraft(draft,command);});
  await innerWhiteForestSelect(source,world,0);
  innerWhiteForestRoute(source,world,'M01040','M01010');
  await checkpoint('tabas_first_visit_before',world);
  await trigger(runner,'M01010',3,2);assert.equal(world.location.map_id,'M01050');
  assert.equal(bit(world,1,1),true);assert.equal(bit(world,26,1),true);assert.equal(bit(world,26,2),false);
  assert.deepEqual(trace.animations.filter(row=>row.id==='m01010-1'),[{id:'m01010-1',commands:75}]);await restore(world);
  await checkpoint('tabas_first_visit',world);
  innerWhiteForestRoute(source,world,'M01040','M01010');await trigger(runner,'M01010',3,2);
  assert.equal(world.location.map_id,'M01019');await checkpoint('tabas_artifact_advice_before',world);
  await npc(runner,'M01019',10);assert.equal(bit(world,26,2),true);assert.equal(bit(world,107,1),false);
  assert.ok(trace.dialogues.some(([map,id])=>map==='M01019'&&id===27));
  await checkpoint('tabas_artifact_advice',world);
  const afterAdvice=world.snapshot();await npc(runner,'M01019',10);
  assert.deepEqual(world.value.inventory,afterAdvice.inventory);assert.equal(trace.animations.filter(row=>row.id==='m01010-1').length,1);
  innerWhiteForestRoute(source,world,'M01010','M01040','M01042');
  await npc(runner,'M01042',11);assert.equal(quantity(world,298),0);assert.equal(bit(world,386,1),false);
  innerWhiteForestRoute(source,world,'M01040','M01060');
  await trigger(runner,'M01060',6,56);await innerWhiteForestSelect(source,world,3);
  innerWhiteForestRoute(source,world,'M70072','M70073','M70076');
  await trigger(runner,'M70076',1,1);assert.equal(world.location.map_id,'M70077-1');

  // Before each source chest, the return trigger keeps the current depth.
  // After collecting it, the same source trigger selects the next DAT identity.
  for(const [i,id]of ['M70078-1_1','M70078-2_1','M70078-3_1'].entries()){
    innerWhiteForestRoute(source,world,id);const before=world.snapshot();
    await trigger(runner,id,1,1);assert.equal(world.location.map_id,`M70077-${i+1}`);
    innerWhiteForestRoute(source,world,id);
    await checkpoint(`artifact_${295+i}_before`,world);
    for(const objectIndex of source.content.maps[id].objects.map(row=>row.index))await collectChest(id,objectIndex);
    assert.equal(quantity(world,295+i),1);assert.equal(quantity(world,332),1);
    await checkpoint(`artifact_${295+i}_after`,world);
    assert.deepEqual(world.value.party,before.party);
    await trigger(runner,id,1,1);assert.equal(world.location.map_id,`M70077-${i+2}`);
    innerWhiteForestRoute(source,world,'M70076');await restore(world);
    await trigger(runner,'M70076',1,1);assert.equal(world.location.map_id,`M70077-${i+2}`);
  }
  innerWhiteForestRoute(source,world,'M70078_2');
  await checkpoint('seal_hint_before',world);
  await runner.runObject({mapId:'M70078_2',objectIndex:23});
  assert.equal(bit(world,107,25),true);assert.equal(bit(world,107,1),false);
  assert.equal(chapterObjectState(world.value,'M70078_2',23,source.story),0);assert.equal(trace.battles.length,0);
  const inventoryBeforeAdvice=structuredClone(world.value.inventory);await runner.runObject({mapId:'M70078_2',objectIndex:23});
  assert.deepEqual(world.value.inventory,inventoryBeforeAdvice);await restore(world);
  await checkpoint('device_missing_sword',world);
  for(const index of [26,27])await collectChest('M70078_2',index);
  assert.equal(materialIds.length,7);assert.equal(quantity(world,332),1);
  await trigger(runner,'M70078_2',1,27);assert.equal(world.location.map_id,'M70077-4');
  innerWhiteForestRoute(source,world,'M70076','M70073','M70072','M70071');
  await trigger(runner,'M70071',4,1);await innerWhiteForestSelect(source,world,0);
  innerWhiteForestRoute(source,world,'M01040','M01042');
  await checkpoint('synthesis_before',world);
  const beforeSynthesis=world.snapshot();cancelPlayback=new StoryPlayback();cancelAnimationMap='M01042';
  await assert.rejects(npc(runner,'M01042',11,cancelPlayback),{name:'AbortError'});
  assert.deepEqual(world.snapshot(),beforeSynthesis);assert.equal(bit(world,386,1),false);cancelAnimationMap=null;
  await npc(runner,'M01042',11);assert.equal(bit(world,386,1),true);
  assert.ok([295,296,297].every(id=>quantity(world,id)===0));assert.equal(quantity(world,298),1);
  assert.equal(world.value.money,beforeSynthesis.money);await restore(world);
  await checkpoint('synthesis_after',world);
  const synthesized=structuredClone(world.value.inventory);await npc(runner,'M01042',11);
  assert.deepEqual(world.value.inventory,synthesized);assert.equal(trace.animations.filter(row=>row.id==='m01042-1').length,1);
  innerWhiteForestRoute(source,world,'M01040','M01060');await trigger(runner,'M01060',6,56);await innerWhiteForestSelect(source,world,3);
  innerWhiteForestRoute(source,world,'M70072','M70073','M70076');await trigger(runner,'M70076',1,1);
  assert.equal(world.location.map_id,'M70077-4');innerWhiteForestRoute(source,world,'M70078_2');
  await checkpoint('seal_before',world);
  const beforeSeal=world.snapshot();failBattle=true;
  await assert.rejects(runner.runObject({mapId:'M70078_2',objectIndex:23}),/YC-04 seal battle defeated/);
  assert.deepEqual(world.snapshot(),beforeSeal);failBattle=false;
  const playback=new StoryPlayback();cancelPlayback=playback;cancelAnimationMap='M70078_2';
  await assert.rejects(runner.runObject({mapId:'M70078_2',objectIndex:23,playback}),{name:'AbortError'});
  assert.deepEqual(world.snapshot(),beforeSeal);cancelAnimationMap=null;
  await runner.runObject({mapId:'M70078_2',objectIndex:23});
  assert.equal(quantity(world,298),0);assert.equal(bit(world,107,1),true);
  assert.equal(chapterObjectState(world.value,'M70078_2',23,source.story),3);
  assert.deepEqual(trace.battles.map(row=>[row.stage,row.members.map(member=>member.id)]),
    [['stage03.scn',['041','041','024']],['stage03.scn',['041','041','024']]]);
  const sealed=world.snapshot();await restore(world);
  await checkpoint('seal_after',world);
  assert.equal((await runner.runObject({mapId:'M70078_2',objectIndex:23})).already_done,true);
  assert.deepEqual(world.snapshot(),sealed);assert.equal(trace.battles.length,2);
  await trigger(runner,'M70078_2',1,27);assert.equal(world.location.map_id,'M70077');
  innerWhiteForestRoute(source,world,'M70076');await trigger(runner,'M70076',1,1);assert.equal(world.location.map_id,'M70077');
  innerWhiteForestRoute(source,world,'M70076','M70073','M70072','M70071');
  await trigger(runner,'M70071',4,1);await innerWhiteForestSelect(source,world,0);
  innerWhiteForestRoute(source,world,'M01040','M01010');await trigger(runner,'M01010',3,2);
  assert.equal(world.location.map_id,'M01019');assert.equal(trace.animations.filter(row=>row.id==='m01010-1').length,1);
  await checkpoint('tabas_seal_revisit_before',world);
  await npc(runner,'M01019',10);assert.equal(bit(world,26,3),true);
  assert.ok(trace.dialogues.some(([map,id])=>map==='M01019'&&id===34));
  assert.deepEqual((await npc(runner,'M01019',10)).traversed,[24,35]);await restore(world);
  await checkpoint('tabas_seal_revisit',world);
  assert.deepEqual(world.value.party,initial.party);assert.deepEqual(world.value.equipment,initial.equipment);
  assert.equal(world.value.money,initial.money);assert.deepEqual(world.value.source,initial.source);
  // Six chest rewards are socket crystals, and245 is a synthesis material.
  // Exercise each earned crystal through the actual socket rules; the original
  // shop only lists material245 for sale, so do not broaden its sell categories.
  const itemData=compileItemConfiguration(source.items,source.itemConfiguration,source.configuration.mode).data;
  const catalog=nativeEconomyCatalog(itemData);
  for(const id of materialIds.filter(id=>catalog[id].subtype===1)){
    const owned=quantity(world,id);
    const options={worldStore:world,attributes:source.attributes,itemData,roleId:'001',socketIndex:1};
    for(let use=0;use<2;use++){
      const crystal=world.value.inventory.find(row=>row.id===id);
      const result=insertCrystal({...options,instanceId:crystal.instance_id});
      assert.equal(result.installed.source_raw_hex,crystal.source_raw_hex);assert.equal(quantity(world,id),owned-1);
      assert.equal(socketEquipmentRows(world.value,source.attributes,itemData,'001')[0].item_id,id);
      await restore(world);removeCrystal(options);assert.equal(quantity(world,id),owned);
    }
  }
  await checkpoint('crystals_used',world);
  innerWhiteForestRoute(source,world,'M01010','M01040','M01050','M01051');
  const beforeSale=world.value.money,stock=quantity(world,245);let sales=0;
  runner.service=async({record,table,draft})=>{
    const item=draft.inventory.find(row=>row.id===245);
    assert.equal(applyNativeServiceAction(draft,readNativeService(record,table),catalog,{mode:'sell',id:item.instance_id,quantity:1}).changed,true);sales++;
  };
  await npc(runner,'M01051',11);assert.equal(sales,1);
  assert.equal(world.value.money,beforeSale+(catalog[245].price>>1));assert.equal(quantity(world,245),stock-1);
  await restore(world);await checkpoint('materials_sold',world);
  innerWhiteForestRoute(source,world,'M01050','M01040','M01010');await trigger(runner,'M01010',3,2);
  return {world,trace};
}
