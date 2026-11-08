// Complete YC-03 source event chain through production TLK/ANM runners.
// Battle outcomes are bounded callbacks here; actual042 combat has its own
// replay tests. This is a rules replay, not browser or GAME.exe observation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeSave,decodeSave} from '../web/core/world/world.mjs';
import {nativeChestAnimation,nativeKeyedChest} from '../web/core/exploration/native_map_chests.mjs';
import {initializeChapterItem,chapterObjectState} from '../web/core/story/chapter_runner.mjs';
import {insertCrystal,removeCrystal,socketEquipmentRows} from '../web/core/party/crystal_sockets.mjs';
import {compileItemConfiguration} from '../web/core/items/item_registry.mjs';
import {mapPresentation} from '../web/core/ui/map_presentation.mjs';
import {createMapController} from '../web/controllers/map.mjs';
import {createStoryController} from '../web/controllers/story.mjs';
import {ActionClock} from '../web/phaser/components/action_clock.mjs';
import {innerWhiteForestSource,innerWhiteForestWorld,innerWhiteForestRunner,
  innerWhiteForestMapIds,innerWhiteForestOriginal,innerWhiteForestComplete} from './helpers/inner_white_forest_world.mjs';

const source=await innerWhiteForestSource();
const quantity=(world,id)=>world.value.inventory.filter(row=>row.id===id).reduce((n,row)=>n+row.quantity,0);
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
  assert.ok(source.content.maps.M70076.triggers.includes(1),'the complete sealed-forest branch is now admitted');
});

test('source014 chest retains its seventeenth logical wait and hides its missing physical frame during collection and restore',async()=>{
  for(const index of [12,13]){
    const resource=source.resources.object_animations.M70071.find(row=>row.object_index_zero_based===index);
    const original=await innerWhiteForestOriginal(resource.source.path),{action,frameIndices,intervalMs}=nativeChestAnimation(resource,4);
    assert.equal(intervalMs,0,'native D9 retains action0 zero interval');
    assert.equal(createHash('sha256').update(original).digest('hex'),resource.source.sha256);
    assert.equal(original[0],9);assert.equal(original[2],2);assert.equal(original.readUInt32LE(0x43+2*0xac+4),17);
    assert.equal(original.subarray(0x43+0xac,0x43+2*0xac).toString('hex'),action.raw_hex);
    assert.equal(resource.frames.length,17);assert.deepEqual(resource.frames.map(row=>row.index),Array.from({length:17},(_,i)=>i));
    assert.deepEqual(frameIndices,Array.from({length:17},(_,i)=>i+1));assert.equal(resource.completed_last_frame,17);
  }
  const world=innerWhiteForestWorld(source);world.transact(draft=>{const object=source.story.maps.M70071.objects.find(row=>row.index===12);
    draft.location={map_id:'M70071',x:object.x_native*2,y:object.y_native*2,direction:0};});
  const object={...source.maps.M70071.objects.find(row=>row.index===12),bitmap:{id:'closed014'}},scene={data:{id:'M70071'},objects:[object],npcs:[]};
  const resource=source.resources.object_animations.M70071.find(row=>row.object_index_zero_based===12);
  const hint={},requested=[],frames=[],state={world,chapterStory:source.story,chapterResources:source.resources,scenes:{phase:'map',current:scene},
    resources:{peek(){throw Error('The nonexistent completed physical frame must not be requested');}}};
  const map=createMapController({state,actions:{},$:()=>hint,canvas:{},ctx:{}});
  map.updateNearest();assert.equal(state.nearest.index,12);assert.equal(hint.hidden,false);
  const queue=()=>mapPresentation({scene,world:world.value,role:{frame_width:16,frame_height:16,map_draw_offset:{x:0,y:0}},
    action:{bitmap:{id:'leader'}},view:{frame:0},objectBitmap:map.objectBitmap});
  const clock=new ActionClock();clock.update(0);state.engine={exploration:{clock}};
  const story=createStoryController({state,actions:{image:async path=>{requested.push(path);return {path};}},$:()=>({}),canvas:{}});
  const {runner}=innerWhiteForestRunner(source,world,{objectAnimation:story.animateChapterObject});
  assert.equal(map.objectBitmap(scene,object),object.bitmap);
  const task=story.playStory(playback=>runner.runObject({mapId:'M70071',objectIndex:12,playback}));
  for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(state.objectPreview,undefined,'selecting action1 retains the idle image');
  for(let i=0;i<17;i++){
    clock.advance(1);for(let j=0;j<20;j++)await Promise.resolve();
    frames.push(state.objectPreview?.bitmap??null);
    if(i===15)assert.deepEqual(queue().map(row=>row.key),['leader']);
  }
  await task;
  assert.equal(requested.length,16);assert.equal(frames[0].path,resource.frames[2].image);
  assert.equal(frames[14].path,resource.frames[16].image);assert.equal(frames[15],null);assert.equal(state.objectPreview,null);
  assert.equal(map.objectBitmap(scene,object),null);assert.deepEqual(queue().map(row=>row.key),['leader']);
  map.updateNearest();assert.equal(state.nearest,null);assert.equal(hint.hidden,true);
  await restore(world);assert.equal(map.objectBitmap(scene,object,world.value,false),null);assert.equal(quantity(world,349),1);
  map.updateNearest();assert.equal(state.nearest,null);assert.equal(hint.hidden,true);
});

