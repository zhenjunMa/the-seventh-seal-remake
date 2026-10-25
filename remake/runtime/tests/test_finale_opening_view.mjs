// Full source finale through real map preparation, OpeningView and ANM clocks.
// PNGs keep their real header dimensions but are not decoded; dialogue, media
// and sound are recorded interfaces. The stage12 interface returns escaped.
// This tests presentation wiring, not movie pixels, combat or an original save.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {OpeningView} from '../web/opening_view.mjs';
import {ChapterAnimationRunner} from '../web/core/chapter_animation.mjs';
import {ChapterRunner} from '../web/core/chapter.mjs';
import {WorldStore} from '../web/core/world.mjs';
import {StoryRepository} from '../web/core/story_repository.mjs';
import {runtimeContent,runtimeContentDefinition} from '../web/core/content_registry.mjs';
import {applyNativeAnmFlagCommand} from '../web/core/native_anm_commands.mjs';
import {StoryPlayback} from '../web/core/story_playback.mjs';
import {ActionClock} from '../web/phaser/components/action_clock.mjs';
import {createMapController} from '../web/controllers/map.mjs';
import {createStoryController} from '../web/controllers/story.mjs';
import {createSessionController} from '../web/controllers/session.mjs';
import {SceneController} from '../web/core/scenes.mjs';
import {StoryMediaView} from '../web/story_media_view.mjs';
import {STORY_COMPLETION_STORAGE_KEY} from '../web/core/story_completion.mjs';

