// PC-02 starts at the prior main-chain endpoint, without the optional ticket
// replays in yc05Jl03Complete. Walking/rendering remain separate browser checks.
import assert from 'node:assert/strict';
import {WorldStore,encodeSave,decodeSave} from '../../web/core/world.mjs';
import {StoryPlayback} from '../../web/core/story_playback.mjs';
import {allPartyRoles} from '../../web/core/party_roster.mjs';
import {innerWhiteForestRunner,innerWhiteForestRoute} from './inner_white_forest_world.mjs';
import {yc05Jl03Complete} from './yc05_jl03_world.mjs';

export async function floatingCitySecondComplete(source,{world,checkpoint=async()=>{}}={}){
  if(!world){
    let endpoint;
    await yc05Jl03Complete(source,{checkpoint:async(name,current)=>{
      if(name==='yc05_main_end')endpoint=current.snapshot();
    }});
    world=new WorldStore(endpoint,source.mapIds);
  }
  const bit=(index,n)=>Boolean(world.value.flags[index]&2**(n-1));
  const quantity=id=>world.value.inventory.filter(row=>row.id===id).reduce((n,row)=>n+row.quantity,0);
  const npc=(mapId,slot,playback)=>runner.runTlk({mapId,playback,
    recordId:source.story.maps[mapId].index_nonzero.find(row=>row.slot===slot).record,
    context:{steps:0,explicitInteraction:true,npcMapId:mapId,npcSlot:slot}});
  const reload=async()=>{
    const before=world.snapshot();world.replace(await decodeSave(await encodeSave(before),source.mapIds));
    assert.deepEqual(world.snapshot(),before);
  };
  let answers={},fallback=0,cancelMap=null,playback;
  const {runner,trace}=innerWhiteForestRunner(source,world,{
    choose:async({record})=>answers[record.id]??fallback,
    animationHooks:{map:async({mapId})=>{if(mapId===cancelMap)playback.cancel();}}
  });
  assert.equal(world.location.map_id,'M03023');assert.equal(bit(456,1),true);
  assert.equal(bit(464,1),false);assert.deepEqual(world.value.party.map(row=>row.id),['001','003','004']);
  await checkpoint('pc02_start',world,trace);
  innerWhiteForestRoute(source,world,'M03020','M03010','M03012_1F');
  await checkpoint('inn_before',world,trace);
  fallback=1;await npc('M03012_1F',16);assert.equal(bit(410,1),false);
  fallback=0;await npc('M03012_1F',16);assert.equal(bit(410,1),true);
  await npc('M03012_1F',15);
  for(const id of ['M03012_2F','M03012_2F-2','M03012_2F-3','M03012_3F']){
    innerWhiteForestRoute(source,world,id);await npc(id,10);
  }
  innerWhiteForestRoute(source,world,'M03012_2F-3','M03012_2F-2','M03012_2F','M03012_1F');
  await npc('M03012_1F',16);assert.equal(quantity(305),0);
  assert.equal(world.value.flags[410]&0x7e,0,'Wrong order clears all five answer flags');
  answers={32:2,33:1,34:0,36:2,37:0,38:2,39:2,40:1};
  await checkpoint('puzzle_before',world,trace);await npc('M03012_1F',16);
  assert.equal(quantity(305),1);await reload();
  const solved=world.snapshot();await npc('M03012_1F',16);
  assert.deepEqual(world.value.inventory,solved.inventory);assert.deepEqual(world.value.flags,solved.flags);
  await checkpoint('puzzle_complete',world,trace);answers={};
  const beforeRest=world.snapshot();fallback=1;await npc('M03012_1F',11);
  assert.deepEqual(world.snapshot(),{...beforeRest,revision:beforeRest.revision+1});fallback=0;
  const canRest=beforeRest.money>=500;
  await npc('M03012_1F',11);assert.equal(world.value.money,beforeRest.money-(canRest?500:0));
  assert.deepEqual(trace.animations.filter(row=>row.id==='rest'),canRest?[{id:'rest',commands:28}]:[]);
  await reload();await checkpoint(canRest?'inn_rest_complete':'inn_insufficient',world,trace);
  innerWhiteForestRoute(source,world,'M03010','M03040','M03050','M03060');
  assert.equal((await npc('M03060',10)).save_requested,true);
  await reload();await checkpoint('plaza',world,trace);
  innerWhiteForestRoute(source,world,'M03050','M03040','M03010','M03020','M03023','M03021-4');
  await checkpoint('second_departure_before',world,trace);
  const before=world.snapshot(),retained=structuredClone(allPartyRoles(world.value));
  cancelMap='M72010-1-B';playback=new StoryPlayback();
  await assert.rejects(npc('M03021-4',22,playback),{name:'AbortError'});
  assert.deepEqual(world.snapshot(),before);cancelMap=null;
  fallback=1;await npc('M03021-4',22);assert.deepEqual(world.snapshot(),{...before,revision:before.revision+1});fallback=0;
  await npc('M03021-4',22);
  assert.equal(world.location.map_id,'M72010-1-B');assert.equal(world.value.leader_id,'003');
  assert.deepEqual(world.value.party.map(row=>row.id),['001','003','004','006']);
  assert.deepEqual(trace.animations.filter(row=>row.id==='m55001'),[{id:'m55001',commands:203}]);
  for(const role of retained)assert.deepEqual(allPartyRoles(world.value).find(row=>row.id===role.id),role);
  assert.equal(bit(464,1),false);assert.equal(bit(465,1),false);
  assert.equal(world.value.encounters.global_pool_map_id,'M72010-1-B');
  assert.deepEqual(source.encounterData.maps['M72010-1-B'].members.map(row=>row.id),['015','026','028']);
  await reload();await checkpoint('pc02_end',world,trace);
  return {world,trace};
}
