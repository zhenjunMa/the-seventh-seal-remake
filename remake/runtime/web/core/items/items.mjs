import {createPartyActors,partyResourcesForWorld} from '../party/party_attributes.mjs';
import {migrateEquipment,withItemQuantity,validateItemInstance} from '../party/equipment.mjs';
import {removeNativeStatus,applyNativeItemStatus,clearNativeStatuses} from '../battle/battle_status.mjs';
import {applyNativeRevivalEffect} from '../battle/battle_revival.mjs';
import {configuredEquipmentHex} from './item_registry.mjs';
import {initialEncounterState,applyEncounterItemEffect} from '../exploration/encounters.mjs';
const copy=structuredClone;
const need=(ok,message)=>{if(!ok)throw new Error(message);};

export function validateItemData(data) {
  need(data?.schema==='seventh-seal-chapter-items'&&data.version===1&&Array.isArray(data.slots)&&data.definitions, '道具数据版本无效');
  need(data.equipment_resource_policy==='preserve-raw','装备资源策略与原规则不同');
  const slots=new Set();
  for(const slot of data.slots){need(typeof slot.id==='string'&&!slots.has(slot.id)&&typeof slot.label==='string', '装备部位定义无效');slots.add(slot.id);}
  for(const [key,def]of Object.entries(data.definitions)){
    need(Number(key)===def.id&&def.source?.path==='SYSTEM/Object.ITM'&&def.source.sha256===data.source_hashes?.['SYSTEM/Object.ITM'], '道具来源不一致');
    if(def.slot_id)need(slots.has(def.slot_id),'装备部位来源缺失');
    if(def.effect)for(const name of ['restore_hp_flat','restore_mp_flat','restore_hp_percent','restore_mp_percent'])
      need(Number.isInteger(def.effect[name]??0)&&(def.effect[name]??0)>=0&&(def.effect[name]??0)<=1000000,'药品效果无效');
  }
  return data;
}

