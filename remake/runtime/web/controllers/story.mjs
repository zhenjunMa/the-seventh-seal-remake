// story adapters. Persistent state belongs to the shared runtime context.
import {OpeningView} from "../opening_view.mjs";
import {ChapterAnimationRunner} from "../core/chapter_animation.mjs";
import {StoryPlayback,storyCancelled,playbackTask,playbackFrame} from '../core/story_playback.mjs';
import {runtimeContent,storyBindings} from "../core/content_registry.mjs";

export function createStoryController({state, actions, $, canvas, ctx}) {
  let session=null,sequence=0;
  const heldDialogueKeys=new Set();
  const cancelled=storyCancelled;
  const inputSuspended=()=>Boolean(state.engine?.paused||state.storyPlayback?.paused||state.storyPlayback?.signal.aborted);
  async function playStory(work){
    if(state.storyPlayback)throw new Error('当前剧情尚未结束');
    const playback=new StoryPlayback({clock:state.engine?.exploration.clock});state.storyPlayback=playback;
    actions.log?.({type:'story-playback-start'});
    try{
      const result=await work(playback);playback.complete();return result;
    }catch(error){playback.fail(error);throw error;}
    finally{
      try{clearDialogue();state.openingView?.dispose();state.openingView=null;state.objectPreview=null;releaseDialogueKeys();state.keys?.clear();}
      finally{
        state.storyPlayback=null;playback.dispose();
        actions.log?.({type:'story-playback-end',status:playback.phase});
      }
    }
  }
  async function cancelStoryPlayback(reason=cancelled()){
    const playback=state.storyPlayback;if(!playback)return;
    playback.cancel(reason);await playback.finished;
  }
  function closeSession(current){
    if(session!==current)return false;
    current?.detach?.();session=null;state.dialogueResolve=null;state.choicePending=false;
    state.captionView?.close();state.dialogueView?.close();$('dialogue').hidden=true;
    return true;
  }
  function clearDialogue(reason=cancelled()){
    const current=session;
    if(closeSession(current))current?.reject(reason);
  }
  function present({speaker,text,style=0,choices=null,signal,record=null,mapId=null}){
    clearDialogue();
    const signals=[signal,state.storyPlayback?.signal].filter(Boolean);
    const aborted=signals.find(signal=>signal.aborted);
    if(aborted)return Promise.reject(aborted.reason??cancelled());
    state.keys?.clear();
    return new Promise((resolve,reject)=>{
      const current={id:++sequence,resolve,reject,choices,detach:()=>{}};session=current;
      const abort=()=>{if(closeSession(current))reject(signals.find(signal=>signal.aborted)?.reason??cancelled());};
      for(const signal of signals)signal.addEventListener('abort',abort,{once:true});
      current.detach=()=>{for(const signal of signals)signal.removeEventListener('abort',abort);};
      state.choicePending=Boolean(choices);
      state.dialogueResolve=choices?null:()=>{if(!inputSuspended()&&closeSession(current))resolve();};
      try{
        if(style===3&&!choices)state.captionView.show(text);
        else state.dialogueView.show({speaker,text,style,choices,record,sessionId:current.id,
          getAnchor:()=>dialogueAnchor(mapId,record)});
      }catch(error){if(closeSession(current))reject(error);}
    });
  }
  function say(speaker,text,style=0,options={}){
    const source=options.source,record=options.record??state.dialogueManifest?.record_overrides?.[`${source?.path}#${source?.record_id}`];
    return present({...options,record,mapId:options.mapId??state.world?.location.map_id,speaker,text,style:record?.style??style});
  }
  function chooseChapter({mapId,record,choices,signal}){
    return present({speaker:chapterSpeaker(mapId,record),text:record.text_raw,style:record.style,choices,signal,record,mapId});
  }
  function chooseDialogue(index,sessionId){
    const current=session;
    if(inputSuspended()||!current?.choices||current.id!==sessionId||!current.choices.some(choice=>choice.index===index))return;
    if(closeSession(current))current.resolve(index);
  }
  function advanceDialogue(){
    const current=session;if(!current||inputSuspended())return;
    if(state.captionView?.active&&!state.captionView.advance())return;
    if(state.dialogueView?.active&&!state.dialogueView.advance())return;
    if(session===current&&!current.choices)state.dialogueResolve?.();
  }
  function dialogueKey(key,repeat=false){
    if(!session)return false;
    if(inputSuspended())return true;
    if([' ','Enter'].includes(key)){
      if(!repeat&&!heldDialogueKeys.has(key)){heldDialogueKeys.add(key);advanceDialogue();}
      return true;
    }
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Escape','Tab','e'].includes(key)){
      state.dialogueView?.key(key,repeat);return true;
    }
    return false;
  }
  function dialogueKeyUp(key){const had=heldDialogueKeys.delete(key);return had;}
  function releaseDialogueKeys(){heldDialogueKeys.clear();}
  function dialogueAnchor(mapId,record){
    if(!record)return {x:320,y:240};
    let actor;
    if(state.openingView?.active){
      actor=state.openingView.actors.get(record.speaker-1);
    }
    if(!actor){
      if(record.speaker===1)actor=state.sceneEntryDraft?.location??state.world.location;
      else actor=state.scenes.current?.npcs.find(npc=>npc.speaker_slot_one_based===record.speaker);
    }
    if(!actor)return {x:320,y:240};
    const native=state.openingView?.active&&state.openingView.nativeViewport;
    const zoom=native?1:state.view.zoom;
    // The native path uses actor+A4/A8 and a role-table height. The browser
    // uses its displayed sprite head; map coordinates/camera are adapted.
    const headOffset=actor.role?.anchor.y??actor.resource?.anchor_y??0;
    return {x:320+(actor.x+16-state.view.x)*zoom,y:240+(actor.y-headOffset-state.view.y)*zoom};
  }
  async function interact(){
    if(state.scenes.phase!=='map'||!state.nearest)return;
    if(state.nearest.kind==='rest'){await runChapter({rest:true,descriptorId:state.nearest.descriptorId});return;}
    if(state.nearest.kind==='object'){await runChapter({mapId:state.world.location.map_id,objectIndex:state.nearest.index});return;}
    const target=state.scenes.current.npcs.find(npc=>npc.id===state.nearest.id);
    const release=target?state.scenes.current.npcRuntime?.hold(target.id):null;
    try{
      if(!state.nearest.event){
        const table=state.chapterStory.maps[state.world.location.map_id],slot=state.nearest.slot_zero_based;
        const entry=table?.index_nonzero.find(row=>row.slot===slot);
        if(entry){await runChapter({mapId:state.world.location.map_id,recordId:entry.record,context:{steps:0,explicitInteraction:true}});return;}
        actions.status('这里暂时没有可执行的对白。');return;
      }
      await runChapter({event:state.nearest.event});
    }finally{release?.();}
  }
  function chapterSpeaker(mapId,record){
    if(typeof record.speaker_name==='string')return record.speaker_name;
    const id=Object.keys(runtimeContent.roles).find(id=>runtimeContent.roles[id].side==='player'&&runtimeContent.roles[id].native_slot===record.speaker-1);
    const definition=state.chapterStory?.role_definitions?.[id]??state.world?.value?.source?.role_definitions?.[id];
    if(definition)return definition.name;
    return (state.chapterResources?.npcs_by_map?.[mapId]??[]).find(npc=>npc.speaker_slot_one_based===record.speaker)?.name??'';
  }
  async function animateChapter({program,mapId,draft,runTlk,joinActor,playback,signal}){
    const scene=await playbackTask(actions.prepareMap(mapId,{world:draft}),signal);
    if(playback?.paused)await playback.ready();playback?.check();
    if(state.scenes.current?.data.id===mapId)scene.npcRuntime?.inherit(state.scenes.current.npcRuntime);
    const prepared=new Map([[mapId,scene]]);
    state.openingView=new OpeningView({resources:state.openingResources,prepared,nativeViewport:true,clock:state.engine?.exploration.clock,
      install:scene=>{state.scenes.current=scene;actions.commitView(scene,draft.location);state.view.follow=false;},
      camera:(x,y)=>{state.view.x=x;state.view.y=y;},say,log: actions.log,shade:()=>{}});
    const animation=new ChapterAnimationRunner({program,hooks:state.openingView.hooks(),runTlk,joinActor,initialLocation:draft.location,playback});
    const result=await animation.run();playback?.check();const hero=state.openingView.getActor(0);
    draft.location={...result.location,direction:hero.direction};
    actions.validateEntry(state.scenes.current,draft.location);
    state.scenes.current.npcRuntime?.adoptActors(state.openingView.actors);state.openingView.dispose();
    actions.log({type:'chapter-animation-complete',program:program.id,...result,
      limitations:['Browser paths/timing/blending are previews; original execution not observed.']});
  }
  async function runChapter(args){
    if(state.scenes.phase!=='map')return;
    const previous={scene:state.scenes.current,view:state.scenes.captureView()};
    try{
      const result=await playStory(async playback=>{
        try{
          const result=args.event?await state.chapterRunner.runEvent(args.event,{playback}):args.rest?await state.chapterRunner.runRest({explicitInteraction:true,descriptorId:args.descriptorId??null,playback}):args.objectIndex===undefined?await state.chapterRunner.runTlk({...args,playback}):await state.chapterRunner.runObject({...args,playback});
          actions.commitView(state.scenes.current,state.world.location);actions.buildHud();actions.updateNearest();return result;
        }catch(error){state.scenes.current=previous.scene;state.scenes.rollbackView(previous.view);throw error;}
      });
      actions.status(result.already_done?'箱子里的装备已经领取。':'可以继续探索。');
      if(result.save_requested)await actions.openSaveCrystal();
    }catch(error){actions.status(error.message,true);}
    finally{canvas.focus({preventScroll:true});}
  }
  async function enterMap(scene,draft,reason){
    const recordId=storyBindings(scene.data.id).entry_record;
    if(!recordId||!['exit','world-map'].includes(reason))return false;
    state.sceneEntryDraft=draft;
    state.scenes.setPhase('event');$('worldMapPanel').hidden=true;
    try{return await playStory(async playback=>{
      await state.chapterRunner.runTlk({mapId:scene.data.id,recordId,draft,playback});
      if(playback.paused)await playback.ready();playback.check();
      actions.validateEntry(state.scenes.current,draft.location);
      actions.log({type:'map-entry-story',map_id:scene.data.id,record_id:recordId});return true;
    });}finally{state.sceneEntryDraft=null;}
  }
  async function animateChapterObject({mapId,objectIndex,signal,playback}){
    const resource=state.chapterResources.object_animations[mapId]?.find(row=>row.object_index_zero_based===objectIndex);
    if(!resource)throw new Error('物件动作资源尚未准备');
    const frames=await playbackTask(Promise.all(resource.frames.map(frame=>actions.image(frame.image, `map:${mapId}`))),signal);
    if(playback?.paused)await playback.ready();signal?.throwIfAborted();playback?.check();
    state.objectPreview={mapId,objectIndex,bitmap:frames[0]};
    const start=performance.now(),interval=resource.actions[0].interval_raw;
    if(state.engine){
      try{await state.engine.exploration.clock.tween(interval*frames.length,t=>{
        state.objectPreview.bitmap=frames[Math.min(frames.length-1,Math.floor(t*frames.length))];
      },[signal]);}finally{state.objectPreview=null;}
      return;
    }
    try{
      let now=start;
      do{now=await playbackFrame(null,signal);
        const frame=Math.min(frames.length-1,Math.floor(Math.max(0,now-start)/interval));state.objectPreview.bitmap=frames[frame];
      }while(now-start<interval*frames.length);
    }finally{state.objectPreview=null;}
  }
  return {playStory,cancelStoryPlayback,say, clearDialogue, chooseChapter, chooseDialogue, advanceDialogue, dialogueKey, dialogueKeyUp, releaseDialogueKeys, interact, chapterSpeaker, animateChapter, runChapter, enterMap, animateChapterObject};
}
