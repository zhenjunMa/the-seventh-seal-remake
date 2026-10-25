// Native learned bytes stay immutable. Sparse saved progress records additional
// learned source indices; this does not grant or infer unlocks from level/name.
import {nativeRevivalSkillSupported} from './battle_revival.mjs';
import {applySavedSkillProgress} from './battle_skill_growth.mjs';
import {allPartyRoles} from './party_roster.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(message);};
export function validateBattleSkillProgress(value){
  need(value&&[1,2].includes(value.version)&&Object.keys(value).sort().join(',')===(value.version===1?'learned_indices,version':'learned_indices,records,version')&&Array.isArray(value.learned_indices), '角色已学技巧记录无效');
  need(value.learned_indices.length<=200&&new Set(value.learned_indices).size===value.learned_indices.length&&value.learned_indices.every(i=>Number.isInteger(i)&&i>=0&&i<200),'角色已学技巧索引无效');
  if(value.version===2){
    need(Array.isArray(value.records)&&value.records.length<=200&&new Set(value.records.map(r=>r?.index)).size===value.records.length,'角色技巧成长记录无效');
    for(const row of value.records)need(row&&Object.keys(row).sort().join(',')==='experience,index,level'&&Number.isInteger(row.index)&&row.index>=0&&row.index<200&&Number.isInteger(row.level)&&row.level>=0&&row.level<=7&&Number.isInteger(row.experience)&&row.experience>=-2147483648&&row.experience<=2147483647,'角色技巧成长数值无效');
  }
  return structuredClone(value);
}
export {applySavedSkillProgress};
/** Read-only source facade for menus, bindings and displayed proficiency. */
export function effectiveSkillSource(commands,world){
  const out=structuredClone(commands),roles=new Map(allPartyRoles(world).map(role=>{if(role.skill_progress)validateBattleSkillProgress(role.skill_progress);return [role.id,role];}));
  for(const [id,role]of Object.entries(out.roles??{}))if(roles.has(id)){
    role.skills=role.skills.map(skill=>applySavedSkillProgress(skill,roles.get(id)));role.learned_indices=role.skills.filter(s=>s.learned_raw).map(s=>s.original_skill_index);
  }
  for(const table of [out.skills,out.field_skills])for(const [id,skill]of Object.entries(table??{}))if(roles.has(skill.actor_id))table[id]=applySavedSkillProgress(skill,roles.get(skill.actor_id));
  return out;
}
export function isBattleSkillLearned(world,skill){
  const role=world.party.find(r=>r.id===skill.actor_id);if(!role)return false;
  const progress=role.skill_progress?validateBattleSkillProgress(role.skill_progress):null;
  return Boolean(skill.learned_raw||progress?.learned_indices.includes(skill.original_skill_index));
}
export function requiredSkillLevel(skill){
  need(/^(?:[0-9a-f]{2}){1053}$/.test(skill?.fixed_raw_hex),'技能源记录缺失');
  const bytes=Uint8Array.from(skill.fixed_raw_hex.match(/../g),part=>parseInt(part,16));
  return new DataView(bytes.buffer).getInt32(0x143,true);
}
export function battleSkillEligibility(world,skill){
  const role=world.party.find(row=>row.id===skill.actor_id),required_level=requiredSkillLevel(skill);
  const learned=isBattleSkillLearned(world,skill),level=role?.level??0;
  return {available:learned&&level>=required_level,learned,required_level,level};
}
export function supportedBattleRecoverySkills(commands){
  return Object.fromEntries(Object.values(commands.roles??{}).flatMap(role=>(role.skills??[])
    .filter(nativeRevivalSkillSupported).map(source=>{const id=`${role.id}_${source.original_skill_index}`;
      return [id,{...structuredClone(source),id,battle_handler:'native-revival',evidence:source.evidence??Object.values(commands.evidence??{})}];})));
}