export function usableItems(inventory,data,scope='battle') {
  return inventory.filter(row=>{const def=data.definitions[String(row.id)];return row.quantity>0&&def?.effect&&def.runtime_enabled!==false&&def[`use_in_${scope}`]!==false;});
}
export function canEquipItem(definition,roleId,slotId) {
  const mask=definition?.allowed_role_mask_raw_13e;
  return Boolean(definition?.runtime_enabled!==false&&definition?.slot_id===slotId&&(mask===0||(mask&(1<<(Number(roleId)-1)))!==0));
}
export function consumeInventoryItem(inventory,instanceId,data) {
  const next=copy(inventory),index=next.findIndex(row=>row.instance_id===instanceId),item=next[index];
  need(item&&item.quantity>0,'道具数量不足');
  validateItemInstance(item,data.definitions[String(item.id)]);
  if(item.quantity===1)next.splice(index,1);else next[index]=withItemQuantity(item,item.quantity-1);
  return {inventory:next,item:copy(item)};
}
export function itemTargetEligible(actor,definition,caster=null){
  const sameSide=definition?.battle?.same_side_raw_157!==0,side=caster?.side??'player';
  return Boolean(actor&&(sameSide?actor.side===side:actor.side!==side)&&!actor.immune_raw&&!actor.escaped
    &&(definition?.behavior?.kind==='revival-item'?actor.state_raw>=4&&actor.state_raw<=7:actor.state_raw>=0&&actor.state_raw<4));
}
export function restoreActorWithItem(actor,item,data,{scope='battle',statusData,content,caster,rng,selectAnimation}={}) {
  const def=data.definitions[String(item.id)];validateItemInstance(item,def);
  need(def.effect,'此物品不能作为药品使用');
  need(['field','battle'].includes(scope)&&def.runtime_enabled!==false&&def[`use_in_${scope}`]!==false,'此物品在当前场合被配置禁用');
  need(scope==='battle'||actor?.side==='player','药品目标不属于队伍');
  need(scope==='field'||itemTargetEligible(actor,def,caster),'战斗中此药品不能用于倒下或免疫的角色，或目标阵营不符');
  let next=copy(actor);const changes={},trace=[];let status=null;
  if(def.behavior?.kind==='status-cure'){
    need(scope==='battle'&&def.status_cure?.mode_raw===1,'此解除状态物品仅在战斗中有效');
    status=removeNativeStatus({actor:next,effect_raw_hex:def.status_cure.effect_raw_hex,data:statusData,content});
    next=status.actor;trace.push(...status.trace);
  }else if(scope==='battle'&&['status-attack','status-support'].includes(def.behavior?.kind)){
    status=applyNativeItemStatus({actor:next,item_id:def.id,data:statusData,rng,content});
    next=status.actor;trace.push(...status.trace);
  }else if(scope==='battle'&&def.behavior?.kind==='status-clear'){
    next=clearNativeStatuses(next,statusData,content);
    status={native_return:1};trace.push({kind:'status-clear',mode_raw:5,effect_id_raw:0});
  }else if(scope==='battle'&&def.behavior?.kind==='revival-item'){
    status=applyNativeRevivalEffect({target:next,effect_raw_hex:def.revival.effect_raw_hex,rng,selectAnimation});
    next=status.actor;trace.push(...(status.animation?.trace??[]),...status.trace);
  }
  let permanentStatApplied=false;
  if(def.behavior?.kind==='permanent-stat-source'){
    const instance=Uint8Array.from(configuredEquipmentHex(item.source_raw_hex,def).match(/../g),part=>parseInt(part,16));
    const values=new DataView(instance.buffer),amount=values.getInt32(def.permanent_stat.instance_offset,true),percent=values.getInt32(def.permanent_stat.percent_instance_offset,true);
    if(amount||percent){
      const raw=Uint8Array.from(next.header_raw_hex.match(/../g),part=>parseInt(part,16)),view=new DataView(raw.buffer),offset=def.permanent_stat.header_offset;
      const before=view.getInt32(offset,true),flat=(before+amount)|0;
      const after=percent?Math.max(0,Math.min(999,(flat+Math.trunc(Math.imul(flat,percent)/100))|0)):flat;
      view.setInt32(offset,after,true);
      next.raw_by_address[`0x${(0x524a6d1+offset).toString(16).padStart(8,'0')}`]=after;
      next.header_raw_hex=Array.from(raw,value=>value.toString(16).padStart(2,'0')).join('');next.permanent_item_header_raw_hex=next.header_raw_hex;
      changes.attack={before,after};permanentStatApplied=true;
    }
  }
  const elementApplied=def.behavior?.kind==='element-source'&&Array.from({length:6},(_,index)=>def.effect[`element_${index}_flat`]).some(Boolean);
  if(elementApplied){
    const raw=Uint8Array.from(next.header_raw_hex.match(/../g),part=>parseInt(part,16)),view=new DataView(raw.buffer);
    for(let index=0;index<6;index++){
      const offset=0x7a+index*4,before=view.getInt32(offset,true),amount=def.effect[`element_${index}_flat`];
      view.setInt32(offset,Math.max(0,Math.min(999,(before+amount)|0)),true);
      const address=`0x${(0x524a6d1+offset).toString(16).padStart(8,'0')}`;
      next.raw_by_address[address]=view.getInt32(offset,true);
      changes[`element_${index}`]={before,after:view.getInt32(offset,true)};
    }
    next.header_raw_hex=Array.from(raw,value=>value.toString(16).padStart(2,'0')).join('');
    next.permanent_item_header_raw_hex=next.header_raw_hex;
  }
  for(const resource of ['hp','mp']){
    const flat=def.effect[`${resource}_maximum_flat`]??0,percent=def.effect[`${resource}_maximum_percent`]??0;
    if(flat||percent){const maximum=(next[`raw_${resource}_maximum`]+flat)|0;
      next[`raw_${resource}_maximum`]=(maximum+Math.trunc(Math.imul(maximum,percent)/100))|0;}
  }
  for(const resource of ['hp','mp']){
    const effect=def.effect,amount=(effect[`restore_${resource}_flat`]??0)+Math.trunc(next[`raw_${resource}_maximum`]*(effect[`restore_${resource}_percent`]??0)/100);
    //47D960's common epilogue runs even when508BB0 rejected the status and
    // every numeric field is zero. Its raw caps also apply to enemy medicines.
    const maximum=Math.min(resource==='hp'?9999:999,next[`raw_${resource}_maximum`]),raw=Math.min(maximum,Math.max(0,(next[`raw_${resource}`]+amount)|0));
    next[`raw_${resource}_maximum`]=maximum;next[resource].maximum=maximum+next.resource_bonuses[`${resource}_maximum`];
    next.raw_by_address[resource==='hp'?'0x0524a705':'0x0524a70d']=maximum;
    const value=Math.max(0,raw+next.resource_bonuses[`${resource}_current`]);
    changes[resource]={before:next[resource].current,after:value};next[resource].current=value;
    need(Number.isInteger(raw)&&raw>=-0x80000000&&raw<=0x7fffffff,'恢复资源超出原字段范围');
    next[`raw_${resource}`]=raw;next[`effective_${resource}_raw`]=raw+next.resource_bonuses[`${resource}_current`];next.raw_by_address[resource==='hp'?'0x0524a701':'0x0524a709']=raw;
  }
  if(next.side==='player'&&(next.permanent_item_header_raw_hex||next.raw_hp_maximum!==actor.raw_hp_maximum||next.raw_mp_maximum!==actor.raw_mp_maximum)){
    const raw=Uint8Array.from(next.header_raw_hex.match(/../g),part=>parseInt(part,16)),view=new DataView(raw.buffer);
    view.setInt32(0x34,next.raw_hp_maximum,true);view.setInt32(0x3c,next.raw_mp_maximum,true);
    next.header_raw_hex=Array.from(raw,value=>value.toString(16).padStart(2,'0')).join('');next.permanent_item_header_raw_hex=next.header_raw_hex;
  }
  if(scope==='field')next.state_raw=next.hp.current>0?0:4;
  const resourceApplied=permanentStatApplied||elementApplied||['hp','mp'].some(resource=>
    ['maximum_flat','maximum_percent'].some(suffix=>Boolean(def.effect[`${resource}_${suffix}`]))
    ||(def.effect[`restore_${resource}_flat`]??0)!==0||(def.effect[`restore_${resource}_percent`]??0)!==0);
  const applied=Boolean(resourceApplied||status?.native_return===1);
  const state_changed=['raw_hp','raw_mp','raw_hp_maximum','raw_mp_maximum'].some(field=>next[field]!==actor[field]);
  return {actor:next,changes,name:def.name,applied,state_changed,native_return:applied?1:0,effect_requested:true,
    ...(def.effect.encounter_modifier_delta?{encounter_effect:{modifier_delta:def.effect.encounter_modifier_delta,duration_ticks:def.effect.encounter_duration_ticks}}:{}),
    revived:status?.reason==='revived',animation:status?.animation??null,cancel_command:status?.cancel_command??false,trace};
}

