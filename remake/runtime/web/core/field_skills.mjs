// 0x450A20 lists learned skills with flag bit 13. 0x45C100 applies
// their flat recovery, then 0x426AC0 commits the caster's own resource costs.
import {createPartyActors} from './party_attributes.mjs';
import {validateWorld} from './world.mjs';
import {applySavedSkillProgress,isBattleSkillLearned} from './battle_skill_access.mjs';
const copy=structuredClone;
const need=(ok,message)=>{if(!ok)throw new Error(message);};
const view=s=>new DataView(Uint8Array.from(s.fixed_raw_hex.match(/../g),h=>parseInt(h,16)).buffer);

export function availableFieldSkills(world,skills,casterId){
  if(!world.party.some(role=>role.id===casterId))return [];
  return Object.values(skills.field_skills??{}).filter(s=>s.actor_id===casterId&&isBattleSkillLearned(world,s)&&
    ((view(s).getUint32(0x32,true)>>>13)&1)).map(skill=>applySavedSkillProgress(skill,world.party.find(role=>role.id===casterId)));
}

function context(world,attributes,skills,items,{casterId,skillId,targetId}){
  const skill=availableFieldSkills(world,skills,casterId).find(s=>s.id===skillId);
  need(skill?.field_handler==='flat-resource-recovery','此技能不能在战斗外使用');
  const raw=view(skill),get=n=>raw.getInt32(n,true);
  // This bounded handler does not simulate unrecovered stat costs or passive
  // updates. The recovered spell requires only level 10 and MP expenditure.
  need([0x147,0x14b,0x153,0x157,0x15b,0x15f,0x163].every(n=>get(n)===0)&&get(0x14f)<=0,
    '此技能的额外资源变化尚未接入');
  const actors=createPartyActors(world,attributes,{},items),caster=actors.find(a=>a.id===casterId),target=actors.find(a=>a.id===targetId);
  need(caster&&target,'技能角色或目标不在队伍中');
  need(caster.level>=get(0x143),'等级不足');
  const cost=-get(0x14f);
  need(caster.effective_mp_raw>=cost,'MP不足');
  need(get(0xab)===0||target.effective_hp_raw!==target.hp.maximum,'目标HP已满');
  return {skill,raw,get,caster,target,cost};
}

export function fieldSkillAvailability(world,attributes,skills,items,options){
  try{const c=context(world,attributes,skills,items,options);return {available:true,hp_delta:c.get(0xab),mp_delta:c.get(0xbb),mp_cost:c.cost};}
  catch(error){return {available:false,reason:error.message};}
}

function recover(raw,maximum,delta,effectiveMaximum,currentBonus){
  let next=(raw+delta)|0;
  // Native compares raw values but clamps through the linked getter. Keep
  // unequal current/max gear bonuses rather than treating them as one term.
  if(next>maximum)next=(effectiveMaximum-currentBonus)|0;
  return next;
}

export function applyFieldSkill(world,attributes,skills,items,options){
  const {skill,get,caster,target,cost}=context(world,attributes,skills,items,options),next=copy(world);
  const targetRole=next.party.find(role=>role.id===target.id),casterRole=next.party.find(role=>role.id===caster.id);
  targetRole.hp.current=recover(target.raw_hp,target.raw_hp_maximum,get(0xab),target.hp.maximum,target.resource_bonuses.hp_current)>>>0;
  targetRole.mp.current=recover(target.raw_mp,target.raw_mp_maximum,get(0xbb),target.mp.maximum,target.resource_bonuses.mp_current)>>>0;
  // Self-target recovery precedes expenditure. Native caster costs then clamp
  // to raw maxima and their hard caps (9999 HP / 999 MP).
  casterRole.hp.current=Math.min(Math.max(casterRole.hp.current|0,0),caster.raw_hp_maximum,9999)>>>0;
  casterRole.mp.current=Math.min(Math.max((casterRole.mp.current|0)-cost,0),caster.raw_mp_maximum,999)>>>0;
  validateWorld(next);
  const after=createPartyActors(next,attributes,{},items),targetAfter=after.find(a=>a.id===target.id),casterAfter=after.find(a=>a.id===caster.id);
  return {world:next,result:{skillId:skill.id,name:skill.name,casterId:caster.id,targetId:target.id,mp_cost:cost,
    target_hp:{before:target.hp.current,after:targetAfter.hp.current},target_mp:{before:target.mp.current,after:targetAfter.mp.current},
    caster_mp:{before:caster.mp.current,after:casterAfter.mp.current},configuration:copy(skill.configuration??null)}};
}

export function useWorldSkill(world,attributes,skills,items,{expectedRevision=world.value.revision,...options}){
  need(world.value.revision===expectedRevision,'操作期间进度已变化');
  const applied=applyFieldSkill(world.snapshot(),attributes,skills,items,options);
  world.transact(draft=>{draft.party=applied.world.party;});
  return {...applied.result,world_revision:world.value.revision};
}
