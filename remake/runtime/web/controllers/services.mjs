// services adapters. Persistent state belongs to the shared runtime context.
import {encodeSave,DEFAULT_GAME_SETTINGS} from "../core/world.mjs";
import {loadRuntimeConfiguration, createRuntimeConfigurationSession} from "../core/runtime_config.mjs";
import {attachSavePreview} from "../core/save_preview.mjs";
import {MANUAL_SAVE_SLOTS,normalizeSaveSlot,saveSlotLabel} from "../core/save_slots.mjs";
import {captureMapNpcState} from '../core/map_npc_state.mjs';

export function createServicesController({state, actions, $, canvas, ctx,now=()=>performance.now()}) {
  let configurationReady;
  let playTime={base:state.world?.value?.play_time_ms??0,elapsed:0,startedAt:null};
  function currentPlayTime(){return Math.floor(playTime.base+playTime.elapsed+(playTime.startedAt===null?0:now()-playTime.startedAt));}
  function resetPlayTime(milliseconds=state.world.value.play_time_ms??0){
    playTime={base:milliseconds,elapsed:0,startedAt:['boot','startup','menu','game-over','story-complete'].includes(state.scenes.phase)?null:now()};
  }
  function status(message, error=false) { $('status').textContent=message; $('status').classList.toggle('error',error); }
  function log(event) {
    const entry={sequence:state.logs.length+1,at:new Date().toISOString(),...event}; state.logs.push(entry);
    const item=document.createElement('li');
    item.textContent = event.type === 'event-commit' ? `${event.event} · ${event.changes.map(c=>`旗标${c.index}: ${c.before}→${c.after}`).join('，') || '无旗标变化'}`
      : event.type === 'scene-enter' ? `${event.from ?? '起点'} → ${event.map_id} (${Math.round(event.x)}, ${Math.round(event.y)})`
      : event.type==='battle-impact'?`${event.actor_id} · ${event.hit?`伤害 ${event.damage}`:'未命中'} · 目标HP ${event.hp_before}→${event.hp_after}`
      : event.type==='battle-world-commit'?`返回地图 · ${event.outcome==='victory'?'胜利':event.outcome==='defeat'?'倒下':'测试结束'} · 结果已回写`
      : event.error ?? `${event.type} ${event.event??''} ${event.op??''}`;
    $('eventLog').append(item); while($('eventLog').children.length>50) $('eventLog').firstChild.remove();
  }
  async function json(path,{cache='no-cache'}={}) { const response=await fetch(path,{cache}); if(!response.ok) throw new Error(`资源加载失败：${path}（${response.status}）`); return response.json(); }
  async function initializeRuntimeConfiguration(){
    // Coalesce startup calls, including a failed startup. Refreshing the page
    // creates a new owner; menu/battle/save operations never reload this input.
    configurationReady??=(async()=>{
      const config=await loadRuntimeConfiguration(json,state.catalog.runtime_config??'data/config/index.json');
      return createRuntimeConfigurationSession({combat:state.battleData,forest:state.forestData,scheduler:state.schedulerData,ai:state.aiData,
        rewards:state.rewardData,party_skills:state.partySkills,items:state.sourceItemData,
        ...(state.sourceSkills?{source_skills:state.sourceSkills}:{}),...(state.sourceMagic?{source_magic:state.sourceMagic}:{})},config,state.partyRewards);
    })();
    return readConfiguredData();
  }
  async function readConfiguredData(options){
    if(!configurationReady)throw new Error('运行配置尚未初始化，请刷新游戏页面');
    const configuration=await configurationReady;
    return configuration.snapshot(options);
  }
  function image(path, scope = 'shared') { return state.resources.load(path, scope); }
  function busy(phase) {
    const at=now();if(playTime.startedAt!==null)playTime.elapsed+=at-playTime.startedAt;
    const paused=['boot','startup','menu','game-over','story-complete'].includes(phase)||['save-menu','save-io'].includes(phase)&&playTime.startedAt===null;
    playTime.startedAt=paused?null:at;
    if(!['map','event'].includes(phase))state.rewardNoticeView?.close();
    if(!['map','event','opening'].includes(phase))state.mapNameNoticeView?.close();
    state.engine?.setPhase(phase);
    state.keys.clear(); state.clock=0;state.view.action=0;state.view.frame=0;state.lastTime=performance.now();
    $('scenePhase').textContent=state.phaseNames[phase]??phase;
    $('loading').hidden=!['loading','boot'].includes(phase);
    $('partyMenuOpen').disabled=phase!=='map';
    $('interactionHint').hidden=phase!=='map'||!state.nearest;
    for(const id of ['save','load','role','jumpProbe','resetEventSample','exportSave','importSave','layerOpen','battleOpen','zoomOut','zoomIn','fit','follow','collision','probe','routeSample','citySample','contentSample','partySkillSampleA','partySkillSampleB']) $(id).disabled=phase!=='map';
    $('battleOpen').disabled=true;
    $('newGame').disabled=!['map','menu'].includes(phase);
    $('menuNew').disabled=phase!=='menu';$('menuLoad').disabled=phase!=='menu';
    $('load').disabled=!['map','menu'].includes(phase);$('importSave').disabled=!['map','menu'].includes(phase);
  }
  function download(value,filename){const url=URL.createObjectURL(value instanceof Blob?value:new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function exportRuntimeLog(){
    // Export the latest fight, even after a technique/scripted session has
    // restored its previous controller. Serialize history one entry at a time.
    const parts=['{"schema":"seventh-seal-runtime-log","version":3,"events":['];
    const append=value=>parts.push(new Blob([JSON.stringify(value)],{type:'application/json'}));
    const appendBattle=battle=>{
      if(!battle){parts.push('null');return;}
      const {history,...metadata}=battle;
      parts.push(JSON.stringify(metadata).slice(0,-1),',"history":[');
      history.forEach((entry,index)=>{if(index)parts.push(',');append(entry);});parts.push(']}');
    };
    state.logs.forEach((entry,index)=>{if(index)parts.push(',');append(entry);});
    parts.push('],"current_battle":');appendBattle(state.lastBattle?.battle??null);
    parts.push(',"battle_result":');append(state.lastBattle?.result??null);
    parts.push(',',JSON.stringify({world:state.world.snapshot(),audio:state.audio?.snapshot()??null,scope:state.catalog.scope}).slice(1));
    download(new Blob(parts,{type:'application/json'}),'seventh-seal-runtime-log.json');
  }
  function guarded(fn){return async()=>{try{await fn();}catch(error){status(error.message,true);log({type:'operation-failed',error:error.message});}};}
  async function saveEnvelope(){
    if(!state.scenes.canSave()&&!(state.saveOperation?.kind==='save'&&state.scenes.current&&(state.saveOperation.phase==='map'||state.saveMenuContext?.originPhase==='map'&&state.saveMenuContext.mode==='save')))throw new Error('请在地图探索状态保存');
    const world=state.world.snapshot();
    world.play_time_ms=currentPlayTime();
    world.game_settings={audio:structuredClone(state.audio?.snapshot().channels??DEFAULT_GAME_SETTINGS.audio),battle_cursor:state.menuSettings?.snapshot().battleCursor??DEFAULT_GAME_SETTINGS.battle_cursor};
    if(state.scenes.current?.npcs)captureMapNpcState(world,state.scenes.current.data.id,state.scenes.current.npcs);
    const preview=actions.captureSavePreview(world);return attachSavePreview(await encodeSave(world),preview);
  }
  async function withSaveOperation(kind,work,{fromMenu=false}={}){
    if(state.saveOperation)throw new Error('正在存取进度，请稍候');
    const phase=state.scenes.phase;
    const menuAllowed=fromMenu&&phase==='save-menu'&&state.saveMenuContext?.mode===kind;
    if(!menuAllowed&&(kind==='save'?!state.scenes.canSave():!['map','menu'].includes(phase)))throw new Error(kind==='save'?'请在地图探索状态保存':'当前操作完成后才能载入');
    const operation={kind,phase};state.saveOperation=operation;state.scenes.setPhase('save-io');
    state.startupView?.updateButtons?.();state.startupView?.updateOptionPositions?.();
    try{return await work(operation);}
    finally{state.saveOperation=null;if((fromMenu&&state.saveMenuContext&&state.scenes.phase!=='opening')||state.scenes.phase==='save-io')state.scenes.setPhase(phase);state.startupView?.updateButtons?.();state.startupView?.updateOptionPositions?.();canvas.focus({preventScroll:true});}
  }
  async function saveProgress(slot='00',{fromMenu=false,expectedSha,createOnly=false}={}){
    slot=normalizeSaveSlot(slot);
    return withSaveOperation('save',async()=>{
      const envelope=await saveEnvelope(),result=await state.saveStorage.write(envelope,slot,createOnly,{expectedSha});
      state.saveSlots[slot]=result.summary;
      const label=slot==='quick'?'快速存档':`存档 ${saveSlotLabel(slot)}`;
      $('saveStatus').textContent=`${label}已保存 · ${new Date(result.summary?.saved_at??envelope.saved_at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'})}`;
      log({type:'save',slot,path:result.path,map_id:state.world.location.map_id,revision:state.world.value.revision});
      status(`${label}已保存到 ${result.path}。`);return envelope;
    },{fromMenu});
  }
  async function loadProgress(slot='00',{fromMenu=false}={}){
    slot=normalizeSaveSlot(slot);
    return withSaveOperation('load',async operation=>{
      const envelope=await state.saveStorage.read(slot);
      if(!envelope)throw new Error(slot==='quick'?'尚无快速存档，请先按 F4 保存':'尚无普通存档，请先在通讯水晶或侧栏保存');
      await actions.restore(envelope,{operation});
    },{fromMenu});
  }
  async function refreshSaveSlots({quiet=false}={}){
    const slots=[...MANUAL_SAVE_SLOTS,'quick'],errors=[];let rows;
    try{rows=await state.saveStorage.list();}catch(error){rows=slots.map(slot=>({slot,summary:null,error:error.message}));}
    state.saveErrors??={};
    for(const row of rows){state.saveSlots[row.slot]=row.summary;state.saveErrors[row.slot]=row.error??null;if(row.error)errors.push(`${saveSlotLabel(row.slot)}：${row.error}`);}
    if(errors.length){$('saveStatus').textContent=errors.join('；');if(!quiet)status(errors.join('；'),true);log({type:'save-list-failed',error:errors.join('；')});}
    else $('saveStatus').textContent=slots.some(slot=>state.saveSlots[slot])?'已有重制存档，可从游戏读取继续。':'尚无重制存档；F4 快速保存，F5 快速读取。';
    return errors;
  }
  function saveEntries(){return [...MANUAL_SAVE_SLOTS,'quick'].map(slot=>({slot,label:slot==='quick'?'快速存档':`存档 ${slot}`,summary:state.saveSlots[slot]??null,error:state.saveErrors?.[slot]??null}));}
  function option(value,text,disabled=false){const node=document.createElement('option');node.value=value;node.textContent=text;node.disabled=disabled;return node;}
  function updateInterface(now){
    if(state.menuContext)state.operationMenu?.tick(now);
    state.startupView?.tick(now);
  }
  function releaseInput(){
    state.keys.clear();actions.releaseDialogueKeys?.();actions.battleKeyUp?.(' ');
  }
  return {status, log, json, initializeRuntimeConfiguration, readConfiguredData, image, busy, download, exportRuntimeLog, guarded, saveEnvelope, withSaveOperation,saveProgress,loadProgress,refreshSaveSlots,saveEntries,option,updateInterface,releaseInput,currentPlayTime,resetPlayTime};
}
