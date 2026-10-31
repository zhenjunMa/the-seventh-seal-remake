// FF-01/02 source rules, starting at PC-02's earned ending. DAT exits select
// original entry markers; battle callbacks and instant media are rule checks,
// not walking, rendered battle victories or natural movie playback.
import assert from 'node:assert/strict';
import {WorldStore,encodeSave,decodeSave} from '../../web/core/world.mjs';
import {StoryPlayback} from '../../web/core/story_playback.mjs';
import {chapterObjectState} from '../../web/core/chapter.mjs';
import {allPartyRoles} from '../../web/core/party_roster.mjs';
import {floatingCitySecondComplete} from './floating_city_pc02_world.mjs';
import {innerWhiteForestRunner,innerWhiteForestRoute} from './inner_white_forest_world.mjs';

export const forestSwitches=[
  {mapId:'M72040-0-7',objectIndex:20,remoteIndex:9,program:'m72040-7',commands:21},
  {mapId:'M72040-0-8',objectIndex:20,remoteIndex:5,program:'m72040-8',commands:21},
  {mapId:'M72040-0-H',objectIndex:20,remoteIndex:8,program:'m72040-h',commands:21},
  {mapId:'M72040-1-P',objectIndex:18,remoteIndex:10,program:'m72040-p',commands:22},
  {mapId:'M72040-1-V',objectIndex:18,remoteIndex:7,program:'m72040-v',commands:21},
  {mapId:'M72040-1-Z',objectIndex:18,remoteIndex:6,program:'m72040-z',commands:21}
];

// Reused only for routes between the six source dead ends. Every edge is an
// admitted physical DAT exit; the variant transfer remains its actual TLK.
function routeTo(source,world,target){
  const paths=[[world.location.map_id]],seen=new Set();let path;
  while(paths.length){
    const next=paths.shift(),id=next.at(-1);if(id===target){path=next;break;}
    if(seen.has(id))continue;seen.add(id);
    for(const exit of source.maps[id].exits)if(exit.state==='ready'&&exit.target_map?.startsWith('M720'))paths.push([...next,exit.target_map]);
  }
  assert.ok(path,`Missing admitted forest DAT route to ${target}`);
  innerWhiteForestRoute(source,world,...path.slice(1));
}

async function restore(source,world){
  const before=world.snapshot();world.replace(await decodeSave(await encodeSave(before),source.mapIds));
  assert.deepEqual(world.snapshot(),before);
}

