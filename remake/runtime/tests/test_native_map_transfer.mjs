import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ChapterRunner,validateChapterStory} from '../web/core/chapter.mjs';
import {ChapterAnimationRunner} from '../web/core/chapter_animation.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {createStoryController} from '../web/controllers/story.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {nativeMapTransfer,worldMapEntry} from '../web/core/map_connections.mjs';
import {MovementMap} from '../web/core/movement.mjs';
import {StoryPlayback} from '../web/core/story_playback.mjs';
import {inspectContentReadiness} from '../web/core/content_readiness.mjs';
import {compileTlkFlow,nativeFlowId} from '../web/core/story_flow_compiler.mjs';
import {applyExperience} from '../web/core/battle_rewards.mjs';
const copy=structuredClone;
const read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [source,seed,resources,targetMap,rewards]=await Promise.all(['chapter_story','opening_seed','chapter_map_resources','maps/m17023','party_rewards'].map(read));

test('kind2 destination marker255 is independent of source TLK targets in both source and compact validators',()=>{
  for(const version of [1,2]){
    const raw=Buffer.alloc(0x66f);raw[0]=2;raw.writeUInt32LE(1,0x13);raw.writeUInt32LE(255,0x2f);raw.write('m99002.dat',0x37,'ascii');
    const row={id:1,kind:2,style:0,region_byte_raw:0,speaker:0,condition_type:0,condition_index:0,condition_bit:0,
      mutation_type:0,mutation_index:0,mutation_bit:0,if_true:255,next:0,text_raw:'m99002.dat',
      ...(version===1?{raw_hex:raw.toString('hex'),offset:0}:{text_id:'M99001:TLK:1',choices:[]})};
    const path='Map/m99001.TLK',sha256='a'.repeat(64),data={schema:'seventh-seal-chapter-story',version,
      source_hashes:{[path]:sha256},maps:{M99001:{id:'M99001',map_flag_index:101,source:{path,sha256},record_base:0,records:[row]}}};
    assert.equal(validateChapterStory(data),data);
    const invalidNext=copy(data);invalidNext.maps.M99001.records[0].next=255;
    if(version===1){const bytes=Buffer.from(row.raw_hex,'hex');bytes.writeUInt32LE(255,0x33);invalidNext.maps.M99001.records[0].raw_hex=bytes.toString('hex');}
    assert.throws(()=>validateChapterStory(invalidNext),/跳转/,'next remains a source TLK reference');
    const invalidBranch=copy(data);invalidBranch.maps.M99001.records[0].kind=0;
    if(version===1){const bytes=Buffer.from(row.raw_hex,'hex');bytes[0]=0;invalidBranch.maps.M99001.records[0].raw_hex=bytes.toString('hex');}
    assert.throws(()=>validateChapterStory(invalidBranch),/跳转/,'ordinary condition targets remain strict');
  }
});

function fixture({flags={},prepareTarget,commitError=false,dialogueError=false}={}){
  const content=copy(runtimeContent);content.maps.M17032.triggers=[1];
  const initial=copy(seed);initial.opening.status='complete';initial.location={map_id:'M17032',x:576,y:704,direction:2};
  for(const [index,value]of Object.entries(flags))initial.flags[Number(index)]=value;
  const world=new WorldStore(initial),original={data:{id:'M17032'}},pins=new Map(),trace=[],view={map:'M17032'};
  const state={world,chapterStory:null,scenes:{current:original,captureView:()=>copy(view),
    rollbackView(value){Object.assign(view,value);},setPhase(phase){this.phase=phase;}}};
  const actions={async prepareMap(id,{world:draft}){
      trace.push(['prepare',id]);assert.equal(draft.flags[10],initial.flags[10]);assert.equal(world.value.location.map_id,'M17032');
      const scene={data:copy(targetMap),movement:new MovementMap(targetMap.movement)};
      return prepareTarget?prepareTarget(scene):scene;
    },validateEntry(scene,at){assert.equal(scene.data.id,at.map_id);assert.equal(scene.movement.at(at.x,at.y).blocked,false);},
    commitView(scene){trace.push(['install',scene.data.id]);view.map=scene.data.id;if(commitError)throw Error('transfer renderer failure');},log(){}};
  const controller=createStoryController({state,actions,$:()=>({}),canvas:{}});
  const runner=new ChapterRunner({world,data:source,content,transfer:controller.transferChapter,
    say:async({record})=>{trace.push(['say',record.id]);if(dialogueError)throw Error('return denial dialogue failure');}});
  state.chapterStory=runner.data;
  state.storyRepository={
    retainMap(id){pins.set(id,(pins.get(id)??0)+1);let done=false;return ()=>{if(done)return;done=true;const n=pins.get(id)-1;if(n)pins.set(id,n);else pins.delete(id);};},
    async ensureMap(id){trace.push(['ensure',id]);assert.ok(pins.has('M17032')&&pins.has(id));},trim(){trace.push(['trim']);}
  };
  return {world,state,runner,content,pins,trace,view,original,before:world.snapshot(),
    run:options=>runner.runTlk({mapId:'M17032',recordId:2,triggerId:1,...options})};
}

