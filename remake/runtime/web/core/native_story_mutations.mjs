// Recovered TLK mutations retain source identities. Learned progress does not
// register a skill handler, and synthesis unlocks do not create inventory.
import {validateBattleSkillProgress} from './battle_skill_access.mjs';
import {allPartyRoles} from './party_roster.mjs';
import {restoreNativeStoryResources} from './recovery.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(`原剧情变更：${message}`);};
const uint=value=>Number.isInteger(value)&&value>=0&&value<=0xffffffff;
const roleId=slot=>String(slot+1).padStart(3,'0');
export const NATIVE_STORY_MUTATION_TYPES=new Set([3,10,11,14,16,17]);
export const NATIVE_STORY_MUTATION_EVIDENCE={
  restoreResources:'ev_f5b336470c325748b8696f702dd1babb487b4e55109ad82d9a04fb904683770d',
  learn:'ev_b81f3b90a966881565f8fafb6e081714c775bca83167ec9eff4199d7a3facf83',
  noEffect:'ev_ea329184a6c4cfc0204f6f3c93d6d9cbbf3da28fe8e7094c7541f5679f1452a2',
  synthesis:'ev_2a1703678dc0fc8df4355f2d71101212f2e70be464c0b148868bbe2cff0633c3'
};

function sourceSkill(definition,id,sourceId){
  if(!definition)return undefined;
  const source=definition.source??definition;
  need(definition.id===id&&source.path===`Fight_Role/${id}.CHR`&&/^[0-9a-f]{64}$/.test(source.sha256??'')
    &&Array.isArray(definition.skills),'角色技能源定义无效');
  // 444BA0 stops at the first source-ID byte match, not an array index.
  const skill=definition.skills.find(skill=>skill.id===sourceId);
  if(skill)need(Number.isInteger(skill.index)&&skill.index>=0&&skill.index<200,'技能源索引无效');
  return skill??null;
}

export function validateNativeStoryMutation(record,{roleDefinitions={}}={}){
  need(NATIVE_STORY_MUTATION_TYPES.has(record?.mutation_type),`类型 ${record?.mutation_type} 尚未接入`);
  need(uint(record.mutation_index)&&uint(record.mutation_bit),'变更参数无效');
  if(record.mutation_type===14){
    need(record.mutation_index<10&&record.mutation_bit<=255,'学会技巧的角色槽或来源编号无效');
    const id=roleId(record.mutation_index);sourceSkill(roleDefinitions[id],id,record.mutation_bit);
  }
  if(record.mutation_type===17)need(record.mutation_bit<=416,'合成物品来源编号无效');
  return record;
}

export function validateNativeStoryMutationState(world){
  if('native_pending_skill_unlocks' in world){
    const rows=world.native_pending_skill_unlocks,seen=new Set();
    need(Array.isArray(rows)&&rows.length<=2560,'待应用技能源记录无效');
    for(const row of rows){
      need(row&&Object.keys(row).sort().join(',')==='role_id,source_skill_id'&&typeof row.role_id==='string'&&/^(?:00[1-9]|010)$/.test(row.role_id)
        &&Number.isInteger(row.source_skill_id)&&row.source_skill_id>=0&&row.source_skill_id<=255,'待应用技能源身份无效');
      const key=`${row.role_id}:${row.source_skill_id}`;need(!seen.has(key),'待应用技能源记录重复');seen.add(key);
    }
  }
  if('recipe_unlock_indices' in world){
    const rows=world.recipe_unlock_indices;
    need(Array.isArray(rows)&&rows.length<=416&&new Set(rows).size===rows.length
      &&rows.every(index=>Number.isInteger(index)&&index>=0&&index<416),'物品合成解锁索引无效');
  }
}

function learn(role,skill){
  if(role.skill_progress)validateBattleSkillProgress(role.skill_progress);
  if(skill.learned_flag||role.skill_progress?.learned_indices.includes(skill.index))return false;
  role.skill_progress={...(role.skill_progress??{version:1}),
    learned_indices:[...role.skill_progress?.learned_indices??[],skill.index].sort((a,b)=>a-b)};
  return true;
}

export function applyPendingNativeSkillUnlocks(draft,role,{roleDefinitions={}}={}){
  validateNativeStoryMutationState(draft);
  const definitions={...draft.source?.role_definitions,...roleDefinitions},remaining=[],applied=[];
  for(const row of draft.native_pending_skill_unlocks??[]){
    if(row.role_id!==role.id){remaining.push(row);continue;}
    const skill=sourceSkill(definitions[role.id],role.id,row.source_skill_id);
    if(skill===undefined){remaining.push(row);continue;}
    if(skill&&learn(role,skill))applied.push(skill.index);
    // A known source with no match has the same no-effect result as 444BA0.
  }
  if(draft.native_pending_skill_unlocks)draft.native_pending_skill_unlocks=remaining;
  return {role_id:role.id,learned_indices:applied};
}

export function applyNativeStoryMutation(draft,record,{roleDefinitions={}}={}){
  const definitions={...draft.source?.role_definitions,...roleDefinitions};
  validateNativeStoryMutation(record,{roleDefinitions:definitions});
  validateNativeStoryMutationState(draft);
  if(record.mutation_type===3){
    // 4618DA adds signed TLK +27 with 32-bit wrap, then clamps negatives.
    const before=draft.money??0,delta=record.mutation_index|0;
    draft.money=Math.max(0,(before+delta)|0);
    return {mutation_type:3,money_before:before,money_after:draft.money,delta};
  }
  if(record.mutation_type===10||record.mutation_type===11){
    // These native branches never read TLK mutation_index/mutation_bit.
    const resource=record.mutation_type===10?'hp':'mp';
    return {mutation_type:record.mutation_type,resource,updates:restoreNativeStoryResources(draft,resource)};
  }
  if(record.mutation_type===16){
    // 461CBC..461CF8 reads arguments and optionally logs, then reaches the
    // 461CF9 epilogue. There is no native gameplay write or helper call.
    return {mutation_type:16,changed:false,native_effect:'none'};
  }
  if(record.mutation_type===17){
    if(record.mutation_bit===0)return {mutation_type:17,changed:false};
    const index=record.mutation_bit-1;
    if(draft.recipe_unlock_indices?.includes(index))return {mutation_type:17,index,changed:false};
    (draft.recipe_unlock_indices??=[]).push(index);
    return {mutation_type:17,index,changed:true};
  }
  const id=roleId(record.mutation_index),skill=sourceSkill(definitions[id],id,record.mutation_bit);
  if(skill===null)return {mutation_type:14,role_id:id,source_skill_id:record.mutation_bit,changed:false,matched:false};
  if(skill?.learned_flag)return {mutation_type:14,role_id:id,source_skill_id:record.mutation_bit,index:skill.index,changed:false,matched:true};
  const role=allPartyRoles(draft).find(role=>role.id===id);
  if(role&&skill)return {mutation_type:14,role_id:id,source_skill_id:record.mutation_bit,
    index:skill.index,changed:learn(role,skill),matched:true};
  const rows=draft.native_pending_skill_unlocks??=[];
  if(rows.some(row=>row.role_id===id&&row.source_skill_id===record.mutation_bit))
    return {mutation_type:14,role_id:id,source_skill_id:record.mutation_bit,changed:false,pending:true};
  rows.push({role_id:id,source_skill_id:record.mutation_bit});
  return {mutation_type:14,role_id:id,source_skill_id:record.mutation_bit,changed:true,pending:true};
}
