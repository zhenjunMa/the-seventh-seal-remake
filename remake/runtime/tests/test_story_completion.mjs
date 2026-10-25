import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {WorldStore} from '../web/core/world.mjs';
import {SceneController} from '../web/core/scenes.mjs';
import {ChapterRunner} from '../web/core/chapter.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {createStoryController} from '../web/controllers/story.mjs';
import {createSessionController} from '../web/controllers/session.mjs';
import {STORY_COMPLETION_STORAGE_KEY,hasNativeStoryCompletion,loadStoryCompletion} from '../web/core/story_completion.mjs';
const copy=structuredClone,read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [seed,story]=await Promise.all(['opening_seed','chapter_story'].map(read));
function fixture(){
  // Small isolated ANM fixture exercises the actual animation controller,
  // source validator and commit bridge. The ending flag uses originalTLK47.
  const bytes=Buffer.alloc(67+74);bytes.writeUInt32LE(1,2);bytes[67]=10;bytes.write('M17023.DAT',67+54);
  const source={path:'Animate/test-completion.anm',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},raw=bytes.subarray(67),command={index:0,opcode:10,raw_hex:raw.toString('hex'),filename:'M17023.DAT',source:{...source,offset:67}};
  for(const at of [1,5,9,13,17,21,25])command[`u32_plus${at}`]=raw.readUInt32LE(at);for(let at=29;at<34;at++)command[`byte_plus${at}`]=raw[at];
  const program={schema:'seventh-seal-chapter-anm',version:1,id:'test-completion',source,commands:[command],maps:['M17023'],expected:{caller_maps:['M17023'],control_maps:['M17023'],control_map:'M17023'}};
  const content=copy(runtimeContent);content.programs[program.id]=source;
  const value=copy(seed);value.opening.status='complete';value.location={map_id:'M17023',x:640,y:480,direction:0};const world=new WorldStore(value);
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,style:{opacity:'0'},focus(){}});return nodes.get(id);};
  const events=[],writes=[],files=new Map(),storage={getItem:key=>files.get(key)??null,setItem(key,value){writes.push([key,value]);files.set(key,value);}};
  const role={anchor:{x:0,y:0},actions:[{index:0,first_frame:0,frame_count:1,directions:8}]};
  const state={world,view:{x:1,y:2},openingResources:{roles:{'001':role}},sidePriority:0,anmVisualState:{},
    storyRepository:{content,async ensureProgram(){return {program,release(){}};}},
    startupView:{showMenu(options){events.push({type:'title',options,flag:world.value.flags[1999],revision:world.value.revision});}},audio:{suspend(){}},keys:new Set()};
  const canvas={focus(){}},actions={log:event=>events.push(event),status:message=>events.push({type:'status',message}),
    commitView(){},validateEntry(){},prepareMap:async id=>({data:{id,opening_npcs:[]},npcs:[],bitmap:{width:1600,height:1504},npcRuntime:{adoptActors(){},inherit(){}}})};
  const controller=createStoryController({state,actions,$,canvas});Object.assign(actions,createSessionController({state,actions,$,canvas,completionStorage:storage}));
  const runner=new ChapterRunner({world,data:story,content:runtimeContent,say:async()=>{}});
  state.scenes={request:0,phase:'event',current:null,setPhase(phase){this.phase=phase;},captureView(){return {...state.view};},rollbackView(value){Object.assign(state.view,value);}};
  const execute=async(draft,playback)=>{
    await runner.runTlk({mapId:'M17023',recordId:47,draft,playback});assert.equal(draft.flags[1999]&1,1);
    await controller.animateChapter({program,mapId:'M17023',draft,playback,runTlk:async()=>{},joinActor:async()=>{}});
    assert.equal(events.some(event=>event.type==='title'),false,'a private ending flag cannot open the title');
  };
  return {world,state,actions,controller,runner,events,writes,storage,files,$,execute};
}
test('the actual finale plays25 before the lastTLK47 and its source flag is1999:1',async()=>{
  const bytes=await readFile(new URL('../../../Animate/m17030-1.anm',import.meta.url)),program=story.programs['m17030-1'];
  assert.equal(createHash('sha256').update(bytes).digest('hex'),program.source.sha256);
  assert.equal(program.commands[182].opcode,60);assert.equal(program.commands[182].filename,'25.bik');
  const final=program.commands.findLast(command=>command.opcode===14);assert.equal(final.index,183);assert.equal(final.u32_plus5,47);
  assert.deepEqual(program.commands.slice(184).map(command=>command.opcode),[16,16],'both source final waits precede the terminal check');
  const record=story.maps.M17023.records.find(row=>row.id===47);assert.equal(record.mutation_type,0);assert.equal(record.mutation_index,1999);assert.equal(record.mutation_bit,1);
});
test('root story commits the complete world before opening a nonresumable title and writing only independent completion metadata',async()=>{
  const f=fixture(),revision=f.world.value.revision;
  const result=await f.controller.playStory(playback=>f.runner.atomic({mapId:'M17023',playback},async draft=>{await f.execute(draft,playback);return {};}));
  assert.equal(result.story_completed,true);assert.equal(f.world.value.revision,revision+1);assert.equal(f.state.scenes.phase,'menu');assert.equal(f.$('menuResume').hidden,true);
  const title=f.events.find(event=>event.type==='title');assert.deepEqual(title.options,{allowResume:false});assert.equal(title.flag&1,1);assert.equal(title.revision,revision+1);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0][0],STORY_COMPLETION_STORAGE_KEY);assert.deepEqual(loadStoryCompletion(f.storage),{schema:'seventh-seal-completion',version:1,menu_code:1});
  assert.equal(f.state.pendingStoryCompletion,null);f.actions.resumeExploration();assert.equal(f.state.scenes.phase,'menu');
});
test('later failure or cancellation rolls back the private ending flag and never opens a title or persists MenuCode',async()=>{
  for(const cancel of [false,true]){
    const f=fixture(),before=f.world.snapshot();
    const running=f.controller.playStory(playback=>f.runner.atomic({mapId:'M17023',playback},async draft=>{await f.execute(draft,playback);if(cancel)playback.cancel();else throw Error('late ending media failed');return {};}));
    await assert.rejects(running,cancel?{name:'AbortError'}:/late ending media failed/);
    assert.deepEqual(f.world.snapshot(),before);assert.equal(f.events.some(event=>event.type==='title'),false);assert.deepEqual(f.writes,[]);assert.equal(f.state.pendingStoryCompletion,undefined);
  }
});
test('entry ANM completion waits forSceneController afterCommit and cannot be undone by terminal presentation failure',async()=>{
  const f=fixture(),revision=f.world.value.revision;
  const scenes=new SceneController({world:f.world,prepare:async()=>({data:{id:'M17023'}}),validateEntry(){},commitView(){},
    enter:async(_scene,draft)=>{scenes.setPhase('event');return f.controller.playStory(async playback=>{await f.execute(draft,playback);return true;});},
    afterCommit:()=>f.actions.finishStoryCompletion()});
  f.state.scenes=scenes;await scenes.loadLocation(f.world.location);
  assert.equal(f.world.value.revision,revision+1);assert.equal(scenes.phase,'menu');assert.equal(f.events.find(event=>event.type==='title').revision,revision+1);assert.equal(f.writes.length,1);
});
test('stale completion tickets and malformed persisted metadata cannot unlock or redirect another world',()=>{
  const f=fixture(),expected=f.world.snapshot();expected.flags[1999]=1;
  f.state.pendingStoryCompletion={world:f.world,sceneRequest:1,expected,request:{}};
  assert.equal(f.actions.finishStoryCompletion(),false);assert.equal(f.state.pendingStoryCompletion,null);assert.equal(f.events.some(event=>event.type==='title'),false);
  f.files.set(STORY_COMPLETION_STORAGE_KEY,JSON.stringify({schema:'seventh-seal-completion',version:2,menu_code:1}));assert.equal(loadStoryCompletion(f.storage),null);
  assert.equal(hasNativeStoryCompletion({flags:Array(2000).fill(0)}),false);
});
test('a denied browser metadata write still enters the terminal title without an invented game save',async()=>{
  const f=fixture();f.storage.setItem=()=>{throw Error('storage unavailable');};
  const result=await f.controller.playStory(playback=>f.runner.atomic({mapId:'M17023',playback},async draft=>{await f.execute(draft,playback);return {};}));
  assert.equal(result.story_completed,true);assert.equal(f.state.scenes.phase,'menu');assert.equal(f.$('menuResume').hidden,true);
  const log=f.events.find(event=>event.type==='story-complete');assert.equal(log.metadata_persisted,false);assert.equal(log.metadata_error,'storage unavailable');assert.equal(log.automatic_game_save,false);
});
test('a post-commit terminal presentation failure never rolls back the committed scene or exposes exploration',async()=>{
  const f=fixture(),revision=f.world.value.revision;
  const scenes=new SceneController({world:f.world,prepare:async()=>({data:{id:'M17023'}}),validateEntry(){},commitView(){},
    enter:async(_scene,draft)=>{scenes.setPhase('event');return f.controller.playStory(async playback=>{await f.execute(draft,playback);return true;});},
    afterCommit:()=>f.actions.finishStoryCompletion()});
  f.state.scenes=scenes;f.state.startupView.showMenu=()=>{throw Error('title presentation failed');};
  await assert.rejects(scenes.loadLocation(f.world.location),/title presentation failed/);
  assert.equal(f.world.value.revision,revision+1);assert.equal(f.world.value.flags[1999]&1,1);assert.equal(scenes.current.data.id,'M17023');assert.equal(scenes.phase,'menu');
});

