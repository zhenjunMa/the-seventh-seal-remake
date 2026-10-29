// Complete YC-03 source event chain through production TLK/ANM runners.
// Battle outcomes are bounded callbacks here; actual042 combat has its own
// replay tests. This is a rules replay, not browser or GAME.exe observation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {chapterObjectState} from '../web/core/chapter.mjs';
import {nativeChestAnimation} from '../web/core/native_map_chests.mjs';
import {mapPresentation} from '../web/core/map_presentation.mjs';
import {createMapController} from '../web/controllers/map.mjs';
import {createStoryController} from '../web/controllers/story.mjs';
import {innerWhiteForestSource,innerWhiteForestWorld,innerWhiteForestRunner,innerWhiteForestRoute,
  innerWhiteForestSelect,innerWhiteForestMapIds,innerWhiteForestOriginal} from './helpers/inner_white_forest_world.mjs';

const source=await innerWhiteForestSource(),copy=structuredClone;
const quantity=(world,id)=>world.value.inventory.filter(row=>row.id===id).reduce((n,row)=>n+row.quantity,0);
const bit=(world,index,number)=>Boolean(world.value.flags[index]&(1<<(number-1)));
const npc=(runner,mapId,slot)=>runner.runTlk({mapId,recordId:source.story.maps[mapId].index_nonzero.find(row=>row.slot===slot).record,
  context:{steps:0,explicitInteraction:true,npcMapId:mapId,npcSlot:slot}});
const restore=async world=>{const saved=world.snapshot();world.replace(await decodeSave(await encodeSave(saved),source.mapIds));assert.deepEqual(world.snapshot(),saved);};

test('YC-03 uses actual seven-map DAT objects and complete original TLK/ANM bytes',async()=>{
  for(const id of innerWhiteForestMapIds){
    assert.ok(source.content.maps[id],id);const table=source.story.maps[id];
    for(const provenance of [table.map_source,...(table.source?[table.source]:[])]){
      const bytes=await innerWhiteForestOriginal(provenance.path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),provenance.sha256,provenance.path);
      const rows=provenance===table.map_source?table.objects:table.records;
      for(const row of rows)assert.equal(bytes.subarray(row.source.offset,row.source.offset+row.raw_hex.length/2).toString('hex'),row.raw_hex);
    }
  }
  for(const id of ['m01051-1','m01050-1','m70073-1','m01050-2','m17010-2']){
    const program=source.story.programs[id],bytes=await innerWhiteForestOriginal(program.source.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),program.source.sha256);
    assert.equal(bytes.length,67+program.commands.length*74);
    for(const command of program.commands)assert.equal(bytes.subarray(command.source.offset,command.source.offset+74).toString('hex'),command.raw_hex);
  }
  assert.equal(source.story.programs['m70073-1'].commands.length,56);
  assert.ok(!source.content.maps.M70076.triggers.includes(1),'the complete later sealed-forest branch remains deferred');
});

