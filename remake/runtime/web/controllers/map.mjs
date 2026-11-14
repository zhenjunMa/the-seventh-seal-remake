// map adapters. Persistent state belongs to the shared runtime context.
import {MovementMap,locomotion,mapActorPosition} from "../core/exploration/movement.mjs";
import {planRouteExit} from "../core/exploration/route.mjs";
import {initialEncounterState, previewMovement} from "../core/exploration/encounters.mjs";
import {createPartyActors} from "../core/party/party_attributes.mjs";
import {drawGameScene,drawOpeningScene} from "../map_scene_view.mjs";
import {openingCamera} from "../core/ui/opening_presentation.mjs";
import {SAVE_PREVIEW_WIDTH,SAVE_PREVIEW_HEIGHT} from "../core/world/save_preview.mjs";
import {MapNpcRuntime} from "../core/exploration/map_npcs.mjs";
import {projectMapStage} from "../core/exploration/map_stage.mjs";
import {MapObjectRuntime} from "../core/exploration/map_objects.mjs";
import {chapterObjectState} from '../core/story/object_state.mjs';
import {storyBindings,runtimeContent} from "../core/content/content_registry.mjs";
import {anmActorSlots} from "../core/story/anm_runtime.mjs";
import {chapterRouteExits,nativeEmptyEventCells} from "../core/exploration/map_connections.mjs";
import {DistanceGait,MapLocomotion,mapTravelDistance,playerMapMotionProfile,nativeMapMovement} from "../core/exploration/map_locomotion.mjs";

import {mapPresentation,mapViewport} from '../core/ui/map_presentation.mjs';
import {mapWorldPoint,mapTargetInFront,pickMapDialogueObject,pickMapNpc,mapConversationRoute,mapInteractionDirection} from '../core/exploration/map_interaction.mjs';
import {playbackFrame} from '../core/story/story_playback.mjs';

import {createExplorationPresentation} from './presentation_handoff.mjs';

const actorImageFields = [['sheet','bitmap'], ['intrinsic_sheet','intrinsic_bitmap'], ['shadow_sheet','shadow_bitmap']];
const returnCacheMs = 15000;
const exitPreloadDistance = 144;

function roleImages(roleId, poses = []) {
  const scope = `role:${roleId}`;
  return poses.flatMap(pose => actorImageFields
    .filter(([sheet]) => pose[sheet])
    .map(([sheet, field]) => ({pose, path: pose[sheet], scope, field})));
}

