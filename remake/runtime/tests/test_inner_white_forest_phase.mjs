// Complete YC-03 source event chain through production TLK/ANM runners.
// Battle outcomes are bounded callbacks here; actual042 combat has its own
// replay tests. This is a rules replay, not browser or GAME.exe observation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeSave,decodeSave} from '../web/core/world.mjs';
import {nativeChestAnimation} from '../web/core/native_map_chests.mjs';
import {mapPresentation} from '../web/core/map_presentation.mjs';
import {createMapController} from '../web/controllers/map.mjs';
import {createStoryController} from '../web/controllers/story.mjs';
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
  await innerWhiteForestComplete(source);
});
