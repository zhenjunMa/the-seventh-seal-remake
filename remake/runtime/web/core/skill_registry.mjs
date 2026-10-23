// One numeric configuration registry for every implemented role skill.
// Source actions, eligibility, targeting and effect rules stay in source data.
import {configureSkills,sourceSkillParameters} from './skill_config.mjs';
import {supportedBattleRecoverySkills} from './battle_skill_access.mjs';
import {expandParameterOverrides,isParameterOverrideFile} from './config_overrides.mjs';
const copy=structuredClone;
const fail=(ok,message)=>{if(!ok)throw new Error(`技能配置：${message}`);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const canonical=v=>JSON.stringify(Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
const same=(a,b)=>canonical(a)===canonical(b);
const fields=(v,keys,label)=>fail(object(v)&&same(Object.keys(v).sort(),[...keys].sort()),`${label}字段缺失或未知`);
const view=s=>new DataView(Uint8Array.from(s.fixed_raw_hex.match(/../g),h=>parseInt(h,16)).buffer);
const hex=v=>Array.from(new Uint8Array(v.buffer),n=>n.toString(16).padStart(2,'0')).join('');

export function skillOwner(skill,side){
  const role_id=skill?.actor_id,skill_index=skill?.original_skill_index;
  fail(typeof role_id==='string'&&/^\d{3}$/.test(role_id),'技能角色编号无效');
  fail(Number.isInteger(skill_index)&&skill_index>=0&&skill_index<200,'原技能索引无效');
  fail(['player','enemy'].includes(side),'技能所属阵营无效');
  return {role_id,skill_index,side};
}
export const skillOwnerKey=skill=>`${skillOwner(skill,'player').role_id}:${skill.original_skill_index}`;
export const runtimeSkillParameters=skill=>({...sourceSkillParameters(skill),preparation_delay_raw:view(skill).getInt32(0x2e,true)});

function enemySkills(data){
  return Object.fromEntries(Object.entries(data.ai.roles).flatMap(([id,role])=>role.learned_indices.map(index=>{
    const skill=role.skills[index];fail(skill?.actor_id===id&&skill.original_skill_index===index,`${id}_${index}敌技角色或源索引不同`);
    return [`${id}_${index}`,skill];
  })));
}
export function createSkillRegistry(data){
  const party=data.party_skills;
  fail(party?.schema==='seventh-seal-party-skills'&&party.version===1&&object(party.skills),'缺少已接入队伍技能源目录');
  const registry={},owners=new Set();
  const add=(id,skill,side,hashes)=>{
    fail(/^[a-zA-Z0-9_]+$/.test(id)&&!Object.hasOwn(registry,id),`技能ID重复或无效：${id}`);
    const owner=skillOwner(skill,side),key=skillOwnerKey(skill),source=skill.source;
    fail(!owners.has(key),`同一角色技能重复登记：${key}`);
    fail(source?.path===`Fight_Role/${owner.role_id}.CHR`&&/^[0-9a-f]{64}$/.test(source.sha256??'')&&source.sha256===hashes?.[source.path],`${id}角色与源CHR指纹不同`);
    fail(Number.isInteger(source.fixed_record_offset)&&source.fixed_record_offset>=8&&source.fixed_bytes===1053,`${id}原记录偏移或长度无效`);
    runtimeSkillParameters(skill); // Validate the retained numeric record before registration.
    owners.add(key);registry[id]={skill,owner};
  };
  for(const [id,skill]of Object.entries({...party.skills,...party.field_skills,...supportedBattleRecoverySkills(party)})){
    fail(id===skill.id&&skill.index===skill.original_skill_index,`${id}源技能ID或索引不同`);add(id,skill,'player',party.source_hashes);
  }
  for(const [id,skill]of Object.entries(enemySkills(data)))add(id,skill,'enemy',data.ai.source_hashes);
  return registry;
}

export function deriveSkillConfiguration(data){
  const entries=Object.fromEntries(Object.entries(createSkillRegistry(data)).map(([id,{skill,owner}])=>{
    const parameters=runtimeSkillParameters(skill);
    return [id,{name:skill.name,owner:copy(owner),source:copy(skill.source),original:copy(parameters),parameters:copy(parameters)}];
  }));
  return {schema:'seventh-seal-skills-parameters',version:2,
    notes:'所有已接入角色技能共用此表；owner按角色编号与原技能索引绑定，ID保持稳定。只修改parameters；source、owner和original只读。随机上限不包含；六元素槽保持原顺序。preparation_delay_raw=0使用battle.json默认准备量。动作、目标、学习条件和特效规则保留原来源；敌方耗蓝当前只支持0。',entries};
}

/** Compile numeric fields onto this source record, retaining its own actions.
 * Historical fixtures may use a save-backed equivalent; owner and every
 * numeric baseline must match the canonical CHR entry before it can be used.
 */
export function applyRegisteredSkillParameters(skill,row,mode){
  fail(same(skillOwner(skill,row.owner.side),row.owner),`${skill.id}角色或原技能索引与配置不同`);
  fail(same(runtimeSkillParameters(skill),row.original),`${skill.id}原数值与统一配置基线不同`);
  const original=copy(row.original),parameters=copy(row.parameters);
  delete original.preparation_delay_raw;delete parameters.preparation_delay_raw;
  const result=configureSkills({[skill.id]:skill},{schema:'seventh-seal-skill-config',version:1,mode,
    skills:{[skill.id]:{name:skill.name,source:copy(skill.source),original,parameters}}})[skill.id];
  const raw=view(result);raw.setInt32(0x2e,row.parameters.preparation_delay_raw,true);result.fixed_raw_hex=hex(raw);
  const differences=Object.keys(row.original).filter(key=>!same(row.original[key],row.parameters[key]))
    .map(field=>({field,original:copy(row.original[field]),current:copy(row.parameters[field])}));
  result.configuration={mode,version:2,owner:copy(row.owner),source:copy(row.source),
    original:copy(row.original),parameters:copy(row.parameters),differences,
    authority:mode==='debug'?'development-parameters; not original skill values':'retained-original-record'};
  return result;
}

/** Export-only upgrade. Existing edits are retained and all files are compiled
 * before writing. Runtime loading requires the complete current registry.
 */
export function upgradeSkillConfiguration(data,config){
  const defaults=deriveSkillConfiguration(data);
  if(isParameterOverrideFile(config))return expandParameterOverrides(defaults,config,{allowNewEntries:true});
  fields(config,['schema','version','notes','entries'],'skills.json');
  fail(config.schema===defaults.schema&&[1,2].includes(config.version)&&typeof config.notes==='string'&&object(config.entries),'技能配置版本不兼容');
  const legacy={yantu:data.combat.skills.yantu,...data.forest.player_skills,...enemySkills(data)};
  const upgraded=copy(config.version===1?defaults:config);
  for(const [id,row]of Object.entries(config.entries)){
    const target=defaults.entries[id];fail(target,`配置中的技能已移除或未知：${id}`);
    fields(row,config.version===1?['name','source','original','parameters']:['name','owner','source','original','parameters'],id);
    if(config.version===1){
      const source=legacy[id];fail(source&&row.name===source.name&&same(row.source,source.source)&&same(row.original,runtimeSkillParameters(source)),`${id}旧配置来源或基线不同，拒绝迁移`);
      fail(same(row.original,target.original),`${id}新旧数值基线不同，拒绝迁移`);
      upgraded.entries[id].parameters=copy(row.parameters);
    }else fail(row.name===target.name&&same(row.owner,target.owner)&&same(row.source,target.source)&&same(row.original,target.original),`${id}配置身份、来源或基线不同`);
  }
  for(const [id,row]of Object.entries(defaults.entries))if(!Object.hasOwn(upgraded.entries,id))upgraded.entries[id]=copy(row);
  return upgraded;
}
