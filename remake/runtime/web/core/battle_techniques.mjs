// Saved compositions are commands over existing configured skills, not new
// numeric definitions. Native 42FE40 -> 501E90 dispatches their members.
import {techniqueCombinations,techniqueCombinationName} from './menu_techniques.mjs';
import {battleSkillEligibility} from './battle_skill_access.mjs';

export const battleTechniqueId=(roleId,indexOneBased)=>`technique:${roleId}:${indexOneBased}`;
export function createBattleTechniques(world,source,skills,charset=null){
  const result={};
  for(const role of world.party)for(const [index,record]of techniqueCombinations(world,source,role.id).entries()){
    const members=record.indices.map(i=>Object.values(skills).find(skill=>skill.actor_id===role.id&&skill.original_skill_index===i));
    const missing=record.indices.findIndex((i,n)=>!members[n]);
    let unavailable='';
    if(missing>=0){
      const original=source.roles[role.id].skills[record.indices[missing]],eligibility=battleSkillEligibility(world,original);
      unavailable=eligibility.available?`组合中的「${original.name}」尚未接入战斗。`:`组合中的「${original.name}」尚未学会或角色等级不足。`;
    }
    const id=battleTechniqueId(role.id,index+1);
    result[id]={id,actor_id:role.id,name:charset?techniqueCombinationName(record,charset):`编成技巧 ${index+1}`,
      battle_handler:'combination',technique_index_one_based:index+1,component_skill_ids:members.map(skill=>skill?.id??null),
      component_indices:[...record.indices],mp_cost:members.reduce((sum,skill)=>sum+(skill?.mp_cost??0),0),
      unavailable_reason:unavailable,icon:record.icon,color:record.total_units,
      source:{kind:'saved-technique',role_id:role.id,native_raw_hex:record.native_raw_hex},
      evidence:['ev_cc2a61bc12664a3028466acad29330e69f7d036955f7d95117e84388aa0af6c1',
        'ev_83211444e38be8006ea27651f70345eacf6b681907e03ef2386c58dcd58028e5']};
  }
  return result;
}