test('real Map32 return marker is kind2 +2F while descriptor1 supplies sort4',async()=>{
  const table=source.maps.M17032,record=table.records.find(row=>row.id===5),content=copy(runtimeContent);content.maps.M17032.triggers=[1];
  const destination=nativeMapTransfer(table,record,{triggerId:1,triggerRecordId:2},content);
  assert.deepEqual([destination.map_id,destination.entry_marker,destination.sort_code],['M17023',2,4]);
  const bytes=await readFile(new URL('../../../Map/m17032.dat',import.meta.url)),descriptor=table.descriptors.find(row=>row.id===1);
  assert.equal(descriptor.source.offset,371442);assert.equal(bytes.readUInt32LE(descriptor.source.offset+0x26),2);
  assert.equal(bytes.readUInt32LE(descriptor.source.offset+0x2a),4);
  assert.deepEqual(worldMapEntry({data:targetMap},destination,source),{map_id:'M17023',x:144,y:160,direction:0});
  assert.throws(()=>nativeMapTransfer(table,record,{},content),/触发器上下文/);
  assert.throws(()=>nativeMapTransfer(table,{...record,text_raw:'../m17023.dat'},{triggerId:1,triggerRecordId:2},content),/文件名/);
});

test('real return branches transfer once or display the native denial and remain on Map32',async()=>{
  for(const [flags,traversed,transferred]of [[{},[2,5],true],[{10:2,471:1},[2,6,5],true],[{10:2},[2,6],false]]){
    const f=fixture({flags}),result=await f.run();assert.deepEqual(result.traversed,traversed);
    assert.equal(f.world.value.location.map_id,transferred?'M17023':'M17032');
    assert.equal(f.trace.filter(row=>row[0]==='install').length,Number(transferred));
    if(transferred){assert.deepEqual(f.world.location,{map_id:'M17023',x:144,y:160,direction:0});assert.deepEqual(f.trace.slice(0,3),[['ensure','M17023'],['prepare','M17023'],['install','M17023']]);}
    else assert.deepEqual(f.trace,[['say',6]]);
    assert.deepEqual(f.world.value.flags,f.before.flags);assert.deepEqual(f.world.value.source,f.before.source);assert.equal(f.pins.size,0);
  }
});

test('readiness respects an explicit return-only test selection without implicitly enabling the other Map32 trigger',()=>{
  const content=copy(runtimeContent);content.maps={M17032:{...content.maps.M17032,triggers:[1]},
    M17023:{...content.maps.M17023,triggers:[],npcs:[]}};
  const report=inspectContentReadiness(content,source,resources);assert.deepEqual(report.errors,[]);
  assert.deepEqual(report.entrances.filter(row=>row.kind==='trigger').map(row=>[row.map_id,row.id]),[['M17032',1]]);
});

test('missing context and failed preparation, installation or denial preserve the original world',async()=>{
  const noContext=fixture();await assert.rejects(noContext.runner.runTlk({mapId:'M17032',recordId:2}),/缺少原地形触发器/);
  assert.deepEqual(noContext.world.snapshot(),noContext.before);
  for(const options of [{prepareTarget:async()=>{throw Error('transfer target missing');}},{commitError:true},{flags:{10:2},dialogueError:true}]){
    const f=fixture(options);await assert.rejects(f.run(),/transfer target missing|transfer renderer failure|denial dialogue failure/);
    assert.deepEqual(f.world.snapshot(),f.before);assert.equal(f.state.scenes.current,f.original);assert.deepEqual(f.view,{map:'M17032'});assert.equal(f.pins.size,0);
  }
});

