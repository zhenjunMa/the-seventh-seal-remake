// Native seven-slot records: 0x4265B0 builds a scratch record; 0x42A910
// copies its ten bytes only on confirmation. This module does not add actions.
const need=(ok,message)=>{if(!ok)throw new Error(message);};
import {allPartyRoles} from './party_roster.mjs';
const object=v=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const keys=(value,expected)=>object(value)&&Object.keys(value).sort().join(',')===[...expected].sort().join(',');
export const TECHNIQUE_COMMANDS=['使用招式','使用物品','防御','逃跑'];
export const TECHNIQUE_CATEGORIES=['编成技巧','魔法技巧','一般技巧','特殊技巧','其他技巧','????'];
// GAME.exe 0x429c10: top, upper-left, lower-left, bottom, lower-right,
// upper-right, center. Native navigation keeps unavailable slots focusable.
export const TECHNIQUE_WHEEL_NAVIGATION={
  ArrowLeft:[1,1,2,2,3,6,1],
  ArrowUp:[0,0,1,6,5,0,0],
  ArrowRight:[5,6,3,4,4,5,5],
  ArrowDown:[6,2,3,3,3,4,3]
};
const sourceRole=(source,id)=>{const role=source.roles?.[id];need(role,'技巧角色来源缺失');return role;};
const rawView=skill=>new DataView(Uint8Array.from(skill.fixed_raw_hex.match(/../g),v=>parseInt(v,16)).buffer);

export function sourceTechniqueSlot(source,roleId,type,indexOneBased,combinations=[]){
  need(Number.isInteger(indexOneBased)&&indexOneBased>0,'技巧索引无效');
  if(type===2){need(indexOneBased<=4,'特殊指令无效');return {type,index_one_based:indexOneBased,icon:indexOneBased-1,color:0};}
  if(type===1){const record=combinations[indexOneBased-1];need(record,'编成技巧索引无效');return {type,index_one_based:indexOneBased,icon:record.icon,color:record.total_units};}
  need(type===0,'技巧记录类型无效');
  const role=sourceRole(source,roleId),skill=role.skills[indexOneBased-1];
  need(skill?.actor_id===roleId&&skill.original_skill_index===indexOneBased-1&&skill.learned_raw&&(skill.type_flags_u32_0x32&15)!==0,'技巧未学会或来源不属于角色');
  // +9 is historically called color in the evidence ledger; native fills it
  // from skill +0x36, the composition-unit count, not an arbitrary CSS color.
  return {type,index_one_based:indexOneBased,icon:(skill.type_flags_u32_0x32>>>4)&15,color:rawView(skill).getUint32(0x36,true)&255};
}

export function validateTechniqueBindingsState(state,party){
  need(keys(state,['version','roles'])&&state.version===1&&object(state.roles),'技巧设置存档无效');
  for(const [id,slots]of Object.entries(state.roles)){
    need(party.some(role=>role.id===id)&&Array.isArray(slots)&&slots.length===7,'技巧设置角色或七槽记录无效');
    for(const slot of slots)need(keys(slot,['type','index_one_based','icon','color'])&&[0,1,2].includes(slot.type)&&Number.isInteger(slot.index_one_based)&&slot.index_one_based>0&&slot.index_one_based<201&&[slot.icon,slot.color].every(n=>Number.isInteger(n)&&n>=0&&n<=255),'技巧设置槽记录无效');
  }
  return structuredClone(state);
}

export function techniqueSlots(world,source,roleId){
  need(world.party.some(role=>role.id===roleId),'技巧角色不在队伍中');
  const role=sourceRole(source,roleId);
  const combinations=techniqueCombinations(world,source,roleId);
  if(world.technique_bindings){validateTechniqueBindingsState(world.technique_bindings,allPartyRoles(world));const retained=world.technique_bindings.roles[roleId];if(retained){for(const slot of retained){const original=sourceTechniqueSlot(source,roleId,slot.type,slot.index_one_based,combinations);need((slot.type===1?slot.icon<66&&['type','index_one_based','color'].every(key=>slot[key]===original[key]):['type','index_one_based','icon','color'].every(key=>slot[key]===original[key])),'技巧槽记录与原来源不符');}return structuredClone(retained);}}
  // Legacy three-slot saves are read without a migration write.
  const direct=world.skill_shortcuts?.roles?.[roleId]??role.default_hotkey_indices;
  need(Array.isArray(direct)&&direct.length===3,'默认技巧快捷槽缺失');
  return [...direct.map(index=>sourceTechniqueSlot(source,roleId,0,index+1)),...[1,2,3,4].map(index=>sourceTechniqueSlot(source,roleId,2,index))];
}

