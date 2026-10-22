// map adapters. Persistent state belongs to the shared runtime context.
import {MovementMap, locomotion} from "/prototype/movement.mjs";
import {createBattleSample} from "../combat_sample.mjs";
import {planRouteExit} from "../core/route.mjs";
import {initialEncounterState, previewMovement} from "../core/encounters.mjs";
import {createPartyActors} from "../core/party_attributes.mjs";
import {drawGameScene,drawOpeningScene} from "../map_scene_view.mjs";
import {openingCamera} from "../core/opening_presentation.mjs";
import {decodeSave} from "../core/world.mjs";
import {savedPreviewPng,SAVE_PREVIEW_WIDTH,SAVE_PREVIEW_HEIGHT} from "../core/save_preview.mjs";
import {MapNpcRuntime} from "../core/map_npcs.mjs";
import {MapObjectRuntime} from "../core/map_objects.mjs";
import {storyBindings,registeredRoles} from "../core/content_registry.mjs";
import {chapterRouteExits} from "../core/map_connections.mjs";

export function createMapController({state, actions, $, canvas, ctx}) {
  function role() { return state.catalog.roles.find(role=>role.id===state.selectedRole); }
  function sheetAction(index=state.view.action) { return role().actions.find(action=>action.index===index); }
  function buildHud() {
    const snapshot=state.world.snapshot();
    let effective=[];state.battleUnavailable='';
    const newParty=snapshot.source.kind==='native-new-game';
    if(state.battleData)try{effective=newParty?createPartyActors(snapshot,state.partyCombat,{},state.itemData):createBattleSample(snapshot,state.battleData).actors;if(!effective.some(a=>a.side==='player'&&a.hp.current>0))state.battleUnavailable='队伍已经倒下，请载入进度。';}catch(error){state.battleUnavailable=error.message;}
    $('battleOpen').disabled=state.scenes.phase!=='map'||Boolean(state.battleUnavailable)||newParty;$('battleOpen').title=newParty?'新游戏请在白木森林中行走遇敌。':state.battleUnavailable;
    state.mapVitals.clear();for(const actor of effective)state.mapVitals.set(actor.id,{hp:{...actor.hp},mp:{...actor.mp}});
    state.selectedRole=snapshot.leader_id;
    $('role').replaceChildren(...snapshot.party.map(actor=>{const option=document.createElement('option');option.value=actor.id;option.textContent=actor.name;return option;}));
    $('role').value=state.selectedRole;
    $('inventory').replaceChildren(...snapshot.inventory.map(item=>{const li=document.createElement('li'),count=document.createElement('span');li.append(document.createTextNode(item.name));count.textContent=`× ${item.quantity}`;li.append(count);return li;}));
    $('itemCount').textContent=`${snapshot.inventory.length} 项`;
    $('money').textContent=`金钱 ${snapshot.money??state.rewardData?.initial_money??'—'}`;
    $('stateInfo').textContent=`世界版本 ${snapshot.revision} · 2000 项事件旗标 · ${snapshot.event_records.reduce((n,row)=>n+row.length,0)} 条原始事件状态`;
  }
  async function prepareMap(id,{world=state.world.value,onProgress}={}) {
    const entry=state.catalog.maps.find(map=>map.id===id); if(!entry) throw new Error(`地图尚未纳入本版：${id}`);
    const data=await actions.json(entry.path);
    if(data.schema!=='seventh-seal-runtime-map'||data.version!==1||data.id!==id) throw new Error('地图数据版本或标识不匹配');
    const extraExits=[...(state.chapterResources.exits_by_map[id]??[]),...chapterRouteExits(id,state.chapterStory,state.chapterResources)];
    data.exits=[...(data.exits??[]).filter(exit=>!extraExits.some(extra=>extra.id===exit.id)),...extraExits];
    data.opening_npcs=state.chapterResources.npcs_by_map[id]??data.opening_npcs;
    data.story_triggers=(state.chapterResources.trigger_regions[id]??[]).filter(trigger=>storyBindings(id).triggers.includes(trigger.id));
    const readyCells=new Set([...(data.exits??[]).filter(exit=>exit.state==='ready').flatMap(exit=>exit.cells.map(cell=>`${cell.x},${cell.y}`)),
      ...data.story_triggers.flatMap(trigger=>trigger.cells.map(cell=>`${cell.x},${cell.y}`))]);
    // Unknown trigger handlers must be visible failures, not silent pass-through.
    // The source JSON retains the original gate; this is a runtime coverage guard.
    const movement=new MovementMap({...data.movement,triggers:data.movement.triggers.map(trigger=>
      ({...trigger,path_gate:!readyCells.has(`${trigger.x},${trigger.y}`)}))});
    const actorIds = new Set([...registeredRoles('player'), ...(data.opening_npcs ?? []).map(npc => npc.resource_id)]);
    const table = state.chapterStory.maps[id];
    const effectMap=state.mapEffects?.maps[id],effectObjects=effectMap?.objects??[];
    const completedAnimations=(state.chapterResources.object_animations[id]??[]).filter(animation=>
      table&&world.event_records[table.map_flag_index]?.[animation.object_index_zero_based]?.slice(0,2)==='03');
    const total=1+(data.objects??[]).length+state.events.filter(e=>e.map_id===id&&e.npc?.resource?.sheet).length+
      [...actorIds].reduce((n,roleId)=>n+(state.openingResources.roles[roleId]?.actions??[])
        .reduce((count,action)=>count+1+Number(Boolean(action.intrinsic_sheet)),0),0)+completedAnimations.length+
      effectObjects.reduce((count,obj)=>count+state.mapEffects.object_banks[obj.bank].actions.length*2,0);
    let completed=0;onProgress?.({completed,total});
    const step=async promise=>{const value=await promise;onProgress?.({completed:++completed,total});return value;};
    const bitmap=await step(actions.image(typeof data.background==='string'?data.background:data.background.image, `map:${id}`));
    if(bitmap.width!==movement.width*16||bitmap.height!==movement.height*16) throw new Error('背景尺寸与逻辑地图不匹配');
    const objects=await Promise.all((data.objects??[]).map(async obj=>({...obj,bitmap:await step(actions.image(obj.image, `map:${id}`))})));
    const npcs=await Promise.all(state.events.filter(event=>event.map_id===id&&event.npc).map(async event=>({event,...event.npc,bitmap:event.npc.resource?.sheet?await step(actions.image(event.npc.resource.sheet, `map:${id}`)):null})));
    state.actorResourcesByMap.set(id, actorIds);
    await Promise.all([...actorIds].flatMap(roleId => (state.openingResources.roles[roleId]?.actions ?? [])
      .flatMap(action => [step(state.resources.attach(action, action.sheet, `role:${roleId}`)),
        ...(action.intrinsic_sheet?[step(state.resources.attach(action,action.intrinsic_sheet,`role:${roleId}`,'intrinsic_bitmap'))]:[])])));
    await Promise.all(completedAnimations.map(animation=>step(actions.image(animation.frames[animation.completed_last_frame].image, `map:${id}`))));
    for(const npc of data.opening_npcs??[]){
      const r=state.openingResources.roles[npc.resource_id],a=r?.actions.find(a=>a.index===0);
      if(!a?.bitmap)throw new Error(`地图人物资源未准备：${npc.resource_id}`);
      npcs.push({...npc,bitmap:a.bitmap,resource:{frame_width:r.frame_width,frame_height:r.frame_height,frames_per_direction:a.frame_count,interval_ms:a.interval_raw,anchor_x:r.anchor.x,anchor_y:r.anchor.y}});
    }
    const probes=[...(data.probes??[]),...state.events.filter(event=>event.map_id===id&&event.sample?.probe).map(event=>event.sample.probe)];
    const scene={data,movement,bitmap,objects,npcs,probes};
    scene.npcRuntime=new MapNpcRuntime({scene,table,roles:state.openingResources.roles});
    if(effectObjects.length){
      const resources=await Promise.all(effectObjects.map(async obj=>{
        const source=state.mapEffects.object_banks[obj.bank],resource={...source,actions:source.actions.map(action=>({...action}))};
        await Promise.all(resource.actions.flatMap(action=>['main','intrinsic'].map(async channel=>{
          action[channel+'_bitmap']=await step(actions.image(action[channel+'_sheet'],`map:${id}`));
        })));
        return {...obj,resource};
      }));
      scene.objectRuntime=new MapObjectRuntime({objects,resources,mapFlagIndex:effectMap.map_flag_index});
      scene.objectRuntime.update(0,{world,paused:true});
    }
    return scene;
  }
  function validateEntry(scene,at) { if(scene.movement.at(at.x,at.y).blocked) throw new Error(`目标位置不在可通行格：${at.map_id} ${at.x},${at.y}`); }
  function commitView(scene,at) {
    state.view.action=0;state.view.frame=0;state.view.follow=true;state.view.zoom=1;
    Object.assign(state.view,openingCamera(at,scene.bitmap.width,scene.bitmap.height));
    state.clock=0;state.nearest=null;state.lastExit='';
    $('mapName').textContent=scene.data.name||scene.data.id;
    state.audio?.setScene({mapId:scene.data.id,battle:false});
    $('probe').replaceChildren(...scene.probes.map((p,i)=>{const opt=document.createElement('option');opt.value=i;opt.textContent=p.name;return opt;}));
    $('resetEventSample').hidden=!state.events.some(event=>event.map_id===scene.data.id&&event.sample?.clear_bits);
  }
  async function changeMap(at,reason='exit',restoredWorld=null) {
    const from=state.world.location.map_id;
    try { await state.scenes.loadLocation(at,{reason,restoredWorld}); buildHud(); updateNearest(); actions.log({type:'scene-enter',from,map_id:at.map_id,x:at.x,y:at.y,reason}); actions.status(reason==='restore'?'进度已载入，可以继续探索。':'已进入场景。'); canvas.focus({preventScroll:true}); }
    catch(error){actions.log({type:'scene-failed',error:error.message,from,to:at.map_id});actions.status(`${error.message}，当前场景已保留。`,true);}
  }
  function follow() {const im=state.scenes.current.bitmap;Object.assign(state.view,openingCamera(state.world.location,im.width,im.height));}
  function fit(){if(!state.scenes?.current)return;const im=state.scenes.current.bitmap;state.view.zoom=Math.min(640/im.width,480/im.height)*.97;state.view.x=im.width/2;state.view.y=im.height/2;state.view.follow=false;}
  function resize(){const rect=$('screen').getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);state.cssWidth=rect.width;state.cssHeight=rect.height;for(const target of [canvas,$('battleCanvas')]){target.width=Math.round(rect.width*dpr);target.height=Math.round(rect.height*dpr);}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.imageSmoothingEnabled=false;}
  function npcAvailable(npc) {
    if(npc.hidden)return false;
    const conditions=npc.event?.conditions??[];
    return conditions.every(condition=>state.world.value.flags[condition.index]===condition.value);
  }
  function updateNearest(){
    state.nearest=null;if(!state.scenes.current)return;const at=state.world.location;
    for(const npc of state.scenes.current.npcs){if(!npcAvailable(npc))continue;
      const admitted=storyBindings(at.map_id).npcs;
      if(!npc.event&&admitted&&!admitted.includes(npc.slot_zero_based))continue;
      const distance=Math.hypot(npc.x-at.x,npc.y-at.y);if(distance<64&&(!state.nearest||distance<state.nearest.distance))state.nearest={...npc,distance};}
    for(const object of state.chapterStory.maps[at.map_id]?.objects??[]){
      if(!storyBindings(at.map_id).objects.some(row=>row.index===object.index))continue;
      if(object.behavior_raw_cf!==3||!object.interaction_record_raw_f6)continue;
      const distance=Math.hypot(object.x_native*2-at.x,object.y_native*2-at.y);
      if(distance<64&&(!state.nearest||distance<state.nearest.distance))state.nearest={...object,kind:'object',name:'装备箱',distance};
    }
    for(const binding of storyBindings(at.map_id).rests){
      const bed=state.chapterStory.maps[at.map_id]?.descriptors?.find(row=>row.id===binding.descriptor_id);
      if(bed){const distance=Math.min(...bed.cells.map(cell=>Math.hypot((cell.x+.5)*16-at.x,(cell.y+.5)*16-at.y)));if(distance<40&&(!state.nearest||distance<state.nearest.distance))state.nearest={kind:'rest',name:'床铺',descriptorId:bed.id,distance};}
    }
    $('interactionHint').hidden=!state.nearest||state.scenes.phase!=='map';
    if(state.nearest)$('interactionHint').textContent=state.nearest.kind==='rest'?'E · 休息':state.nearest.kind==='object'?'E · 查看装备箱':`E · 与${state.nearest.name??'人物'}交谈`;
  }
  function objectBitmap(scene,obj,world=state.world.value,live=true){
    if(live&&state.objectPreview?.mapId===scene.data.id&&state.objectPreview.objectIndex===obj.index)return state.objectPreview.bitmap;
    const table=state.chapterStory.maps[scene.data.id],record=table&&world.event_records[table.map_flag_index]?.[obj.index];
    if(record?.slice(0,2)==='03'){
      const animation=state.chapterResources.object_animations[scene.data.id]?.find(row=>row.object_index_zero_based===obj.index);
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
    const from=state.world.location.map_id;await state.worldMap.select(index);buildHud();updateNearest();
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
  function drawCollision(scene){const size=16;for(let y=0;y<scene.movement.height;y++)for(let x=0;x<scene.movement.width;x++){const cell=scene.movement.cell(x,y);ctx.fillStyle=cell.trigger?'#e6bd6855':cell.blocked?'#d14d4738':'#78c79623';ctx.fillRect(x*size,y*size,size,size);}}
  function paint(){
    const scene=state.scenes?.current;
    const world=state.sceneEntryDraft??state.world.value;
    const draw=state.openingView?.active&&state.openingView.nativeViewport?drawOpeningScene:drawGameScene;
    draw(ctx,{scene,world,role:role(),action:sheetAction(),view:state.view,width:state.cssWidth,height:state.cssHeight,objectBitmap:(scene,obj)=>objectBitmap(scene,obj,world),
      openingQueue:state.openingView?.active?state.openingView.drawQueue(scene.data.role_layer_preview??2):null,
      collision:scene&&state.view.collision?()=>drawCollision(scene):null,nearest:state.nearest});
    if(!scene)return;const at=world.location;
    $('zoomValue').textContent=`${Math.round(state.view.zoom*100)}%`;$('position').textContent=`${at.map_id} · ${at.x.toFixed(1)}, ${at.y.toFixed(1)}`;
    $('position').dataset.x=at.x;$('position').dataset.y=at.y;$('position').dataset.map=at.map_id;
  }
  function renderSavePreview(scene,world,{view=null,action=null}={}){
    const r=state.catalog.roles.find(role=>role.id===world.leader_id),a=action??r?.actions.find(action=>action.index===0);
    if(!r||!a?.bitmap)throw new Error('存档人物图像未准备');
    const camera=view??{zoom:1,frame:0,...openingCamera(world.location,scene.bitmap.width,scene.bitmap.height)};
    const frame=document.createElement('canvas');frame.width=640;frame.height=480;const drawing=frame.getContext('2d');drawing.imageSmoothingEnabled=false;
    drawGameScene(drawing,{scene,world,role:r,action:a,view:camera,width:640,height:480,time:0,objectBitmap:(scene,obj)=>objectBitmap(scene,obj,world,false)});
    const thumbnail=document.createElement('canvas');thumbnail.width=SAVE_PREVIEW_WIDTH;thumbnail.height=SAVE_PREVIEW_HEIGHT;
    thumbnail.getContext('2d').drawImage(frame,0,0,SAVE_PREVIEW_WIDTH,SAVE_PREVIEW_HEIGHT);return thumbnail;
  }
  function captureSavePreview(world){
    const scene=state.scenes.current;if(scene?.data.id!==world.location.map_id)throw new Error('当前场景与存档地图不一致');
    return renderSavePreview(scene,world,{view:{...state.view},action:sheetAction()}).toDataURL('image/png');
  }
  async function loadSavePreview(envelope){
    const world=await decodeSave(envelope,state.catalog.maps.map(map=>map.id)),stored=savedPreviewPng(envelope);
    if(stored){
      try{const image=new Image();image.src=stored;await image.decode();return {image,source:'stored',map_id:world.location.map_id};}catch{}
    }
    const scene=await prepareMap(world.location.map_id,{world});
    return {image:renderSavePreview(scene,world),source:'reconstructed',map_id:world.location.map_id};
  }
  let retainedScene = null, retainedRevision = -1;
  function reconcileResources() {
    const scene = state.scenes.current;
    if (!scene || scene === retainedScene && retainedRevision === state.resources.revision) return;
    retainedScene = scene;
    const roleIds = state.actorResourcesByMap.get(scene.data.id) ?? new Set(registeredRoles('player'));
    state.resources.retainScopes(['shared', `map:${scene.data.id}`, ...[...roleIds].map(id => `role:${id}`)]);
    for (const [id, role] of Object.entries(state.openingResources.roles))
      if (!roleIds.has(id)) for (const action of role.actions) {delete action.bitmap;delete action.intrinsic_bitmap;}
    for (const id of state.actorResourcesByMap.keys()) if (id !== scene.data.id) state.actorResourcesByMap.delete(id);
    retainedRevision = state.resources.revision;
  }
  function render(now){
    const delta=Math.min((now-state.lastTime)/1000||0,.08);state.lastTime=now;
    if(state.menuContext)state.operationMenu?.tick(now);
      state.startupView?.tick(now);
    state.scenes?.current?.npcRuntime?.update(now,{player:state.world.location,visible:npcAvailable,
      paused:!['map','event'].includes(state.scenes.phase)||Boolean(state.openingView?.active)});
    state.scenes?.current?.objectRuntime?.update(now,{world:state.sceneEntryDraft??state.world.value,
      paused:!['map','event'].includes(state.scenes.phase)||Boolean(state.openingView?.active)});
    if(state.scenes?.phase==='map'){
      reconcileResources();
      const dx=Number(state.keys.has('ArrowRight')||state.keys.has('d'))-Number(state.keys.has('ArrowLeft')||state.keys.has('a'));
      const dy=Number(state.keys.has('ArrowDown')||state.keys.has('s'))-Number(state.keys.has('ArrowUp')||state.keys.has('w'));
      const at=state.world.location;let action=0;
      const active=state.world.value.party.find(actor=>actor.id===state.selectedRole),effectivePlayer=state.mapVitals.get(state.selectedRole)??active;
      if((dx||dy)&&effectivePlayer.hp.current>0){const length=Math.hypot(dx,dy),running=state.keys.has('Shift'),velocity=running?270:150;
        const moved=state.scenes.current.movement.move(at.x,at.y,dx/length*velocity*delta,dy/length*velocity*delta),choice=locomotion({dx,dy,running},moved.moved);
        state.world.setPosition(moved.x,moved.y,choice.direction);action=choice.action;state.view.follow=true;
        const reached=state.scenes.current.movement.at(moved.x,moved.y),exit=reached.trigger?transitionFor(reached):null;
        const storyTrigger=state.scenes.current.data.story_triggers.find(trigger=>trigger.cells.some(cell=>cell.x===reached.x&&cell.y===reached.y));
        if(storyTrigger){
          const tag=`${at.map_id}:${storyTrigger.id}`;
          if(tag!==state.lastStoryTrigger){state.lastStoryTrigger=tag;actions.runChapter({mapId:at.map_id,recordId:storyTrigger.field_26_raw});}
        }else state.lastStoryTrigger='';
        if(exit){
          const tag=`${at.map_id}:${exit.id}`;
          if(tag!==state.lastExit){state.lastExit=tag;if(exit.kind==='world-map-event')routeExit(exit);else changeMap({map_id:exit.target_map,...exit.entry},'exit');}
        }
        else if(moved.blocked&&moved.hit?.trigger){if(state.lastBoundary!==`${at.map_id}:${moved.hit.trigger.id}`){state.lastBoundary=`${at.map_id}:${moved.hit.trigger.id}`;actions.status('这条出口的执行规则尚未纳入当前片段。');}}
        else {state.lastBoundary='';state.lastExit='';}
        if(moved.moved&&state.encounterData&&state.scenes.phase==='map'&&!state.battleUnavailable){
          const preview=previewMovement(state.world.value.encounters??initialEncounterState(state.world.value.party),{
            party:state.world.value.party,leader_id:state.selectedRole,map_id:at.map_id,dx:moved.x-at.x,dy:moved.y-at.y,transition:Boolean(exit),phase:'map'},state.encounterData);
          if(preview.encounter){actions.guarded(()=>actions.startBattle(preview.encounter,preview.state))();}
          else if(preview.steps||moved.x!==at.x||moved.y!==at.y)state.world.setEncounterState(preview.state);
        }
      }
      if(state.view.action!==action){state.view.action=action;state.view.frame=0;state.clock=0;}
      const a=sheetAction();state.clock+=delta*1000;const interval=Math.max(20,a.interval_ms_preview??a.interval_raw??180);
      if(state.clock>=interval){state.view.frame=(state.view.frame+Math.floor(state.clock/interval))%a.frames_per_direction;state.clock%=interval;}
      if(state.view.follow)follow();updateNearest();
    }
    if(state.scenes?.phase.startsWith('battle-')){
      if(state.scenes.phase!=='battle-loading'&&!state.battlePresentationError)try{
        state.battle?.advanceClock(now);
        state.battleView?.draw(state.battle?.presentationSnapshot(),now);actions.drawBattleInterface(now);
      }catch(error){
        state.battlePresentationError=error.message;state.battleView?.stop(error.message);state.battle?.interrupt(error);actions.status(error.message,true);
      }
    }else if(!state.startupView||state.startupView.sequence.stage==='closed')paint();state.raf=requestAnimationFrame(render);
  }
  return {role, sheetAction, buildHud, prepareMap, validateEntry, commitView, changeMap, follow, fit, resize, npcAvailable, updateNearest, objectBitmap, transitionFor, renderWorldMap,selectWorldMapDestination,closeWorldMap, routeExit, drawCollision, paint, render,captureSavePreview,loadSavePreview};
}
