// Static operation-panel values use stored CHR stats plus equipment links.
// Native 0x44c580 does not roll the combat skill ranges for this panel.
import {createPartyActors} from './party_attributes.mjs';
import {equipmentRows} from './equipment.mjs';
import {crystalSocketRows} from './crystal_sockets.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(message);};

export function operationStatus(world,attributes,items,roleId){
  const actor=createPartyActors(world,attributes,{},items).find(row=>row.id===roleId);
  need(actor,'操作角色不在队伍中');
  const value=(raw,linked)=>Math.max(0,Math.min(999,(actor.raw_by_address[raw]+actor.linked_by_address[linked])|0));
  const address=n=>'0x'+n.toString(16).padStart(8,'0');
  const header=new DataView(Uint8Array.from(actor.header_raw_hex.match(/../g),v=>parseInt(v,16)).buffer);
  return {id:actor.id,name:actor.name,level:actor.level,hp:{...actor.hp},mp:{...actor.mp},
    attack:value('0x0524a711','0x04f99098'),defense:value('0x0524a719','0x04f9909c'),
    speed:value('0x0524a729','0x04f990a4'),
    elements:[0,2,1,3,4,5].map(index=>value(address(0x524a74b+index*4),address(0x4f990e0+index*4))),
    experience:header.getUint32(0x28,true),nextLevelExperience:header.getUint32(0x2c,true)-header.getUint32(0x28,true)};
}

// Native 0x49D330 selects the image bank; 0x49D6F0 uses +0x20 minus one.
export function operationItemCard(definition,manifest){
  if(!definition)return null;
  const type=definition.type_raw_24,subtype=definition.subtype_raw_25;
  const bank=manifest.item_card_dispatcher.categories.find(row=>row.type===type&&row.subtype===subtype)?.resource;
  const index=new DataView(Uint8Array.from(definition.raw_hex.match(/../g),v=>parseInt(v,16)).buffer).getUint32(0x20,true)-1;
  const cards=manifest.item_card_assets.find(row=>row.id===bank);
  return bank&&index>=0&&index<cards?.frame_count?{image:cards.images[index],width:cards.width,height:cards.height}:null;
}

// Native 0x47ae20 initializes empty actor-owned sockets. Optional remake socket
// records retain later changes; legacy remake saves predate any socket editing.
export function operationWeaponDetails(world,attributes,items,roleId){
  const status=operationStatus(world,attributes,items,roleId);
  const weapon=equipmentRows(world,attributes,items,roleId).find(row=>items.definitions[String(row.item_id)]?.type_raw_24===1);
  if(!weapon)return {status,weapon:null,socketCount:0,sockets:null};
  const definition=items.definitions[String(weapon.item_id)],raw=Uint8Array.from(definition.raw_hex.match(/../g),v=>parseInt(v,16));
  need(raw[0x155]<=6,'原法器孔数超出面板范围');
  const sockets=crystalSocketRows(world,attributes,items,roleId).map(row=>row.item);
  return {status,weapon:{id:definition.id,name:definition.name,definition},socketCount:raw[0x155],sockets};
}

export function learnedOperationSkills(world,source,configured,roleId){
  need(world.party.some(row=>row.id===roleId)&&source.roles?.[roleId],'操作角色技能来源缺失');
  const role=source.roles[roleId];
  return role.learned_indices.map(index=>{
    const original=role.skills[index];
    need(original?.original_skill_index===index&&original.actor_id===roleId&&original.learned_raw!==0,'学习记录与角色技能不一致');
    const active=Object.values(configured?.skill_registry??source.skills).find(skill=>skill.actor_id===roleId&&skill.original_skill_index===index);
    return {index,name:original.name,source:original.source,mpCost:active?.mp_cost??original.mp_cost,
      implemented:Boolean(active),skillId:active?.id??null,targetSide:original.target_side_raw,
      description:original.description??'',skill:active??original};
  });
}