export function techniqueSlotName(source,roleId,slot){
  return slot.type===2?TECHNIQUE_COMMANDS[slot.index_one_based-1]:slot.type===0?sourceRole(source,roleId).skills[slot.index_one_based-1]?.name??'':'编成技巧';
}

export function techniqueCandidates(world,source,roleId,category,{action='set',capacity=0}={}){
  need(world.party.some(role=>role.id===roleId),'技巧角色不在队伍中');
  if(category===4)return action==='set'?TECHNIQUE_COMMANDS.map((name,index)=>({name,index,type:2,slot:sourceTechniqueSlot(source,roleId,2,index+1),source:null})):[];
  if(![1,2,3].includes(category)||capacity===0)return [];
  const categoryType={1:2,2:1,3:3}[category];
  return sourceRole(source,roleId).skills.filter(skill=>{
    const units=rawView(skill).getUint32(0x36,true),flags=skill.type_flags_u32_0x32;
    return skill.learned_raw&&(flags&15)===categoryType&&units<=capacity&&(action==='set'||units>0&&((flags>>>8)&1));
  }).map(skill=>({name:skill.name,index:skill.original_skill_index,type:0,slot:sourceTechniqueSlot(source,roleId,0,skill.original_skill_index+1),source:skill}));
}

export function changeTechniqueSlot(world,source,{roleId,slotIndex,type,indexOneBased,expectedRevision=world.value.revision}){
  need(world.value.revision===expectedRevision,'操作期间进度已变化');
  need(Number.isInteger(slotIndex)&&slotIndex>=0&&slotIndex<7,'请选择七个技巧槽之一');
  const slots=techniqueSlots(world.value,source,roleId),slot=sourceTechniqueSlot(source,roleId,type,indexOneBased,techniqueCombinations(world.value,source,roleId));slots[slotIndex]=slot;
  world.transact(draft=>{draft.technique_bindings??={version:1,roles:{}};draft.technique_bindings.roles[roleId]=slots;
    // Keep an old reader's three direct shortcuts synchronized when all three
    // remain direct. The seven-slot table is the authoritative new state.
    if(slots.slice(0,3).every(row=>row.type===0)){draft.skill_shortcuts??={version:1,roles:{}};draft.skill_shortcuts.roles[roleId]=slots.slice(0,3).map(row=>row.index_one_based-1);}});
  return structuredClone(slots);
}

