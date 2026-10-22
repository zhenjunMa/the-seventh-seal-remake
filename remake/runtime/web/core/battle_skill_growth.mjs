// Original skill practice / rank growth / prerequisite learning. Fixed CHR
// records stay immutable; saved rank and experience are replayed onto the
// selected source/configuration snapshot, never used as another parameter file.
import {idiv} from './combat_rules.mjs';
const copy=structuredClone,need=(ok,message)=>{if(!ok)throw new Error(message);};
const int=(n,label,min=-2147483648,max=2147483647)=>{need(Number.isInteger(n)&&n>=min&&n<=max,`${label}无效`);return n;};
const add=(a,b)=>(a+b)|0;
const bytes=skill=>{need(/^(?:[0-9a-f]{2}){1053}$/i.test(skill?.fixed_raw_hex),'技巧成长原记录无效');return Uint8Array.from(skill.fixed_raw_hex.match(/../g),n=>parseInt(n,16));};
const hex=b=>Array.from(b,n=>n.toString(16).padStart(2,'0')).join('');
const view=b=>new DataView(b.buffer,b.byteOffset,b.byteLength);
const signed=n=>n&128?n-256:n;
export const SKILL_GROWTH_EVIDENCE=Object.freeze({practice:'ev_671ce5d0595f5d8a6af3720a3dbdadeb33e2cfa1a168b28595b81f6d8861a1f2',upgrade:'ev_a6e1c1739d3f04a4b1f5c8a312d5bfe35ffa6fdc7e23c1ac84c688e9ba84a92b',prerequisite:'ev_7859d6c93ab161979a62219e691309ea9ceb9da1b3e76de18c7c50b30bc54f7a',settle:'ev_b513b24728bf72e5a50ea92ea4ad9463fd8ff6aee9939be0f3521468441c55e0'});

function refresh(skill,b){const v=view(b),out={...copy(skill),fixed_raw_hex:hex(b),learned_raw:b[0x23],skill_level_raw:b[0x2d],skill_experience_raw:v.getInt32(0x2fb,true),mp_delta_raw:v.getInt32(0x14f,true)};out.mp_cost=Math.max(0,-out.mp_delta_raw);return out;}
/** Native 50C000: flat first, then percent of the updated signed DWORD. */
export function upgradeNativeSkill(skill){
  const b=bytes(skill),v=view(b),get=n=>v.getInt32(n,true),put=(n,value)=>v.setInt32(n,value,true);b[0x23]=1;
  if(b[0x2d]<7){
    b[0x2d]++;
    for(let pair=0;pair<8;pair++)for(let side=0;side<2;side++){
      const at=0xab+pair*8+side*4,flat=get(0x303+pair*4),percent=get(0x327+pair*4),value=add(get(at),flat);
      put(at,add(value,idiv(Math.imul(value,percent),100)));
    }
    for(const [at,increment]of [[0x14b,0x327],[0x14f,0x32f],[0x153,0x337],[0x157,0x33b],[0x15b,0x33f],[0x15f,0x343]])put(at,add(get(at),get(increment)));
    for(let i=0;i<5;i++){b[0xfb+i]=(b[0xfb+i]+b[0x34b+i])&255;b[0x100+i]=(b[0x100+i]+b[0x350+i])&255;}
    for(let i=0;i<10;i++)put(0x105+i*4,add(get(0x105+i*4),signed(b[0x355+i])));
    b[0x12d]=(b[0x12d]+b[0x35f])&255;
  }
  return refresh(skill,b);
}

/** Compile after numeric configuration source/baseline validation. */
export function applySavedSkillProgress(skill,role){
  const index=skill.original_skill_index??skill.index,b=bytes(skill),record=role?.skill_progress?.version===2?role.skill_progress.records.find(row=>row.index===index):null;
  const marker=record||role?.skill_progress?.learned_indices.includes(index)?{index,level:record?.level??b[0x2d],experience:record?.experience??view(b).getInt32(0x2fb,true),learned:Boolean(b[0x23]||role?.skill_progress?.learned_indices.includes(index))}:null;
  if(marker&&JSON.stringify(skill.skill_progress_applied)===JSON.stringify(marker))return copy(skill);
  let out=copy(skill);
  if(record){
    const initial=b[0x2d],base=Math.max(1,initial);need(record.level>=initial&&record.level<=7,'保存技巧等级低于原记录');
    for(let level=base;level<record.level;level++)out=upgradeNativeSkill(out);
    const compiled=bytes(out),v=view(compiled);compiled[0x2d]=record.level;v.setInt32(0x2fb,record.experience,true);v.setInt32(0x2ff,0,true);out=refresh(out,compiled);
  }
  if(role?.skill_progress?.learned_indices.includes(index)){const raw=bytes(out);raw[0x23]=1;out=refresh(out,raw);}
  if(marker)out.skill_progress_applied=marker;return out;
}