test('a terminal entry commits an intentionally nonplayable cinematic location without a second exploration validation or view commit',async()=>{
  const f=fixture(),revision=f.world.value.revision,validations=[],commits=[],phases=[];
  const scenes=new SceneController({world:f.world,prepare:async()=>({data:{id:'M17023'}}),
    validateEntry(_scene,location){validations.push(copy(location));assert.ok(location.x<1000,'only the valid incoming entrance may be tested for walking');},
    commitView(_scene,location){commits.push(copy(location));},onPhase:phase=>phases.push(phase),
    enter:async(_scene,draft)=>{scenes.setPhase('event');return f.controller.playStory(async playback=>{
      await f.execute(draft,playback);
      // A synthetic nonplayable pose checks the generic entry outcome; the
      // real ANM and exact entrance are covered in test_finale_opening_view.
      draft.location.x=1632.602580645161;
      return {resume_exploration:false};
    });},
    afterCommit:()=>{assert.equal(scenes.phase,'event');f.actions.finishStoryCompletion();}});
  f.state.scenes=scenes;await scenes.loadLocation(f.world.location);
  assert.equal(validations.length,1);assert.equal(commits.length,1);assert.equal(scenes.phase,'menu');
  assert.equal(f.world.value.revision,revision+1);assert.equal(f.world.value.flags[1999]&1,1);assert.equal(f.world.location.x,1632.602580645161);
  assert.deepEqual(phases,['loading','event','event','story-complete','menu']);
  assert.equal(f.events.filter(event=>event.type==='title').length,1);assert.equal(f.writes.length,1);
});
test('enterMap emits a terminal entry outcome only after its completed ANM has requested the post-commit title',async()=>{
  const f=fixture(),draft=f.world.snapshot();
  // Synthetic entry callback isolates the entry adapter. Its nested ANM and
  // finalTLK47 still use the actual animation controller and source mutation.
  f.state.chapterRunner={runTlk:async({draft,playback})=>f.execute(draft,playback)};
  const outcome=await f.controller.enterMap({data:{id:'M17010'}},draft,'exit');
  assert.deepEqual(outcome,{resume_exploration:false});assert.equal(draft.flags[1999]&1,1);
  assert.equal(f.events.some(event=>event.type==='title'),false);assert.equal(f.writes.length,0);
  assert.ok(f.state.pendingStoryCompletion);assert.equal(f.world.value.flags[1999]&1,0);
});