export function createMapController({state, actions, $, canvas, ctx}) {
  const presentation=createExplorationPresentation({state,actions,$,canvas});
  const motionState=new MapLocomotion();let gaitScene=null,gaitRole=null;
  let retainedScene=null,retainedParty=null,retainedRevision=-1,previousMap=null;
  let preload=null,preloadSerial=0;
  function role() { return state.catalog.roles.find(role=>role.id===state.selectedRole); }
  function sheetAction(index=state.view.action) { return role().actions.find(action=>action.index===index); }
  function buildHud({resourcesOnly=false,actors=null}={}) {
    const snapshot=resourcesOnly?state.world.value:state.world.snapshot();
    if(!resourcesOnly)state.questProgress=state.storyRepository?.journal(snapshot)??[];
    let effective=[];state.battleUnavailable='';
    if(state.partyCombat)try{effective=actors??createPartyActors(snapshot,state.partyCombat,{},state.itemData);if(!effective.some(a=>a.side==='player'&&a.hp.current>0))state.battleUnavailable='队伍已经倒下，请载入进度。';}catch(error){state.battleUnavailable=error.message;}
    $('battleOpen').disabled=true;$('battleOpen').title='请在野外行走遇敌。';
    state.mapVitals.clear();for(const actor of effective)state.mapVitals.set(actor.id,{hp:{...actor.hp},mp:{...actor.mp}});
    $('stateInfo').textContent=`世界版本 ${snapshot.revision} · 2000 项事件旗标 · ${snapshot.event_records.reduce((n,row)=>n+row.length,0)} 条原始事件状态`;
    if(resourcesOnly)return;
    state.selectedRole=snapshot.leader_id;
    $('role').replaceChildren(...snapshot.party.map(actor=>{const option=document.createElement('option');option.value=actor.id;option.textContent=actor.name;return option;}));
    $('role').value=state.selectedRole;
    $('inventory').replaceChildren(...snapshot.inventory.map(item=>{const li=document.createElement('li'),count=document.createElement('span');li.append(document.createTextNode(item.name));count.textContent=`× ${item.quantity}`;li.append(count);return li;}));
    $('itemCount').textContent=`${snapshot.inventory.length} 项`;
    $('money').textContent=`金钱 ${snapshot.money??state.rewardData?.initial_money??'—'}`;
  }
  async function readMapDefinition(id,signal) {
    const entry=state.catalog.maps.find(map=>map.id===id);
    if(!entry)throw new Error(`地图尚未纳入本版：${id}`);
    const data=await actions.json(entry.path,{signal});
    if(data.schema!=='seventh-seal-runtime-map'||data.version!==1||data.id!==id)throw new Error('地图数据版本或标识不匹配');
    return data;
  }
  function stopMapPreload() {
    if(!preload)return;
    const {controller,scope}=preload;
    preload=null;
    controller.abort();
    state.resources.release(scope);
  }
  function preloadExit(dx,dy,at) {
    const scene=state.scenes.current;
    const size=scene.movement.cellSize;
    let target=null,nearest=exitPreloadDistance;
    for(const exit of scene.data.exits??[]){
      if(exit.state!=='ready'||!exit.entry||!exit.target_map||exit.target_map===at.map_id)continue;
      for(const cell of exit.cells){
        const x=(cell.x+.5)*size-at.x,y=(cell.y+.5)*size-at.y;
        if(x*dx+y*dy<=0)continue;
        const distance=Math.hypot(x,y);
        if(distance<nearest){nearest=distance;target=exit;}
      }
    }
    if(preload?.exit===target)return;
    stopMapPreload();
    if(!target||target.target_map===previousMap?.id)return;
    const controller=new AbortController(),{signal}=controller;
    const id=target.target_map,scope=`map-preload:${++preloadSerial}`;
    const definition=readMapDefinition(id,signal);
    preload={exit:target,controller,scope,definition};
    void definition.then(async data=>{
      signal.throwIfAborted();
      const {background}=data;
      const path=typeof background==='string'?background:background.image;
      const width=background.width??data.movement.width*size;
      const height=background.height??data.movement.height*size;
      const view=openingCamera(target.entry,width,height),visible=mapViewport(view,2);
      const world=state.world.value;
      const [bitmap,objects]=await Promise.all([
        state.resources.load(path,scope,{visible,mapBackground:true,signal}),
        Promise.all((data.objects??[]).filter(obj=>world.object_states[`${id}:${obj.index}`]?.visible!==false
          &&visible({x:obj.draw_x,y:obj.draw_y,width:obj.frame_width,height:obj.frame_height}))
          .map(async obj=>({...obj,bitmap:await actions.image(obj.image,scope)}))),
      ]);
      signal.throwIfAborted();
      if(state.scenes.phase!=='map')return;
      await state.engine?.exploration.prepareViewport({scene:{data,bitmap,objects},world,view,openingQueue:[]},
        {signal,preload:true,isCurrent:()=>state.scenes.phase==='map'&&state.scenes.current===scene});
    }).catch(error=>{
      if(signal.aborted)return;
      actions.log?.({type:'map-preload-failed',map_id:id,error:error.message});
    });
  }
  async function prepareMap(id,options={}) {
    if(preload&&preload.exit.target_map!==id)stopMapPreload();
    const warm=preload;
    const previous=previousMap?.until>performance.now()?previousMap:null;
    const release=state.storyRepository.retainMap(id);
    try{
      const definition=warm?.definition.catch(()=>readMapDefinition(id))
        ??(previous?.id===id?previous.definition:undefined);
      return await prepareMapContent(id,options,definition);
    }finally{
      release();
      if(warm&&preload===warm)stopMapPreload();
    }
  }
  async function prepareMapContent(id,{world=state.world.value,program,onProgress,duringAnimation=false}={},definition) {
    await state.storyRepository.ensureMap(id,{protect:[state.scenes?.current?.data.id].filter(Boolean)});
    const mapEvents=state.events.filter(event=>event.map_id===id);
    for(const event of mapEvents){const resource=event.npc?.resource;
      if(resource){const roleId=resource.source?.match(/(?:^|\/)([^/]+)\.dgp$/i)?.[1],action=state.mapShadows?.roles[roleId]?.actions.find(action=>action.index===0);
        if(action){resource.shadow_sheet=action.shadow_sheet;resource.shadow_geometry=action.shadow_geometry;}}}
    const source=await (definition??readMapDefinition(id));
    const data={...source};
    data.movement=nativeMapMovement(data.movement,state.chapterStory.maps[id],state.chapterStory.programs);
    const extraExits=[...(state.chapterResources.exits_by_map[id]??[]),...chapterRouteExits(id,state.chapterStory,state.chapterResources)];
    data.exits=[...(data.exits??[]).filter(exit=>!extraExits.some(extra=>extra.id===exit.id)),...extraExits];
    const nativeNpcs=state.chapterResources.npcs_by_map[id];
    data.opening_npcs=(nativeNpcs?.length?nativeNpcs:data.opening_npcs??[]).filter(npc=>!mapEvents.some(event=>event.npc
      &&(event.npc.id===npc.id||event.npc.slot_zero_based!==undefined&&event.npc.slot_zero_based===npc.slot_zero_based)));
    data.opening_npcs=await projectMapStage({mapId:id,world,story:state.chapterStory,npcs:data.opening_npcs,
      roles:state.openingResources.roles,duringAnimation});
    data.story_triggers=(state.chapterResources.trigger_regions[id]??[]).filter(trigger=>storyBindings(id).triggers.includes(trigger.id));
    // Some legacy map exports also list a registered StoryFlow trigger as a world-map exit.
    const storyTriggerIds=new Set(data.story_triggers.map(trigger=>trigger.id));
    data.exits=data.exits.filter(exit=>exit.kind!=='world-map-event'||!storyTriggerIds.has(exit.id));
    const readyCells=new Set([...(data.exits??[]).filter(exit=>exit.state==='ready').flatMap(exit=>exit.cells.map(cell=>`${cell.x},${cell.y}`)),
      ...data.story_triggers.flatMap(trigger=>trigger.cells.map(cell=>`${cell.x},${cell.y}`)),
      ...nativeEmptyEventCells(data.movement,state.chapterStory.maps[id])]);
    // Unknown trigger handlers must be visible failures, not silent pass-through.
    // The source JSON retains the original gate; this is a runtime coverage guard.
    const movement=new MovementMap({...data.movement,rail_boundaries:state.rails?.[id],triggers:data.movement.triggers.map(trigger=>
      ({...trigger,path_gate:!readyCells.has(`${trigger.x},${trigger.y}`)}))});
    const npcRoleIds = new Set(data.opening_npcs.map(npc => npc.resource_id));
    const playerIds = new Set((world.party ?? []).map(actor => actor.id));
    const content = state.storyRepository.content ?? runtimeContent;
    const actorSlots = anmActorSlots(program);
    // Slots 6–9 alias the controlled actor, already in the party or named by a control command.
    for (const [roleId, role] of Object.entries(content.roles)) {
      if (role.side === 'player' && actorSlots.has(role.native_slot)) playerIds.add(roleId);
    }
    const actorIds = new Set([...playerIds, ...npcRoleIds]);
    const actorImages = [
      ...[...actorIds].flatMap(roleId => roleImages(roleId, state.openingResources.roles[roleId]?.actions)),
      ...state.catalog.roles.filter(role => playerIds.has(role.id))
        .flatMap(role => roleImages(role.id, role.actions.filter(action => action.index <= 2))),
    ];
    const table = state.chapterStory.maps[id];
    data.native_layer=table?.map_flag_index;
    const effectMap=state.mapEffects?.maps[id],effectObjects=effectMap?.objects??[];
    const completedAnimations=(state.chapterResources.object_animations[id]??[]).filter(animation=>
      table&&world.event_records[table.map_flag_index]?.[animation.object_index_zero_based]?.slice(0,2)==='03');
    const total=1+(data.objects??[]).length+state.events.filter(e=>e.map_id===id&&e.npc?.resource?.sheet).length+
      state.events.filter(e=>e.map_id===id&&e.npc?.resource?.shadow_sheet).length+
      actorImages.length+completedAnimations.length+
      effectObjects.reduce((count,obj)=>count+state.mapEffects.object_banks[obj.bank].actions
        .reduce((n,action)=>n+['main','intrinsic','shadow'].filter(channel=>action[channel+'_sheet']).length,0),0);
    let completed=0;onProgress?.({completed,total});
    const step=async promise=>{const value=await promise;onProgress?.({completed:++completed,total});return value;};
    const bitmap=await step(actions.image(typeof data.background==='string'?data.background:data.background.image,`map:${id}`,{mapBackground:true}));
    if(bitmap.width!==movement.width*16||bitmap.height!==movement.height*16) throw new Error('背景尺寸与逻辑地图不匹配');
    const objects=await Promise.all((data.objects??[]).map(async obj=>({...obj,bitmap:await step(actions.image(obj.image, `map:${id}`))})));
    const npcs=await Promise.all(state.events.filter(event=>event.map_id===id&&event.npc).map(async event=>({event,...event.npc,
      bitmap:event.npc.resource?.sheet?await step(actions.image(event.npc.resource.sheet, `map:${id}`)):null,
      shadow_bitmap:event.npc.resource?.shadow_sheet?await step(actions.image(event.npc.resource.shadow_sheet, `map:${id}`)):null})));
    await Promise.all(actorImages.map(({pose, path, scope, field}) => step(state.resources.attach(pose, path, scope, field))));
    await Promise.all(completedAnimations.filter(animation=>animation.completed_last_frame<animation.frames.length)
      .map(animation=>step(actions.image(animation.frames[animation.completed_last_frame].image, `map:${id}`))));
    for(const npc of data.opening_npcs??[]){
      const r=state.openingResources.roles[npc.resource_id],a=r?.actions.find(a=>a.index===0);
      if(!a?.bitmap)throw new Error(`地图人物资源未准备：${npc.resource_id}`);
      npcs.push({...npc,event:mapEvents.find(event=>event.npc_slot===npc.slot_zero_based),bitmap:a.bitmap,shadow_bitmap:a.shadow_bitmap,resource:{frame_width:r.frame_width,frame_height:r.frame_height,
        frames_per_direction:a.frame_count,interval_ms:a.interval_raw,anchor_x:r.anchor.x,anchor_y:r.anchor.y,shadow_geometry:a.shadow_geometry}});
    }
    for(const npc of npcs)npc.native_layer??=data.native_layer;
    const probes=[...(data.probes??[]),...state.events.filter(event=>event.map_id===id&&event.sample?.probe).map(event=>event.sample.probe)];
    const scene={data,definition:source,movement,bitmap,objects,npcs,probes,npcRoleIds};
    scene.npcRuntime=new MapNpcRuntime({scene,table,roles:state.openingResources.roles});
    if(effectObjects.length){
      const resources=await Promise.all(effectObjects.map(async obj=>{
        const source=state.mapEffects.object_banks[obj.bank],resource={...source,actions:source.actions.map(action=>({...action}))};
        await Promise.all(resource.actions.flatMap(action=>['main','intrinsic','shadow'].filter(channel=>action[channel+'_sheet']).map(async channel=>{
          action[channel+'_bitmap']=await step(actions.image(action[channel+'_sheet'],`map:${id}`));
        })));
        return {...obj,resource};
      }));
      scene.objectRuntime=new MapObjectRuntime({objects,resources,mapFlagIndex:effectMap.map_flag_index,mapId:id,movement,
        onSound:({token,x,y})=>{
          const listener=state.openingView?.active?state.openingView.cameraAt:state.world.location;
          const shift=data.movement.native_coordinate_shift;
          state.audio?.playClip('sound/'+token,null,{singleVoice:true,
            position:{dx:((Math.trunc(listener.x/2)-x)>>shift)<<1,dy:((y-Math.trunc(listener.y/2))>>shift)<<1}});
        }});
      scene.objectRuntime.update(0,{world,paused:true});
    }
    return scene;
  }
  function validateEntry(scene,at) { if(!scene.movement.validEntry(at.x,at.y)) throw new Error(`目标位置不在可通行格：${at.map_id} ${at.x},${at.y}`); }
  function prepareMapView(scene,world,options){
    if(!state.engine)return;
    const role=state.catalog.roles.find(role=>role.id===world.leader_id);
    const action=role.actions.find(action=>action.index===0);
    const view={...openingCamera(world.location,scene.bitmap.width,scene.bitmap.height),zoom:1,frame:0};
    return state.engine.exploration.prepareViewport({scene,world,role,action,view,
      objectBitmap:(scene,obj)=>objectBitmap(scene,obj,world,false)},options);
  }
  function commitView(scene,at,reason) {
    if(scene!==gaitScene&&reason!=='boot')state.mapNameNoticeView?.show(scene.data.name||scene.data.id);
    motionState.reset();state.view.collisionFeedback=null;gaitScene=scene;gaitRole=state.selectedRole;
    state.view.action=0;state.view.frame=0;state.view.follow=true;state.view.zoom=1;
    Object.assign(state.view,openingCamera(at,scene.bitmap.width,scene.bitmap.height));
    state.clock=0;state.nearest=null;state.lastExit='';
    $('mapName').textContent=scene.data.name||scene.data.id;
    state.audio?.setScene({mapId:scene.data.id,battle:false});
    $('probe').replaceChildren(...scene.probes.map((p,i)=>{const opt=document.createElement('option');opt.value=i;opt.textContent=p.name;return opt;}));
    $('resetEventSample').hidden=!state.events.some(event=>event.map_id===scene.data.id&&event.sample?.clear_bits);
  }
  async function changeMap(at,reason='exit',restoredWorld=null,nativeSortCode) {
    const from=state.world.location.map_id;
    try { await state.scenes.loadLocation(at,{reason,restoredWorld,nativeSortCode});if(state.scenes.phase!=='map')return; buildHud(); updateNearest(); actions.log({type:'scene-enter',from,map_id:at.map_id,x:at.x,y:at.y,reason}); actions.status(reason==='restore'?'进度已载入，可以继续探索。':'已进入场景。'); canvas.focus({preventScroll:true}); }
    catch(error){actions.log({type:'scene-failed',error:error.message,from,to:at.map_id});if(error.gameOverPolicy)await actions.presentGameOver(error.gameOverPolicy);else actions.status(`${error.message}，当前场景已保留。`,true);}
  }
  function follow() {const im=state.scenes.current.bitmap;Object.assign(state.view,openingCamera(state.world.location,im.width,im.height));}
  function fit(){if(!state.scenes?.current)return;const im=state.scenes.current.bitmap;state.view.zoom=Math.min(640/im.width,480/im.height)*.97;state.view.x=im.width/2;state.view.y=im.height/2;state.view.follow=false;}
  function resize(){const rect=$('screen').getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);state.cssWidth=rect.width;state.cssHeight=rect.height;for(const target of [canvas,$('battleCanvas')]){target.width=Math.round(rect.width*dpr);target.height=Math.round(rect.height*dpr);}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.imageSmoothingEnabled=false;state.engine?.resize();}
  function npcAvailable(npc) {
    if(npc.hidden||npc.route_hidden_ticks>0||npc.native_layer!==undefined&&state.scenes.current.data.native_layer!==undefined&&npc.native_layer!==state.scenes.current.data.native_layer)return false;
    const conditions=npc.event?.conditions??[];
    return conditions.every(condition=>state.world.value.flags[condition.index]===condition.value);
  }
  function npcCanTalk(npc,bindings=storyBindings(state.world.location.map_id)){
    return npcAvailable(npc)&&(npc.event||!bindings.npcs||bindings.npcs.includes(npc.slot_zero_based));
  }
  function mapPointerDown(event){
    if(event.button!==0||state.engine?.paused||state.scenes.phase!=='map')return false;
    const scene=state.scenes.current;
    if(!scene)return false;
    const point=mapWorldPoint(event,(state.engine?.canvas??canvas).getBoundingClientRect(),state.view);
    if(!point)return false;
    const queue=mapPresentation({scene,world:state.world.value,role:role(),action:sheetAction(),
      view:state.view,objectBitmap});
    const npcId=pickMapNpc(queue,point);
    if(npcId!==undefined){
      const npc=scene.npcs.find(row=>row.id===npcId);
      if(!npc||!npcCanTalk(npc))return false;
      event.preventDefault();
      actions.interact(npc);
      return true;
    }
    const selected=pickMapDialogueObject({scene,world:state.world.value,
      bindings:storyBindings(scene.data.id).objects,
      header:state.chapterStory.maps[scene.data.id]?.header_raw_hex,queue,point});
    if(!selected)return false;
    event.preventDefault();
    if(!selected.nearby){actions.status('请先靠近这个物件，再点击交谈。');return true;}
    actions.guarded(()=>actions.runChapter({mapId:scene.data.id,objectIndex:selected.object.index}))();
    return true;
  }
  function updateNearest(){
    state.nearest=null;if(!state.scenes.current)return;const at=state.world.location;
    const bindings=storyBindings(at.map_id);
    for(const npc of state.scenes.current.npcs){
      if(!npcCanTalk(npc,bindings))continue;
      const position=mapActorPosition(npc);
      if(!mapTargetInFront(at,position))continue;
      const distance=Math.hypot(position.x-at.x,position.y-at.y);
      if(distance<64&&(!state.nearest||distance<state.nearest.distance)){
        state.nearest={...npc,x:position.x,y:position.y,direction:position.direction??npc.direction,distance};
      }
    }
    for(const object of state.chapterStory.maps[at.map_id]?.objects??[]){
      const binding=bindings.objects.find(row=>row.index===object.index);
      if(!binding)continue;
      if(binding.handler==='stationary-chest'&&(![3,4].includes(object.behavior_raw_cf)||!object.interaction_record_raw_f6))continue;
      if(binding.handler==='keyed-chest'&&![3,4].includes(object.behavior_raw_cf))continue;
      const isChest=binding.handler==='stationary-chest'||binding.handler==='keyed-chest';
      if(isChest&&chapterObjectState(state.world.value,at.map_id,object.index,state.chapterStory)===3)continue;
      if(binding.handler==='tlk-object'&&(object.behavior_raw_cf!==1||!object.interaction_record_raw_f6))continue;
      if(binding.handler==='scripted-switch'&&(object.behavior_raw_cf!==9||!object.interaction_record_raw_f6))continue;
      if(binding.handler==='scripted-object'&&(object.behavior_raw_cf!==2||!object.interaction_record_raw_f6))continue;
      if(binding.handler==='toggle-object'&&object.behavior_raw_cf!==7)continue;
      if(binding.handler==='mechanism'&&object.behavior_raw_cf!==2)continue;
      const position={x:object.x_native*2,y:object.y_native*2};
      if(isChest&&!mapTargetInFront(at,position))continue;
      const distance=Math.hypot(position.x-at.x,position.y-at.y);
      if(distance<64&&(!state.nearest||distance<state.nearest.distance))state.nearest={...object,kind:'object',name:binding.handler==='keyed-chest'?'宝箱':['scripted-switch','toggle-object','mechanism'].includes(binding.handler)?'机关':'物件',distance};
    }
    for(const binding of bindings.rests){
      const bed=state.chapterStory.maps[at.map_id]?.descriptors?.find(row=>row.id===binding.descriptor_id);
      if(bed){const distance=Math.min(...bed.cells.map(cell=>Math.hypot((cell.x+.5)*16-at.x,(cell.y+.5)*16-at.y)));if(distance<40&&(!state.nearest||distance<state.nearest.distance))state.nearest={kind:'rest',name:'床铺',descriptorId:bed.id,distance};}
    }
    $('interactionHint').hidden=!state.nearest||state.scenes.phase!=='map';
    if(state.nearest)$('interactionHint').textContent=state.nearest.kind==='rest'?'空格 · 休息':state.nearest.kind==='object'?`空格 · 查看${state.nearest.name}`:`空格 · 与${state.nearest.name??'人物'}交谈`;
  }
  async function approachConversation(npc,playback){
    const scene=state.scenes.current,map=scene.movement,world=state.world;
    state.keys.clear();$('interactionHint').hidden=true;
    state.view.collisionFeedback=null;
    const obstacles=()=>map.actorObstacles(scene.npcs.filter(npcAvailable));
    const route=mapConversationRoute(map,world.location,mapActorPosition(npc),obstacles(),scene.data.story_triggers);
    if(!route)return false;
    const walk=sheetAction(1),gait=new DistanceGait();
    const motion=playerMapMotionProfile(walk,scene.data.movement,state.chapterStory.maps[scene.data.id]?.header_raw_hex);
    const current=()=>state.scenes.current===scene&&state.world===world&&npcAvailable(npc);
    try{
      let last=playback.clock?.time??performance.now();
      for(const point of route){
        let start=world.location;
        while(mapTravelDistance(start,point)>1e-6){
          const now=await playbackFrame(playback.clock,playback.signal);
          playback.check();
          if(!current())return false;
          const elapsed=Math.min(80,Math.max(0,now-last));last=now;
          const part=Math.min(1,motion.speed*elapsed/1000/mapTravelDistance(start,point));
          if(!part)continue;
          const dx=(point.x-start.x)*part,dy=(point.y-start.y)*part;
          const next=map.moveAndSlide(start.x,start.y,dx,dy,{obstacles:obstacles()});
          if(next.blocked)return false;
          world.setPosition(next.x,next.y,locomotion({dx,dy},true).direction);
          state.view.action=1;state.view.frame=gait.advance(walk,{dx,dy,stride:motion.stride});
          state.view.follow=true;follow();
          start=world.location;
        }
      }
      const at=world.location,target=mapActorPosition(npc);
      world.setPosition(at.x,at.y,mapInteractionDirection(at,target));
      const direction=mapInteractionDirection(target,at);
      if(Number.isInteger(direction)&&!scene.npcRuntime?.face(npc.id,direction))npc.direction=direction;
      return true;
    }finally{
      if(state.scenes.current===scene&&state.world===world){
        state.view.action=0;state.view.frame=0;state.clock=0;
      }
    }
  }
  function objectBitmap(scene,obj,world=state.world.value,live=true){
    if(live&&state.objectPreview?.mapId===scene.data.id&&state.objectPreview.objectIndex===obj.index)return state.objectPreview.bitmap;
    if(scene.objectRuntime?.actors.some(actor=>actor.object.index===obj.index&&[2,9].includes(actor.behavior)))return obj.bitmap;
    const table=state.chapterStory.maps[scene.data.id],record=table&&world.event_records[table.map_flag_index]?.[obj.index];
    if(record?.slice(0,2)==='03'){
      const animation=state.chapterResources.object_animations[scene.data.id]?.find(row=>row.object_index_zero_based===obj.index);
      if(animation&&animation.completed_last_frame>=animation.frames.length)return null;
      if(animation)return state.resources.peek(animation.frames[animation.completed_last_frame].image)??obj.bitmap;
    }
    return obj.bitmap;
  }
  function transitionFor(hit){return state.scenes.current.data.exits?.find(exit=>exit.state==='ready'&&exit.cells.some(cell=>cell.x===hit.x&&cell.y===hit.y));}
  function renderWorldMap(snapshot){
    state.audio?.setScene({mapId:state.world.location.map_id,worldMap:snapshot.phase!=='closed'});
    state.worldMapView?.show(snapshot);
  }
  function selectWorldMapDestination(index){return actions.guarded(async()=>{
    const from=state.world.location.map_id;
    await state.loadingView.run('world-map',async(onProgress,onReady)=>{
      await state.worldMap.select(index,{onProgress,onReady});
      buildHud();updateNearest();presentLoadedMap();
    });
    actions.log({type:'scene-enter',from,...state.world.location,reason:'world-map',destination:index});actions.status('已进入场景。');canvas.focus();
  })();}
  function closeWorldMap(){
    if(state.worldMap?.phase!=='open')return;
    state.worldMap.close();actions.status('已返回当前地图。');canvas.focus();
  }
  async function routeExit(exit){
    if(state.scenes.phase!=='map')return;
    const mapId=state.world.location.map_id,gate=storyBindings(mapId).routes.find(row=>row.record_id===exit.record_id)?.requires_flag;
    if(gate&&!(state.world.value.flags[gate.index]&(1<<(gate.bit-1)))){
      await actions.runChapter({mapId,recordId:exit.record_id});return;
    }
    state.scenes.setPhase('event');
    try{
      const plan=planRouteExit(state.world.value,state.world.location.map_id,exit.record_id,state.routeEvents);
      if(plan.denied){await actions.say(plan.denied.speaker,plan.denied.text);actions.log({type:'route-denied',source:plan.denied});return;}
      state.worldMap.initialize();for(const command of plan.commands)state.worldMap.apply(command);
      actions.log({type:'world-map-open',commands:plan.commands,source:plan.source});actions.status('方向键选择目的地，空格／Enter前往；也可点击地图上的地点，Esc返回。');
    }catch(error){actions.status(error.message,true);actions.log({type:'route-failed',error:error.message});}
    finally{if(state.scenes.phase==='event')state.scenes.setPhase('map');}
  }
  function drawCollision(scene){
    const {cellSize:size,width,height,rails}=scene.movement;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const cell=scene.movement.cell(x,y);
      ctx.fillStyle=cell.trigger?'#e6bd6855':cell.blocked?'#d14d4738':'#78c79623';
      ctx.fillRect(x*size,y*size,size,size);
    }
    if(!rails.length)return;
    ctx.save();ctx.strokeStyle='#ff765b';ctx.lineWidth=2;ctx.beginPath();
    for(const {from,to} of rails){ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);}
    ctx.stroke();ctx.restore();
  }
  function paint(){
    const scene=state.scenes?.current;
    const sourceWorld=state.sceneEntryDraft??state.world.value,actor=state.objectActorPreview;
    const direction=actor?.direction;
    const world=direction===undefined?sourceWorld:{...sourceWorld,location:{...sourceWorld.location,direction}};
    const draw=state.openingView?.active&&state.openingView.nativeViewport?drawOpeningScene:drawGameScene;
    const options={scene,world,role:actor?.role??role(),action:actor?.action??sheetAction(),view:actor?{...state.view,frame:actor.frame,collisionFeedback:null}:state.view,width:state.cssWidth,height:state.cssHeight,objectBitmap:(scene,obj)=>objectBitmap(scene,obj,world),
      objectPreview:state.objectPreview,
      openingQueue:state.openingView?.active?state.openingView.drawQueue(scene.data.role_layer_preview??2):null,
      nativeViewport:Boolean(state.openingView?.active&&state.openingView.nativeViewport),
      collision:scene&&state.view.collision?()=>drawCollision(scene):null,nearest:state.nearest};
    if(state.engine)state.engine.presentMap(options);else draw(ctx,options);
    if(!scene)return;const at=world.location;
    $('zoomValue').textContent=`${Math.round(state.view.zoom*100)}%`;$('position').textContent=`${at.map_id} · ${at.x.toFixed(1)}, ${at.y.toFixed(1)}`;
    $('position').dataset.x=at.x;$('position').dataset.y=at.y;$('position').dataset.map=at.map_id;
  }
  function captureScene(kind='exploration'){
    const target=kind==='battle'?$('battleCanvas'):canvas;
    if(state.engine){if(kind==='exploration')paint();state.engine.capture(kind,target);}
    return target;
  }
  function presentLoadedMap(){
    paint();
    state.engine?.flush();
  }
  function renderSavePreview(scene,world,{view=null,action=null}={}){
    const r=state.catalog.roles.find(role=>role.id===world.leader_id),a=action??r?.actions.find(action=>action.index===0);
    if(!r||!a?.bitmap)throw new Error('存档人物图像未准备');
    const camera={...(view??{zoom:1,frame:0,...openingCamera(world.location,scene.bitmap.width,scene.bitmap.height)}),collisionFeedback:null};
    const frame=document.createElement('canvas');frame.width=640;frame.height=480;const drawing=frame.getContext('2d');drawing.imageSmoothingEnabled=false;
    drawGameScene(drawing,{scene,world,role:r,action:a,view:camera,width:640,height:480,time:0,objectBitmap:(scene,obj)=>objectBitmap(scene,obj,world,false)});
    const thumbnail=document.createElement('canvas');thumbnail.width=SAVE_PREVIEW_WIDTH;thumbnail.height=SAVE_PREVIEW_HEIGHT;
    thumbnail.getContext('2d').drawImage(frame,0,0,SAVE_PREVIEW_WIDTH,SAVE_PREVIEW_HEIGHT);return thumbnail;
  }
  function captureSavePreview(world){
    const scene=state.scenes.current;if(scene?.data.id!==world.location.map_id)throw new Error('当前场景与存档地图不一致');
    return renderSavePreview(scene,world,{view:{...state.view},action:sheetAction()}).toDataURL('image/png');
  }
  function reconcileResources() {
    const scene = state.scenes.current, party = state.world.value.party;
    if (!scene || state.storyPlayback) return;
    const now=performance.now();
    const expired=previousMap&&now>=previousMap.until;
    if(expired)previousMap=null;
    if (scene === retainedScene && party === retainedParty && retainedRevision === state.resources.revision&&!expired) return;
    if(retainedScene&&scene.data.id!==retainedScene.data.id){
      previousMap={id:retainedScene.data.id,definition:retainedScene.definition,
        npcRoleIds:retainedScene.npcRoleIds,until:now+returnCacheMs};
    }

    const roleIds = new Set(scene.npcRoleIds);
    for (const actor of party) roleIds.add(actor.id);
    const scopes=['shared',`map:${scene.data.id}`];
    if(previousMap){
      scopes.push(`map:${previousMap.id}`);
      for(const id of previousMap.npcRoleIds)roleIds.add(id);
    }
    if(preload)scopes.push(preload.scope);
    state.resources.retainScopes([...scopes,...[...roleIds].map(id=>`role:${id}`)]);
    const roles = [...Object.entries(state.openingResources.roles), ...state.catalog.roles.map(role => [role.id, role])];
    for (const [id, role] of roles) {
      if (roleIds.has(id)) continue;
      for (const action of role.actions) {
        for (const [, field] of actorImageFields) delete action[field];
      }
    }
    retainedScene = scene;
    retainedParty = party;
    retainedRevision = state.resources.revision;
  }
  function updateExploration(now,deltaMs){
    const delta=Math.min(deltaMs/1000,.08);
    state.scenes?.current?.npcRuntime?.update(now,{player:state.world.location,visible:npcAvailable,
      paused:!['map','event'].includes(state.scenes.phase)||Boolean(state.openingView?.active)});
    state.scenes?.current?.objectRuntime?.update(now,{world:state.sceneEntryDraft??state.world.value,
      paused:!['map','event'].includes(state.scenes.phase)});
    if(state.scenes?.phase==='map'){
      reconcileResources();
      const dx=Number(state.keys.has('ArrowRight')||state.keys.has('d'))-Number(state.keys.has('ArrowLeft')||state.keys.has('a'));
      const dy=Number(state.keys.has('ArrowDown')||state.keys.has('s'))-Number(state.keys.has('ArrowUp')||state.keys.has('w'));
      const at=state.world.location;let pose=null;
      if(gaitScene!==state.scenes.current||gaitRole!==state.selectedRole||state.view.action!==motionState.action){
        motionState.reset();gaitScene=state.scenes.current;gaitRole=state.selectedRole;
      }
      const active=state.world.value.party.find(actor=>actor.id===state.selectedRole),effectivePlayer=state.mapVitals.get(state.selectedRole)??active;
      if((dx||dy)&&effectivePlayer.hp.current>0){const running=state.running;
        const headerRawHex=state.chapterStory.maps[at.map_id]?.header_raw_hex;
        const motion=playerMapMotionProfile(sheetAction(running?2:1),state.scenes.current.data.movement,headerRawHex,state.playerRunSpeed);
        const {movement,data}=state.scenes.current;
        const storyAt=cell=>data.story_triggers.find(trigger=>trigger.cells.some(c=>c.x===cell.x&&c.y===cell.y));
        const storyTag=trigger=>`${at.map_id}:${trigger.id}`;
        const shouldStartStory=trigger=>Boolean(trigger&&state.lastStoryTrigger!==storyTag(trigger)
          &&state.chapterRunner.triggerHasEffect(at.map_id,trigger.id));
        let encounter=null,encounterState=state.world.value.encounters??initialEncounterState(state.world.value.party),encounterAdvanced=false;
        const moved=motionState.movement.advance(movement,at,{dx,dy,profile:motion,elapsedMs:delta*1000,
          obstacles:movement.actorObstacles(state.scenes.current.npcs.filter(npcAvailable)),onTravel:segment=>{
            const cell=movement.at(segment.x,segment.y),exit=cell.trigger?transitionFor(cell):null;
            const stop=Boolean(exit||shouldStartStory(storyAt(cell)));
            if(state.encounterData&&!state.battleUnavailable){
              const preview=previewMovement(encounterState,{party:state.world.value.party,leader_id:state.selectedRole,map_id:at.map_id,
                dx:segment.dx,dy:segment.dy,distance:segment.distance,step_pixels:motion.keyboardStepSize,transition:stop,phase:'map',play_time_ms:actions.currentPlayTime(),world:state.world.value,itemData:state.itemData},state.encounterData);
              encounterState=preview.state;encounter=preview.encounter;encounterAdvanced=true;
            }
            return !encounter&&!stop;
          }});
        pose=motionState.advance(moved,{from:at,dx,dy,running,elapsedMs:delta*1000,
          role:role(),profile:motion});
        state.world.setPosition(moved.x,moved.y,pose.direction??at.direction);state.view.follow=true;
        if(encounterAdvanced&&!encounter)state.world.setEncounterState(encounterState);
        const reached=movement.at(moved.x,moved.y),exit=reached.trigger?transitionFor(reached):null;
        const storyTrigger=storyAt(reached);
        if(shouldStartStory(storyTrigger)){
          state.lastStoryTrigger=storyTag(storyTrigger);
          actions.runChapter({mapId:at.map_id,triggerId:storyTrigger.id});
        }else if(!storyTrigger||state.lastStoryTrigger!==storyTag(storyTrigger))state.lastStoryTrigger='';
        if(exit){
          const tag=`${at.map_id}:${exit.id}`;
          if(tag!==state.lastExit){state.lastExit=tag;if(exit.kind==='world-map-event')routeExit(exit);else changeMap({map_id:exit.target_map,...exit.entry},'exit',null,exit.source?.entry_sort_code);}
        }
        else if(moved.blocked&&moved.hit?.trigger){if(state.lastBoundary!==`${at.map_id}:${moved.hit.trigger.id}`){state.lastBoundary=`${at.map_id}:${moved.hit.trigger.id}`;actions.status('这条出口的执行规则尚未纳入当前片段。');}}
        else {state.lastBoundary='';state.lastExit='';}
        if(encounter&&state.scenes.phase==='map')actions.guarded(()=>actions.startBattle(encounter,encounterState))();
      }
      pose??=motionState.advance(null,{from:at,role:role(),elapsedMs:delta*1000});
      if((dx||dy)&&state.scenes.phase==='map'&&state.engine)preloadExit(dx,dy,state.world.location);
      state.view.action=pose.action;state.view.frame=pose.frame;
      state.view.collisionFeedback=pose.feedback;state.clock=pose.elapsed;
      if(state.view.follow)follow();updateNearest();
    }else {motionState.reset();state.view.collisionFeedback=null;}
    paint();
  }
  return {explorationPresentation:presentation,role, sheetAction, buildHud, prepareMap, prepareMapView, stopMapPreload, validateEntry, commitView, changeMap, follow, fit, resize, npcAvailable, updateNearest, mapPointerDown, approachConversation, objectBitmap, transitionFor, renderWorldMap,selectWorldMapDestination,closeWorldMap, routeExit, drawCollision, paint, presentLoadedMap, updateExploration,captureScene,captureSavePreview};
}
