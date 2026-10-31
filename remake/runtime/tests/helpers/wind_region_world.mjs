// LC-01/WI-01/WI-02 rule integration. Source DAT exits, counters and complete
// TLK/ANM earn every new flag. Battle outcome callbacks and instant media do
// not prove rendered victories, natural walking or movie completion.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WorldStore,encodeSave,decodeSave} from '../../web/core/world.mjs';
import {WorldMapController} from '../../web/core/world_map.mjs';
import {worldMapEntry} from '../../web/core/map_connections.mjs';
import {loadEncounterMap} from '../../web/core/encounters.mjs';
import {storyBindings} from '../../web/core/content_registry.mjs';
import {StoryPlayback} from '../../web/core/story_playback.mjs';
import {chapterObjectState} from '../../web/core/chapter.mjs';
import {nativeKeyedChest,canOpenNativeChest} from '../../web/core/native_map_chests.mjs';
import {allPartyRoles} from '../../web/core/party_roster.mjs';
import {questJournal} from '../../web/core/story_quests.mjs';
import {templeComplete} from './fairy_forest_temple_world.mjs';
import {innerWhiteForestRunner,innerWhiteForestRoute} from './inner_white_forest_world.mjs';

export const windIslandChests=[
  {mapId:'M19021',objectIndex:21,rewards:[52]},
  {mapId:'M19022',objectIndex:19,rewards:[84]},
  {mapId:'M19023',objectIndex:17,rewards:[228]},
  {mapId:'M19023',objectIndex:18,rewards:[100]},
  {mapId:'M19024',objectIndex:19,rewards:[227]},
  {mapId:'M19041',objectIndex:9,rewards:[350]},
  {mapId:'M19041',objectIndex:10,rewards:[33,34,35,36,37,38]}
];

