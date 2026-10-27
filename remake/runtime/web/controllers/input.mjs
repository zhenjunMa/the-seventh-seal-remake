// input adapters. Persistent state belongs to the shared runtime context.
import {useWorldItem, changeEquipment} from "../core/items.mjs";
import {changeSkillShortcuts} from "../core/skill_shortcuts.mjs";
import {availableFieldSkills, useWorldSkill} from "../core/field_skills.mjs";
import {effectiveSkillSource} from "../core/battle_skill_access.mjs";
import {createContentSample} from "../core/content_sample.mjs";
import {createPartySkillSample,PARTY_SKILL_SAMPLE_ROSTERS} from "../core/party_skill_sample.mjs";
import {createFullscreenController} from "./fullscreen.mjs";

export function createInputController({state, actions, $, canvas, ctx}) {
  const listeners=new AbortController(),options={signal:listeners.signal};
  const fullscreen=createFullscreenController({$,canvas});
  function saveKey(key,repeat=false){
    if(!['F4','F5'].includes(key))return false;
    if(!repeat){if(state.engine?.paused)actions.status('请先返回游戏，再存取进度。',true);else actions.guarded(()=>key==='F4'?actions.saveProgress('quick'):actions.loadProgress('quick'))();}
    return true;
  }
  function wire(){
    $('partyMenuOpen').onclick=()=>actions.openPartyMenu();
    $('menuActor').onchange=()=>{$('menuShortcutEditor').hidden=true;actions.refreshPartyMenu();};$('menuSlot').onchange=actions.refreshPartyMenu;$('menuItem').onchange=actions.refreshPartyMenu;
    $('menuSkill').onchange=actions.refreshMenuSkill;$('menuSkillTarget').onchange=actions.refreshMenuSkill;
    $('menuEditShortcut').textContent='快捷设置（前三槽）';$('menuEditShortcut').onclick=actions.editSkillShortcuts;
    $('menuShortcutCancel').onclick=()=>{$('menuShortcutEditor').hidden=true;};
    $('menuShortcutSave').onclick=actions.menuOperation(()=>{const roleId=$('menuActor').value,indices=[1,2,3].map(n=>Number($('menuShortcut'+n).value));changeSkillShortcuts(state.world,effectiveSkillSource(state.partySkills,state.world.value),{roleId,indices});$('menuShortcutEditor').hidden=true;actions.log({type:'skill-shortcuts-changed',role_id:roleId,indices});return '快捷技能已设置，下一场战斗按此顺序显示。';});
    $('menuFieldSkill').onclick=actions.menuOperation(()=>{const casterId=$('menuActor').value,targetId=$('menuSkillTarget').value,index=Number($('menuSkill').value),skill=availableFieldSkills(state.world.value,state.menuContext.configured.party_skills,casterId).find(s=>s.original_skill_index===index);if(!skill)throw new Error('此技能不能在战斗外使用');const result=useWorldSkill(state.world,state.partyCombat,state.menuContext.configured.party_skills,state.itemData,{casterId,targetId,skillId:skill.id});actions.buildHud();actions.log({type:'world-skill-used',...result});return `${result.name}已使用，HP ${result.target_hp.before}→${result.target_hp.after}，消耗MP ${result.mp_cost}。`;});
    $('menuUseItem').onclick=actions.menuOperation(async()=>{
      const instanceId=$('menuItem').value,targetId=$('menuActor').value;
      if(state.menuContext.combat){actions.closePartyMenu();await state.battle.chooseItem(instanceId,targetId);return;}
      const result=useWorldItem(state.world,state.partyCombat,state.itemData,{instanceId,targetId});actions.buildHud();actions.log({type:'world-item-used',target_id:targetId,name:result.name,changes:result.changes});return `${result.name}已使用。`;
    });
    $('menuEquip').onclick=actions.menuOperation(()=>{changeEquipment(state.world,state.partyCombat,state.itemData,{roleId:$('menuActor').value,slotId:$('menuSlot').value,instanceId:$('menuEquipment').value});actions.buildHud();actions.log({type:'equipment-changed',role_id:$('menuActor').value,slot_id:$('menuSlot').value});return '装备已更换。';});
    $('menuUnequip').onclick=actions.menuOperation(()=>{changeEquipment(state.world,state.partyCombat,state.itemData,{roleId:$('menuActor').value,slotId:$('menuSlot').value});actions.buildHud();return '装备已卸下。';});
    $('newGame').onclick=actions.guarded(()=>actions.beginOpening());
    $('menuResume').onclick=actions.resumeExploration;
    $('battleOpen').onclick=actions.guarded(()=>actions.startBattle());
    $('routeSample').onclick=actions.guarded(async()=>{if(state.scenes.phase!=='map')return;const seed=await actions.json('data/route_seed.json');await actions.changeMap(seed.location,'development-sample',seed);actions.status('已进入剧情后的历史存档样本，开场剧情未重放。');});
    $('citySample').onclick=actions.guarded(async()=>{if(state.scenes.phase!=='map')return;const seed=await actions.json('data/world_seed.json');await actions.changeMap(seed.location,'development-sample',seed);actions.status('已进入原城市验证样本。');});
    $('contentSample').onclick=actions.guarded(async()=>{
      if(state.scenes.phase!=='map')return;
      const [initial,forest]=await Promise.all([actions.json('data/opening_seed.json'),actions.json('data/maps/m70010.json')]);
      const {x,y,direction}=forest.route_entry;
      const sample=createContentSample(initial,state.partyRewards,{map_id:forest.id,x,y,direction});
      await actions.changeMap(sample.location,'development-sample',sample);
      actions.log({type:'content-extension-sample',party:sample.party.map(role=>({id:role.id,level:role.level})),development_granted_skill:'001_26',persistent_save_written:false});
      actions.status('已进入三人扩展样本：英格妮12级、凯、娃蒂；燕落为测试授予，行走即可遇敌。');
    });
    for(const group of ['A','B'])$('partySkillSample'+group).onclick=actions.guarded(async()=>{
      if(state.scenes.phase!=='map')return;
      const [initial,forest]=await Promise.all([actions.json('data/opening_seed.json'),actions.json('data/maps/m70010.json')]);
      const {x,y,direction}=forest.route_entry;
      const sample=createPartySkillSample(initial,state.partyRewards,state.partySkills,{map_id:forest.id,x,y,direction},{activeRoleIds:PARTY_SKILL_SAMPLE_ROSTERS[group]});
      await actions.changeMap(sample.location,'development-sample',sample);
      actions.log({type:'party-skill-test-sample',group,party:sample.party.map(role=>({id:role.id,level:role.level})),persistent_save_written:false});
      actions.status(`已进入全技能测试${group}组：六人99级，当前出战${sample.party.map(role=>role.name).join('、')}。`);
      canvas.focus();
    });
    $('role').onchange=()=>{state.selectedRole=$('role').value;state.world.transact(draft=>{draft.leader_id=state.selectedRole;});state.view.action=0;state.view.frame=0;state.clock=0;canvas.focus();};
    $('zoomOut').onclick=()=>{state.view.zoom=Math.max(.15,state.view.zoom/1.2);};$('zoomIn').onclick=()=>{state.view.zoom=Math.min(3,state.view.zoom*1.2);};$('fit').onclick=actions.fit;$('follow').onclick=()=>{state.view.zoom=1;state.view.follow=true;canvas.focus();};
    $('fullscreen').onclick=actions.guarded(fullscreen.toggle);
    $('fullscreenExit').onclick=actions.guarded(fullscreen.toggle);
    document.addEventListener('fullscreenchange',fullscreen.changed,options);
    $('collision').onchange=()=>{state.view.collision=$('collision').checked;};
    $('jumpProbe').onclick=actions.guarded(async()=>{if(state.scenes.phase!=='map')return;const p=state.scenes.current.probes[Number($('probe').value)];if(!p)throw new Error('当前地图没有样本位置');actions.validateEntry(state.scenes.current,{...p,map_id:state.world.location.map_id});state.world.setPosition(p.x,p.y,p.direction??state.world.location.direction);state.view.follow=true;actions.updateNearest();actions.log({type:'development-relocation',map_id:state.world.location.map_id,...p});actions.status(`已定位开发样本：${p.name}`);canvas.focus();});
    $('resetEventSample').onclick=actions.guarded(async()=>{
      if(state.scenes.phase!=='map')return;const event=state.events.find(event=>event.map_id===state.world.location.map_id&&event.sample?.clear_bits);
      if(!event)throw new Error('当前地图没有首次交互样本');
      const before=state.world.snapshot();state.world.transact(next=>{for(const bit of event.sample.clear_bits)next.flags[bit.index]=(next.flags[bit.index]&~(1<<(bit.bit-1)))>>>0;});
      actions.log({type:'development-event-reset',event:event.id,changes:event.sample.clear_bits.map(bit=>({index:bit.index,bit:bit.bit,before:before.flags[bit.index],after:state.world.value.flags[bit.index]}))});
      actions.buildHud();actions.status('已恢复受控的首次／重复交互条件；这是开发样本设置。');canvas.focus();
    });
    $('save').onclick=actions.guarded(()=>actions.openSaveMenu({mode:'save'}));
    $('load').onclick=actions.guarded(()=>actions.openSaveMenu({mode:'load'}));
    $('exportSave').onclick=actions.guarded(async()=>actions.download(await actions.saveEnvelope(),'seventh-seal-runtime-save.json'));
    $('importSave').onclick=()=>$('saveFile').click();$('saveFile').onchange=actions.guarded(async()=>{const file=$('saveFile').files[0];$('saveFile').value='';if(!file)return;if(file.size>8_000_000)throw new Error('存档文件超过当前版本上限');await actions.restore(JSON.parse(await file.text()));});
    $('exportLog').onclick=()=>actions.download({schema:'seventh-seal-runtime-log',version:2,events:state.logs,battle_history:state.battleHistory,current_battle:state.battle?.snapshot()??null,world:state.world.snapshot(),audio:state.audio?.snapshot()??null,scope:state.catalog.scope},'seventh-seal-runtime-log.json');
    $('layerOpen').onclick=actions.guarded(actions.showLayers);$('layerClose').onclick=()=>{$('layerPanel').hidden=true;state.scenes.setPhase('map');canvas.focus();};
    $('layerPrevious').onclick=actions.guarded(async()=>{state.layerIndex=Math.max(0,state.layerIndex-1);await actions.drawLayer();});$('layerNext').onclick=actions.guarded(async()=>{state.layerIndex=Math.min(state.layerData.frames.length-1,state.layerIndex+1);await actions.drawLayer();});$('mainLayer').onchange=actions.guarded(actions.drawLayer);$('intrinsicLayer').onchange=actions.guarded(actions.drawLayer);
    $('layerSelect').onchange=actions.guarded(async()=>{state.layerIndex=Number($('layerSelect').value);await actions.drawLayer();});
    window.addEventListener('keydown',event=>{
      const key=event.key.length===1?event.key.toLowerCase():event.key;
      if(saveKey(key,event.repeat)){event.preventDefault();return;}
      if(state.engine?.paused)return;
      if(state.saveMenu?.key(key,event.repeat)){event.preventDefault();return;}
      if(state.startupView?.key(key,event.repeat)){event.preventDefault();return;}
      if(['event','opening'].includes(state.scenes?.phase)&&actions.dialogueKey(key,event.repeat)){event.preventDefault();return;}
      if(state.worldMapView?.key(key,event.repeat)){event.preventDefault();return;}
      if(state.menuContext){const kind=key==='Escape'?'cancel':[' ','Enter'].includes(key)?'confirm':key==='Tab'?'ignore':'select';const handle=()=>{if(key==='Escape'){if(!event.repeat&&state.operationMenu.escape())actions.closePartyMenu();return true;}return state.operationMenu.key(key,event.repeat);};const handled=state.menuFeedback?state.menuFeedback.run(kind,handle,{repeat:event.repeat}):handle();if(handled)event.preventDefault();return;}
      if(state.scenes?.phase.startsWith('battle-')){if(actions.battleKey(key,event.repeat))event.preventDefault();return;}
      if(state.scenes?.phase==='map'&&state.world.value.source.kind==='native-new-game'&&key==='Tab'&&!event.shiftKey){event.preventDefault();if(!event.repeat)actions.openPartyMenu();return;}
      if(['INPUT','SELECT','TEXTAREA','BUTTON'].includes(document.activeElement?.tagName))return;
      if(state.scenes?.phase!=='map')return;
      if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d','Shift','e'].includes(key)){event.preventDefault();if(key==='e'){if(!event.repeat)actions.interact();}else state.keys.add(key);}
    },options);
    window.addEventListener('keyup',event=>{if(actions.dialogueKeyUp(event.key))event.preventDefault();if(state.scenes?.phase.startsWith('battle-')){actions.battleKeyUp?.(event.key);if(event.key===' ')event.preventDefault();}if(state.menuContext&&event.key===' '&&$('menuShortcutEditor').hidden&&state.menuContext.page!=='system')event.preventDefault();state.keys.delete(event.key.length===1?event.key.toLowerCase():event.key);},options);
    window.addEventListener('blur',actions.releaseInput,options);
    document.addEventListener('visibilitychange',actions.releaseInput,options);
    window.addEventListener('resize',actions.resize,options);
    canvas.addEventListener('pointerdown',()=>canvas.focus(),options);
    canvas.addEventListener('wheel',event=>{event.preventDefault();if(!state.engine?.paused&&state.scenes.phase==='map')state.view.zoom=Math.min(3,Math.max(.15,state.view.zoom*(event.deltaY<0?1.1:1/1.1)));},{...options,passive:false});
  }
  function disposeInput(){listeners.abort();fullscreen.dispose();state.keys.clear();}
  return {wire,disposeInput,saveKey};
}
