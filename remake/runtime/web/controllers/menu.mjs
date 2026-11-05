// menu adapters. Persistent state belongs to the shared runtime context.
import {effectiveSkillSource,updateEffectiveSkillSource} from "../core/battle_skill_access.mjs";
import {createPartyActors} from "../core/party_attributes.mjs";
import {usableItems, canEquipItem} from "../core/items.mjs";
import {equipmentRows} from "../core/equipment.mjs";
import {operationActorStatus, learnedOperationSkills, operationItemCard, operationWeaponDetails} from "../core/operation_menu.mjs";
import {skillShortcuts} from "../core/skill_shortcuts.mjs";
import {availableFieldSkills, fieldSkillAvailability} from "../core/field_skills.mjs";
import {useWorldSkill} from "../core/field_skills.mjs";
import {changeTechniqueSlot,createTechniqueCombination,renameTechniqueCombination,deleteTechniqueCombination} from "../core/menu_techniques.mjs";
import {partyFormationSlots,exchangeFormationSlots} from "../core/party_formation.mjs";
import {crystalSocketCandidates,insertCrystal,removeCrystal} from "../core/crystal_sockets.mjs";

export function createMenuController({state, actions, $, canvas, ctx}) {
  const battleItemSelections=new Map();
  let techniqueTestMenu=null;
  let skillFacade=null;
  let partyView=null;
  function currentSkills(){const source=state.menuContext?.configured?.party_skills??state.partySkills;if(!skillFacade||skillFacade.world!==state.world||skillFacade.worldValue!==state.world.value||skillFacade.revision!==state.world.value.revision||skillFacade.source!==source)skillFacade={world:state.world,worldValue:state.world.value,revision:state.world.value.revision,source,value:effectiveSkillSource(source,state.world.value)};return skillFacade.value;}
  function currentPartyView(){
    const world=state.world.value;
    if(!partyView||partyView.world!==state.world||partyView.worldValue!==world||partyView.revision!==world.revision||partyView.attributes!==state.partyCombat||partyView.items!==state.itemData){
      const actors=createPartyActors(world,state.partyCombat,{},state.itemData);
      partyView={world:state.world,worldValue:world,revision:world.revision,attributes:state.partyCombat,items:state.itemData,actors,rows:actors.map(operationActorStatus)};
    }
    return partyView;
  }
  function showMessage(value){if(state.operationMenu.info)state.operationMenu.info(value);else $('menuMessage').textContent=value;}
  function menuOperation(fn){return async()=>{try{const message=await (state.menuFeedback?state.menuFeedback.transaction(fn):fn());$('menuMessage').classList.remove('error');showMessage(message??'');if(!state.menuFeedback)state.audio?.playCue('menuConfirm');refreshPartyMenu();}catch(error){$('menuMessage').classList.add('error');showMessage(error.message);if(!state.menuFeedback)state.audio?.playCue('menuError');actions.status(error.message,true);actions.log({type:'operation-failed',error:error.message});}};}
  async function openPartyMenu(combat=false){
    const battle=combat?actions.battleMenuState():null;
    if(combat?!battle?.canCommand:state.scenes.phase!=='map')return;
    const context={combat,phase:state.scenes.phase,page:combat?'items':'roster',commandActor:battle?.actorId??null,items:battle?.items};state.menuContext=context;state.keys.clear();
    if(combat)$('menuItem').value=state.menuSettings.snapshot().battleCursor==='memory'?battleItemSelections.get(context.commandActor)??'':'';
    if(!combat)state.scenes.setPhase('party-menu');
    if(!combat)try{
      const configured=await actions.readMenuConfiguration();if(state.menuContext!==context)return;
      state.itemData=configured.items;context.configured=configured;context.mode=configured.audit.mode;
      actions.log({type:'item-configuration',scope:'field',mode:configured.audit.mode,differences:configured.items.runtime_configuration.differences});
    }catch(error){if(state.menuContext!==context)return;state.menuContext=null;state.scenes.setPhase(context.phase);actions.status(error.message,true);actions.log({type:'operation-failed',error:error.message});return;}
    $('partyMenu').hidden=false;$('partyMenuTitle').textContent=combat?'战斗药品':'操作界面';$('menuMessage').textContent=state.menuContext.mode==='debug'?'调试参数':'';
    const roles=combat?battle.actors:state.world.value.party;
    $('menuActor').replaceChildren(...roles.map(r=>actions.option(r.id,r.name,combat&&r.hp.current===0)));
    $('menuActor').value=combat?battle.actorId:roles.some(role=>role.id===state.selectedRole)?state.selectedRole:roles[0]?.id??'';
    $('menuShortcutEditor').hidden=true;
    $('menuUseItem').textContent=combat?'使用（一次行动）':'使用';state.audio?.playCue('menuOpen');state.menuFeedback?.activate();state.operationMenu.focusInitial();showOperationPage(context.page);
  }
  function showOperationPage(page,itemCategory=null){
    if(!state.menuContext)return;if(state.menuContext.combat)page='items';
    if(page==='back-roster')page='roster';
    else if(page.startsWith('choose-')){const target=page.slice(7);state.menuContext.selectionPage=target;page=target==='formation'?'formation':'roster';}
    else if(page==='roster')state.menuContext.selectionPage=null;
    $('menuMessage').textContent='';$('menuMessage').classList.remove('error');
    const nextItemCategory=itemCategory??state.menuContext.itemCategory??'items',enteringItems=page==='items'&&(page!==state.menuContext.page||nextItemCategory!==state.menuContext.itemCategory);
    if(page!==state.menuContext.page||itemCategory&&itemCategory!==state.menuContext.itemCategory)state.operationMenu.itemFocused=false;
    if(enteringItems&&!state.menuContext.combat){state.menuContext.itemFilter=nextItemCategory==='equipment'?[2,1]:nextItemCategory==='crystals'?[3,1]:[5,1];$('menuItem').value='';}
    state.menuContext.page=page;if(itemCategory)state.menuContext.itemCategory=itemCategory;state.menuContext.itemCategory??='items';$('menuShortcutEditor').hidden=true;
    state.operationMenu.page(page,{combat:state.menuContext.combat,itemCategory:state.menuContext.itemCategory,selectionPage:state.menuContext.selectionPage,deferTechniquePaint:true});refreshPartyMenu();
  }
  function closePartyMenu(){
    if(!state.menuContext)return;const previous=state.menuContext;if(previous.combat)battleItemSelections.set(previous.commandActor,$('menuItem').value);state.menuContext=null;$('partyMenu').hidden=true;state.operationMenu.suspend();
    if(!previous.combat)state.scenes.setPhase(previous.phase);
    if(state.menuFeedback)state.menuFeedback.closing();else state.audio?.playCue('menuCancel');if(previous.combat)actions.focusBattleMenu();else canvas.focus();
  }
  function beginTechniqueTestMenu({retainVisible=false}={}){
    if(techniqueTestMenu)throw new Error('技巧测试正在进行。');
    if(!state.menuContext||state.menuContext.combat||state.menuContext.page!=='skills'||state.scenes.phase!=='party-menu')throw new Error('请从操作界面的技巧测试进入。');
    const root=$('partyMenu'),focus=root.ownerDocument.activeElement,ticket=Object.freeze({});
    techniqueTestMenu={ticket,context:state.menuContext,phase:state.scenes.phase,hidden:root.hidden,inert:Boolean(root.inert),focus,focusKey:focus?.dataset?.techniqueKey};
    // Input dispatch uses menuContext before the battle controller. Retain the
    // view and DOM, but release that input owner until the test returns.
    state.menuContext=null;state.keys.clear();root.inert=true;if(!retainVisible)root.hidden=true;
    return ticket;
  }
  function hideTechniqueTestMenu(ticket){
    if(techniqueTestMenu?.ticket!==ticket)return false;
    $('partyMenu').hidden=true;return true;
  }
  function resumeTechniqueTestMenu(ticket){
    const retained=techniqueTestMenu;
    if(!retained||retained.ticket!==ticket)return false;
    if(state.menuContext&&state.menuContext!==retained.context)return false;
    techniqueTestMenu=null;state.menuContext=retained.context;state.keys.clear();state.scenes.setPhase(retained.phase);
    const root=$('partyMenu');root.hidden=retained.hidden;root.inert=retained.inert;
    const focus=root.contains(retained.focus)?retained.focus:[...root.querySelectorAll('[data-technique-key]')].find(node=>node.dataset.techniqueKey===retained.focusKey);
    const techniques=state.operationMenu.techniques,wasRestoring=techniques?.restoring;
    // Refocusing a retained header must not run its preview/selection handler.
    if(techniques)techniques.restoring=true;
    try{(focus??state.operationMenu.frame).focus({preventScroll:true});}finally{if(techniques)techniques.restoring=wasRestoring;}
    return true;
  }
  function refreshPartyMenu(){
    if(!state.menuContext)return;
    const {combat,page}=state.menuContext,roleId=$('menuActor').value,world=state.world.value;
    const itemData=combat?state.menuContext.items:state.itemData;
    state.operationMenu.mnuText($('menuGold'),String(state.world.value.money??0).padStart(8,'0'),'game001','GOLD');state.operationMenu.mnuText($('menuArea'),$('mapName').textContent,'game001','AREA');
    // Hidden panels keep their DOM until their own page is entered. Rebuild
    // actor data only after a world/configuration change, never once per role.
    if(page==='system'){state.operationMenu.system.render(state.audio.snapshot().channels,state.menuSettings.snapshot().battleCursor);return;}
    const party=combat?null:currentPartyView(),actors=combat?actions.battleMenuState().actors:party.actors,actor=actors.find(r=>r.id===roleId);
    $('menuVitals').textContent=`${actor.name} · 等级 ${actor.level} · HP ${actor.hp.current}/${actor.hp.maximum} · MP ${actor.mp.current}/${actor.mp.maximum}`;
    state.operationMenu.actorId=roleId;state.operationMenu.rosterOrder=world.party.map(role=>role.id);
    if(page==='roster'){state.operationMenu.roster(party.rows,roleId);return;}
    if(page==='formation'){state.operationMenu.formation.render({slots:partyFormationSlots(world),actors});return;}
    if(page==='status'||page==='equipment')state.operationMenu.stats(party.rows.find(row=>row.id===roleId));
    if(page==='status')return;
    if(page==='skills'){
      if(state.operationMenu.techniques){
        const weapon=equipmentRows(world,state.partyCombat,itemData,roleId).find(row=>itemData.definitions[String(row.item_id)]?.type_raw_24===1);
        const raw=itemData.definitions[String(weapon?.item_id)]?.raw_hex,capacity=raw?new DataView(Uint8Array.from(raw.match(/../g),v=>parseInt(v,16)).buffer).getUint32(0x146,true):0;
        const skills=currentSkills();
        state.operationMenu.techniques.render(state.world.value,skills,{...state.menuContext.configured,party_skills:skills},{rows:party.rows,capacity});
      }
      refreshFieldSkillList(roleId);return;
    }
    if(page==='weapon'){
      state.operationMenu.weapon({...operationWeaponDetails(world,state.partyCombat,itemData,roleId,party.rows.find(row=>row.id===roleId)),definitions:itemData.definitions,actor,
        candidates:crystalSocketCandidates(world.inventory,itemData,{includeDisabled:true}).map(row=>({...row,available:row.socket_enabled})),
        slotIndex:state.menuContext.socketIndex??0,selectedId:state.menuContext.crystalInstanceId});return;
    }
    if(page==='equipment'){refreshEquipment(roleId,actor);return;}
    if(page!=='items')return;
    state.menuContext.itemFilter??=state.menuContext.itemCategory==='equipment'?[2,1]:state.menuContext.itemCategory==='crystals'?[3,1]:[5,1];
    state.operationMenu.setItemFilter?.(...state.menuContext.itemFilter);
    const previous=$('menuItem').value,previousIndex=state.operationMenu.itemFocused?Math.max(0,state.operationMenu.itemOrder?.indexOf(previous)??0):0,inventory=combat?actions.battleMenuState({inventory:true}).inventory:state.world.value.inventory,usable=usableItems(inventory,itemData,combat?'battle':'field'),listed=(combat?usable:inventory.filter(row=>{const def=itemData.definitions[String(row.id)],type=def?.type_raw_24,subtype=def?.subtype_raw_25;return row.quantity>0&&(state.menuContext.itemCategory==='equipment'?type===2&&subtype===state.menuContext.itemFilter[1]:state.menuContext.itemCategory==='crystals'?type===3&&subtype===1:type===state.menuContext.itemFilter[0]&&subtype===state.menuContext.itemFilter[1]);})).sort((a,b)=>a.id-b.id);
    $('menuItem').replaceChildren(...(listed.length?listed.map(r=>actions.option(r.instance_id,`${r.name} ×${r.quantity}`)):[actions.option('','没有物品')]));
    $('menuItem').value=listed.some(r=>r.instance_id===previous)?previous:listed[Math.min(previousIndex,listed.length-1)]?.instance_id??'';
    state.operationMenu.items(listed,$('menuItem').value,itemData.definitions,{usableIds:new Set(usable.map(row=>row.instance_id))});
    state.menuContext.itemRows=new Map(listed.map(row=>[row.instance_id,row]));
    state.menuContext.usableItemIds=new Set(usable.map(row=>row.instance_id));
    selectMenuItem($('menuItem').value);
  }
  function selectMenuItem(instanceId,{showInfo=false}={}){
    const context=state.menuContext;if(!context||context.page!=='items')return;
    const itemData=context.combat?context.items:state.itemData;
    $('menuItem').value=instanceId;
    state.operationMenu.selectItem?.(instanceId);
    const selected=context.itemRows?.get(instanceId),def=selected&&itemData.definitions[String(selected.id)];
    const card=state.operationMenu.itemFocused?operationItemCard(def,state.operationMenu.manifest):null,back=context.itemCategory==='items'?state.operationMenu.manifest.item_card_back:null;
    const image=$('menuItemCard');image.hidden=!(card||back);
    if(card||back){const path=card?.image??back.image??back;if(image.getAttribute?.('src')!==path)image.src=path;image.style.width=(card?.width??175)+'px';image.style.height=(card?.height??265)+'px';image.style.left=(state.operationMenu.cardRect?.left??292)+'px';image.style.top=((state.operationMenu.cardRect?.top??28)+(card?1:0))+'px';}
    const actor=context.combat?actions.battleMenuState().actors.find(row=>row.id===$('menuActor').value):null;
    $('menuUseItem').disabled=!context.usableItemIds?.has(instanceId)||context.combat&&actor?.hp.current===0;
    const hint=def?.description??(context.combat?'消耗当前行动人物的一次行动。':context.itemCategory==='items'?'选择物品与使用目标。':'');
    if($('menuItemHint').textContent!==hint)$('menuItemHint').textContent=hint;
    if(showInfo)showMessage(hint);
  }

  function selectEquipmentSlot(slotId,confirm=false){
    if(state.menuContext?.page!=='equipment')return;
    $('menuSlot').value=slotId;const roleId=$('menuActor').value;
    refreshEquipment(roleId,currentPartyView().actors.find(row=>row.id===roleId));
    showMessage($('menuEquipmentHint').textContent);if(confirm)state.operationMenu.equipmentPicker();
  }
  function refreshEquipment(roleId,actor){
    if(!$('menuSlot').children.length)$('menuSlot').replaceChildren(...state.itemData.slots.map(s=>actions.option(s.id,s.label)));
    const slotId=$('menuSlot').value,rows=equipmentRows(state.world.value,state.partyCombat,state.itemData,roleId);
    const worn=rows.find(row=>(row.slot_id??state.itemData.definitions[String(row.item_id)].slot_id)===slotId);
    $('menuWorn').textContent=`当前：${worn?state.itemData.definitions[String(worn.item_id)].name:'未装备'}`;
    const candidates=state.world.value.inventory.filter(row=>row.quantity>0&&state.itemData.definitions[String(row.id)]?.type_raw_24===2&&state.itemData.definitions[String(row.id)]?.slot_id===slotId).map(row=>({...row,available:canEquipItem(state.itemData.definitions[String(row.id)],roleId,slotId)}));
    const previousEquipment=$('menuEquipment').value;$('menuEquipment').replaceChildren(...(candidates.length?candidates.map(row=>actions.option(row.instance_id,`${row.name} ×${row.quantity}`)):[actions.option('','没有适合此部位的装备')]));
    $('menuEquipment').value=candidates.some(row=>row.instance_id===previousEquipment)?previousEquipment:candidates[0]?.instance_id??'';
    $('menuEquip').disabled=!candidates.length;$('menuUnequip').disabled=!worn;
    $('menuEquipmentHint').textContent=state.itemData.definitions[String(worn?.item_id)]?.description??'';
    state.operationMenu.equipment(state.itemData.slots,rows,state.itemData.definitions,slotId);
    state.operationMenu.equipmentView.render({slots:state.itemData.slots,rows,definitions:state.itemData.definitions,candidates,slotId,selectedId:$('menuEquipment').value,actor,roleId});
  }
  function refreshFieldSkillList(roleId){
    const previousSkill=$('menuSkill').value,fieldSkills=availableFieldSkills(state.world.value,state.menuContext.configured.party_skills,roleId),skills=learnedOperationSkills(state.world.value,currentSkills(),state.menuContext.configured,roleId).filter(skill=>fieldSkills.some(field=>field.original_skill_index===skill.index));
    $('menuSkill').replaceChildren(...(skills.length?skills.map(skill=>actions.option(String(skill.index),`${skill.name} · MP ${skill.mpCost}`)):[actions.option('','没有可在战斗外使用的技巧')]));
    if(skills.some(skill=>String(skill.index)===previousSkill))$('menuSkill').value=previousSkill;
    else{const firstField=fieldSkills[0];if(firstField)$('menuSkill').value=String(firstField.original_skill_index);}
    const target=$('menuSkillTarget').value;$('menuSkillTarget').replaceChildren(...state.world.value.party.map(role=>actions.option(role.id,role.name)));if(state.world.value.party.some(role=>role.id===target))$('menuSkillTarget').value=target;else $('menuSkillTarget').value=roleId;
    refreshMenuSkill();
  }
  function refreshMenuSkill(){
    if(!state.menuContext||state.menuContext.combat)return;
    const casterId=$('menuActor').value,targetId=$('menuSkillTarget').value,index=Number($('menuSkill').value),skills=learnedOperationSkills(state.world.value,currentSkills(),state.menuContext.configured,casterId),entry=skills.find(row=>row.index===index);
    const availability=entry?.skillId?fieldSkillAvailability(state.world.value,state.partyCombat,state.menuContext.configured.party_skills,state.itemData,{casterId,targetId,skillId:entry.skillId}):{available:false,reason:'此招式当前无法使用。'};
    $('menuFieldSkill').disabled=!availability.available;
    $('menuSkillHint').textContent=availability.available?`${entry.name}：HP回复${availability.hp_delta}，消耗MP ${availability.mp_cost}。`:!entry?'此人物没有可在战斗外使用的技巧。':availability.reason;
  }
  function editSkillShortcuts(){
    if(!state.menuContext||state.menuContext.combat)return;const roleId=$('menuActor').value,slots=skillShortcuts(state.world.value,currentSkills(),roleId),skills=learnedOperationSkills(state.world.value,currentSkills(),state.menuContext.configured,roleId);
    for(let n=0;n<3;n++){const select=$('menuShortcut'+(n+1));select.replaceChildren(...skills.map(skill=>actions.option(String(skill.index),skill.name+(state.partySkills.skills[skill.skillId]?'':'（当前战斗不可用）'))));select.value=String(slots[n]);}
    $('menuShortcutEditor').hidden=false;
  }
  function setTechniqueSlot(request){
    if(!state.menuContext||state.menuContext.combat)throw new Error('当前无法设置技巧');
    const result=changeTechniqueSlot(state.world,currentSkills(),request);actions.log({type:'technique-slot-changed',...request});refreshPartyMenu();return result;
  }
  function useFieldTechnique(request){
    if(!state.menuContext||state.menuContext.combat)throw new Error('当前无法使用技巧');
    const beforeRole=state.world.value.party.find(role=>role.id===request.casterId),previousSkills=currentSkills();
    const result=useWorldSkill(state.world,state.partyCombat,state.menuContext.configured.party_skills,state.itemData,request);
    state.audio?.playCue('fieldSkillRecover');
    const message=result.notifications.map(notice=>notice.type==='skill-level-up'?`${notice.actor_name}的${notice.skill_name}升到${notice.after.level}级。`:notice.type==='skill-learned'?`${notice.actor_name}学会了${notice.skill_name}。`:'').filter(Boolean).join('\n')||`${result.name}已使用，HP ${result.target_hp.before}→${result.target_hp.after}，消耗MP ${result.mp_cost}。`;
    const source=state.menuContext.configured.party_skills,world=state.world.value;
    const skills=updateEffectiveSkillSource(source,world,previousSkills,beforeRole);
    skillFacade={world:state.world,worldValue:world,revision:world.revision,source,value:skills};
    const party=currentPartyView(),actor=party.actors.find(role=>role.id===$('menuActor').value);
    actions.buildHud({resourcesOnly:true,actors:party.actors});actions.log({type:'world-skill-used',...result});
    if(state.menuContext.page==='skills'&&state.operationMenu.techniques){
      $('menuVitals').textContent=`${actor.name} · 等级 ${actor.level} · HP ${actor.hp.current}/${actor.hp.maximum} · MP ${actor.mp.current}/${actor.mp.maximum}`;
      state.operationMenu.techniques.updateFieldUse(state.world.value,skills,{...state.menuContext.configured,party_skills:skills},{rows:party.rows});
      refreshFieldSkillList(actor.id);
    }else refreshPartyMenu();
    $('menuMessage').classList.remove('error');showMessage(message);return {...result,message};
  }
  function editTechniqueCombination(kind,request){
    if(!state.menuContext||state.menuContext.combat)throw new Error('当前无法编成技巧');
    if(kind==='create'){
      const weapon=operationWeaponDetails(state.world.snapshot(),state.partyCombat,state.itemData,request.roleId).weapon;
      const capacity=weapon?new DataView(Uint8Array.from(weapon.definition.raw_hex.match(/../g),n=>parseInt(n,16)).buffer).getUint32(0x146,true):0;
      request={...request,capacity};
    }
    const handler={create:createTechniqueCombination,rename:renameTechniqueCombination,delete:deleteTechniqueCombination}[kind];
    const result=handler(state.world,currentSkills(),request);actions.log({type:'technique-combination-'+kind,...request});refreshPartyMenu();return result;
  }
  function changePartyFormation(first,second){
    if(!state.menuContext||state.menuContext.combat)throw new Error('当前无法调整队列');
    const slots=exchangeFormationSlots(partyFormationSlots(state.world.value),state.world.value.party,first,second);
    state.world.transact(draft=>{draft.formation_slots=slots;});actions.log({type:'formation-changed',first,second,slots});refreshPartyMenu();
  }
  function changeWeaponSocket(index,instanceId){return menuOperation(()=>{
    if(!state.menuContext||state.menuContext.combat||state.menuContext.page!=='weapon')throw new Error('当前无法修改法器孔位');
    const request={worldStore:state.world,attributes:state.partyCombat,itemData:state.itemData,roleId:$('menuActor').value,socketIndex:index+1,expectedRevision:state.world.value.revision};
    const result=instanceId?insertCrystal({...request,instanceId}):removeCrystal(request);actions.buildHud();actions.log({type:instanceId?'crystal-inserted':'crystal-removed',...result});return instanceId?'晶石已镶嵌。':'晶石已卸下。';
  })();}
  return {menuOperation, openPartyMenu, showOperationPage, closePartyMenu, beginTechniqueTestMenu, hideTechniqueTestMenu, resumeTechniqueTestMenu, refreshPartyMenu, selectMenuItem, selectEquipmentSlot, refreshMenuSkill, editSkillShortcuts,setTechniqueSlot,useFieldTechnique,editTechniqueCombination,changePartyFormation,changeWeaponSocket};
}
