import {createPartySkillSample,PARTY_SKILL_SAMPLE_ROSTERS} from '../../web/core/party_skill_sample.mjs';

export const playerRoleIds=['001','002','003','004','005','006'];
export const fullSkillGroups=Object.values(PARTY_SKILL_SAMPLE_ROSTERS);

// Use the retained library, independently of the runtime admission manifest.
// The unnamed 003:50 animation and type0 005:30 aid record remain sources.
export function namedPartySourceSkills(library){
  return Object.values(library.skills).filter(skill=>playerRoleIds.includes(skill.actor_id)&&skill.name&&[1,2,3].includes(skill.type_raw));
}

export function level99SkillWorld(seed,rewards,commands,ids){
  return createPartySkillSample(seed,rewards,commands,seed.location,{activeRoleIds:ids});
}

export function nativeSequenceSteps(compiled){
  return compiled.steps.flatMap(step=>step.carrier_spawn?[step,...step.carrier_spawn.steps]:[step]);
}