test('two forest trips naturally earn349,332,293/294 and299 before all three first-return rewards and005 admission',async()=>{
  await innerWhiteForestComplete(source);
});


test('M70071 wind chest accepts held333, grants usable145 once, and keeps key and saved state',async()=>{
  const mapId='M70071',objectIndex=14,object=source.story.maps[mapId].objects.find(row=>row.index===objectIndex);
  assert.equal(source.content.maps[mapId].objects.find(row=>row.index===objectIndex)?.handler,'keyed-chest');
  assert.deepEqual(nativeKeyedChest(object),{keyId:333,rewards:[{slot:0,id:145}]});
  const resource=source.resources.object_animations[mapId].find(row=>row.object_index_zero_based===objectIndex);
  const original=await innerWhiteForestOriginal(resource.source.path),animation=nativeChestAnimation(resource,4);
  assert.equal(createHash('sha256').update(original).digest('hex'),resource.source.sha256);
  assert.equal(animation.action.interval_raw,130);assert.equal(animation.intervalMs,110);assert.deepEqual(animation.frameIndices,Array.from({length:16},(_,i)=>i+10));
  const world=innerWhiteForestWorld(source);world.transact(draft=>{draft.location={map_id:mapId,x:336,y:920,direction:0};});
  let interrupted=false,animations=0;
  const {runner}=innerWhiteForestRunner(source,world,{objectAnimation:async()=>{
    animations++;if(interrupted)throw Error('wind chest animation interrupted');
  }});
  const closed=world.snapshot();assert.equal((await runner.runObject({mapId,objectIndex})).locked,true);
  assert.deepEqual(world.snapshot(),closed);assert.equal(animations,0);
  // The caller hands in only the key, matching the player's reported inventory.
  const key=initializeChapterItem(source.items.definitions['333']);new DataView(key.buffer).setUint32(4,1,true);
  world.transact(draft=>draft.inventory.push({id:333,name:source.items.definitions['333'].name,quantity:1,
    instance_id:'wind-chest-key',source_raw_hex:Buffer.from(key).toString('hex')}));
  interrupted=true;const before=world.snapshot();
  await assert.rejects(runner.runObject({mapId,objectIndex}),/wind chest animation interrupted/);
  assert.deepEqual(world.snapshot(),before);interrupted=false;
  await runner.runObject({mapId,objectIndex});assert.equal(quantity(world,145),1);assert.equal(quantity(world,333),1);
  assert.equal(chapterObjectState(world.value,mapId,objectIndex,source.story),3);await restore(world);
  const opened=world.snapshot();assert.equal((await runner.runObject({mapId,objectIndex})).already_done,true);
  assert.deepEqual(world.snapshot(),opened);
  const itemData=compileItemConfiguration(source.items,source.itemConfiguration,'original').data;
  const crystal=world.value.inventory.find(row=>row.id===145),options={worldStore:world,attributes:source.attributes,
    itemData,roleId:'001',socketIndex:1};
  assert.equal(itemData.definitions['145'].runtime_enabled,true);
  insertCrystal({...options,instanceId:crystal.instance_id});
  const linked=socketEquipmentRows(world.value,source.attributes,itemData,'001').find(row=>row.item_id===145);
  assert.equal(Buffer.from(linked.source_raw_hex,'hex').readInt32LE(0x6d),10);
  await restore(world);removeCrystal(options);assert.equal(quantity(world,145),1);assert.equal(quantity(world,333),1);
});