/** Keep only fixed records needed for progression, not complete action tables. */
export function skillGrowthSource(commands){
  need(commands?.schema==='seventh-seal-party-skills'&&commands.version===1&&commands.roles,'技巧成长来源缺失');
  return {roles:Object.fromEntries(Object.entries(commands.roles).map(([id,role])=>[id,{id,name:role.name,skill_count:role.skill_count,skills:role.skills.map(skill=>{
    bytes(skill);need(skill.actor_id===id&&Number.isInteger(skill.original_skill_index),'技巧成长归属无效');
    return {id:skill.id,actor_id:id,index:skill.original_skill_index,original_skill_index:skill.original_skill_index,name:skill.name,source:copy(skill.source),fixed_raw_hex:skill.fixed_raw_hex};
  })}]))};
}

/** 501CC0 calls once at action start, even on a miss/rejected contact. */
export function recordNativeSkillPractice(practice,actor,skill,componentCount=1){
  const b=bytes(skill),index=int(skill.original_skill_index??skill.index,'技巧索引',0,199),count=int(componentCount,'编成招数',1,200),level=Math.max(1,Math.min(7,b[0x2d]));
  const gain=Math.imul([10,8,6,5,4,2,1][level-1],Math.min(count,7));
  practice[actor.id]??={};practice[actor.id][index]=add(practice[actor.id][index]??0,gain);
  return {actor_id:actor.id,skill_index:index,component_count:count,level,gain,pending:practice[actor.id][index]};
}

const rank=skill=>bytes(skill)[0x2d];
/** 50C4C0 finds the first original ID, regardless of its learned byte. */
export function nativeSkillPrerequisite(skills,originalId,requiredLevel){
  const found=skills.find(skill=>signed(bytes(skill)[0])===originalId);return Boolean(found&&rank(found)>=requiredLevel);
}

/** 50C560: source index order, skill upgrades first, then one learning pass.
 * Skill eligibility uses the actor level BEFORE report experience is applied.
 */
export function settleNativeSkillProgress({role,source_role,practice={},chain_bonus=0}){
  int(chain_bonus,'连击技巧奖励',0);need(source_role?.id===role.id&&source_role.skills.length===source_role.skill_count,'技巧成长角色来源无效');
  const skills=source_role.skills.map(skill=>applySavedSkillProgress(skill,role)),notifications=[],trace=[];let changedRank=false,practiceTotal=0;
  for(let index=0;index<skills.length;index++){
    let skill=skills[index],b=bytes(skill),v=view(b),required=v.getInt32(0x2f7,true);
    if(!b[0x23]||!(v.getUint32(0x32,true)&15)||required===0||b[0x2d]>=7)continue;
    if(b[0x2d]===0)b[0x2d]=1;
    const pending=int(practice[index]??0,'技巧实践'),before={level:b[0x2d],experience:v.getInt32(0x2fb,true)},gain=add(pending,chain_bonus),total=add(before.experience,gain);
    if(pending!==0)practiceTotal=add(practiceTotal,gain);
    v.setInt32(0x2fb,total,true);v.setInt32(0x2ff,0,true);skill=refresh(skill,b);
    if(required<=total){
      const count=idiv(total,required);view(b).setInt32(0x2fb,add(total,-Math.imul(required,count)),true);skill=refresh(skill,b);
      for(let n=0;n<count;n++)skill=upgradeNativeSkill(skill);
      changedRank=true;notifications.push({type:'skill-level-up',actor_id:role.id,actor_name:role.name,skill_index:index,skill_name:skill.name,before,after:{level:rank(skill),experience:view(bytes(skill)).getInt32(0x2fb,true)}});
    }
    skills[index]=skill;trace.push({type:'skill-practice-settled',actor_id:role.id,skill_index:index,pending,chain_bonus,gain,level_before:before.level,level_after:rank(skill)});
  }
  if(changedRank)for(let index=0;index<skills.length;index++){
    const skill=skills[index],b=bytes(skill),v=view(b);if(b[0x23]||v.getInt32(0x143,true)>role.level||!(v.getUint32(0x32,true)&15))continue;
    let any=false,accepted=true;
    for(let n=0;n<4&&accepted;n++){
      const wanted=signed(b[0x360+n*5]);if(wanted===0)continue;
      accepted=nativeSkillPrerequisite(skills,wanted-1,v.getInt32(0x361+n*5,true));if(accepted)any=true;
    }
    if(any&&accepted){const before={learned:false,level:b[0x2d]};b[0x23]=1;if(b[0x2d]===0)b[0x2d]=1;skills[index]=refresh(skill,b);notifications.push({type:'skill-learned',actor_id:role.id,actor_name:role.name,skill_index:index,skill_name:skill.name,before,after:{learned:true,level:b[0x2d]}});}
  }
  const learned=new Set(role.skill_progress?.learned_indices??[]),records=[];
  skills.forEach((skill,index)=>{
    const current=bytes(skill),initial=bytes(source_role.skills[index]),v=view(current),iv=view(initial);
    if(current[0x23]&&!initial[0x23])learned.add(index);
    if(current[0x2d]!==initial[0x2d]||v.getInt32(0x2fb,true)!==iv.getInt32(0x2fb,true))records.push({index,level:current[0x2d],experience:v.getInt32(0x2fb,true)});
  });
  const next=copy(role);
  if(records.length||learned.size||role.skill_progress)next.skill_progress={version:2,learned_indices:[...learned].sort((a,b)=>a-b),records};
  return {role:next,skills,notifications,practice_total:practiceTotal,trace};
}
