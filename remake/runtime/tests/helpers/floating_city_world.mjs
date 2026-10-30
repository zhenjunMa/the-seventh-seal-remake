// PC-01 continues the earned YC-04 endpoint using original exits and TLK/ANM.
// Rule callbacks do not simulate walking, rendering, or an original GAME run.
import assert from 'node:assert/strict';
import {encodeSave,decodeSave} from '../../web/core/world.mjs';
import {StoryPlayback} from '../../web/core/story_playback.mjs';
import {allPartyRoles} from '../../web/core/party_roster.mjs';
import {innerWhiteForestRunner,innerWhiteForestRoute} from './inner_white_forest_world.mjs';
import {innerWhiteForestSealComplete} from './inner_white_forest_seal_world.mjs';

export async function floatingCityComplete(source,{world,checkpoint=async()=>{}}={}){
  world??=(await innerWhiteForestSealComplete(source)).world;
  const bit=(index,number)=>Boolean(world.value.flags[index]&(1<<(number-1)));
  const npc=(mapId,slot,playback)=>runner.runTlk({mapId,playback,
    recordId:source.story.maps[mapId].index_nonzero.find(row=>row.slot===slot).record,
    context:{steps:0,explicitInteraction:true,npcMapId:mapId,npcSlot:slot}});
  const trigger=(mapId,id,recordId,playback)=>runner.runTlk({mapId,triggerId:id,recordId,playback});
  const restore=async()=>{
    const before=world.snapshot();
    world.replace(await decodeSave(await encodeSave(before),source.mapIds));
    assert.deepEqual(world.snapshot(),before);
  };
  let cancelMap=null,cancelPlayback,choice=0;
  const {runner,trace}=innerWhiteForestRunner(source,world,{
    choose:async({choices})=>choices.find(row=>row.index===choice).index,
    animationHooks:{map:async({mapId})=>{if(mapId===cancelMap)cancelPlayback.cancel();}}
  });
  assert.equal(bit(107,1),true);assert.equal(bit(426,1),false);
  innerWhiteForestRoute(source,world,'M01010','M01040','M01030');
  const originalRoles=structuredClone(allPartyRoles(world.value));
  const originalPool=world.value.encounters.global_pool_map_id;
  assert.equal(originalPool,'M01050');
  const beforeDetective=world.snapshot();await checkpoint('detective_before',world,trace);
  cancelMap='M00000';cancelPlayback=new StoryPlayback();
  await assert.rejects(npc('M01030',19,cancelPlayback),{name:'AbortError'});
  assert.deepEqual(world.snapshot(),beforeDetective);cancelMap=null;
  await npc('M01030',19);
  assert.equal(world.location.map_id,'M03039');assert.equal(world.value.leader_id,'004');
  assert.deepEqual(world.value.party.map(row=>row.id),['004']);assert.equal(bit(426,1),true);
  assert.ok(world.value.recipe_unlock_indices.includes(255));
  assert.equal(world.value.encounters.global_pool_map_id,originalPool);
  for(const role of originalRoles)assert.deepEqual(allPartyRoles(world.value).find(row=>row.id===role.id),role);
  await restore();await checkpoint('franco_room',world,trace);
  innerWhiteForestRoute(source,world,'M03034');await npc('M03034',19);
  assert.equal(bit(421,1),true);await checkpoint('library_commission',world,trace);
  innerWhiteForestRoute(source,world,'M03033','M03030','M03040','M03041','M03043',
    'M03043-2','M03043-3','M03043-4','M03043-5');
  await trigger('M03043-5',31,1);assert.equal(world.location.map_id,'M03044');
  const beforeBook=world.snapshot();await checkpoint('book_before',world,trace);
  cancelMap='M71071';cancelPlayback=new StoryPlayback();
  await assert.rejects(trigger('M03044',2,55,cancelPlayback),{name:'AbortError'});
  assert.deepEqual(world.snapshot(),beforeBook);cancelMap=null;
  await trigger('M03044',2,55);
  assert.equal(world.location.map_id,'M71071');assert.equal(bit(428,2),true);assert.equal(bit(428,3),false);
  assert.equal(world.value.encounters.global_pool_map_id,originalPool);
  assert.deepEqual(trace.animations.filter(row=>row.id==='m03044-1'),[{id:'m03044-1',commands:48}]);
  await restore();await checkpoint('dream_entry',world,trace);
  // The deep-floor teleport entrance remains wholly unadmitted.
  assert.ok(!source.content.maps.M71071.triggers.includes(3));
  assert.ok(!source.maps.M71075.exits.some(row=>row.target_map==='M71077'&&row.state==='ready'));
  innerWhiteForestRoute(source,world,'M71072','M71073','M71074','M71075');
  await checkpoint('dream_seal_before',world,trace);
  choice=1;await runner.runObject({mapId:'M71075',objectIndex:9});choice=0;
  assert.equal(world.location.map_id,'M71075');assert.equal(bit(428,3),false);
  const beforeReturn=world.snapshot();cancelMap='M03044';cancelPlayback=new StoryPlayback();
  await assert.rejects(runner.runObject({mapId:'M71075',objectIndex:9,playback:cancelPlayback}),{name:'AbortError'});
  assert.deepEqual(world.snapshot(),beforeReturn);cancelMap=null;
  await runner.runObject({mapId:'M71075',objectIndex:9});
  assert.equal(world.location.map_id,'M03044');assert.equal(bit(428,3),true);
  assert.deepEqual(trace.animations.filter(row=>row.id==='m03044-2'),[{id:'m03044-2',commands:22}]);
  await restore();await checkpoint('dream_return',world,trace);
  innerWhiteForestRoute(source,world,'M03043-5','M03043-4','M03043-3','M03043-2',
    'M03043','M03041','M03040','M03030','M03033','M03034','M03039');
  choice=1;await npc('M03039',11);choice=0;
  assert.equal(bit(426,2),false);assert.equal(world.value.leader_id,'004');
  await checkpoint('rest_before',world,trace);await npc('M03039',11);
  assert.equal(bit(426,2),true);assert.equal(bit(10,2),true);
  assert.equal(world.location.map_id,'M17032');assert.equal(world.value.leader_id,'001');
  assert.deepEqual(world.value.party.map(row=>row.id),['001','005']);
  assert.equal(bit(471,1),false);await restore();await checkpoint('fire_valley_return',world,trace);
  await trigger('M17032',2,1);assert.equal(world.location.map_id,'M17030-1');
  await npc('M17030-1',10);assert.equal(bit(471,1),true);
  await restore();await checkpoint('pc01_end',world,trace);
  const ended=world.snapshot();await npc('M17030-1',10);
  assert.deepEqual(world.value.party,ended.party);assert.deepEqual(world.value.inventory,ended.inventory);
  assert.deepEqual(world.value.flags,ended.flags);
  assert.deepEqual(trace.animations.filter(row=>row.id==='m03039-1'),[{id:'m03039-1',commands:38}]);
  assert.deepEqual(trace.animations.filter(row=>row.id==='m17010-3'),[{id:'m17010-3',commands:67}]);
  return {world,trace};
}