test('cancelled preparation cannot install a late target or commit its destination',async()=>{
  let started,finish;const ready=new Promise(resolve=>{started=resolve;}),pending=new Promise(resolve=>{finish=resolve;});
  const f=fixture({prepareTarget:scene=>{started();return pending.then(()=>scene);}}),playback=new StoryPlayback();
  const running=f.run({playback});await ready;playback.cancel();await assert.rejects(running,{name:'AbortError'});
  finish();await Promise.resolve();await Promise.resolve();
  assert.deepEqual(f.world.snapshot(),f.before);assert.equal(f.state.scenes.current,f.original);assert.deepEqual(f.view,{map:'M17032'});
  assert.equal(f.trace.some(row=>row[0]==='install'),false);assert.equal(f.pins.size,0);playback.dispose();
});

test('target arrival shares the original draft and playback and failed arrival rolls back installation',async()=>{
  // Isolated synthetic sources test generic arrival behavior. Real Map23 has
  // no arrival event and its original header remains unchanged.
  const binding=id=>({path:`data/maps/${id.toLowerCase()}.json`,triggers:[],objects:[],rests:[],routes:[],npcs:[]});
  const record=(mapId,id,fields)=>({id,kind:0,style:0,region_byte_raw:0,speaker:500,
    condition_type:0,condition_index:0,condition_bit:0,mutation_type:0,mutation_index:0,mutation_bit:0,
    if_true:0,next:0,text_raw:'',choices:[],text_id:`${mapId}:TLK:${id}`,...fields});
  for(const fail of [false,true]){
    const content=copy(runtimeContent);content.maps.M99001={...binding('M99001'),triggers:[1]};content.maps.M99002={...binding('M99002'),entry_record:1};
    const a=record('M99001',1,{kind:2,text_raw:'m99002.dat',if_true:2}),b=record('M99002',1,{text_raw:'arrival',mutation_index:123,mutation_bit:1});
    const tables={M99001:{id:'M99001',map_flag_index:101,source:{path:'Map/m99001.TLK',sha256:'a'.repeat(64)},records:[a],descriptors:[{id:1,state_raw:2,field_26_raw:1,field_2a_raw:4}]},
      M99002:{id:'M99002',map_flag_index:102,source:{path:'Map/m99002.TLK',sha256:'b'.repeat(64)},records:[b],entry_markers:{2:[{x:9,y:10}]},header_entry_tlk_raw:1}};
    const data={schema:'seventh-seal-chapter-story',version:2,maps:tables,source_hashes:{'Map/m99001.TLK':'a'.repeat(64),'Map/m99002.TLK':'b'.repeat(64)},flows:{}};
    for(const table of Object.values(tables))data.flows[nativeFlowId(table.id)]=compileTlkFlow(table,{choices:()=>[]});
    const initial=copy(seed);initial.opening.status='complete';initial.location={map_id:'M99001',x:32,y:32,direction:2};
    const world=new WorldStore(initial),before=world.snapshot(),playback=new StoryPlayback(),releases=[];let installed='M99001',seenPlayback;
    const runner=new ChapterRunner({world,data,content,
      transfer:async({draft,playback:active})=>{assert.equal(draft.flags[123],before.flags[123]);seenPlayback=active;installed='M99002';
        return {location:{map_id:'M99002',x:144,y:160,direction:0},release({failed}){releases.push(failed);if(failed)installed='M99001';}};},
      say:async({draft,playback:active})=>{assert.equal(active,playback);assert.equal(active,seenPlayback);assert.equal(draft.flags[123]&1,1);assert.deepEqual(world.snapshot(),before);if(fail)throw Error('arrival failed');}});
    if(fail){await assert.rejects(runner.runTlk({mapId:'M99001',recordId:1,triggerId:1,playback}),/arrival failed/);assert.deepEqual(world.snapshot(),before);assert.equal(installed,'M99001');assert.deepEqual(releases,[true]);}
    else{await runner.runTlk({mapId:'M99001',recordId:1,triggerId:1,playback});assert.equal(world.location.map_id,'M99002');assert.equal(world.value.flags[123]&1,1);assert.equal(world.value.revision,before.revision+1);assert.deepEqual(releases,[false]);}
    playback.dispose();
  }
});