export async function forestSealComplete(source,{world,checkpoint=async()=>{}}={}){
  world??=(await floatingCitySecondComplete(source)).world;
  const before=world.snapshot(),bit=(index,n)=>Boolean(world.value.flags[index]&2**(n-1));
  const {runner,trace}=innerWhiteForestRunner(source,world);
  assert.equal(world.location.map_id,'M72010-1-B');assert.equal(world.value.leader_id,'003');
  assert.deepEqual(world.value.party.map(row=>row.id),['001','003','004','006']);
  assert.equal(bit(464,1)||bit(465,1),false);
  assert.ok(forestSwitches.every(row=>chapterObjectState(world.value,row.mapId,row.objectIndex,source.story)===0));
  await checkpoint('ff01_start',world,trace);

  routeTo(source,world,'M72010-1-D');await runner.runTrigger({mapId:'M72010-1-D',triggerId:4});
  assert.equal(world.location.map_id,'M72050');
  await runner.runTrigger({mapId:'M72050',triggerId:3});
  assert.equal(bit(96,1),false);assert.equal(chapterObjectState(world.value,'M72050',11,source.story),0);
  await checkpoint('seal_unfinished',world,trace);routeTo(source,world,'M72010-1-D');

  for(const [index,row]of forestSwitches.entries()){
    routeTo(source,world,row.mapId);await checkpoint(`switch_${index+1}_before`,world,trace);
    if(index===0){
      const cancelled=new WorldStore(world.snapshot(),source.mapIds),snapshot=cancelled.snapshot(),playback=new StoryPlayback();
      const failed=innerWhiteForestRunner(source,cancelled,{animationHooks:{map:async({mapId})=>{if(mapId==='M72050')playback.cancel();}}});
      await assert.rejects(failed.runner.runObject({...row,playback}),{name:'AbortError'});
      assert.deepEqual(cancelled.snapshot(),snapshot);
    }
    await runner.runObject(row);
    assert.equal(world.location.map_id,row.mapId);
    assert.equal(chapterObjectState(world.value,row.mapId,row.objectIndex,source.story),3);
    assert.equal(chapterObjectState(world.value,'M72050',row.remoteIndex,source.story),3);
    assert.equal(world.value.event_records[96].filter((record,slot)=>slot>=5&&slot<=10&&record.startsWith('03')).length,index+1);
    const animations=trace.animations.length,events=structuredClone(world.value.event_records);
    assert.equal((await runner.runObject(row)).already_done,true);
    assert.equal(trace.animations.length,animations);assert.deepEqual(world.value.event_records,events);
    await restore(source,world);await checkpoint(`switch_${index+1}_complete`,world,trace);
    if(index===2){
      routeTo(source,world,'M72010-1-D');await runner.runTrigger({mapId:'M72010-1-D',triggerId:4});
      assert.equal(world.location.map_id,'M72050');await runner.runTrigger({mapId:'M72050',triggerId:3});
      assert.equal(bit(96,1),false);assert.equal(chapterObjectState(world.value,'M72050',11,source.story),0);
      await checkpoint('seal_partial',world,trace);routeTo(source,world,'M72010-1-D');
    }
  }
  routeTo(source,world,'M72010-1-D');await checkpoint('seal_six_before_variant',world,trace);
  await runner.runTrigger({mapId:'M72010-1-D',triggerId:4});assert.equal(world.location.map_id,'M72050-1');
  // The original southward retreat plays its complete eight-command warning
  // and returns to the sealed map, where all six conditions open the vine.
  await runner.runTrigger({mapId:'M72050-1',triggerId:1});assert.equal(world.location.map_id,'M72050');
  await checkpoint('vine_before',world,trace);
  await runner.runTrigger({mapId:'M72050',triggerId:3});
  assert.equal(bit(96,1),true);assert.equal(chapterObjectState(world.value,'M72050',11,source.story),3);
  await restore(source,world);await checkpoint('vine_complete',world,trace);
  routeTo(source,world,'M72010-1-D');await runner.runTrigger({mapId:'M72010-1-D',triggerId:4});
  assert.equal(world.location.map_id,'M72050-1');await checkpoint('unseal_before',world,trace);
  await runner.runTrigger({mapId:'M72050-1',triggerId:30});assert.equal(bit(615,1),true);
  assert.equal(world.location.map_id,'M72050-1');
  const completed=world.snapshot(),count=trace.animations.length;
  await runner.runTrigger({mapId:'M72050-1',triggerId:30});assert.equal(trace.animations.length,count);
  assert.deepEqual(world.value.flags,completed.flags);assert.deepEqual(world.value.event_records,completed.event_records);
  assert.deepEqual(trace.animations,[...forestSwitches.map(({program:id,commands})=>({id,commands})),
    {id:'m72050-1',commands:8},{id:'m72050-2',commands:30}]);
  for(const key of ['party','reserve_party','equipment','inventory','money','source'])assert.deepEqual(world.value[key],before[key]);
  assert.equal(bit(464,1)||bit(465,1),false);await restore(source,world);
  await checkpoint('ff01_end',world,trace);return {world,trace};
}

