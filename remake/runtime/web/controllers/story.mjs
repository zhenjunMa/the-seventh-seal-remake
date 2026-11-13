// story adapters. Persistent state belongs to the shared runtime context.
import {OpeningView} from "../opening_view.mjs";
import {ChapterAnimationRunner} from "../core/story/chapter_animation.mjs";
import {StoryMediaView} from '../story_media_view.mjs';
import {StoryPlayback,storyCancelled,playbackTask,playbackFrame} from '../core/story/story_playback.mjs';
import {runtimeContent,storyBindings} from "../core/content/content_registry.mjs";
import {worldMapEntry} from '../core/exploration/map_connections.mjs';
import {hasNativeStoryCompletion} from '../core/story/story_completion.mjs';
import {nativeChestAnimation} from '../core/exploration/native_map_chests.mjs';
import {captureMapNpcState} from '../core/exploration/map_npc_state.mjs';
import {mapInteractionDirection} from '../core/exploration/map_interaction.mjs';
import {loadEncounterMap} from '../core/exploration/encounters.mjs';
import {initializeMapSequence} from '../core/exploration/map_stage.mjs';

import {createStoryPresentation} from './presentation_handoff.mjs';

export function createStoryController({state, actions, $, canvas, ctx}) {
  const presentation=createStoryPresentation({state,actions,$,canvas});
  let session=null,sequence=0;
  const heldDialogueKeys=new Set();
  const cancelled=storyCancelled;
  const inputSuspended=()=>Boolean(state.engine?.paused||state.storyPlayback?.paused||state.storyPlayback?.signal.aborted);
  async function playStory(work){
    if(state.storyPlayback)throw new Error('当前剧情尚未结束');
    const before={world:state.world,value:state.world?.value,revision:state.world?.value?.revision,
      hasPriority:Object.hasOwn(state,'sidePriority'),sidePriority:state.sidePriority,
      visualState:state.anmVisualState,visualSnapshot:state.anmVisualState?structuredClone(state.anmVisualState):null};
    const playback=new StoryPlayback({clock:state.engine?.exploration.clock});state.storyPlayback=playback;
    actions.log?.({type:'story-playback-start'});
    try{
      const result=await work(playback);playback.complete();
      if(playback.nativeCompletion&&state.storyPlayback===playback){
        const {draft,...request}=playback.nativeCompletion,expected=structuredClone(draft);
        expected.revision=(before.revision+1)>>>0;
        state.pendingStoryCompletion={world:before.world,sceneRequest:state.scenes?.request,expected,request};
        if(actions.finishStoryCompletion?.()&&result&&typeof result==='object')result.story_completed=true;
      }
      return result;
    }catch(error){
      playback.fail(error);
      // A complete event shares one transaction. Successful inner battles and
      // ANMs must not leave transient scheduling/camera globals behind when a
      // later command fails. A replaced world or owner belongs to a new run.
      if(state.storyPlayback===playback&&state.world===before.world&&state.world?.value===before.value
        &&state.world?.value?.revision===before.revision){
        if(before.hasPriority)state.sidePriority=before.sidePriority;else delete state.sidePriority;
        if(before.visualState&&state.anmVisualState===before.visualState){
          for(const key of Object.keys(before.visualState))delete before.visualState[key];
          Object.assign(before.visualState,before.visualSnapshot);
        }
      }
      throw error;
    }
    finally{
      const ownsState=state.storyPlayback===playback;
      try{if(ownsState){clearDialogue();state.openingView?.dispose();state.openingView=null;state.objectPreview=null;releaseDialogueKeys();presentation.clearInput();}}
      finally{
        if(ownsState)state.storyPlayback=null;playback.dispose();
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
    presentation.clearInput();
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
    const selected=state.nearest;
    if(state.scenes.phase!=='map'||!selected)return;
    const mapId=state.world.location.map_id;
    if(selected.kind==='rest'){await runChapter({rest:true,descriptorId:selected.descriptorId});return;}
    if(selected.kind==='object'){await runChapter({mapId,objectIndex:selected.index});return;}
    const target=state.scenes.current.npcs.find(npc=>npc.id===selected.id);
    if(!target)return;
    const release=state.scenes.current.npcRuntime?.hold(target.id);
    try{
      if(!selected.event){
        const slot=selected.slot_zero_based;
        const entry=state.chapterStory.maps[mapId]?.index_nonzero.find(row=>row.slot===slot);
        if(entry){await runChapter({mapId,recordId:entry.record,context:{steps:0,explicitInteraction:true,npcMapId:mapId,npcSlot:slot}},selected);return;}
        actions.status('这里暂时没有可执行的对白。');return;
      }
      await runChapter({event:selected.event},selected);
    }finally{release?.();}
  }
  function chapterSpeaker(mapId,record){
    if(typeof record.speaker_name==='string')return record.speaker_name;
    const id=Object.keys(runtimeContent.roles).find(id=>runtimeContent.roles[id].side==='player'&&runtimeContent.roles[id].native_slot===record.speaker-1);
    const definition=state.chapterStory?.role_definitions?.[id]??state.world?.value?.source?.role_definitions?.[id];
    if(definition)return definition.name;
    return (state.chapterResources?.npcs_by_map?.[mapId]??[]).find(npc=>npc.speaker_slot_one_based===record.speaker)?.name??'';
  }
  async function animateChapter({program,mapId,draft,runTlk,joinActor,leaveActor,flagCommand,objectCommand,playback,signal}){
    signal??=playback?.signal;
    const previous={scene:state.scenes.current,view:state.scenes.captureView?.(),shadeHidden:$('openingShade').hidden,shadeOpacity:$('openingShade').style.opacity,
      hasNpcState:Object.hasOwn(draft,'map_npc_state'),npcState:draft.map_npc_state,entryDraft:state.sceneEntryDraft},prepared=new Map();
    let lease,view,media;
    const prepare=async(id,requestSignal)=>{
      const scene=await playbackTask(actions.prepareMap(id,{world:draft,program}),requestSignal);
      if(playback?.paused)await playback.ready();requestSignal?.throwIfAborted();playback?.check();
      if(state.scenes.current?.data.id===id)scene.npcRuntime?.inherit(state.scenes.current.npcRuntime);
      return scene;
    };
    try{
      state.sceneEntryDraft=draft;
      lease=await state.storyRepository?.ensureProgram(program.id,{callerMap:mapId,signal});
      if(lease)program=lease.program;
      prepared.set(mapId,await prepare(mapId,signal));
      const content=state.storyRepository?.content??runtimeContent;
      const initialActor=content.roles[draft.leader_id]?.native_slot;
      if(!Number.isInteger(initialActor))throw new Error('剧情控制角色来源缺失');
      view=new OpeningView({resources:state.openingResources,prepared,prepare,nativeViewport:true,clock:state.engine?.exploration.clock,
        content,initialActor,
        install:scene=>{state.scenes.current=scene;actions.commitView(scene,draft.location);state.view.follow=false;},
        camera:(x,y)=>{state.view.x=x;state.view.y=y;},say,log:actions.log,
        shade:alpha=>{$('openingShade').hidden=false;$('openingShade').style.opacity=String(alpha);}});
      state.openingView=view;
      const captureActors=()=>captureMapNpcState(draft,view.mapId,[...view.actors].filter(([slot])=>slot>=10)
        .map(([slot,actor])=>({...actor,slot_zero_based:slot,hidden:!actor.visible})));
      if(program.commands.some(command=>[60,62,63].includes(command.opcode))){
        const manifest=await playbackTask(actions.json('data/story_media.json'),signal);
        if(playback?.paused)await playback.ready();signal?.throwIfAborted();playback?.check();
        media=new StoryMediaView({manifest,root:$('screen'),audio:state.audio,playback});
      }
      const nestedTlk=async args=>{
        // A battle or nested event sees the actual current map/controlled pose,
        // while the outer world remains uncommitted until the ANM completes.
        const hero=view.getActor(view.controlledActor);
        draft.location={map_id:args.mapId,x:hero.x,y:hero.y,direction:hero.direction};
        captureActors();
        return runTlk(args);
      };
      const hooks=view.hooks();
      hooks.object=({mapId,objectIndex,state:objectState,signal})=>{
        if(state.scenes.current?.data.id!==mapId||!state.scenes.current.objectRuntime)throw new Error('剧情物件显示来源缺失');
        return state.scenes.current.objectRuntime.animate({objectIndex,state:objectState,signal});
      };
      for(const name of ['map','actor','move']){const invoke=hooks[name];hooks[name]=async payload=>{
        const result=await invoke(payload);if(name==='map'){
          loadEncounterMap(draft,payload.mapId,state.encounterData);
          if(!payload.bootstrap)await initializeMapSequence({mapId:payload.mapId,world:draft,story:state.chapterStory,content});
        }captureActors();
        return result;
      };}
      const animation=new ChapterAnimationRunner({program,hooks:{...hooks,...media?.hooks()},runTlk:nestedTlk,joinActor,leaveActor,flagCommand,objectCommand,initialActor,initialLocation:draft.location,playback,
        visualState:state.anmVisualState,
        content});
      const result=await animation.run();signal?.throwIfAborted();playback?.check();const hero=view.getActor(result.controlled_actor);
      const location={...result.location,direction:hero.direction};
      if(state.scenes.current?.data.id!==location.map_id)throw new Error('剧情结束地图与当前场景不同');
      const terminal=hasNativeStoryCompletion(draft);
      if(terminal){
        if(!playback||typeof actions.finishStoryCompletion!=='function')throw new Error('终章提交后的标题菜单接口缺失');
        // 477330 checks the ending flag after ANM cleanup and enters the title.
        // A hidden controlled actor need not have an exploration landing on the
        // last cinematic map. Keep its source pose; never invent a teleport.
        playback.nativeCompletion={draft,program_id:program.id,source:program.source};
      }else actions.validateEntry(state.scenes.current,location);
      draft.location=location;
      if(!terminal)state.scenes.current.npcRuntime?.adoptActors(view.actors);
      captureActors();
      actions.log({type:'chapter-animation-complete',program:program.id,...result,
        limitations:['Browser paths/timing/blending are previews; original execution not observed.']});
    }catch(error){
      state.scenes.current=previous.scene;
      if(previous.view!==undefined)state.scenes.rollbackView?.(previous.view);
      if(previous.hasNpcState)draft.map_npc_state=previous.npcState;else delete draft.map_npc_state;
      throw error;
    }finally{state.sceneEntryDraft=previous.entryDraft;media?.dispose();view?.dispose();lease?.release();$('openingShade').hidden=previous.shadeHidden;$('openingShade').style.opacity=previous.shadeOpacity;}
  }
  async function runChapter(args,npc=null){
    if(state.scenes.phase!=='map')return;
    const previous={scene:state.scenes.current,view:state.scenes.captureView()};
    const at=state.world.location;
    const direction=mapInteractionDirection(at,npc);
    const turn=direction!==at.direction?{scene:previous.scene,direction}:null;
    try{
      if(args.objectIndex!==undefined)state.scenes.setPhase('event');
      const result=await playStory(async playback=>{
        try{
          if(turn){
            state.scenes.setPhase('event');
            state.npcConversationFacing=turn;
            if(playback.clock)await playbackFrame(playback.clock,playback.signal);
          }
          const result=args.event?await state.chapterRunner.runEvent(args.event,{playback}):args.rest?await state.chapterRunner.runRest({explicitInteraction:true,descriptorId:args.descriptorId??null,playback}):args.triggerId!==undefined&&args.recordId===undefined?await state.chapterRunner.runTrigger({...args,playback}):args.objectIndex===undefined?await state.chapterRunner.runTlk({...args,playback}):await state.chapterRunner.runObject({...args,playback});
          if(!playback.nativeCompletion){actions.commitView(state.scenes.current,state.world.location);actions.buildHud();actions.updateNearest();}
          return result;
        }catch(error){state.scenes.current=previous.scene;state.scenes.rollbackView(previous.view);throw error;}
      });
      if(result.story_completed)return result;
      if(result.rewards?.length)state.rewardNoticeView.show(result.rewards.map(reward=>state.itemData.definitions[reward.id].name));
      const requiredItem=state.itemData?.definitions?.[result.key_id]?.name;
      actions.status(result.locked?(result.mechanism&&requiredItem?`需要${requiredItem}。`:'需要对应元素钥匙。'):
        result.already_done?(result.mechanism||[7,9].includes(state.chapterStory.maps[args.mapId]?.objects.find(row=>row.index===args.objectIndex)?.behavior_raw_cf)
          ?'机关已启动。':'宝箱已打开。'):'可以继续探索。');
      if(result.save_requested)await actions.openSaveCrystal();
      if(result.world_map_requested)state.worldMap.open(result.world_map_requested.area);
    }catch(error){if(error.gameOverPolicy)await actions.presentGameOver(error.gameOverPolicy);else actions.status(error.message,true);}
    finally{
      if(turn&&state.npcConversationFacing===turn)state.npcConversationFacing=null;
      if((turn||args.objectIndex!==undefined)&&state.scenes.phase==='event')state.scenes.setPhase('map');
      canvas.focus({preventScroll:true});
    }
  }
  async function transferChapter({mapId,destination,draft,playback,signal=playback?.signal}){
    const previous={scene:state.scenes.current,view:state.scenes.captureView?.(),entryDraft:state.sceneEntryDraft};
    const revision=state.world.value.revision,releases=[];let installed=false,released=false;
    const check=()=>{signal?.throwIfAborted();playback?.check();if(state.world.value.revision!==revision)throw new Error('地图跳转期间世界状态已变化');};
    const release=({failed=false}={})=>{
      if(released)return;released=true;
      if(failed&&installed){state.scenes.current=previous.scene;if(previous.view!==undefined)state.scenes.rollbackView?.(previous.view);}
      state.sceneEntryDraft=previous.entryDraft;
      for(const detach of releases.reverse())detach();state.storyRepository?.trim();
    };
    try{
      const repository=state.storyRepository;
      if(!repository)throw new Error('地图跳转剧情资料库未准备');
      releases.push(repository.retainMap(mapId),repository.retainMap(destination.map_id));
      await playbackTask(repository.ensureMap(destination.map_id,{protect:[mapId,destination.map_id]}),signal);check();
      const targetWorld=structuredClone(draft);delete targetWorld.map_npc_state;
      const scene=await playbackTask(actions.prepareMap(destination.map_id,{world:targetWorld}),signal);
      if(playback?.paused)await playback.ready();check();
      const location=worldMapEntry(scene,destination,state.chapterStory);actions.validateEntry(scene,location);check();
      await actions.prepareMapView?.(scene,{...targetWorld,location},{signal});check();
      loadEncounterMap(draft,destination.map_id,state.encounterData);
      await initializeMapSequence({mapId:destination.map_id,world:draft,story:state.chapterStory,content:repository.content??runtimeContent});
      state.sceneEntryDraft=draft;installed=true;state.scenes.current=scene;
      delete draft.map_npc_state;
      const committed=actions.commitView(scene,location,'exit');
      if(committed&&typeof committed.then==='function')throw new Error('地图跳转视图提交必须同步');
      check();actions.log?.({type:'chapter-map-transfer',from:mapId,to:destination.map_id,source:destination.source});
      return {location,release};
    }catch(error){release({failed:true});throw error;}
  }
  async function enterMap(scene,draft,reason){
    loadEncounterMap(draft,scene.data.id,state.encounterData);
    await initializeMapSequence({mapId:scene.data.id,world:draft,story:state.chapterStory,content:state.storyRepository?.content??runtimeContent,restore:reason==='restore'||reason==='boot'});
    const recordId=storyBindings(scene.data.id).entry_record;
    if(!recordId||!['exit','world-map'].includes(reason))return false;
    state.sceneEntryDraft=draft;
    state.scenes.setPhase('event');$('worldMapPanel').hidden=true;
    try{return await playStory(async playback=>{
      await state.chapterRunner.runTlk({mapId:scene.data.id,recordId,draft,playback});
      if(playback.paused)await playback.ready();playback.check();
      if(!playback.nativeCompletion)actions.validateEntry(state.scenes.current,draft.location);
      actions.log({type:'map-entry-story',map_id:scene.data.id,record_id:recordId});
      return playback.nativeCompletion?{resume_exploration:false}:true;
    });}finally{state.sceneEntryDraft=null;}
  }
  async function animateObjectInteraction({mapId,objectIndex,object,actionGroup,signal,playback}){
    const role=state.openingResources.roles[state.world.value.leader_id];
    const actionIndex=role.native_action_bindings[actionGroup];
    if(!actionGroup||actionIndex===-1)return;
    const target={x:object.x_native*2,y:object.y_native*2};
    const direction=mapInteractionDirection(state.world.location,target);
    const action=role.actions.find(row=>row.index===actionIndex),count=action.logical_count??action.frame_count;
    const actor={role,action,direction,frame:action.uses_sequence?action.sequence_raw[0]:0};
    state.objectActorPreview=actor;
    actions.log?.({type:'object-interaction-start',mapId,objectIndex,role_id:role.id,action_group:actionGroup,action_index:actionIndex,direction});
    try{
      await state.engine.exploration.clock.tween(action.interval_raw*count,t=>{
        const frame=Math.min(count-1,Math.floor(t*count));
        actor.frame=action.uses_sequence?action.sequence_raw[frame]:frame;
      },[signal]);
      playback?.check();
      actions.log?.({type:'object-interaction-complete',mapId,objectIndex});
    }finally{state.objectActorPreview=null;}
  }
  async function animateChapterObject({mapId,objectIndex,fromState=2,signal,playback}){
    const object=state.chapterStory.maps[mapId]?.objects.find(row=>row.index===objectIndex);
    if([2,7,9].includes(object?.behavior_raw_cf)){
      if(state.scenes.current.data.id!==mapId)throw new Error('机关动作目标不是当前地图');
      return state.scenes.current.objectRuntime.animate({objectIndex,state:fromState,signal});
    }
    const resource=state.chapterResources.object_animations[mapId]?.find(row=>row.object_index_zero_based===objectIndex);
    if(!resource)throw new Error('物件动作资源尚未准备');
    const {action,frameIndices,intervalMs}=nativeChestAnimation(resource,object?.behavior_raw_cf);
    const scene=state.scenes?.current;
    const bank=scene?.data.id===mapId
      ?scene.objectRuntime?.actors.find(actor=>actor.object.index===objectIndex)?.resource:null;
    const layeredAction=bank?.actions.find(row=>row.index===action.index&&row.intrinsic_bitmap
      &&frameIndices.every(index=>index>=resource.frames.length||index>=row.first_frame&&index<row.first_frame+row.frame_count));
    // The standalone DGP frame PNGs contain only the main stream. Layered
    // chests need the matching indexed light, including the final core flash.
    const frames=layeredAction?frameIndices.map(index=>index>=resource.frames.length?{bitmap:null,motion:null}:({
      bitmap:layeredAction.main_bitmap,
      motion:{main:layeredAction.main_bitmap,intrinsic:layeredAction.intrinsic_bitmap,shadow:layeredAction.shadow_bitmap,
        width:bank.frame_width,height:bank.frame_height,frame:index-layeredAction.first_frame},
    })):await playbackTask(Promise.all(frameIndices.map(async index=>({
      bitmap:index>=resource.frames.length?null:await actions.image(resource.frames.find(frame=>frame.index===index).image, `map:${mapId}`),
    }))),signal);
    if(playback?.paused)await playback.ready();signal?.throwIfAborted();playback?.check();
    const clock=state.engine?.exploration.clock;
    // CF4 keeps its idle image when selecting action1; 414E92 advances to
    // logical1 on the next eligible visit. CF3 already displays action0.
    const preview={mapId,objectIndex,...frames[0]};
    if(object.behavior_raw_cf===3)state.objectPreview=preview;
    let frame=0,last=clock?.time??performance.now(),completed=false;
    try{
      for(;;){
        const now=await playbackFrame(clock,signal);
        playback?.check();
        if(now-last<intervalMs)continue;
        // 413854 writes DD=now: advance once and discard elapsed overshoot.
        last=now;
        if(frame===frames.length-1){state.objectPreview=preview;break;}
        Object.assign(preview,frames[++frame]);state.objectPreview=preview;
      }
      completed=true;
      // Keep the final pose while the parallel actor action finishes. The
      // complete event releases it in playStory, after the world/view commit.
    }finally{if(!completed)state.objectPreview=null;}
  }
  return {storyPresentation:presentation,playStory,cancelStoryPlayback,say, clearDialogue, chooseChapter, chooseDialogue, advanceDialogue, dialogueKey, dialogueKeyUp, releaseDialogueKeys, interact, chapterSpeaker, animateChapter, transferChapter, runChapter, enterMap, animateObjectInteraction, animateChapterObject};
}