export function useWorldItem(world,attributes,data,{instanceId,targetId,expectedRevision=world.value.revision,playTimeMs=world.value.play_time_ms??0}) {
  need(world.value.revision===expectedRevision,'操作期间进度已变化');
  const target=createPartyActors(world.snapshot(),attributes,{},data).find(a=>a.id===targetId);
  const consumed=consumeInventoryItem(world.value.inventory,instanceId,data),result=restoreActorWithItem(target,consumed.item,data,{scope:'field'});
  if(!result.applied&&!result.state_changed&&!result.encounter_effect)return {...result,targetId,world_revision:world.value.revision};
  const resources=partyResourcesForWorld(result.actor);
  world.transact(draft=>{if(result.applied)draft.inventory=consumed.inventory;const role=draft.party.find(r=>r.id===targetId);role.hp.current=resources.hp;role.mp.current=resources.mp;
    if(result.encounter_effect)draft.encounters=applyEncounterItemEffect(draft.encounters??initialEncounterState(draft.party),result.encounter_effect,playTimeMs);
    if(resources.header_raw_hex){role.combat_progress={header_raw_hex:resources.header_raw_hex};role.hp.maximum=resources.hp_maximum;role.mp.maximum=resources.mp_maximum;role.attributes_stored=resources.attributes_stored;}});
  return {...result,targetId,world_revision:world.value.revision};
}

function addReturnedItem(inventory,item) {
  const value=withItemQuantity(item,1);delete value.slot_id;
  const fingerprint=raw=>raw.slice(0,8)+raw.slice(16);
  const stack=inventory.find(row=>row.id===value.id&&row.quantity<99&&fingerprint(row.source_raw_hex)===fingerprint(value.source_raw_hex));
  if(stack){inventory[inventory.indexOf(stack)]=withItemQuantity(stack,stack.quantity+1);return;}
  need(inventory.length<1000,'背包已满，无法卸下装备');inventory.push(value);
}
export function changeEquipment(world,attributes,data,{roleId,slotId,instanceId=null,expectedRevision=world.value.revision}) {
  validateItemData(data);need(world.value.revision===expectedRevision,'操作期间进度已变化');
  need(data.slots.some(s=>s.id===slotId)&&world.value.party.some(r=>r.id===roleId),'角色或装备部位无效');
  createPartyActors(world.snapshot(),attributes,{},data);
  world.transact(draft=>{
    migrateEquipment(draft,attributes,data);const equipped=draft.equipment.roles[roleId],index=equipped.findIndex(r=>r.slot_id===slotId),old=equipped[index];
    let replacement=null;
    if(instanceId){
      const consumed=consumeInventoryItem(draft.inventory,instanceId,data);
      need(canEquipItem(data.definitions[String(consumed.item.id)],roleId,slotId),'角色或部位不能装备此物品');
      replacement=withItemQuantity({...consumed.item,slot_id:slotId,
        instance_id:consumed.item.quantity>1?`gear:${roleId}:${slotId}:${draft.revision}`:consumed.item.instance_id},1);
      draft.inventory=consumed.inventory;
    }else need(old,'此部位没有装备');
    if(index>=0)equipped.splice(index,1);
    if(old)addReturnedItem(draft.inventory,old);
    if(replacement)equipped.push(replacement);
    // 0x47C250/0x47CC30 recalculate linked gear values without changing raw HP/MP.
    createPartyActors(draft,attributes,{},data);
  });
  return createPartyActors(world.snapshot(),attributes,{},data).find(r=>r.id===roleId);
}