test('source014 chest retains its seventeenth logical wait and hides its missing physical frame during collection and restore',async()=>{
  for(const index of [12,13]){
    const resource=source.resources.object_animations.M70071.find(row=>row.object_index_zero_based===index);
    const original=await innerWhiteForestOriginal(resource.source.path),{action,frameIndices}=nativeChestAnimation(resource,4);
    assert.equal(createHash('sha256').update(original).digest('hex'),resource.source.sha256);
    assert.equal(original[0],9);assert.equal(original[2],2);assert.equal(original.readUInt32LE(0x43+2*0xac+4),17);
    assert.equal(original.subarray(0x43+0xac,0x43+2*0xac).toString('hex'),action.raw_hex);
    assert.equal(resource.frames.length,17);assert.deepEqual(resource.frames.map(row=>row.index),Array.from({length:17},(_,i)=>i));
    assert.deepEqual(frameIndices,Array.from({length:17},(_,i)=>i+1));assert.equal(resource.completed_last_frame,17);
  }
  const world=innerWhiteForestWorld(source);world.transact(draft=>{draft.location={map_id:'M70071',x:0,y:0,direction:0};});
  const object={...source.maps.M70071.objects.find(row=>row.index===12),bitmap:{id:'closed014'}},scene={data:{id:'M70071'},objects:[object],npcs:[]};
  const resource=source.resources.object_animations.M70071.find(row=>row.object_index_zero_based===12),{action}=nativeChestAnimation(resource,4);
  const requested=[],frames=[],state={world,chapterStory:source.story,chapterResources:source.resources,
    resources:{peek(){throw Error('The nonexistent completed physical frame must not be requested');}}};
  const map=createMapController({state,actions:{},$:()=>({}),canvas:{},ctx:{}});
  const queue=()=>mapPresentation({scene,world:world.value,role:{frame_width:16,frame_height:16,map_draw_offset:{x:0,y:0}},
    action:{bitmap:{id:'leader'}},view:{frame:0},objectBitmap:map.objectBitmap});
  state.engine={exploration:{clock:{async tween(duration,update){
    assert.equal(duration,action.interval_raw*17);
    for(let i=0;i<17;i++){update((i+.25)/17);frames.push(state.objectPreview.bitmap);}
    assert.equal(frames.at(-1),null);assert.deepEqual(queue().map(row=>row.key),['leader']);
  }}}};
  const story=createStoryController({state,actions:{image:async path=>{requested.push(path);return {path};}},$:()=>({}),canvas:{}});
  const {runner}=innerWhiteForestRunner(source,world,{objectAnimation:story.animateChapterObject});
  assert.equal(map.objectBitmap(scene,object),object.bitmap);await runner.runObject({mapId:'M70071',objectIndex:12});
  assert.equal(requested.length,16);assert.equal(frames[0].path,resource.frames[1].image);
  assert.equal(frames[15].path,resource.frames[16].image);assert.equal(state.objectPreview,null);
  assert.equal(map.objectBitmap(scene,object),null);assert.deepEqual(queue().map(row=>row.key),['leader']);
  await restore(world);assert.equal(map.objectBitmap(scene,object,world.value,false),null);assert.equal(quantity(world,349),1);
});