const toHex=b=>Array.from(b,n=>n.toString(16).padStart(2,'0')).join('');
function encodeCombination({icon,name_codes,total_units,indices},originalHex=null){
  const bytes=originalHex?Uint8Array.from(originalHex.match(/../g),h=>parseInt(h,16)):new Uint8Array(36),v=new DataView(bytes.buffer);
  v.setUint32(0,icon,true);bytes.set(name_codes,4);bytes[4+name_codes.length]=0;
  bytes[24]=total_units;bytes[25]=indices.length;bytes.set(indices,26);return toHex(bytes);
}
export function validateTechniqueCombinationState(state,party){
  need(keys(state,['version','roles'])&&state.version===1&&object(state.roles),'编成技巧存档无效');
  for(const [id,records]of Object.entries(state.roles)){
    need(party.some(role=>role.id===id)&&Array.isArray(records)&&records.length<=29,'编成技巧角色或数量无效');
    for(const r of records){
      need(keys(r,['icon','name_codes','total_units','indices','native_raw_hex'])&&Number.isInteger(r.icon)&&r.icon>=0&&r.icon<66,'编成技巧图标无效');
      need(Array.isArray(r.name_codes)&&r.name_codes.length>0&&r.name_codes.length<=8&&r.name_codes.every(n=>Number.isInteger(n)&&n>0&&n<=166),'编成技巧名称编码无效');
      need(Number.isInteger(r.total_units)&&r.total_units>=1&&r.total_units<=7&&Array.isArray(r.indices)&&r.indices.length>0&&r.indices.length<=7&&r.indices.every(n=>Number.isInteger(n)&&n>=0&&n<200)&&new Set(r.indices).size===r.indices.length,'编成技巧序列无效');
      need(typeof r.native_raw_hex==='string'&&/^[0-9a-f]{72}$/.test(r.native_raw_hex)&&r.native_raw_hex===encodeCombination(r,r.native_raw_hex),'编成技巧原记录无效');
    }
  }return structuredClone(state);
}
export function techniqueCombinations(world,source,roleId){
  need(world.party.some(role=>role.id===roleId),'技巧角色不在队伍中');
  if(!world.technique_combinations)return [];
  validateTechniqueCombinationState(world.technique_combinations,allPartyRoles(world));
  const records=world.technique_combinations.roles[roleId]??[],role=sourceRole(source,roleId);
  for(const record of records){let units=0;for(const index of record.indices){const skill=role.skills[index],flags=skill?.type_flags_u32_0x32??0;need(skill?.learned_raw&&[1,2,3].includes(flags&15)&&((flags>>>8)&1),'编成技巧技能来源无效');const n=rawView(skill).getUint32(0x36,true);need(n>0,'编成技巧球数无效');units+=n;}need(units===record.total_units,'编成技巧球数与原来源不符');}
  return structuredClone(records);
}
export function techniqueCombinationName(record,charset){return record.name_codes.map(code=>charset.characters[code-1]).join('');}
export function createTechniqueCombination(world,source,{roleId,indices,nameCodes,icon,capacity,expectedRevision=world.value.revision}){
  need(world.value.revision===expectedRevision,'操作期间进度已变化');
  const records=techniqueCombinations(world.value,source,roleId);need(records.length<29,'技巧编成数量已满');
  need(Array.isArray(indices)&&indices.length>0&&new Set(indices).size===indices.length,'请选择不重复的编成技巧');
  const candidates=[1,2,3].flatMap(category=>techniqueCandidates(world.value,source,roleId,category,{action:'compose',capacity}));
  let units=0;for(const index of indices){const entry=candidates.find(row=>row.index===index);need(entry,'此技巧不能编成');units+=entry.slot.color;}need(units<=capacity&&units<=7,'编成球数超出法器容量');
  const record={icon,name_codes:[...nameCodes],total_units:units,indices:[...indices]};record.native_raw_hex=encodeCombination(record);
  records.push(record);validateTechniqueCombinationState({version:1,roles:{[roleId]:records}},world.value.party);
  world.transact(draft=>{draft.technique_combinations??={version:1,roles:{}};draft.technique_combinations.roles[roleId]=records;});
  return {record:structuredClone(record),index_one_based:records.length};
}
export function renameTechniqueCombination(world,source,{roleId,indexOneBased,nameCodes,icon,expectedRevision=world.value.revision}){
  need(world.value.revision===expectedRevision,'操作期间进度已变化');const records=techniqueCombinations(world.value,source,roleId),r=records[indexOneBased-1];need(r,'编成技巧不存在');
  r.icon=icon;r.name_codes=[...nameCodes];r.native_raw_hex=encodeCombination(r,r.native_raw_hex);validateTechniqueCombinationState({version:1,roles:{[roleId]:records}},world.value.party);
  // Native rename edits only the combination record, leaving the cached
  // shortcut icon until that shortcut is explicitly set again.
  world.transact(draft=>{draft.technique_combinations.roles[roleId]=records;});return structuredClone(r);
}
export function deleteTechniqueCombination(world,source,{roleId,indexOneBased,expectedRevision=world.value.revision}){
  need(world.value.revision===expectedRevision,'操作期间进度已变化');const records=techniqueCombinations(world.value,source,roleId),slots=techniqueSlots(world.value,source,roleId);need(records[indexOneBased-1],'编成技巧不存在');
  records.splice(indexOneBased-1,1);
  // The original 0x443A90 repairs only its first matching shortcut. Repair all
  // references here so duplicate bindings cannot retain a deleted record.
  for(let n=0;n<slots.length;n++)if(slots[n].type===1){if(slots[n].index_one_based===indexOneBased)slots[n]=sourceTechniqueSlot(source,roleId,2,1);else if(slots[n].index_one_based>indexOneBased)slots[n].index_one_based--;}
  world.transact(draft=>{draft.technique_combinations.roles[roleId]=records;if(draft.technique_bindings?.roles[roleId])draft.technique_bindings.roles[roleId]=slots;});return structuredClone(records);
}