export async function windRegionComplete(source,{world,checkpoint=async()=>{},battle=async()=>({outcome:'victory'}),verifyFailures=true,servicesOnly=false}={}){
  world??=(await templeComplete(source)).world;
  const {quests}=JSON.parse(await readFile(new URL('../../web/data/story/shared.json',import.meta.url),'utf8'));
  const journal=()=>questJournal(quests,world.value).find(row=>row.id==='wind-region-main');
  const bit=(index,n)=>Boolean(world.value.flags[index]&2**(n-1));
  const quantity=(id,value=world.value)=>value.inventory.filter(row=>row.id===id).reduce((sum,row)=>sum+row.quantity,0);
  const reload=async()=>{const before=world.snapshot();world.replace(await decodeSave(await encodeSave(before),source.mapIds));assert.deepEqual(world.snapshot(),before);};
  let choice=0;const commandIndexes={};
  const animationHooks=Object.fromEntries(['map','actor','move','camera','wait','fade','sound','media','object'].map(name=>[name,async row=>{
    const id=row.command.source.path.split('/').at(-1).replace(/\.anm$/i,'').toLowerCase(),seen=commandIndexes[id]??=[];
    if(!seen.includes(row.command.index))seen.push(row.command.index);
    if(name==='media')trace.media.push(row.filename);
    if(name==='map'&&!row.bootstrap)trace.loaded_maps.push(row.mapId);
  }]));
  const {runner,trace}=innerWhiteForestRunner(source,world,{battle,choose:async()=>choice,animationHooks});
  trace.media=[];trace.loaded_maps=[];trace.routes=[];trace.command_indexes=commandIndexes;
  const route=(...ids)=>{for(const id of ids){trace.routes.push([world.location.map_id,id]);innerWhiteForestRoute(source,world,id);}};
  const npc=(mapId,slot,playback)=>{
    assert.equal(world.location.map_id,mapId);
    return runner.runTlk({mapId,playback,recordId:source.story.maps[mapId].index_nonzero.find(row=>row.slot===slot).record,
      context:{steps:0,explicitInteraction:true,npcMapId:mapId,npcSlot:slot}});
  };
  const select=async(area,index)=>{
    const controller=new WorldMapController({world,data:source.worldMap,load(){},
      prepare:async destination=>({location:worldMapEntry({},destination,source.story)}),
      enter:async(prepared,draft)=>{
        const mapId=prepared.location.map_id;loadEncounterMap(draft,mapId,source.encounterData);
        const entry=storyBindings(mapId,source.content).entry_record;
        if(entry){await runner.runTlk({mapId,recordId:entry,draft});return true;}
        return false;
      }});
    controller.open(area);await controller.select(index);
  };
  assert.equal(world.location.map_id,'M72061');assert.equal(bit(465,1),true);assert.equal(bit(12,1),false);
  assert.equal(journal().status,'active');assert.equal(journal().stage,'pursuit');
  assert.equal(world.value.leader_id,'003');assert.deepEqual(world.value.party.map(row=>row.id),['001','003','004','006']);
  const incoming=world.snapshot();await checkpoint('ff02_handoff',world,trace);
  assert.deepEqual((await runner.runTrigger({mapId:'M72061',triggerId:1})).world_map_requested,{area:1});
  await select(1,0);assert.equal(world.location.map_id,'M29010');await checkpoint('power_city_arrival',world,trace);
  if(servicesOnly){
    trace.services=[];
    for(const [mapId,slot,name]of [['M29014',15,'power_city_inn_before'],['M29013',12,'power_city_shop_before'],['M29015',14,'power_city_synthesis_before']]){
      route(mapId);await checkpoint(name,world,trace);
      const before=world.snapshot(),table=source.story.maps[mapId],entry=table.index_nonzero.find(row=>row.slot===slot).record;
      assert.ok(storyBindings(mapId,source.content).npcs.includes(slot));
      // Browser samples keep their earned175 money and injured resources.
      // Only the full original refusal root is replayed here; the UI must
      // perform a real sale before it can afford successful lodging/crafting.
      choice=1;await npc(mapId,slot);choice=0;
      assert.deepEqual(world.snapshot(),{...before,revision:before.revision+1});
      trace.services.push({map_id:mapId,npc_slot:slot,record_id:entry,source:table.records.find(row=>row.id===entry).source,choice:'decline'});
      route('M29010');
    }
    assert.equal(world.value.money,incoming.money);assert.deepEqual(world.value.inventory,incoming.inventory);assert.deepEqual(world.value.party,incoming.party);
    await checkpoint('power_city_services_complete',world,trace);return {world,trace};
  }
  // Leaving the city really closes the coast; the later plaza exit must earn
  // it again. No test fixture writes a world-map status directly.
  await runner.runTrigger({mapId:'M29010',triggerId:1});assert.equal(world.value.world_map.areas[1].statuses[6],2);
  route('M29011','M29012');await npc('M29012',11);assert.equal(world.location.map_id,'M29012');assert.equal(bit(519,1),false);
  route('M29011');await checkpoint('power_city_ticket_before',world,trace);
  choice=1;await npc('M29011',11);assert.equal(bit(519,1),false);choice=0;
  await npc('M29011',11);assert.equal(bit(519,1),true);await reload();
  await npc('M29011',11);assert.equal(bit(519,1),true);
  route('M29012');choice=1;await npc('M29012',11);assert.equal(bit(519,1),true);choice=0;
  await npc('M29012',11);assert.equal(bit(519,1),false);assert.equal(world.location.map_id,'M03021-4');
  route('M03023','M03020','M03010','M03040','M03050','M03060');
  await checkpoint('floating_plaza_exit_before',world,trace);
  assert.deepEqual((await runner.runTrigger({mapId:'M03060',triggerId:9})).world_map_requested,{area:1});
  assert.equal(world.value.world_map.areas[1].statuses[6],0);await select(1,6);
  assert.equal(world.location.map_id,'M55010');await checkpoint('island_ship_before',world,trace);
  if(verifyFailures){
    const cancelled=new WorldStore(world.snapshot(),source.mapIds),before=cancelled.snapshot(),playback=new StoryPlayback();
    const attempt=innerWhiteForestRunner(source,cancelled,{animationHooks:{map:async({mapId})=>{if(mapId==='M19010')playback.cancel();}}});
    await assert.rejects(attempt.runner.runTlk({mapId:'M55010',recordId:1,playback,
      context:{steps:0,explicitInteraction:true,npcMapId:'M55010',npcSlot:10}}),{name:'AbortError'});
    assert.deepEqual(cancelled.snapshot(),before);
  }
  await npc('M55010',10);assert.equal(world.location.map_id,'M19010');
  assert.deepEqual(trace.animations,[{id:'m19010-1',commands:36}]);
  assert.deepEqual([...commandIndexes['m19010-1']].sort((a,b)=>a-b),Array.from({length:36},(_,i)=>i));
  await reload();await checkpoint('island_arrival',world,trace);
  route('M19020');assert.equal((await npc('M19020',19)).save_requested,true);
  for(const mapId of ['M19021','M19022','M19023','M19024']){
    route(mapId);
    for(const chest of windIslandChests.filter(row=>row.mapId===mapId)){
      const before=world.snapshot();await checkpoint(`chest_${mapId.toLowerCase()}_${chest.objectIndex}_before`,world,trace);
      if(verifyFailures&&chest===windIslandChests[0]){
        const failed=new WorldStore(before,source.mapIds),attempt=innerWhiteForestRunner(source,failed,{objectAnimation:async()=>{throw Error('WI-01 chest animation unavailable');}});
        await assert.rejects(attempt.runner.runObject(chest),/WI-01 chest animation unavailable/);assert.deepEqual(failed.snapshot(),before);
      }
      await runner.runObject(chest);assert.equal(chapterObjectState(world.value,mapId,chest.objectIndex,source.story),3);
      for(const id of chest.rewards)assert.equal(quantity(id),quantity(id,before)+1);
      await reload();const earned=world.snapshot();assert.equal((await runner.runObject(chest)).already_done,true);assert.deepEqual(world.snapshot(),earned);
      await checkpoint(`chest_${mapId.toLowerCase()}_${chest.objectIndex}_complete`,world,trace);
    }
    route('M19020');
  }
  route('M19042','M19040');await checkpoint('elder_gift_before',world,trace);const beforeGift=world.snapshot();
  if(verifyFailures){
    const failed=new WorldStore(beforeGift,source.mapIds),attempt=innerWhiteForestRunner(source,failed,{say:async({record})=>{if(record.id===2)throw Error('WI-01 gift interrupted');}});
    await assert.rejects(attempt.runner.runTlk({mapId:'M19040',recordId:1,context:{steps:0,explicitInteraction:true,npcMapId:'M19040',npcSlot:12}}),/WI-01 gift interrupted/);
    assert.deepEqual(failed.snapshot(),beforeGift);
  }
  await npc('M19040',12);for(const id of [169,16,18])assert.equal(quantity(id),quantity(id,beforeGift)+1);
  assert.equal(bit(436,1),true);await reload();const gift=world.snapshot();await npc('M19040',12);
  assert.deepEqual(world.value.inventory,gift.inventory);assert.deepEqual(world.value.flags,gift.flags);await checkpoint('elder_gift_complete',world,trace);
  route('M19041');
  for(const chest of windIslandChests.filter(row=>row.mapId==='M19041')){
    const before=world.snapshot();await checkpoint(`chest_m19041_${chest.objectIndex}_before`,world,trace);await runner.runObject(chest);
    for(const id of chest.rewards)assert.equal(quantity(id),quantity(id,before)+1);
    assert.equal(chapterObjectState(world.value,chest.mapId,chest.objectIndex,source.story),3);await reload();
    const earned=world.snapshot();assert.equal((await runner.runObject(chest)).already_done,true);assert.deepEqual(world.snapshot(),earned);
    await checkpoint(`chest_m19041_${chest.objectIndex}_complete`,world,trace);
  }
  route('M19040','M19030-1','M19030','M73014');
  const sealedChest=nativeKeyedChest(source.story.maps.M73014.objects.find(row=>row.index===9));
  assert.equal(sealedChest.keyId,333);assert.equal(canOpenNativeChest(world.value,sealedChest),false);
  assert.equal(storyBindings('M73014',source.content).objects.some(row=>row.index===9),false,'Wind-key chest stays outside this acquisition phase');
  const beforeUnderground=world.snapshot();assert.deepEqual((await runner.runTrigger({mapId:'M73014',triggerId:3})).traversed,[34]);
  assert.deepEqual(world.snapshot(),{...beforeUnderground,revision:beforeUnderground.revision+1});
  route('M73012-01','M73011-02','M73012-03','M73011-04','M73012-05','M73011-06','M73012-07','M73011-08','M73012-09','M73011-10');
  assert.equal(world.value.encounters.global_pool_map_id,'M73012-09');await checkpoint('sacred_mountain_before',world,trace);
  const beforeMountain=world.snapshot(),retained=structuredClone(allPartyRoles(beforeMountain));
  if(verifyFailures){
    const failed=new WorldStore(beforeMountain,source.mapIds),attempt=innerWhiteForestRunner(source,failed,{battle:async({draft})=>{draft.money=0;throw Error('WI-02 guardian defeated');}});
    await assert.rejects(attempt.runner.runTrigger({mapId:'M73011-10',triggerId:2}),/WI-02 guardian defeated/);assert.deepEqual(failed.snapshot(),beforeMountain);
    const cancelled=new WorldStore(beforeMountain,source.mapIds),playback=new StoryPlayback();
    const mediaAttempt=innerWhiteForestRunner(source,cancelled,{animationHooks:{media:async({filename})=>{assert.equal(filename,'18.bik');playback.cancel();}}});
    await assert.rejects(mediaAttempt.runner.runTrigger({mapId:'M73011-10',triggerId:2,playback}),{name:'AbortError'});assert.deepEqual(cancelled.snapshot(),beforeMountain);
  }
  await runner.runTrigger({mapId:'M73011-10',triggerId:2});assert.equal(bit(12,1),true);assert.equal(world.location.map_id,'M55010');
  assert.equal(journal().status,'active');assert.equal(journal().stage,'return-to-valley');
  assert.deepEqual(trace.animations.at(-1),{id:'m73013-1',commands:113});assert.deepEqual(trace.media,['18.bik']);
  assert.deepEqual([...commandIndexes['m73013-1']].sort((a,b)=>a-b),Array.from({length:113},(_,i)=>i));
  assert.deepEqual(trace.battles.map(row=>[row.stage,row.members.map(member=>member.id)]),[['stage09.scn',['034']]]);
  assert.deepEqual(trace.loaded_maps.slice(-3),['M73013','M73014','M55010']);assert.deepEqual(world.value.party.map(row=>row.id),['001','003']);
  for(const id of ['004','006'])assert.deepEqual(allPartyRoles(world.value).find(row=>row.id===id),retained.find(row=>row.id===id));
  assert.equal(bit(10,5),false);await reload();await checkpoint('coast_return',world,trace);
  const beforeKey=quantity(334);await npc('M55010',10);assert.equal(quantity(334),beforeKey+1);assert.equal(bit(477,1),true);
  await reload();const key=world.snapshot();await npc('M55010',10);assert.deepEqual(world.value.inventory,key.inventory);assert.deepEqual(world.value.flags,key.flags);
  await checkpoint('water_key_complete',world,trace);await runner.runTrigger({mapId:'M55010',triggerId:1});await select(1,4);
  route('M03050','M03040','M03010','M03020','M03023');await npc('M03023',11);
  assert.equal(bit(411,1),true);assert.equal(bit(411,3),true);route('M03021-4');await npc('M03021-4',11);
  assert.equal(world.location.map_id,'M01022');assert.equal(bit(411,1),false);assert.equal(bit(411,3),false);
  route('M01021','M01020A','M01030','M01040','M01060');
  assert.deepEqual((await runner.runTrigger({mapId:'M01060',triggerId:6})).world_map_requested,{area:0});
  await checkpoint('fire_valley_return_before',world,trace);await select(0,4);
  assert.equal(world.location.map_id,'M17010');assert.equal(bit(10,5),true);assert.equal(bit(12,1),true);assert.equal(bit(465,1),true);
  assert.equal(journal().status,'completed');assert.equal(journal().stage,'returned');
  assert.deepEqual(world.value.party.map(row=>row.id),['001','003','002']);assert.deepEqual(trace.animations.at(-1),{id:'m17010-6',commands:30});
  await reload();const returned=world.snapshot(),animations=trace.animations.length;
  await runner.runTlk({mapId:'M17010',recordId:source.story.maps.M17010.header_entry_tlk_raw});
  assert.equal(trace.animations.length,animations);assert.deepEqual(world.value.party,returned.party);assert.deepEqual(world.value.flags,returned.flags);
  assert.deepEqual(world.value.source,incoming.source);await checkpoint('fire_valley_return_complete',world,trace);
  return {world,trace};
}
