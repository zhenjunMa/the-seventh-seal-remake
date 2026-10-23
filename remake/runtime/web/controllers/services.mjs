// services adapters. Persistent state belongs to the shared runtime context.
import {encodeSave} from "../core/world.mjs";
import {createPartyActors} from "../core/party_attributes.mjs";
import {loadRuntimeConfiguration, compileRuntimeConfiguration} from "../core/runtime_config.mjs";
import {attachSavePreview} from "../core/save_preview.mjs";
import {MANUAL_SAVE_SLOTS,normalizeSaveSlot,saveSlotLabel} from "../core/save_slots.mjs";

export function createServicesController({state, actions, $, canvas, ctx}) {
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
  async function readConfiguredData(){
    const config=await loadRuntimeConfiguration(json,state.catalog.runtime_config??'data/config/index.json');
    return compileRuntimeConfiguration({combat:state.battleData,forest:state.forestData,scheduler:state.schedulerData,ai:state.aiData,
      rewards:state.world.value.source.kind==='native-new-game'?state.partyRewards:state.rewardData,party_skills:state.partySkills,items:state.sourceItemData},config);
  }
  function image(path, scope = 'shared') { return state.resources.load(path, scope); }
  function busy(phase) {
    state.engine?.setPhase(phase);
    state.keys.clear(); state.clock=0;state.view.action=0;state.view.frame=0;state.lastTime=performance.now();
    $('scenePhase').textContent=state.phaseNames[phase]??phase;
    $('loading').hidden=!['loading','boot'].includes(phase);
    $('partyMenuOpen').disabled=phase!=='map'||state.world?.value.source.kind!=='native-new-game';
    $('interactionHint').hidden=phase!=='map'||!state.nearest;
    for(const id of ['save','load','role','jumpProbe','resetEventSample','exportSave','importSave','layerOpen','battleOpen','zoomOut','zoomIn','fit','follow','collision','probe','routeSample','citySample','contentSample']) $(id).disabled=phase!=='map';
    $('battleOpen').disabled=phase!=='map'||Boolean(state.battleUnavailable)||state.world?.value.source.kind==='native-new-game';
    $('newGame').disabled=!['map','menu'].includes(phase);
    $('menuNew').disabled=phase!=='menu';$('menuLoad').disabled=phase!=='menu';
    $('load').disabled=!['map','menu'].includes(phase);$('importSave').disabled=!['map','menu'].includes(phase);
  }
  function download(value,filename){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function guarded(fn){return async()=>{try{await fn();}catch(error){status(error.message,true);log({type:'operation-failed',error:error.message});}};}
  async function saveEnvelope(){if(!state.scenes.canSave()&&!(state.saveOperation?.kind==='save'&&state.scenes.current&&(state.saveOperation.phase==='map'||state.saveMenuContext?.originPhase==='map'&&state.saveMenuContext.mode==='save')))throw new Error('请在地图探索状态保存');const world=state.world.snapshot();if(world.source.kind==='native-new-game')createPartyActors(world,state.partyCombat,{},state.itemData);const preview=actions.captureSavePreview(world);return attachSavePreview(await encodeSave(world),preview);}
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
      state.saveSlots[slot]=envelope;
      const label=slot==='quick'?'快速存档':`存档 ${saveSlotLabel(slot)}`;
      $('saveStatus').textContent=`${label}已保存 · ${new Date(envelope.saved_at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'})}`;
      log({type:'save',slot,path:result.path,map_id:state.world.location.map_id,revision:state.world.value.revision});
      status(`${label}已保存到 ${result.path}。`);return envelope;
    },{fromMenu});
  }
  async function loadProgress(slot='00',{fromMenu=false}={}){
    slot=normalizeSaveSlot(slot);
    return withSaveOperation('load',async operation=>{
      const envelope=await state.saveStorage.read(slot);state.saveSlots[slot]=envelope;
      if(!envelope)throw new Error(slot==='quick'?'尚无快速存档，请先按 F4 保存':'尚无普通存档，请先在通讯水晶或侧栏保存');
      await actions.restore(envelope,{operation});
    },{fromMenu});
  }
  async function refreshSaveSlots({quiet=false}={}){
    const slots=[...MANUAL_SAVE_SLOTS,'quick'],errors=[];let rows;
    try{rows=await state.saveStorage.list();}catch(error){rows=slots.map(slot=>({slot,envelope:null,error:error.message}));}
    state.saveErrors??={};
    for(const row of rows){state.saveSlots[row.slot]=row.envelope;state.saveErrors[row.slot]=row.error??null;if(row.error)errors.push(`${saveSlotLabel(row.slot)}：${row.error}`);}
    if(errors.length){$('saveStatus').textContent=errors.join('；');if(!quiet)status(errors.join('；'),true);log({type:'save-list-failed',error:errors.join('；')});}
    else $('saveStatus').textContent=slots.some(slot=>state.saveSlots[slot])?'已有重制存档，可从游戏读取继续。':'尚无重制存档；F4 快速保存，F5 快速读取。';
    return errors;
  }
  function saveEntries(){return [...MANUAL_SAVE_SLOTS,'quick'].map(slot=>({slot,label:slot==='quick'?'快速存档':`存档 ${slot}`,envelope:state.saveSlots[slot]??null,error:state.saveErrors?.[slot]??null}));}
  function option(value,text,disabled=false){const node=document.createElement('option');node.value=value;node.textContent=text;node.disabled=disabled;return node;}
  function updateInterface(now){
    if(state.menuContext)state.operationMenu?.tick(now);
    state.startupView?.tick(now);
  }
  function releaseInput(){
    state.keys.clear();actions.releaseDialogueKeys?.();actions.battleKeyUp?.(' ');
  }
  return {status, log, json, readConfiguredData, image, busy, download, guarded, saveEnvelope, withSaveOperation,saveProgress,loadProgress,refreshSaveSlots,saveEntries,option,updateInterface,releaseInput};
}
