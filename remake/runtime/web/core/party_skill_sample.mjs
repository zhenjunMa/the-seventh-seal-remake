// Explicit development worlds. Source definitions, normal learning conditions
// and player saves remain untouched; grants exist only in the returned world.
import {admitPartyMember,deactivatePartyMember} from './party_members.mjs';
import {allPartyRoles} from './party_roster.mjs';
import {applyExperience,progressHeaderForRole} from './battle_rewards.mjs';
import {initialEncounterState} from './encounters.mjs';
import {validateWorld} from './world.mjs';

export const PARTY_SKILL_SAMPLE_ROSTERS=Object.freeze({
  A:Object.freeze(['001','002','003','004']),
  B:Object.freeze(['001','004','005','006'])
});
const need=(ok,message)=>{if(!ok)throw new Error(message);};

/** All named source skills, including the two original type-0 aid records.
 * Keeping those records learned does not change their original menu type.
 */
export function partySampleSkillIndices(sourceRole){
  need(sourceRole?.skills&&sourceRole.id,'全技巧样本缺少人物技能源记录');
  return sourceRole.skills.filter(skill=>skill.name?.trim()&&[0,1,2,3].includes(skill.type_raw))
    .map(skill=>skill.original_skill_index).sort((a,b)=>a-b);
}

export function createPartySkillSample(seed,rewards,commands,location,{activeRoleIds=PARTY_SKILL_SAMPLE_ROSTERS.A}={}){
  const world=validateWorld(seed),ids=Object.keys(commands.roles??{}).sort();
  need(ids.length===6&&ids.every(id=>rewards.initial_roles?.[id]&&world.source.role_definitions?.[id]),'全技巧样本需要六名队友的原始成长和技能');
  need(Array.isArray(activeRoleIds)&&activeRoleIds.length===4&&new Set(activeRoleIds).size===4&&activeRoleIds.every(id=>ids.includes(id)),'全技巧样本必须选择四名已登记队友');
  need(allPartyRoles(world).every(role=>ids.includes(role.id)),'全技巧样本包含未知人物');
  // Use the normal admission/departure paths, including the four-slot cap and
  // persistence envelope. Temporarily move a non-leader to reserve if full.
  for(const id of ids){
    if(allPartyRoles(world).some(role=>role.id===id))continue;
    if(world.party.length===4)deactivatePartyMember(world,world.party.findLast(role=>role.id!==world.leader_id).id);
    need(admitPartyMember(world,id).added,'全技巧样本入队失败');
  }
  for(const role of [...world.party])if(!activeRoleIds.includes(role.id)){
    if(world.leader_id===role.id)world.leader_id=world.party.find(row=>activeRoleIds.includes(row.id))?.id??world.party.find(row=>row.id!==role.id).id;
    deactivatePartyMember(world,role.id);
  }
  for(const id of activeRoleIds)admitPartyMember(world,id);
  world.party=activeRoleIds.map(id=>world.party.find(role=>role.id===id));
  world.leader_id=activeRoleIds[0];world.formation_slots=[...activeRoleIds];
  for(const role of allPartyRoles(world)){
    let grown=role;const trace=[];
    while(grown.level<99){
      const raw=progressHeaderForRole(grown,rewards),view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
      grown=applyExperience(grown,Math.max(1,view.getInt32(0x2c,true)-view.getInt32(0x28,true)),rewards,()=>0,trace).role;
    }
    const learned=new Set([...(grown.skill_progress?.learned_indices??[]),...partySampleSkillIndices(commands.roles[role.id])]);
    grown.skill_progress={version:2,learned_indices:[...learned].sort((a,b)=>a-b),records:structuredClone(grown.skill_progress?.records??[])};
    Object.assign(role,grown);
  }
  if(world.opening)world.opening.status='complete';
  world.location=structuredClone(location);
  // The next native draw is 998. On the registered forest checkpoint the next
  // successful 16-pixel step triggers the unchanged encounter transaction.
  world.encounters=initialEncounterState(world.party,294);
  world.encounters.counters[world.leader_id]=40;
  return validateWorld(world);
}