const web=new URL('../web/',import.meta.url),copy=structuredClone;
const read=async path=>JSON.parse(await readFile(new URL(path.replace(/^\//,''),web),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function elements(){
  const nodes=new Map();return id=>{
    if(!nodes.has(id))nodes.set(id,{hidden:true,style:{opacity:'0'},dataset:{},replaceChildren(){},focus(){}});
    return nodes.get(id);
  };
}
async function fakeImages(){
  const images=new Map();
  return async path=>{
    path='/'+path.replace(/^\//,'');if(images.has(path))return images.get(path);
    const file=await open(new URL(path.slice(1),web));
    try{
      const header=Buffer.alloc(24),{bytesRead}=await file.read(header,0,24,0);
      assert.equal(bytesRead,24,path);assert.equal(header.subarray(1,4).toString(),'PNG',path);
      const image={path,width:header.readUInt32BE(16),height:header.readUInt32BE(20)};
      assert.ok(image.width>0&&image.height>0,path);images.set(path,image);return image;
    }finally{await file.close();}
  };
}
async function fixture(flag23,{location={map_id:'M17032',x:640,y:480,direction:0}}={}){
  const [catalog,index,seed,opening,mapEffects]=await Promise.all(['data/catalog.json','data/story/index.json','data/opening_seed.json','data/opening_map_resources.json','data/map_effects.json'].map(read));
  const value=copy(seed);value.opening.status='complete';value.location=copy(location);
  const world=new WorldStore(value),clock=new ActionClock(),playback=new StoryPlayback({clock});clock.time=0;
  const events=[],cameras=[],dialogues=[],media=[],sounds=[],battles=[],visited=new Set(),installed=[],prepared=new Map(),image=await fakeImages(),$=elements();
  const state={catalog,world,openingResources:opening,events:[],actorResourcesByMap:new Map(),mapEffects,
    view:{zoom:1,frame:0},scenes:{current:null,phase:'event'},resources:{async attach(action,path,_scope,field='bitmap'){action[field]=await image(path);return action[field];}}};
  state.storyRepository=await StoryRepository.create({read,index,content:runtimeContent,definition:runtimeContentDefinition,currentMap:()=>state.scenes.current?.data.id});
  const lease=await state.storyRepository.ensureProgram('m17030-1',{callerMap:'M17032'}),program=lease.program;
  state.chapterStory=state.storyRepository.story;state.chapterResources=state.storyRepository.resources;state.events=state.storyRepository.events;
  state.openingResources.roles={...state.openingResources.roles,...state.chapterResources.roles};
  const mapController=createMapController({state,actions:{json:read,image},$,canvas:{focus(){}},ctx:{}});
  const chapter=new ChapterRunner({world,data:state.chapterStory,
    say:async payload=>dialogues.push({map:payload.mapId,id:payload.record.id,text:payload.record.text_raw}),
    choose:async payload=>{events.push({type:'choice-interface',map:payload.mapId,id:payload.record.id});return 0;},
    battle:async payload=>{
      assert.equal(payload.group.stage,'stage12.scn');assert.deepEqual(payload.group.members.map(member=>member.id),['032']);
      battles.push({group:copy(payload.group),location:copy(payload.draft.location),outcome:'escaped'});
      return {outcome:'escaped'};
    },log:event=>events.push(event)});
  // Development roster for presentation coverage, admitted from real CHR
  // definitions. No external mainline, growth or original-save claim is made.
  world.transact(draft=>{
    for(const slot of [2,4,1])chapter.joinActor({actorSlot:slot,modeRaw:0,draft});
    draft.flags[10]|=1<<4;draft.flags[12]|=1;draft.flags[23]=flag23;
  });
  const before=world.snapshot(),draft=copy(before);
  let view;
  const prepare=async mapId=>{
    const scene=await mapController.prepareMap(mapId,{world:draft});prepared.set(mapId,scene);return scene;
  };
  view=new OpeningView({resources:state.openingResources,prepared,prepare,program,nativeViewport:true,clock,initialActor:0,
    install:scene=>{state.scenes.current=scene;mapController.commitView(scene,draft.location);state.view.follow=false;installed.push(scene.data.id);},
    camera:(x,y)=>{assert.ok(Number.isFinite(x)&&Number.isFinite(y));cameras.push({x,y});Object.assign(state.view,{x,y});},
    shade:alpha=>{assert.ok(alpha>=0&&alpha<=1);},log:event=>events.push(event)});
  const presentationView=view,draws=[];
  const checkActors=()=>{
    const view=state.openingView??presentationView;
    if(!view.active)return;
    for(const [slot,actor]of view.actors)if(actor.visible){
      const action=actor.role.actions.find(action=>action.index===actor.action);
      assert.ok(action,`${view.mapId}: actor${slot} action${actor.action}`);
      assert.ok(actor.frame>=0&&actor.frame<action.frame_count,`${view.mapId}: actor${slot} frame${actor.frame}/${action.frame_count}`);
      assert.ok(actor.direction>=0&&actor.direction<action.directions,`${view.mapId}: actor${slot} direction${actor.direction}/${action.directions}`);
    }
    for(const row of view.drawQueue())row.draw({save(){},restore(){},drawImage(bitmap,...args){assert.ok(bitmap?.path);assert.ok(args.every(Number.isFinite));draws.push(bitmap.path);}});
  };
  const hooks=Object.fromEntries(Object.entries(view.hooks()).map(([name,hook])=>[name,async payload=>{
    visited.add(payload.command.index);events.push({type:'actual-view-hook',name,command:payload.command.index,operation:payload.kind,actor:payload.actor,map:payload.mapId});
    await hook(payload);checkActors();
  }]));
  hooks.media=async payload=>{visited.add(payload.command.index);media.push([payload.command.index,payload.filename]);};
  hooks.sound=async payload=>{visited.add(payload.command.index);sounds.push([payload.command.index,payload.kind,payload.filename??null]);};
  const anm=new ChapterAnimationRunner({program,hooks,playback,initialLocation:copy(draft.location),initialActor:0,
    runTlk:async args=>{
      const hero=view.getActor(view.controlledActor);draft.location={map_id:args.mapId,x:hero.x,y:hero.y,direction:hero.direction};
      return chapter.runTlk({...args,draft,context:{steps:0,playback}});
    },
    joinActor:async payload=>{visited.add(payload.command.index);return chapter.joinActor({...payload,draft});},
    leaveActor:async payload=>{visited.add(payload.command.index);return chapter.leaveActor({...payload,draft});},
    flagCommand:({command,mapId})=>{visited.add(command.index);return applyNativeAnmFlagCommand(draft,command,state.chapterStory.maps[mapId].map_flag_index);}});
  return {state,world,before,draft,clock,playback,view,anm,program,visited,media,sounds,dialogues,battles,events,cameras,draws,installed,mapController,chapter,$,image,checkActors,
    close(){view.dispose();playback.dispose();clock.destroy();lease.release();}};
}
async function accelerate(f,promise){
  let done=false,result,error;promise.then(value=>{result=value;done=true;},reason=>{error=reason;done=true;});
  for(let turns=0;!done;turns++){
    assert.ok(turns<50000,'bounded finale source clock');
    await Promise.resolve();
    if(f.clock.tasks.size){f.clock.advance(160);f.checkActors();}
    else await new Promise(resolve=>setImmediate(resolve));
  }
  if(error)throw error;return result;
}

test('all186 finale records reach actual OpeningView methods across both source flag23 branches, including actor58 and final handoff',async()=>{
  const previousDocument=globalThis.document;globalThis.document={createElement:()=>({})};
  try{
    for(const flag23 of [0,1]){
      const f=await fixture(flag23);
      try{
        const bytes=await readFile(new URL('../../../Animate/m17030-1.anm',import.meta.url));
        assert.equal(hash(bytes),f.program.source.sha256);assert.equal(f.program.commands.length,186);
        for(const command of f.program.commands)assert.equal(bytes.subarray(67+command.index*74,67+(command.index+1)*74).toString('hex'),command.raw_hex);
        const result=await accelerate(f,f.anm.run());assert.equal(f.anm.phase,'complete');assert.equal(result.commands,186);
        const skipped=flag23?[8,9,10,...Array.from({length:10},(_,i)=>i+36)]:[];
        assert.deepEqual([...f.visited].sort((a,b)=>a-b),Array.from({length:186},(_,i)=>i).filter(i=>!skipped.includes(i)));
        assert.equal(result.steps,186-skipped.length);
        assert.deepEqual(f.installed,['M17032','M17030-2','M17023']);assert.equal(f.state.scenes.current.data.id,'M17023');
        assert.equal(result.controlled_actor,0);assert.equal(result.location.map_id,'M17023');
        const hero=f.view.getActor(0),location={...result.location,direction:hero.direction};
        f.mapController.validateEntry(f.state.scenes.current,location);assert.equal(hero.x,location.x);assert.equal(hero.y,location.y);
        const adopted=f.state.scenes.current.npcRuntime;adopted.adoptActors(f.view.actors);
        const altar=f.view.prepared.get('M17030-2'),actor58=[...altar.npcRuntime.actors.values()].find(actor=>actor.npc.slot_zero_based===58);
        assert.equal(actor58.npc.resource_id,'012');assert.equal(actor58.source.bindings_initialized,true);
        assert.ok(actor58.source.bindings_raw.every(index=>index===-1),'the original DAT template remains uninitialized');
        assert.deepEqual(actor58.source.bindings.slice(0,2),[0,1],'469F50 supplies actual ROLE012 idle/walk channels');
        assert.ok(f.events.some(event=>event.type==='opening-move-complete'&&event.command===73&&event.actor===58));
        assert.ok(f.events.some(event=>event.type==='opening-move-complete'&&event.command===78&&event.actor===58));
        assert.deepEqual(f.media,[[96,'20.bik'],[107,'24.bik'],[182,'25.bik']]);assert.equal(f.battles.length,1);assert.equal(f.battles[0].outcome,'escaped');
        assert.ok(f.dialogues.length>20);assert.deepEqual(f.dialogues.at(-1),{map:'M17023',id:30,text:f.state.chapterStory.maps.M17023.records.find(record=>record.id===30).text_raw});
        assert.ok(f.events.some(event=>event.type==='chapter-record'&&event.mapId==='M17023'&&event.recordId===47),'the empty final TLK still executes its completion mutation');
        assert.ok(f.events.some(event=>event.type==='opening-animation-complete'));assert.ok(f.cameras.length>20);assert.ok(f.draws.length>100);
        assert.equal(f.draft.flags[23]&1,flag23);assert.equal(f.draft.flags[1999]&1,1);
        assert.deepEqual(f.world.snapshot(),f.before,'the complete presentation operates on the caller draft');
        assert.equal(f.clock.tasks.size,0);
      }finally{f.close();}
    }
  }finally{globalThis.document=previousDocument;}
});

// Official root story transaction, actual browser entrance and actual full ANM.
// Media remains an explicit recorded interface, and stage12 still returns
// escaped; this asserts commit/title wiring, not movie or battle playback.
test('the official finale controller commits from the real entrance directly to the title without inventing a final exploration pose',async()=>{
  const previousDocument=globalThis.document,previousHooks=StoryMediaView.prototype.hooks;
  globalThis.document={createElement:()=>({})};
  let current;
  StoryMediaView.prototype.hooks=function(){return {
    media:async payload=>{current.media.push([payload.command.index,payload.filename]);current.events.push({type:'media-interface',index:payload.command.index});},
    sound:async payload=>current.sounds.push([payload.command.index,payload.kind,payload.filename??null])
  };};
  try{
    for(const flag23 of [0,1]){
      const entry={map_id:'M17032',x:1632.602580645161,y:248,direction:0},f=current=await fixture(flag23,{location:entry});
      try{
        // The actual descriptor2 follows r1 -> r7 -> r8 with10:2 and12:1.
        f.world.transact(draft=>{draft.flags[10]|=2;});
        const before=f.world.snapshot(),writes=[],commits=[],entries=[],titles=[],terminalActors=[];
        const state=f.state;state.keys=new Set();state.engine={exploration:{clock:f.clock}};
        state.audio={suspend(){},setScene(){},setStoryMusicSuppressed(){}};
        state.startupView={showMenu(options){titles.push({options,world:f.world.snapshot(),tasks:f.clock.tasks.size});}};
        const actions={json:read,image:f.image,status(message,error){f.events.push({type:'status',message,error});},
          buildHud(){assert.fail('the terminal story must not rebuild exploration HUD');},updateNearest(){assert.fail('the terminal story must not resume interaction');},
          prepareMap:(id,options)=>f.mapController.prepareMap(id,options),
          validateEntry(scene,location){entries.push(copy(location));f.mapController.validateEntry(scene,location);},
          commitView(scene,location){commits.push({map:scene.data.id,location:copy(location),afterVideo25:f.media.some(([index])=>index===182)});f.mapController.commitView(scene,location);},
          log(event){f.events.push(event);if(event.type==='chapter-animation-complete'){
            const hero=state.openingView.getActor(0);terminalActors.push({x:hero.x,y:hero.y,visible:hero.visible,map:state.openingView.mapId});
          }}};
        state.scenes=new SceneController({world:f.world,prepare:actions.prepareMap,validateEntry:actions.validateEntry,commitView:actions.commitView,
          captureView:()=>copy(state.view),rollbackView:snapshot=>Object.assign(state.view,snapshot),afterCommit:()=>actions.finishStoryCompletion()});
        state.scenes.current=await actions.prepareMap('M17032',{world:before});state.scenes.setPhase('map');
        actions.validateEntry(state.scenes.current,entry);
        const controller=createStoryController({state,actions,$:f.$,canvas:{focus(){}}});
        Object.assign(actions,createSessionController({state,actions,$:f.$,canvas:{focus(){}},completionStorage:{getItem(){return null;},setItem(key,value){writes.push([key,value]);}}}));
        state.chapterRunner=f.chapter;f.chapter.animate=controller.animateChapter;f.chapter.setPhase=phase=>state.scenes.setPhase(phase);
        await accelerate(f,controller.runChapter({mapId:'M17032',recordId:1,triggerId:2}));
        assert.equal(f.world.value.revision,before.revision+1);assert.equal(f.world.value.flags[1999]&1,1);
        assert.equal(state.scenes.current.data.id,'M17023');assert.equal(state.scenes.phase,'menu');
        assert.deepEqual(terminalActors,[{x:entry.x,y:entry.y,visible:false,map:'M17023'}],'opcode35 hide never relocates the controlled actor');
        assert.deepEqual(f.world.location,{...entry,map_id:'M17023'},'terminal bookkeeping is not a new playable landing');
        assert.throws(()=>f.mapController.validateEntry(state.scenes.current,f.world.location),/目标位置不在可通行格/,'the regression must keep the real nonwalkable terminal pose');
        assert.deepEqual(entries,[entry],'only the genuine initial exploration entrance is validated');
        assert.deepEqual(commits.map(row=>row.map),['M17032','M17030-2','M17023']);assert.ok(commits.every(row=>!row.afterVideo25),'there is no exploration view commit after the final movie');
        assert.deepEqual(f.media,[[96,'20.bik'],[107,'24.bik'],[182,'25.bik']]);assert.equal(f.battles.length,1);
        assert.equal(titles.length,1);assert.deepEqual(titles[0].options,{allowResume:false});assert.equal(titles[0].world.revision,before.revision+1);assert.equal(titles[0].world.flags[1999]&1,1);assert.equal(titles[0].tasks,0);
        assert.equal(writes.length,1);assert.equal(writes[0][0],STORY_COMPLETION_STORAGE_KEY);
        assert.equal(state.pendingStoryCompletion,null);assert.equal(state.openingView,null);assert.equal(state.storyPlayback,null);
        assert.ok(!f.events.some(event=>event.type==='chapter-failed'));assert.ok(f.events.findIndex(event=>event.type==='chapter-commit')<f.events.findIndex(event=>event.type==='story-complete'));
        const complete=f.events.find(event=>event.type==='chapter-animation-complete');assert.equal(complete.commands,186);assert.equal(complete.steps,flag23?173:186);
      }finally{f.close();}
    }
  }finally{StoryMediaView.prototype.hooks=previousHooks;globalThis.document=previousDocument;}
});