function valleyTriggerFixture({localJoined=false,requestComplete=false,failDialogue=false}={}){
  const content=copy(runtimeContent);content.maps.M17010.triggers=[...new Set([...content.maps.M17010.triggers,31])];
  const initial=copy(seed);initial.opening.status='complete';initial.location={map_id:'M17010',x:600,y:600,direction:2};
  initial.flags[10]=localJoined?initial.flags[10]|1:initial.flags[10]&~1;
  initial.flags[16]=requestComplete?initial.flags[16]|1:initial.flags[16]&~1;
  const world=new WorldStore(initial),trace=[];
  const runner=new ChapterRunner({world,data:source,content,
    say:async({mapId,record})=>{trace.push(['say',mapId,record.id]);if(failDialogue)throw Error('Jute source dialogue failure');},
    animate:async({program,runTlk,joinActor,draft,playback})=>{
      trace.push(['program',program.id]);
      const result=await new ChapterAnimationRunner({program,runTlk,joinActor,content,playback,
        initialLocation:draft.location,hooks:Object.fromEntries(['map','actor','move','camera','wait','fade'].map(key=>[key,async()=>{}]))}).run();
      draft.location={...result.location,direction:result.location.direction??draft.location.direction};
    }});
  return {world,trace,runner,before:world.snapshot(),run:()=>runner.runTlk({mapId:'M17010',recordId:49,triggerId:31})};
}

test('real Fire Valley descriptor31 selects no scene, Jute admission, or completed-request return from original flags',async()=>{
  const early=valleyTriggerFixture(),initialParty=copy(early.world.value.party);
  assert.deepEqual((await early.run()).traversed,[49,51]);assert.deepEqual(early.trace,[]);
  assert.deepEqual(early.world.location,early.before.location);assert.deepEqual(early.world.value.party,initialParty);
  const joined=valleyTriggerFixture({localJoined:true});await joined.run();
  assert.deepEqual(joined.trace.filter(row=>row[0]==='program'),[['program','m17010-2']]);
  assert.equal(joined.world.location.map_id,'M17014');assert.equal(joined.world.value.flags[16]&1,1);
  assert.equal(joined.world.value.party.filter(role=>role.id==='005').length,1);
  assert.equal(joined.world.value.party.find(role=>role.id==='005').hp.current,1330);
  assert.deepEqual(joined.world.value.recipe_unlock_indices,[256]);
  const completed=valleyTriggerFixture({localJoined:true,requestComplete:true});await completed.run();
  assert.deepEqual(completed.trace,[['program','m17014-1']]);assert.equal(completed.world.location.map_id,'M17014');
  assert.deepEqual(completed.world.value.party,completed.before.party);
  const failed=valleyTriggerFixture({localJoined:true,failDialogue:true});
  await assert.rejects(failed.run(),/Jute source dialogue failure/);assert.deepEqual(failed.world.snapshot(),failed.before);
});

test('saved Jute growth and current HP/MP survive ordinary reentry and a replay of the original admission',async()=>{
  const f=valleyTriggerFixture({localJoined:true});await f.run();
  f.world.transact(draft=>{const index=draft.party.findIndex(row=>row.id==='005');
    const role=applyExperience(draft.party[index],3000,rewards,()=>0,[]).role;draft.party[index]=role;
    assert.ok(role.level>14);role.hp.current=42;role.mp.current=3;
    draft.location={map_id:'M17010',x:600,y:600,direction:2};});
  const saved=await decodeSave(await encodeSave(f.world.snapshot())),restoredRole=copy(saved.party.find(row=>row.id==='005'));
  f.world.replace(saved);await f.run();
  assert.equal(f.trace.filter(row=>row[0]==='program').at(-1)[1],'m17014-1');
  assert.deepEqual(f.world.value.party.find(row=>row.id==='005'),restoredRole);
  // Force the same source eligibility in an isolated fixture to test admission
  // replay safety. The ordinary path above naturally takes m17014-1.
  f.world.transact(draft=>{draft.location.map_id='M17010';draft.flags[16]&=~1;});await f.run();
  assert.equal(f.trace.filter(row=>row[0]==='program').at(-1)[1],'m17010-2');
  assert.equal(f.world.value.party.filter(row=>row.id==='005').length,1);
  assert.deepEqual(f.world.value.party.find(row=>row.id==='005'),restoredRole);
});