export async function templeComplete(source,{world,checkpoint=async()=>{},battle=async()=>({outcome:'victory'})}={}){
  world??=(await forestSealComplete(source)).world;
  const before=world.snapshot(),bit=(index,n)=>Boolean(world.value.flags[index]&2**(n-1));
  let trace;
  const current=innerWhiteForestRunner(source,world,{battle,animationHooks:{media:async row=>trace.media.push(row.filename)}});
  const {runner}=current;trace=current.trace;trace.media=[];
  assert.equal(world.location.map_id,'M72050-1');assert.equal(bit(615,1),true);assert.equal(bit(465,1),false);
  await checkpoint('ff02_start',world,trace);await runner.runTrigger({mapId:'M72050-1',triggerId:2});
  assert.equal(world.location.map_id,'M72062');assert.equal(world.value.flags[388],before.flags[388]);
  assert.equal(chapterObjectState(world.value,'M72061',0,source.story),3);
  await runner.runTrigger({mapId:'M72062',triggerId:32});assert.equal(bit(464,1),true);
  await restore(source,world);await checkpoint('temple_warning_complete',world,trace);
  const stairs=[['M72063',32,524,['031A1']],['M72062-2',31,611,['031A1','031B2']],
    ['M72063-2',31,525,['031A2','031B1','031B1']],['M72062-3',31,612,['031A1','031A1','031B2']],
    ['M72063-3',31,526,['031A','031B','031C']]];
  for(const [index,[mapId,triggerId,flag,enemies]]of stairs.entries()){
    innerWhiteForestRoute(source,world,mapId);await checkpoint(`stair_${index+1}_before`,world,trace);
    const failedWorld=new WorldStore(world.snapshot(),source.mapIds),failedBefore=failedWorld.snapshot();
    const failed=innerWhiteForestRunner(source,failedWorld,{battle:async({draft})=>{draft.party[0].hp.current=1;throw Error('FF-02 stair defeated');}});
    await assert.rejects(failed.runner.runTrigger({mapId,triggerId}),/FF-02 stair defeated/);
    assert.deepEqual(failedWorld.snapshot(),failedBefore);
    await runner.runTrigger({mapId,triggerId});assert.equal(bit(flag,1),true);
    assert.equal(trace.battles.at(-1).stage,'stage05.scn');
    assert.deepEqual(trace.battles.at(-1).members.map(row=>row.id).sort(),enemies);
    const battleCount=trace.battles.length,animationCount=trace.animations.length;
    await runner.runTrigger({mapId,triggerId});assert.equal(trace.battles.length,battleCount);assert.equal(trace.animations.length,animationCount);
    await restore(source,world);await checkpoint(`stair_${index+1}_complete`,world,trace);
  }
  innerWhiteForestRoute(source,world,'M72064');await checkpoint('plaza_before',world,trace);
  const plaza=world.snapshot();
  const defeated=new WorldStore(plaza,source.mapIds),failed=innerWhiteForestRunner(source,defeated,{battle:async({draft})=>{draft.money=0;throw Error('FF-02 plaza defeated');}});
  await assert.rejects(failed.runner.runTrigger({mapId:'M72064',triggerId:31}),/FF-02 plaza defeated/);assert.deepEqual(defeated.snapshot(),plaza);
  const cancelled=new WorldStore(plaza,source.mapIds),playback=new StoryPlayback();
  const cancelledRunner=innerWhiteForestRunner(source,cancelled,{animationHooks:{media:async({filename})=>{assert.equal(filename,'14.bik');playback.cancel();}}});
  await assert.rejects(cancelledRunner.runner.runTrigger({mapId:'M72064',triggerId:31,playback}),{name:'AbortError'});
  assert.deepEqual(cancelled.snapshot(),plaza);
  await runner.runTrigger({mapId:'M72064',triggerId:31});
  assert.equal(world.location.map_id,'M72064');assert.equal(bit(465,1),true);
  assert.deepEqual(trace.battles.at(-1).members.map(row=>row.id),['033']);assert.equal(trace.battles.at(-1).stage,'stage04.scn');
  assert.deepEqual(trace.media,['14.bik']);assert.equal(trace.animations.at(-1).commands,93);
  assert.ok(trace.dialogues.some(([mapId,id])=>mapId==='M00000'&&id===1));
  assert.deepEqual(world.value.world_map.areas[1].statuses.slice(0,2),[0,2]);
  await restore(source,world);await checkpoint('revival_complete',world,trace);
  const animationCount=trace.animations.length,battleCount=trace.battles.length;
  await runner.runTrigger({mapId:'M72064',triggerId:31});assert.equal(trace.animations.length,animationCount);assert.equal(trace.battles.length,battleCount);
  const retreat=[['M72063-3',31],['M72062-3',31],['M72063-2',31],['M72062-2',31],['M72063',32],['M72062',32]];
  for(const [mapId,triggerId]of retreat){innerWhiteForestRoute(source,world,mapId);await runner.runTrigger({mapId,triggerId});}
  innerWhiteForestRoute(source,world,'M72061');
  const exit=await runner.runTrigger({mapId:'M72061',triggerId:1});assert.deepEqual(exit.world_map_requested,{area:1});
  assert.equal(trace.animations.length,animationCount);assert.equal(trace.battles.length,battleCount);
  assert.deepEqual(world.value.world_map.areas[1].statuses.slice(0,3),[0,0,0]);
  assert.equal(world.value.leader_id,'003');assert.deepEqual(world.value.party.map(row=>row.id),before.party.map(row=>row.id));
  for(const role of allPartyRoles(before))assert.ok(allPartyRoles(world.value).some(row=>row.id===role.id));
  assert.deepEqual(world.value.source,before.source);assert.deepEqual(world.value.equipment,before.equipment);
  await restore(source,world);await checkpoint('ff02_end',world,trace);return {world,trace};
}
