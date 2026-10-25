import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ChapterAnimationRunner,validateChapterAnimation} from '../web/core/chapter_animation.mjs';
import {createStoryController} from '../web/controllers/story.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {StoryPlayback} from '../web/core/story_playback.mjs';
import {StoryRepository} from '../web/core/story_repository.mjs';
import {STORY_RESOURCE_TABLES,storyDigest} from '../web/core/story_packages.mjs';

const copy=structuredClone;
const binding=id=>({path:`data/maps/${id.toLowerCase()}.json`,triggers:[],objects:[],rests:[],routes:[]});
function decodeCommands(bytes,source){
  return Array.from({length:bytes.readUInt32LE(2)},(_,index)=>{
    const at=67+index*74,raw=bytes.subarray(at,at+74),command={index,opcode:raw[0],raw_hex:raw.toString('hex'),map_index_raw:raw.readUInt32LE(34),source:{...source,offset:at,record_index:index}};
    for(const offset of [1,5,9,13,17,21,25])command[`u32_plus${offset}`]=raw.readUInt32LE(offset);
    for(let offset=29;offset<34;offset++)command[`byte_plus${offset}`]=raw[offset];
    if(command.opcode===10)command.filename=raw.subarray(54,74).toString().split('\0')[0];
    return command;
  });
}
function programFromBytes(bytes,id,maps,expected){
  const source={path:`Animate/${id}.anm`,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
  return {schema:'seventh-seal-chapter-anm',version:1,id,source,commands:decodeCommands(bytes,source),maps,expected};
}
function contentFor(program){
  const content=copy(runtimeContent);content.programs[program.id]=copy(program.source);
  for(const id of program.maps)content.maps[id]??=binding(id);
  return content;
}
function syntheticCrossMap(){
  // An isolated fixture of already implemented opcode10/35 encodings. This
  // never admits or bypasses the unknown instructions in real late ANMs.
  const records=[];
  for(const [id,x,y]of [['M17010',10,20],['M17014',30,40]]){
    const load=Buffer.alloc(74);load[0]=10;load.write(`${id}.DAT`,54,'ascii');records.push(load);
    const place=Buffer.alloc(74);place[0]=35;place.writeUInt32LE(x,13);place.writeUInt32LE(y,17);place.writeUInt32LE(1,25);records.push(place);
  }
  const header=Buffer.alloc(67);header.writeUInt16LE(3);header.writeUInt32LE(records.length,2);
  return programFromBytes(Buffer.concat([header,...records]),'test-cross-map',['M17010','M17014'],{
    control_map:'M17014',control_maps:['M17010','M17014'],caller_maps:['M17010'],final_control_actor:0});
}
const hooks=()=>Object.fromEntries(['map','actor','move','camera','wait'].map(key=>[key,async()=>{}]));

test('real no-map m17010-6 inherits its actual M17010 caller before actor operations',async()=>{
  const bytes=await readFile(new URL('../../../Animate/m17010-6.anm',import.meta.url));
  const program=programFromBytes(bytes,'m17010-6',['M17010'],{control_map:'M17010',control_maps:[],caller_maps:['M17010'],final_control_actor:0});
  assert.equal(program.commands.some(command=>command.opcode===10),false);
  const trace=[],h=hooks();h.map=async payload=>trace.push(['map',payload.mapId,payload.bootstrap]);
  h.actor=async payload=>trace.push(['actor',payload.actor]);
  const runner=new ChapterAnimationRunner({program,content:contentFor(program),hooks:h,
    runTlk:async payload=>trace.push(['tlk',payload.mapId,payload.recordId]),joinActor:async payload=>trace.push(['join',payload.actorSlot]),
    initialLocation:{map_id:'M17010',x:160,y:160,direction:1}});
  const result=await runner.run();
  assert.deepEqual(trace[0],['map','M17010',true]);
  assert.deepEqual(trace.filter(row=>row[0]==='tlk'),[['tlk','M17010',71],['tlk','M17010',72],['tlk','M17010',83]]);
  assert.deepEqual(trace.filter(row=>row[0]==='join'),[['join',1]]);
  assert.equal(result.location.map_id,'M17010');assert.equal(runner.phase,'complete');
  const invalid=copy(program);invalid.commands[0].opcode=254;
  assert.throws(()=>validateChapterAnimation(invalid,contentFor(invalid)),/未支持/);
  const unsupported=copy(program),raw=Buffer.from(unsupported.commands[7].raw_hex,'hex');raw[29]=3;
  unsupported.commands[7].byte_plus29=3;unsupported.commands[7].raw_hex=raw.toString('hex');
  assert.throws(()=>validateChapterAnimation(unsupported,contentFor(unsupported)),/剧情移动模式/);
});

test('m17010-6 action2 moves bind actual ROLE014/015 source action records',async()=>{
  const resources=JSON.parse(await readFile(new URL('../web/data/chapter_map_resources.json',import.meta.url),'utf8'));
  const raw=await readFile(new URL('../../../Animate/m17010-6.anm',import.meta.url));
  const commands=decodeCommands(raw,{});
  for(const [commandIndex,slot,resource]of [[7,29,'015'],[8,28,'014']]){
    const command=commands[commandIndex],npc=resources.npcs_by_map.M17010.find(npc=>npc.slot_zero_based===slot);
    assert.equal(command.opcode,33);assert.equal(command.u32_plus5,slot);assert.equal(command.byte_plus29,2);
    assert.equal(npc.resource_id,resource);
    const role=resources.roles[resource],action=role.actions.find(action=>action.index===2);
    assert.equal(action.frame_count,12);assert.equal(action.directions,8);
    const bytes=await readFile(new URL(`../../../ROLE/${resource}.dgp`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),role.source.sha256);
    assert.equal(action.source_offset,0x43+2*0xac);
    assert.equal(bytes.subarray(action.source_offset,action.source_offset+0xac).toString('hex'),action.raw_hex);
  }
});

function controllerFixture(program,prepareTarget){
  const role={frame_width:16,frame_height:24,anchor:{x:0,y:0},actions:[{index:0,first_frame:0,frame_count:1,directions:8}]};
  const makeScene=id=>({data:{id,opening_npcs:[]},bitmap:{width:1024,height:768},npcs:[],npcRuntime:{inherit(){},adoptActors(){}}});
  const original=makeScene('M17010'),prepared=[],adopted=[];
  const state={view:{x:10,y:20,follow:true},openingResources:{roles:{'001':role}},scenes:{current:original,
    captureView(){return copy(state.view);},rollbackView(value){state.view=copy(value);}},
    storyRepository:{content:contentFor(program),async ensureProgram(){return {program,release(){adopted.push('release');}};}}};
  const draft={leader_id:'001',location:{map_id:'M17010',x:160,y:160,direction:1},flags:[4]},before=copy(draft),view=copy(state.view);
  const actions={async prepareMap(id){prepared.push(id);if(id==='M17014'&&prepareTarget)return prepareTarget(makeScene(id));return makeScene(id);},
    commitView(){},validateEntry(scene,location){assert.equal(scene.data.id,location.map_id);},log(){}};
  const shade={hidden:true,style:{opacity:'0'}};
  const controller=createStoryController({state,actions,$:id=>id==='openingShade'?shade:{},canvas:{}});
  return {state,draft,before,view,original,prepared,adopted,actions,run:options=>controller.animateChapter({program,mapId:'M17010',draft,runTlk:async()=>{},joinActor:async()=>{},...options})};
}
test('cross-map presentation prepares its target on demand and commits the final map pose',async()=>{
  const fixture=controllerFixture(syntheticCrossMap());await fixture.run();
  assert.deepEqual(fixture.prepared,['M17010','M17014']);
  assert.deepEqual(fixture.draft.location,{map_id:'M17014',x:60,y:80,direction:0});
  assert.equal(fixture.state.scenes.current.data.id,'M17014');assert.equal(fixture.state.openingView.active,false);
  assert.deepEqual(fixture.adopted,['release']);
});
test('failed target preparation restores the prior scene and view without draft writes',async()=>{
  const fixture=controllerFixture(syntheticCrossMap(),async()=>{throw new Error('target unavailable');});
  await assert.rejects(fixture.run(),/target unavailable/);
  assert.equal(fixture.state.scenes.current,fixture.original);assert.deepEqual(fixture.state.view,fixture.view);
  assert.deepEqual(fixture.draft,fixture.before);assert.deepEqual(fixture.adopted,['release']);
});
test('cancelled cross-map preparation cannot install a late scene or commit the draft',async()=>{
  let targetStarted,finishTarget;
  const started=new Promise(resolve=>{targetStarted=resolve;}),target=new Promise(resolve=>{finishTarget=resolve;});
  const fixture=controllerFixture(syntheticCrossMap(),scene=>{targetStarted();return target.then(()=>scene);}),playback=new StoryPlayback();
  const running=fixture.run({playback});await started;playback.cancel();
  await assert.rejects(running,{name:'AbortError'});finishTarget();await Promise.resolve();await Promise.resolve();
  assert.equal(fixture.state.scenes.current,fixture.original);assert.deepEqual(fixture.state.view,fixture.view);
  assert.deepEqual(fixture.draft,fixture.before);assert.deepEqual(fixture.adopted,['release']);
});

test('program map leases load one explicit dependency set and preserve shared programs during eviction',async()=>{
  const program=syntheticCrossMap(),content=contentFor(program),definition={maps:['M17010','M17014','M17098','M17099']};
  content.maps=Object.fromEntries(definition.maps.map(id=>[id,binding(id)]));content.programs={[program.id]:program.source};
  const files=new Map(),reads=[];
  async function reference(path,value){files.set(path,value);return {path,sha256:await storyDigest(value)};}
  const shared=await reference('data/story/shared.json',{schema:'seventh-seal-story-shared',version:1,roles:{},quests:[],
    chapter:{source_hashes:{[program.source.path]:program.source.sha256},item_definitions:{},role_definitions:{}}});
  const maps={};
  for(const id of definition.maps)maps[id]=await reference(`data/story/maps/${id.toLowerCase()}.json`,{
    schema:'seventh-seal-story-map',version:2,map_id:id,chapter:null,texts:{},events:[],flows:{},
    programs:program.maps.includes(id)?{[program.id]:program}:{},resources:Object.fromEntries(STORY_RESOURCE_TABLES.map(key=>[key,[]]))});
  const repository=await StoryRepository.create({read:async path=>{reads.push(path);return copy(files.get(path));},content,definition,capacity:2,
    index:{schema:'seventh-seal-story-index',version:2,definition_sha256:await storyDigest(definition),shared,maps}});
  await repository.ensureMap('M17010');assert.deepEqual([...repository.loaded.keys()],['M17010']);
  const lease=await repository.ensureProgram(program.id,{callerMap:'M17010'});
  assert.deepEqual(new Set(repository.loaded.keys()),new Set(program.maps));
  await repository.ensureMap('M17099');assert.equal(repository.loaded.size,3);lease.release();
  assert.equal(repository.loaded.has('M17010'),false);assert.equal(repository.story.programs[program.id].id,program.id);
  await repository.ensureMap('M17098');assert.equal(repository.story.programs[program.id],undefined);
  assert.equal(repository.pins.size,0);assert.equal(reads.filter(path=>path.endsWith('m17014.json')).length,1);
});

test('an ordinary cross-map ANM still rejects a blocked final exploration pose before committing its draft',async()=>{
  const fixture=controllerFixture(syntheticCrossMap());
  fixture.actions.validateEntry=()=>{throw Error('blocked final exploration pose');};
  await assert.rejects(fixture.run(),/blocked final exploration pose/);
  assert.equal(fixture.state.scenes.current,fixture.original);assert.deepEqual(fixture.state.view,fixture.view);
  assert.deepEqual(fixture.draft,fixture.before);assert.deepEqual(fixture.adopted,['release']);
});
