// Actual source bytes through the shared TLK/ANM runners. These tests do not
// claim an observation of GAME.exe or natural cross-region quest progression.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ChapterRunner} from '../web/core/chapter.mjs';
import {ChapterAnimationRunner,validateChapterAnimation} from '../web/core/chapter_animation.mjs';
import {nativeCombinationConditions,nativeCombinationHex,evaluateNativeStoryCombination} from '../web/core/native_story_combinations.mjs';
import {evaluateNativeStoryCondition} from '../web/core/native_story_conditions.mjs';
import {applyNativeStoryMutation} from '../web/core/native_story_mutations.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {StoryPlayback} from '../web/core/story_playback.mjs';
import {ActorEffectView} from '../web/actor_effect_view.mjs';
import {inspectContentReadiness} from '../web/core/content_readiness.mjs';
import {projectMapStage} from '../web/core/map_stage.mjs';
import {createStoryController} from '../web/controllers/story.mjs';
import {createServicesController} from '../web/controllers/services.mjs';
const read=name=>readFile(new URL(`../../../${name}`,import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const seed=JSON.parse(await readFile(new URL('../web/data/opening_seed.json',import.meta.url),'utf8'));
const fields={speaker:15,condition_type:23,condition_index:27,condition_bit:31,mutation_type:35,mutation_index:39,mutation_bit:43,if_true:47,next:51};
async function sourceTable(id){
  const [bytes,dat]=await Promise.all([read(`Map/${id}.TLK`),read(`Map/${id}.DAT`)]),source={path:`Map/${id}.TLK`,sha256:hash(bytes)};
  const base=26+bytes.readUInt32LE(2)*4;
  const records=Array.from({length:bytes.readUInt32LE(6)},(_,index)=>{
    const offset=base+index*1647,raw=bytes.subarray(offset,offset+1647),text=raw.subarray(55,311),end=text.indexOf(0);
    const record={id:index+1,offset,kind:raw[0],style:raw[1],region_byte_raw:raw[7],raw_hex:raw.toString('hex'),
      text_raw:new TextDecoder('gbk').decode(end<0?text:text.subarray(0,end)),source:{...source,offset,record_id:index+1}};
    for(const [name,at]of Object.entries(fields))record[name]=raw.readUInt32LE(at);
    assert.equal(raw.readUInt32LE(19),record.id);return record;
  });
  const index_nonzero=Array.from({length:bytes.readUInt32LE(2)},(_,slot)=>({slot,record:bytes.readUInt32LE(26+slot*4)})).filter(row=>row.record);
  return {id,source,record_base:base,map_flag_index:dat.readUInt32LE(0x92),records,index_nonzero};
}
async function sourceProgram(id,caller){
  const bytes=await read(`Animate/${id}.anm`),source={path:`Animate/${id}.anm`,sha256:hash(bytes),bytes:bytes.length};
  const commands=Array.from({length:bytes.readUInt32LE(2)},(_,index)=>{
    const offset=67+index*74,raw=bytes.subarray(offset,offset+74),row={index,opcode:raw[0],raw_hex:raw.toString('hex'),source:{...source,offset}};
    for(const at of [1,5,9,13,17,21,25])row[`u32_plus${at}`]=raw.readUInt32LE(at);
    for(let at=29;at<34;at++)row[`byte_plus${at}`]=raw[at];
    if(row.opcode===10)row.filename=raw.subarray(54).toString().split('\0')[0];return row;
  });
  const maps=[...new Set(commands.filter(row=>row.opcode===10).map(row=>row.filename.slice(0,-4).toUpperCase()))];
  return {schema:'seventh-seal-chapter-anm',version:1,id,source,commands,maps:[...new Set([caller,...maps])],expected:{caller_maps:[caller],control_maps:maps,control_map:maps.at(-1)??caller}};
}
async function fixture(id,extra={}){
  const table=await sourceTable(id),programs={};
  for(const record of table.records.filter(row=>row.kind===1)){
    const name=record.text_raw.replace(/\.anm$/i,'').toLowerCase();programs[name]={id:name};
  }
  const data={schema:'seventh-seal-chapter-story',version:1,maps:{[id]:table},programs,source_hashes:{[table.source.path]:table.source.sha256}};
  const content=structuredClone(runtimeContent);content.maps[id]={triggers:[],objects:[],rests:[],routes:[],npcs:[]};
  const value=structuredClone(seed);value.location={map_id:id,x:640,y:480,direction:0};value.opening.status='complete';value.flags[table.map_flag_index]=0;
  const world=new WorldStore(value,[id]),runner=new ChapterRunner({world,data,content,say:async()=>{},choose:async()=>0,animate:async()=>{},...extra});
  return {table,content,world,runner};
}

test('real hide-and-seek kind4 checks all three native bits and compiles to the shared flow',async()=>{
  const {table,content,world,runner}=await fixture('M01040'),record=table.records[3];
  assert.equal(table.map_flag_index,4);
  assert.deepEqual(nativeCombinationConditions(record,table).map(row=>[row.condition_type,row.condition_index,row.condition_bit]),[[0,0,1],[0,0,2],[0,0,3],[0,0,0],[0,0,0],[0,0,0]]);
  for(let mask=0;mask<8;mask++){
    world.transact(draft=>{draft.flags[4]=mask;});
    assert.equal(evaluateNativeStoryCombination(record,world.value,table),mask===7);
    const result=await runner.runTlk({mapId:table.id,recordId:4});
    assert.equal(result.traversed[1],mask===7?32:28);
    assert.equal(Boolean(world.value.flags[4]&8),mask===7);
  }
  const compact={kind:4,native_combination_hex:nativeCombinationHex(record)};
  assert.equal(evaluateNativeStoryCombination(compact,world.value,table),true);
  const corrupt={...compact,native_combination_hex:'ff'+compact.native_combination_hex.slice(2)};
  assert.throws(()=>nativeCombinationConditions(corrupt,table),/尚未接入/);
  // An unknown capability in the true branch must fail readiness even though
  // the header condition fields of kind4 are all zero.
  const closure=structuredClone(table);closure.records[31].mutation_type=99;
  const report=inspectContentReadiness({maps:{M01040:{...content.maps.M01040,npcs:[20]}},programs:{},roles:{}},
    {maps:{M01040:closure},programs:{}},{npcs_by_map:{},trigger_regions:{}});
  assert.ok(report.errors.some(row=>row.record_id===32&&/99/.test(row.message)));
});

test('real password-shop NPC transfer retains native sort and one transaction across save/load',async()=>{
  const source=await sourceTable('M01040'),target=await sourceTable('M01041'),tables={M01040:source,M01041:target};
  const data={schema:'seventh-seal-chapter-story',version:1,maps:tables,programs:{},source_hashes:Object.fromEntries(Object.values(tables).map(t=>[t.source.path,t.source.sha256]))};
  const content=structuredClone(runtimeContent);
  for(const id of Object.keys(tables))content.maps[id]={triggers:[],objects:[],rests:[],routes:[],npcs:id==='M01040'?[17]:[]};
  const initial=structuredClone(seed);initial.opening.status='complete';initial.location={map_id:'M01040',x:640,y:480,direction:0};initial.flags[4]|=1<<11;
  const world=new WorldStore(initial,Object.keys(tables)),trace=[];
  let fail=false;
  const runner=new ChapterRunner({world,data,content,say:async()=>{},transfer:async({destination,draft})=>{
    assert.equal(world.location.map_id,'M01040');assert.equal(draft.location.map_id,'M01040');trace.push(destination);
    if(fail)throw Error('password-shop preparation failed');
    return {location:{map_id:'M01041',x:160,y:160,direction:2}};
  }});
  const request={mapId:'M01040',recordId:26,context:{steps:0,explicitInteraction:true,npcMapId:'M01040',npcSlot:17}};
  const result=await runner.runTlk(request);
  assert.deepEqual(result.traversed,[26,27,86,87,88]);assert.deepEqual([trace[0].map_id,trace[0].entry_marker,trace[0].sort_code],['M01041',1,1]);
  assert.equal(world.value.revision,initial.revision+1);assert.equal(world.value.native_map_sort_code,1);
  assert.equal((await decodeSave(await encodeSave(world.snapshot()))).native_map_sort_code,1);
  world.replace({...initial,native_map_sort_code:4});fail=true;const before=world.snapshot();
  await assert.rejects(runner.runTlk(request),/password-shop preparation failed/);assert.deepEqual(world.snapshot(),before);assert.equal(trace.at(-1).sort_code,4);
  await assert.rejects(runner.runTlk({...request,context:{steps:0}}),/缺少原地形触发器或NPC/);assert.deepEqual(world.snapshot(),before);
});

test('all four original city departure rings retain their exact source bit4 polarity and bit10 writer',async()=>{
  const data=JSON.parse(await readFile(new URL('../web/data/chapter_story.json',import.meta.url),'utf8'));
  for(const [mapId,triggerId,recordId,afterReport]of [['M01010',31,18,false],['M01030',31,63,false],['M01050',31,88,true],['M01060',30,74,true]]){
    const table=data.maps[mapId],descriptor=table.descriptors.find(row=>row.id===triggerId);
    assert.ok(runtimeContent.maps[mapId].triggers.includes(triggerId),mapId);
    const dat=await read(table.source.path.replace(/\.tlk$/i,'.dat'));
    assert.equal(dat.subarray(descriptor.source.offset,descriptor.source.offset+descriptor.record_bytes).toString('hex'),descriptor.raw_hex);
    assert.equal(descriptor.state_raw,2);assert.equal(descriptor.field_26_raw,recordId);assert.ok(descriptor.cells.length);
    const location={map_id:mapId,x:descriptor.cells[0].x*16+8,y:descriptor.cells[0].y*16+8,direction:0};
    for(const reported of [false,true]){
      const initial=structuredClone(seed);initial.opening.status='complete';initial.location={map_id:'M01040',x:640,y:480,direction:0};initial.flags[4]=0;
      const world=new WorldStore(initial,Object.keys(runtimeContent.maps));
      const runner=new ChapterRunner({world,data,content:runtimeContent,say:async()=>{}});
      if(reported){await runner.runTlk({mapId:'M01040',recordId:37});assert.equal(world.value.flags[4],8);}
      world.transact(draft=>{draft.location=location;});
      const result=await runner.runTlk({mapId,triggerId,recordId});
      const writes=reported===afterReport;
      assert.deepEqual(result.traversed,writes?[recordId,recordId+1]:[recordId]);
      assert.equal(world.value.flags[4],(reported?8:0)|(writes?512:0));
    }
  }
});

test('second source round needs31:2 and bits6/7/8, rewards once, and remote clauses keep their native index',async()=>{
  const animations=[],{table,world,runner}=await fixture('M01040',{animate:async({program})=>animations.push(program.id)});
  let result=await runner.runTlk({mapId:table.id,recordId:41});assert.deepEqual(result.traversed,[41]);
  world.transact(draft=>{draft.flags[31]|=2;});
  result=await runner.runTlk({mapId:table.id,recordId:41});assert.ok(result.traversed.includes(43));assert.ok(animations.includes('m01040-3'));
  animations.length=0;
  for(let mask=0;mask<8;mask++){
    world.transact(draft=>{draft.flags[4]=(mask<<5);});
    result=await runner.runTlk({mapId:table.id,recordId:46});
    assert.equal(result.traversed[1]??null,mask===7?50:null);
    assert.equal(Boolean(world.value.flags[4]&256),mask===7);
  }
  assert.deepEqual(animations,['m01040-2']);
  await runner.runTlk({mapId:table.id,recordId:46});assert.deepEqual(animations,['m01040-2']);
  const other=await sourceTable('M01030'),gate=other.records[26];
  world.transact(draft=>{draft.flags[3]=4;draft.flags[5]=0;});
  assert.equal(evaluateNativeStoryCombination(gate,world.value,other),false);
  world.transact(draft=>{draft.flags[5]=0x40000000;});
  assert.equal(evaluateNativeStoryCombination(gate,world.value,other),true);
});

test('actual100-currency inn uses its NPC root, restores then deducts once, and rolls back failed animation',async()=>{
  const {table,world,runner}=await fixture('M01031');
  assert.equal(table.records.length,15,'TLK trailing bytes are not extra records');
  assert.deepEqual([table.records[5].condition_type,table.records[5].condition_index,table.records[2].mutation_type,table.records[2].mutation_index],[2,100,3,0xffffff9c]);
  world.transact(draft=>{draft.money=99;draft.party[0].hp.current=1;});
  let result=await runner.runTlk({mapId:table.id,recordId:1,context:{steps:0,explicitInteraction:true}});
  assert.deepEqual(result.traversed,[1,6,7]);assert.equal(world.value.money,99);assert.equal(world.value.party[0].hp.current,1);
  world.transact(draft=>{draft.money=100;});
  result=await runner.runTlk({mapId:table.id,recordId:1,context:{steps:0,explicitInteraction:true}});
  assert.deepEqual(result.traversed,[1,6,2,3,8,9]);assert.equal(world.value.money,0);assert.equal(world.value.party[0].hp.current,world.value.party[0].hp.maximum);
  const loaded=await decodeSave(await encodeSave(world.value),[table.id]);assert.deepEqual(loaded,world.value);
  world.transact(draft=>{draft.money=200;draft.party[0].hp.current=1;});
  runner.animate=async()=>{throw new Error('inn renderer failed');};
  const before=world.snapshot();await assert.rejects(runner.runTlk({mapId:table.id,recordId:1,context:{steps:0,explicitInteraction:true}}),/inn renderer failed/);assert.deepEqual(world.snapshot(),before);
  runner.choose=async()=>1;
  result=await runner.runTlk({mapId:table.id,recordId:1,context:{steps:0,explicitInteraction:true}});
  assert.deepEqual(result.traversed,[1]);assert.equal(world.value.money,200);assert.equal(world.value.party[0].hp.current,1);
  const money={money:5};applyNativeStoryMutation(money,table.records[2]);assert.equal(money.money,0);
  applyNativeStoryMutation(money,{mutation_type:3,mutation_index:150,mutation_bit:123});assert.equal(money.money,150);
  assert.equal(evaluateNativeStoryCondition(table.records[5],money,table),true);
});

test('rescue source keeps all78 commands, c32 disperses NPC10 and cancellation joins the pending effect',async()=>{
  const program=await sourceProgram('m01060-2','M01060'),content=structuredClone(runtimeContent),trace=[];
  content.programs[program.id]=program.source;
  for(const id of program.maps)content.maps[id]??={triggers:[],objects:[],rests:[],routes:[]};
  validateChapterAnimation(program,content);assert.equal(program.commands.length,78);
  const command=program.commands[32];assert.deepEqual([command.opcode,command.u32_plus1,command.u32_plus5,command.byte_plus29],[41,0,10,0]);
  const hooks=Object.fromEntries(['map','actor','move','camera','wait','fade','sound','media'].map(hook=>[hook,async payload=>trace.push({hook,...payload})]));
  await new ChapterAnimationRunner({program,content,hooks,initialLocation:{map_id:'M01060',x:640,y:480},runTlk:async()=>{},joinActor:async()=>{},leaveActor:async()=>{}}).run();
  assert.deepEqual(trace.filter(row=>row.kind==='behavior').map(row=>[row.command.index,row.actor,row.nativeStateRaw]),[[32,10,1]]);
  const playback=new StoryPlayback(),cancelHooks={...hooks,actor:async payload=>{if(payload.kind==='behavior')await new Promise((resolve,reject)=>payload.signal.addEventListener('abort',()=>reject(payload.signal.reason),{once:true}));}};
  const cancelled=new ChapterAnimationRunner({program,content,hooks:cancelHooks,playback,initialLocation:{map_id:'M01060',x:640,y:480},runTlk:async()=>{},joinActor:async()=>{}});
  const running=cancelled.run();for(let i=0;i<60;i++)await Promise.resolve();playback.cancel(new Error('rescue cancelled'));
  await assert.rejects(running,/rescue cancelled/);assert.equal(cancelled.phase,'cancelled');
});

test('dispersal renders source pixels, retains local RNG, groups neighbouring speeds and ends after30ticks',()=>{
  const pixels=new Uint8ClampedArray([255,128,64,255,255,128,64,255,0,0,0,0,255,128,64,255]);
  const previous=globalThis.document;
  globalThis.document={createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:pixels}),createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(){}})})};
  try{
    const actor={action:0,frame:0,direction:0,role:{frame_width:2,frame_height:2,anchor:{x:1,y:1},actions:[{index:0,bitmap:{}}]}};
    const effect=new ActorEffectView(actor,'scatter');assert.equal(effect.particles.length,3);
    assert.equal(new Set(effect.particles.map(row=>row.speed)).size,1);
    assert.deepEqual(effect.particles.map(row=>[row.dx,row.dy]),[[-2,-35],[-1,-35],[-1,-34]]);
    assert.equal(effect.output.data.some(value=>value!==0),true);effect.update(30);assert.equal(effect.output.data.some(value=>value!==0),false);
  }finally{globalThis.document=previous;}
});

