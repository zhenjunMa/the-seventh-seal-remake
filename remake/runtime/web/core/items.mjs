import {createPartyActors,partyResourcesForWorld} from './party_attributes.mjs';
import {migrateEquipment,withItemQuantity,validateItemInstance} from './equipment.mjs';
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
export function restoreActorWithItem(actor,item,data,{scope='battle'}={}) {
  const def=data.definitions[String(item.id)];validateItemInstance(item,def);
  need(def.effect,'此物品不能作为药品使用');
  need(['field','battle'].includes(scope)&&def.runtime_enabled!==false&&def[`use_in_${scope}`]!==false,'此物品在当前场合被配置禁用');
  need(actor?.side==='player','药品目标不属于队伍');
  need(scope==='field'||actor.hp.current>0&&actor.state_raw<4&&!actor.immune_raw,'战斗中此药品不能用于倒下或免疫的角色');
  const next=copy(actor),changes={};
  for(const resource of ['hp','mp']){
    const effect=def.effect,amount=(effect[`restore_${resource}_flat`]??0)+Math.trunc(next[`raw_${resource}_maximum`]*(effect[`restore_${resource}_percent`]??0)/100);
    const raw=amount>0?Math.min(next[`raw_${resource}_maximum`],next[`raw_${resource}`]+amount):next[`raw_${resource}`];
    const value=Math.max(0,raw+next.resource_bonuses[`${resource}_current`]);
    changes[resource]={before:next[resource].current,after:value};next[resource].current=value;
    need(Number.isInteger(raw)&&raw>=-0x80000000&&raw<=0x7fffffff,'恢复资源超出原字段范围');
    next[`raw_${resource}`]=raw;next[`effective_${resource}_raw`]=raw+next.resource_bonuses[`${resource}_current`];next.raw_by_address[resource==='hp'?'0x0524a701':'0x0524a709']=raw;
  }
  if(scope==='field')next.state_raw=next.hp.current>0?0:4;
  return {actor:next,changes,name:def.name};
}

export function useWorldItem(world,attributes,data,{instanceId,targetId,expectedRevision=world.value.revision}) {
  need(world.value.revision===expectedRevision,'操作期间进度已变化');
  const target=createPartyActors(world.snapshot(),attributes,{},data).find(a=>a.id===targetId);
  const consumed=consumeInventoryItem(world.value.inventory,instanceId,data),result=restoreActorWithItem(target,consumed.item,data,{scope:'field'});
  const resources=partyResourcesForWorld(result.actor);
  world.transact(draft=>{draft.inventory=consumed.inventory;const role=draft.party.find(r=>r.id===targetId);role.hp.current=resources.hp;role.mp.current=resources.mp;});
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
