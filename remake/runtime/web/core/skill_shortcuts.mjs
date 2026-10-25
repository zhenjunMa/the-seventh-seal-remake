// Bounded editable first three slots of the native seven-slot command table.
// Four native fixed-command slots and composed techniques remain separate.
const need=(ok,message)=>{if(!ok)throw new Error(message);};
import {techniqueSlots} from './menu_techniques.mjs';
import {battleSkillEligibility} from './battle_skill_access.mjs';
import {allPartyRoles} from './party_roster.mjs';
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
export function validateSkillShortcutState(state,party){
  need(object(state)&&state.version===1&&Object.keys(state).length===2&&object(state.roles),'快捷技能存档无效');
  for(const [id,slots]of Object.entries(state.roles)){
    need(party.some(role=>role.id===id)&&Array.isArray(slots)&&slots.length===3,'快捷技能角色或槽位无效');
    need(slots.every(index=>Number.isInteger(index)&&index>=0&&index<200),'快捷技能源索引无效');
  }
  return structuredClone(state);
}
function checkSlots(source,roleId,slots){
  const role=source.roles?.[roleId];need(role,'快捷技能角色来源缺失');
  need(Array.isArray(slots)&&slots.length===3,'需要三个快捷技能槽');
  for(const index of slots){
    const skill=role.skills[index];
    need(role.learned_indices.includes(index)&&skill?.actor_id===roleId&&skill.original_skill_index===index&&skill.learned_raw!==0&&(skill.type_flags_u32_0x32&15)!==0,'快捷技能未学会或来源不属于角色');
  }
  return [...slots];
}
export function skillShortcuts(world,source,roleId){
  need(world.party.some(role=>role.id===roleId),'快捷技能角色不在队伍中');
  if(world.skill_shortcuts)validateSkillShortcutState(world.skill_shortcuts,allPartyRoles(world));
  return checkSlots(source,roleId,world.skill_shortcuts?.roles[roleId]??source.roles?.[roleId]?.default_hotkey_indices);
}
export function validateSourceSkillShortcuts(world,source){
  if(world.skill_shortcuts){validateSkillShortcutState(world.skill_shortcuts,allPartyRoles(world));
    for(const [roleId,slots]of Object.entries(world.skill_shortcuts.roles))checkSlots(source,roleId,slots);}
}
export function changeSkillShortcuts(world,source,{roleId,indices,expectedRevision=world.value.revision}){
  need(world.value.revision===expectedRevision,'操作期间进度已变化');
  need(world.value.party.some(role=>role.id===roleId),'快捷技能角色不在队伍中');
  const slots=checkSlots(source,roleId,indices);
  world.transact(draft=>{draft.skill_shortcuts??={version:1,roles:{}};draft.skill_shortcuts.roles[roleId]=slots;});
  return [...slots];
}
export function battleMenuSkillOrder(world,source,skills,roleId){
  const candidates=Object.values(skills).filter(skill=>skill.actor_id===roleId&&battleSkillEligibility(world,skill).available),slots=skillShortcuts(world,source,roleId);
  // An unsupported source slot stays saved and does not synthesize an attack.
  const indices=world.technique_bindings?techniqueSlots(world,source,roleId).filter(slot=>slot.type===0).map(slot=>slot.index_one_based-1):slots;
  const bound=indices.map(index=>candidates.find(skill=>skill.original_skill_index===index)?.id).filter(Boolean);
  return [...new Set([...bound,...candidates.map(skill=>skill.id)])];
}