test('real hide-and-seek actor placement survives save/load, natural motion is captured, and cancel keeps the prior snapshot',async()=>{
  const id='M01040',dat=await read(`Map/${id}.DAT`),table=await sourceTable(id),resources=JSON.parse(await readFile(new URL('../web/data/chapter_map_resources.json',import.meta.url),'utf8'));
  const stride=dat.readUInt32LE(0x18)===1?0x42:0x2b,start=0x172+dat.readUInt32LE(0x146)*dat.readUInt32LE(0x14a)*64+32*(0x2a+stride+0x1b+0x110)+dat.readUInt32LE(0x82)*0x112;
  const npcs=Array.from({length:dat[0x86]},(_,index)=>{
    const raw=dat.subarray(start+index*0x4c5,start+(index+1)*0x4c5),slot=index+10;
    return {id:`${id}-role-${slot}`,slot_zero_based:slot,resource_id:String(raw.readUInt32LE(0x28)).padStart(3,'0'),x:raw.readInt32LE(0x6f)*2,y:raw.readInt32LE(0x73)*2,direction:raw[0x45],hidden:Boolean(raw[0x97]||raw[0x2ac])};
  });
  table.header_setup_tlk_raw=dat.readUInt32LE(0x8a);assert.equal(table.header_setup_tlk_raw,0);
  const programs=Object.fromEntries(await Promise.all(['m01040-1','m01040-2'].map(async name=>[name,await sourceProgram(name,id)])));
  const data={schema:'seventh-seal-chapter-story',version:1,maps:{[id]:table},programs,source_hashes:{[table.source.path]:table.source.sha256}},content=structuredClone(runtimeContent);
  for(const program of Object.values(programs))content.programs[program.id]=program.source;
  content.maps[id]={triggers:[],objects:[],rests:[],routes:[],npcs:[18,19,20,21]};
  const initial=structuredClone(seed);initial.opening.status='complete';initial.location={map_id:id,x:768,y:640,direction:0};initial.source.kind='npc-state-source-fixture';
  const world=new WorldStore(initial,[id]),elements=new Map(),$=key=>{if(!elements.has(key))elements.set(key,{hidden:true,style:{opacity:'0'}});return elements.get(key);};
  const scene=npcs=>({data:{id,opening_npcs:npcs},npcs,bitmap:{width:1800,height:1400}}),original=scene(structuredClone(npcs));
  let block=false,waitCount=0,started;
  const pending=new Promise(resolve=>{started=resolve;}),clock={async tween(ms,update,signals){
    update(1);
    if(block&&++waitCount===2){started();await new Promise((resolve,reject)=>signals[0].addEventListener('abort',()=>reject(signals[0].reason),{once:true}));}
  }};
  const state={world,view:{x:0,y:0,follow:false},scenes:{current:original,captureView:()=>({}),rollbackView(){},setPhase(){}},
    engine:{exploration:{clock}},openingResources:{roles:resources.roles},chapterStory:data,storyRepository:{content,ensureProgram:async()=>null}};
  const actions={log(){},commitView(){},validateEntry(){},prepareMap:async(mapId,{world:draft})=>scene(await projectMapStage({mapId,world:draft,story:data,npcs,roles:resources.roles,content}))};
  const controller=createStoryController({state,actions,$,canvas:{}}),runner=new ChapterRunner({world,data,content,animate:controller.animateChapter,say:async()=>{}});
  state.chapterStory=runner.data;
  await runner.runTlk({mapId:id,recordId:39});
  const children=world.value.map_npc_state.actors.filter(row=>[18,19,21].includes(row.slot));
  assert.deepEqual(children.map(row=>[row.slot,row.x,row.y,row.hidden]),[[18,602,640,false],[19,1466,1048,false],[21,92,648,false]]);
  const loaded=await decodeSave(await encodeSave(world.snapshot()),[id]),restored=await projectMapStage({mapId:id,world:loaded,story:data,npcs,roles:resources.roles,content});
  assert.deepEqual(restored.filter(row=>[18,19,21].includes(row.slot_zero_based)).map(row=>[row.slot_zero_based,row.x,row.y,row.hidden]),children.map(row=>[row.slot,row.x,row.y,row.hidden]));
  // Saving uses the live scene, including ordinary NPC motion after the ANM.
  const live=restored.find(row=>row.slot_zero_based===18);Object.assign(live,{x:610,y:652,direction:3,motion:{action:1,frame:2,direction:4}});
  state.scenes.current=scene(restored);state.scenes.canSave=()=>true;
  const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]).copy(png);png.writeUInt32BE(104,16);png.writeUInt32BE(76,20);
  const services=createServicesController({state,actions:{captureSavePreview:()=>`data:image/png;base64,${png.toString('base64')}`}}),saved=await decodeSave(await services.saveEnvelope(),[id]);
  assert.deepEqual(saved.map_npc_state.actors.find(row=>row.slot===18),{slot:18,x:610,y:652,direction:4,hidden:false,action:1,frame:2});
  assert.deepEqual(world.value.map_npc_state.actors.filter(row=>[18,19,21].includes(row.slot)),children,'a save snapshot does not mutate the active world');
  // The real hide ANM shares the draft. Cancelling after placements must not
  // expose those hidden actors in the committed save or previous scene.
  const before=world.snapshot(),previous=state.scenes.current,playback=new StoryPlayback();block=true;
  const running=runner.runTlk({mapId:id,recordId:40,playback});await pending;playback.cancel();await assert.rejects(running,{name:'AbortError'});playback.dispose();
  assert.deepEqual(world.snapshot(),before);assert.equal(state.scenes.current,previous);
  block=false;await runner.runTlk({mapId:id,recordId:40});
  const hiddenSave=await decodeSave(await encodeSave(world.snapshot()),[id]),hiddenRestore=await projectMapStage({mapId:id,world:hiddenSave,story:data,npcs,roles:resources.roles,content});
  assert.ok(hiddenRestore.filter(row=>[18,19,21].includes(row.slot_zero_based)).every(row=>row.hidden),'the source hide ANM also persists on successful completion');
  const invalid=structuredClone(saved);invalid.map_npc_state.actors[0].slot=9;assert.throws(()=>new WorldStore(invalid,[id]),/人物槽/);
});