test('two forest trips naturally earn349,332,293/294 and299 before all three first-return rewards and005 admission',async()=>{
  const world=innerWhiteForestWorld(source),initial=world.snapshot();let defeat=false;
  const {runner,trace}=innerWhiteForestRunner(source,world,{battle:async({draft})=>{
    if(defeat){draft.party[0].hp.current=1;throw Error('YC-03 battle defeat');}return {outcome:'victory'};
  }});
  await npc(runner,'M01051',10);
  assert.equal(bit(world,31,1),true);assert.equal(bit(world,31,2),false);
  assert.equal(world.value.world_map.areas[0].statuses[3],0);
  innerWhiteForestRoute(source,world,'M01050');await npc(runner,'M01050',15);
  assert.equal(quantity(world,332),0);assert.equal(bit(world,5,1),false);
  innerWhiteForestRoute(source,world,'M01040','M01060');
  await runner.runTlk({mapId:'M01060',triggerId:6,recordId:56});await innerWhiteForestSelect(source,world,3);
  assert.equal(world.location.map_id,'M70071');
  await runner.runObject({mapId:'M70071',objectIndex:12});assert.equal(quantity(world,349),1);
  await restore(world);assert.equal((await runner.runObject({mapId:'M70071',objectIndex:12})).already_done,true);
  assert.equal(quantity(world,349),1);
  innerWhiteForestRoute(source,world,'M70072');
  assert.deepEqual((await runner.runObject({mapId:'M70072',objectIndex:13})).traversed,[1,2,4]);
  assert.equal(bit(world,97,1),false);
  innerWhiteForestRoute(source,world,'M70071');
  await runner.runTlk({mapId:'M70071',triggerId:4,recordId:1});await innerWhiteForestSelect(source,world,0);
  innerWhiteForestRoute(source,world,'M01040','M01050','M01051');await npc(runner,'M01051',10);
  assert.equal(quantity(world,349),0);assert.equal(bit(world,31,2),true);
  assert.ok([252,253].every(index=>world.value.recipe_unlock_indices.includes(index)));await restore(world);
  innerWhiteForestRoute(source,world,'M01050');await npc(runner,'M01050',15);
  assert.equal(bit(world,5,1),true);assert.equal(quantity(world,332),1);
  await npc(runner,'M01050',15);assert.equal(quantity(world,332),1);
  assert.equal(trace.animations.filter(row=>row.id==='m01050-1').length,1);
  innerWhiteForestRoute(source,world,'M01040','M01060');
  await runner.runTlk({mapId:'M01060',triggerId:6,recordId:56});await innerWhiteForestSelect(source,world,3);
  innerWhiteForestRoute(source,world,'M70073');
  const beforeFight=world.snapshot();defeat=true;
  await assert.rejects(runner.runTlk({mapId:'M70073',triggerId:31,recordId:1}),/YC-03 battle defeat/);
  assert.deepEqual(world.snapshot(),beforeFight);assert.equal(bit(world,98,1),false);defeat=false;
  await runner.runTlk({mapId:'M70073',triggerId:31,recordId:1});
  assert.equal(bit(world,98,1),true);assert.deepEqual(trace.battles.map(row=>[row.stage,row.members.map(member=>member.id)]),
    [['stage03.scn',['042']],['stage03.scn',['042']]]);
  assert.deepEqual(trace.animations.filter(row=>row.id==='m70073-1'),[{id:'m70073-1',commands:56}]);
  const afterFight=world.snapshot();assert.deepEqual([afterFight.location.x,afterFight.location.y],[288,1200]);
  assert.ok(trace.actors.some(row=>row.program==='m70073-1'&&row.command===27&&row.kind==='behavior'&&row.actor===10));
  await restore(world);
  assert.deepEqual((await runner.runTlk({mapId:'M70073',triggerId:31,recordId:1})).traversed,[1]);
  assert.deepEqual(world.location,afterFight.location);assert.equal(trace.battles.length,2);
  const moonOnly=new WorldStore(copy(afterFight),source.mapIds),moonRunner=innerWhiteForestRunner(source,moonOnly).runner;
  innerWhiteForestRoute(source,moonOnly,'M70076');await moonRunner.runObject({mapId:'M70076',objectIndex:7});
  innerWhiteForestRoute(source,moonOnly,'M70073','M70072');
  assert.deepEqual((await moonRunner.runObject({mapId:'M70072',objectIndex:13})).traversed,[1,2,6,4]);
  assert.equal(quantity(moonOnly,294),1);assert.equal(bit(moonOnly,97,1),false);
  innerWhiteForestRoute(source,world,'M70075');await runner.runObject({mapId:'M70075',objectIndex:7});
  assert.equal(quantity(world,293),1);assert.equal(quantity(world,332),1);
  innerWhiteForestRoute(source,world,'M70073','M70072');
  await runner.runObject({mapId:'M70072',objectIndex:13});
  assert.equal(quantity(world,293),1);assert.equal(bit(world,97,1),false);
  innerWhiteForestRoute(source,world,'M70073','M70076');await runner.runObject({mapId:'M70076',objectIndex:7});
  assert.equal(quantity(world,294),1);assert.equal(quantity(world,332),1);
  assert.equal((await npc(runner,'M70076',10)).save_requested,true);await restore(world);
  innerWhiteForestRoute(source,world,'M70073','M70072');
  const beforeGate=world.snapshot(),transfer=runner.transfer;
  runner.transfer=async({draft})=>{
    assert.equal(draft.flags[97]&1,1);assert.ok(!draft.inventory.some(row=>[293,294].includes(row.id)));
    throw Error('YC-03 gate target unavailable');
  };
  await assert.rejects(runner.runObject({mapId:'M70072',objectIndex:13}),/YC-03 gate target unavailable/);
  assert.deepEqual(world.snapshot(),beforeGate);runner.transfer=transfer;
  runner.choose=async()=>1;
  const leave=await runner.runObject({mapId:'M70072',objectIndex:13});
  assert.deepEqual(leave.traversed,[1,2,6,7,8,9,3]);assert.equal(world.location.map_id,'M70072');
  assert.equal(bit(world,97,1),true);assert.equal(quantity(world,293)+quantity(world,294),0);
  assert.equal(chapterObjectState(world.value,'M70072',13,source.story),0);await restore(world);
  assert.deepEqual((await runner.runObject({mapId:'M70072',objectIndex:13})).traversed,[1,3]);
  const sort=world.value.native_map_sort_code,releases=[];
  runner.transfer=async payload=>({...await transfer(payload),release:({failed})=>{
    releases.push(failed);assert.equal(world.location.map_id,'M70074_1');
  }});
  runner.choose=async()=>0;await runner.runObject({mapId:'M70072',objectIndex:13});
  assert.equal(world.location.map_id,'M70074_1');assert.equal(quantity(world,332),1);
  assert.equal(world.value.native_map_sort_code,sort);assert.deepEqual(releases,[false]);
  assert.equal(trace.objects.some(([id,index])=>id==='M70072'&&index===13),false);
  innerWhiteForestRoute(source,world,'M70074_2');await runner.runObject({mapId:'M70074_2',objectIndex:12});
  assert.equal(quantity(world,299),1);await restore(world);
  assert.equal((await runner.runObject({mapId:'M70074_2',objectIndex:12})).already_done,true);
  assert.equal(quantity(world,299),1);assert.equal(quantity(world,332),1);
  innerWhiteForestRoute(source,world,'M70074_1','M70072','M70071');
  await runner.runTlk({mapId:'M70071',triggerId:4,recordId:1});await innerWhiteForestSelect(source,world,0);
  innerWhiteForestRoute(source,world,'M01040','M01050');const earned=world.snapshot();
  assert.deepEqual(earned.party,initial.party);assert.equal(earned.money,initial.money);assert.deepEqual(earned.source,initial.source);
  for(const [choice,id]of [[0,358],[1,348],[2,342]]){
    const branch=new WorldStore(copy(earned),source.mapIds),f=innerWhiteForestRunner(source,branch,{choose:async()=>choice});
    await npc(f.runner,'M01050',15);
    assert.equal(quantity(branch,299),0);assert.equal(quantity(branch,id),quantity(world,id)+1);
    assert.equal(bit(branch,5,3),true);assert.equal(branch.location.map_id,'M17010');
    assert.deepEqual(f.trace.animations,[{id:'m01050-2',commands:44}]);
    await f.runner.runTlk({mapId:'M17010',triggerId:31,recordId:49});
    assert.equal(branch.location.map_id,'M17014');assert.equal(bit(branch,16,1),true);
    assert.deepEqual(branch.value.party.map(role=>role.id),['001','002','005']);
    assert.deepEqual(branch.value.party.slice(0,2),initial.party);assert.deepEqual(branch.value.equipment,earned.equipment);
    assert.deepEqual(branch.value.source,initial.source);assert.equal(branch.value.money,initial.money);
    assert.equal(quantity(branch,332),1);await restore(branch);
    branch.transact(draft=>{draft.location=copy(earned.location);});const inventory=copy(branch.value.inventory);
    await npc(f.runner,'M01050',15);assert.deepEqual(branch.value.inventory,inventory);
    assert.equal(f.trace.animations.filter(row=>row.id==='m01050-2').length,1);
  }
});
