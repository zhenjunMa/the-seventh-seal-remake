// Real WING DAT/TLK records exercise the shared sequence VM and map loader.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ChapterRunner,chapterChoices} from '../web/core/chapter.mjs';
import {compileTlkFlow,nativeFlowId} from '../web/core/story_flow_compiler.mjs';
import {initializeMapSequence,projectMapStage} from '../web/core/map_stage.mjs';
import {WorldStore,validateWorld,encodeSave,decodeSave} from '../web/core/world.mjs';
import {evaluateNativeStoryCondition} from '../web/core/native_story_conditions.mjs';
import {applyNativeStoryMutation} from '../web/core/native_story_mutations.mjs';
import {inspectContentReadiness} from '../web/core/content_readiness.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {createStoryController} from '../web/controllers/story.mjs';

const copy=structuredClone;
const seed=JSON.parse(await readFile(new URL('../web/data/opening_seed.json',import.meta.url),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(mapId='WING-B01-A',pattern=0){
  const [tlk,dat]=await Promise.all(['TLK','dat'].map(extension=>readFile(new URL(`../../../Map/${mapId}.${extension}`,import.meta.url))));
  const path=`Map/${mapId}.TLK`,sha256=hash(tlk),record_base=0x1a+tlk.readUInt32LE(2)*4;
  const offsets={id:0x13,speaker:0x0f,condition_type:0x17,condition_index:0x1b,condition_bit:0x1f,
    mutation_type:0x23,mutation_index:0x27,mutation_bit:0x2b,if_true:0x2f,next:0x33};
  const records=Array.from({length:tlk.readUInt32LE(6)},(_,index)=>{
    const offset=record_base+index*0x66f,raw=tlk.subarray(offset,offset+0x66f);
    return {offset,raw_hex:raw.toString('hex'),kind:raw[0],style:raw[1],region_byte_raw:raw[7],condition_byte_raw_0b:raw[11],
      ...Object.fromEntries(Object.entries(offsets).map(([key,at])=>[key,raw.readUInt32LE(at)])),
      text_raw:new TextDecoder('gbk').decode(raw.subarray(0x37,0x137)).split('\0')[0],
      source:{path,sha256,offset,record_id:index+1}};
  });
  const table={id:mapId,source:{path,sha256},map_flag_index:dat.readUInt32LE(0x92),record_base,records,
    header_setup_tlk_raw:dat.readUInt32LE(0x8a),header_entry_tlk_raw:dat.readUInt32LE(0x13a)};
  const story={schema:'seventh-seal-chapter-story',version:1,maps:{[mapId]:table},programs:{},
    source_hashes:{[path]:sha256},flows:{[nativeFlowId(mapId)]:compileTlkFlow(table,{choices:chapterChoices})}};
  const world=copy(seed);world.opening.status='complete';world.location.map_id=mapId;
  world.flags[records[12].condition_index]|=128|(1<<pattern);
  const content=copy(runtimeContent);
  content.maps={[mapId]:{path:`data/maps/${mapId.toLowerCase()}.json`,triggers:[],objects:[],rests:[],routes:[],npcs:[],setup_record:8}};
  return {mapId,world,story,content,npcs:[],roles:{}};
}

test('three source puzzle flows compile shared 5/6/7/8 operations and keep numeric operands out of dialogue',async()=>{
  for(const mapId of ['WING-B01-A','WING-B01-B','WING-B01-C']){
    const value=await fixture(mapId),flow=value.story.flows[nativeFlowId(mapId)];
    assert.equal(flow.commands.some(command=>command.op==='unsupported'),false);
    assert.equal(flow.commands.filter(command=>command.op==='set_native_sequence').length,7);
    assert.equal(flow.commands.filter(command=>command.op==='append_native_sequence').length,7);
    assert.deepEqual(flow.commands.filter(command=>command.op==='test_native_condition').map(command=>command.condition_type),[6,5]);
    assert.equal(flow.commands.some(command=>command.op==='say'&&command.record_id<=27&&command.record_id!==11&&command.record_id!==12),false);
    assert.deepEqual(inspectContentReadiness(value.content,value.story,{trigger_regions:{},npcs_by_map:{}}).errors,[]);
  }
});

test('source setup selects all seven targets on each floor; previews stay pure and restore avoids arrival RNG or sound',async()=>{
  for(const mapId of ['WING-B01-A','WING-B01-B','WING-B01-C'])for(let pattern=0;pattern<7;pattern++){
    const value=await fixture(mapId,pattern),before=copy(value.world);
    await projectMapStage(value);assert.deepEqual(value.world,before);
    await initializeMapSequence(value);
    assert.deepEqual(value.world.native_sequence,{target:value.story.maps[mapId].records[20+pattern].text_raw,input:'',input_count:0});
    const {native_sequence,...rest}=value.world;assert.deepEqual(rest,before);
    native_sequence.input='15';native_sequence.input_count=2;
    await initializeMapSequence({...value,restore:true});assert.equal(native_sequence.input_count,2,'world JSON retains its explicit input');
    delete value.world.native_sequence;
    await initializeMapSequence({...value,restore:true});assert.equal(value.world.native_sequence.input_count,0,'native files rebuild transient globals');
    assert.equal(value.world.encounters?.rng_state,before.encounters?.rng_state);
  }
  const value=await fixture('WING-B01-B',2);delete value.story.flows;
  const world=new WorldStore(value.world),runner=new ChapterRunner({world,data:value.story,content:value.content,say:async()=>assert.fail('loader must not play dialogue')});
  const state={world,chapterStory:runner.data,storyRepository:{content:value.content}};
  const controller=createStoryController({state,actions:{},$:()=>({}),canvas:{}}),scene={data:{id:value.mapId}},draft=world.snapshot();
  assert.notEqual(runner.data,value.story);assert.ok(runner.data.flows,'v1 source data only receives flows through ChapterRunner');
  await controller.enterMap(scene,draft,'restore');assert.equal(draft.native_sequence.target,'5676564');
  draft.native_sequence.input='567';draft.native_sequence.input_count=3;
  await controller.enterMap(scene,draft,'restore');assert.equal(draft.native_sequence.input_count,3,'controller restores a world JSON input');
  delete draft.native_sequence;await controller.enterMap(scene,draft,'restore');assert.equal(draft.native_sequence.input_count,0,'controller rebuilds a native-file target');
  draft.native_sequence.input='567';draft.native_sequence.input_count=3;
  await controller.enterMap(scene,draft,'exit');assert.equal(draft.native_sequence.input_count,0,'ordinary entry starts the source setup again');
});

test('source pads reject a wrong full sequence, retry it, then open the gate atomically with native sounds',async()=>{
  for(const mapId of ['WING-B01-A','WING-B01-B','WING-B01-C']){
    const value=await fixture(mapId);await initializeMapSequence(value);
    const world=new WorldStore(value.world),sounds=[],lines=[];
    const runner=new ChapterRunner({world,data:value.story,content:value.content,sound:({token})=>sounds.push(token),say:async({record})=>lines.push(record.id)});
    for(let index=0;index<7;index++)await runner.runTlk({mapId,recordId:7});
    assert.equal(world.value.native_sequence.input_count,0);
    assert.equal(world.value.native_sequence.input,'7777777');assert.deepEqual(lines,[12]);
    assert.equal(world.value.flags[value.story.maps[mapId].map_flag_index]&1,0);
    for(const digit of world.value.native_sequence.target)await runner.runTlk({mapId,recordId:Number(digit)});
    assert.equal(world.value.native_sequence.input_count,7);
    assert.equal(world.value.flags[value.story.maps[mapId].map_flag_index]&1,1);
    assert.deepEqual(lines,[12,11]);assert.equal(sounds.at(-1),'w01A.wav');
    assert.deepEqual(sounds.slice(7,-1),['w1DO.wav','w5SO.wav','w4FA.wav','w3MI.wav','w4FA.wav','w6LA.wav','w5SO.wav']);
  }
});

test('failed sound or success presentation rolls back sequence input and gate changes',async()=>{
  const value=await fixture();await initializeMapSequence(value);
  const world=new WorldStore(value.world);
  const failedSound=new ChapterRunner({world,data:value.story,content:value.content,sound(){throw Error('sound unavailable');},say:async()=>{}});
  const before=world.snapshot();await assert.rejects(failedSound.runTlk({mapId:value.mapId,recordId:1}),/sound unavailable/);assert.deepEqual(world.snapshot(),before);
  const runner=new ChapterRunner({world,data:value.story,content:value.content,sound(){},say:async()=>{throw Error('dialogue unavailable');}});
  const target=world.value.native_sequence.target;
  for(const digit of target.slice(0,-1))await runner.runTlk({mapId:value.mapId,recordId:Number(digit)});
  const partial=world.snapshot();await assert.rejects(runner.runTlk({mapId:value.mapId,recordId:Number(target.at(-1))}),/dialogue unavailable/);
  assert.deepEqual(world.snapshot(),partial);
});

test('sequence helpers retain native stale input bytes and world JSON round-trips their explicit count',async()=>{
  const value=await fixture(),records=value.story.maps[value.mapId].records;
  assert.equal(evaluateNativeStoryCondition(records[8],value.world,{}),false);
  assert.equal(applyNativeStoryMutation(value.world,records[0]).changed,false,'input without a target is ignored');
  applyNativeStoryMutation(value.world,records[20]);
  for(const digit of records[20].text_raw)applyNativeStoryMutation(value.world,records[Number(digit)-1]);
  assert.equal(evaluateNativeStoryCondition(records[9],value.world,{}),true);
  applyNativeStoryMutation(value.world,records[21]);
  assert.equal(value.world.native_sequence.input_count,0,'new targets reset only the input count');
  assert.equal(value.world.native_sequence.input,records[20].text_raw);
  assert.equal(evaluateNativeStoryCondition(records[9],value.world,{}),false);
  assert.deepEqual(await decodeSave(await encodeSave(value.world)),value.world);
  for(const native_sequence of [{target:'1',input:'1',input_count:2},{target:'1',input:'1',input_count:0,extra:true}]){
    assert.throws(()=>validateWorld({...value.world,native_sequence}),/原剧情序列/);
  }
});
