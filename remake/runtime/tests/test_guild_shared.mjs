import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nativeRandomBranches} from '../web/core/story/native_story_random.mjs';
import {compileTlkFlow} from '../web/core/story/story_flow_compiler.mjs';
import {StoryFlowRunner} from '../web/core/story/story_flow.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world/world.mjs';
import {chapterObjectState} from '../web/core/story/chapter_runner.mjs';
import {innerWhiteForestSource,innerWhiteForestRunner} from './helpers/inner_white_forest_world.mjs';
import {MapObjectRuntime} from '../web/core/exploration/map_objects.mjs';

test('real sewer, forest and Luther WORD weights keep every threshold in source and compact flows',async()=>{
  for(const [file,id,expected]of [['m01053',6,[[31,90],[7,10]]],['Elf-forest-E',3,[[22,20],[4,80]]],
    ['m03066',12,[[3,10],[4,10],[5,10],[6,10],[7,10],[8,10],[9,10],[10,10],[11,10],[13,10]]]]){
    const bytes=await readFile(new URL(`../../../Map/${file}.TLK`,import.meta.url)),base=0x1a+bytes.readUInt32LE(2)*4;
    const raw=bytes.subarray(base+(id-1)*0x66f,base+id*0x66f);
    const record={id,kind:raw[0],raw_hex:raw.toString('hex'),mutation_type:0,mutation_index:0,mutation_bit:0,
      condition_type:0,condition_index:0,condition_bit:0,if_true:0,next:0};
    const branches=nativeRandomBranches(record);
    assert.deepEqual(branches.map(row=>[row.recordId,row.weight]),expected);
    // Kind3 is resolved by462600 before the ordinary header dispatch.
    const table={id:'M01053',map_flag_index:396,records:[{...record,mutation_type:99,condition_type:99},
      ...branches.map(row=>({id:row.recordId,kind:0,style:0,text_raw:'',mutation_type:0,mutation_bit:0,condition_type:0,condition_bit:0,next:0}))]};
    const source=compileTlkFlow(table,{choices:()=>[]}),compact=structuredClone(table);
    delete compact.records[0].raw_hex;compact.records[0].native_random_branches=branches;
    assert.deepEqual(compileTlkFlow(compact,{choices:()=>[]}),source);
    for(const roll of Array.from({length:100},(_,i)=>i)){
      const result=await new StoryFlowRunner({record(){},random_jump:()=>roll}).execute(source,{draft:{}});
      const expectedTarget=expected.find((_,index)=>roll<expected.slice(0,index+1).reduce((sum,row)=>sum+row[1],0))[0];
      assert.deepEqual(result.traversed,[id,expectedTarget]);
    }
  }
});

test('a real CF2 experiment event commits its animation once and rolls a failed six-enemy battle back',async()=>{
  const source=await innerWhiteForestSource(),value=structuredClone(source.seed),mapId='M71078-3-24',objectIndex=95;
  value.opening.status='complete';
  const object=source.story.maps[mapId].objects.find(row=>row.index===objectIndex);
  assert.equal(object.behavior_raw_cf,2);
  value.location={map_id:mapId,x:object.x_native*2,y:object.y_native*2,direction:0};
  const world=new WorldStore(value,source.mapIds),before=world.snapshot();let fail=true;
  const {runner,trace}=innerWhiteForestRunner(source,world,{battle:async()=>{
    if(fail)throw Error('experiment defeat');return {outcome:'victory'};
  }});
  await assert.rejects(runner.runObject({mapId,objectIndex}),/experiment defeat/);assert.deepEqual(world.snapshot(),before);
  fail=false;await runner.runObject({mapId,objectIndex});
  assert.equal(chapterObjectState(world.value,mapId,objectIndex,source.story),3);
  assert.equal(trace.battles.at(-1).members.length,6);
  const saved=world.snapshot();world.replace(await decodeSave(await encodeSave(saved),source.mapIds));
  assert.deepEqual(world.snapshot(),saved);
  assert.equal((await runner.runObject({mapId,objectIndex})).already_done,true);assert.deepEqual(world.snapshot(),saved);
});

test('research maps load their real CF2 sounds and play once at the original forward and reverse cursor',async()=>{
  const effects=JSON.parse(await readFile(new URL('../web/data/map_effects.json',import.meta.url),'utf8'));
  let sample,world,sounds=[];
  for(const [mapId,entry]of Object.entries(effects.maps).filter(([id])=>/^M7107[6-9]|^M71080$/.test(id))){
    if(!entry.objects.length)continue;
    const map=JSON.parse(await readFile(new URL(`../web/data/maps/${mapId.toLowerCase()}.json`,import.meta.url),'utf8'));
    const resources=entry.objects.map(row=>({...row,resource:effects.object_banks[row.bank]}));
    const model=new MapObjectRuntime({objects:structuredClone(map.objects),resources,mapId,mapFlagIndex:entry.map_flag_index,
      random:()=>0,onSound:event=>sounds.push(event)});
    const state={event_records:[]};model.update(0,{world:state});
    if(mapId==='M71078-3-24'){sample=model;world=state;}
  }
  const actor=sample.actors.find(actor=>actor.object.index===95);
  assert.deepEqual(actor.sounds[0],{token:'NEWCantOp.wav',enabled:true,frame:1,x:136,y:264});
  let now=0;
  const forward=sample.animate({objectIndex:95,state:2});
  while(actor.pending)sample.update(now+=150,{world});
  await forward;
  assert.equal(sounds.filter(event=>event.objectIndex===95&&event.mapId==='M71078-3-24').length,1);
  const reverse=sample.animate({objectIndex:95,state:5});
  while(actor.pending)sample.update(now+=150,{world});
  await reverse;
  assert.equal(sounds.filter(event=>event.objectIndex===95&&event.mapId==='M71078-3-24').length,2);
  for(let i=0;i<20;i++)sample.update(now+=150,{world});
  assert.equal(sounds.filter(event=>event.objectIndex===95&&event.mapId==='M71078-3-24').length,2);
});
