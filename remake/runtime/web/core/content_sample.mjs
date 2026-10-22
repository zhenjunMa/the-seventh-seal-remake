// Explicit development fixture. It uses source growth/admission and returns a
// private world; neither localStorage nor a user's current world is touched.
import {admitPartyMember} from './party_members.mjs';
import {applyExperience,progressHeaderForRole} from './battle_rewards.mjs';
import {validateWorld} from './world.mjs';
import {partyFormationSlots} from './party_formation.mjs';
import {initialEncounterState} from './encounters.mjs';
export function createContentSample(seed,rewards,location,{heroLevel=12,learnSkillIndices=[26]}={}){
  const world=structuredClone(seed);
  world.opening.status='complete';world.location=structuredClone(location);
  for(const id of ['002','003'])admitPartyMember(world,id);
  world.formation_slots=partyFormationSlots(world);
  // Reuse the normal character growth calculation. A development grant is
  // separate from the unchanged source learned byte and normal story unlocks.
  const trace=[];let hero=world.party[0];
  if(!Number.isInteger(heroLevel)||heroLevel<hero.level||heroLevel>99)throw new Error('扩展样本等级无效');
  while(hero.level<heroLevel){
    const raw=progressHeaderForRole(hero,rewards),view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
    hero=applyExperience(hero,Math.max(1,view.getInt32(0x2c,true)-view.getInt32(0x28,true)),rewards,()=>0,trace).role;
  }
  if(learnSkillIndices.length)hero.skill_progress={version:1,learned_indices:[...learnSkillIndices]};
  world.party[0]=hero;
  // Development-only checkpoint: the next source RNG draw is 998, which
  // satisfies the unchanged forest frequency1 threshold after step40.
  world.encounters=initialEncounterState(world.party,294);
  world.encounters.counters[world.leader_id]=40;
  return validateWorld(world);
}
