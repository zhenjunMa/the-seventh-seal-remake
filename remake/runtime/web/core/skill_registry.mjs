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
const sourceOnlyParameterCache=new WeakMap();

export function skillOwner(skill,side){
  const role_id=skill?.actor_id,skill_index=skill?.original_skill_index;
  fail(typeof role_id==='string'&&/^\d{3}$/.test(role_id),'技能角色编号无效');
  fail(Number.isInteger(skill_index)&&skill_index>=0&&skill_index<200,'原技能索引无效');
  fail(['player','enemy'].includes(side),'技能所属阵营无效');
  return {role_id,skill_index,side};
}
export const skillOwnerKey=skill=>`${skillOwner(skill,'player').role_id}:${skill.original_skill_index}`;
export const runtimeSkillParameters=skill=>({...sourceSkillParameters(skill),preparation_delay_raw:view(skill).getInt32(0x2e,true)});

/** Unknown commands, idle records and reactions retain their native numeric
 * slots without assigning them an executable battle/field interpretation.
 * In particular a positive native MP delta is not a negative MP cost.
 */
export function sourceOnlySkillParameters(skill){
  fail(typeof skill.fixed_raw_hex==='string'&&/^([0-9a-f]{2}){1053}$/i.test(skill.fixed_raw_hex),'原始技能记录无效');
  const raw=view(skill),parameters=runtimeSkillParameters({...skill,mp_cost:0});
  delete parameters.mp_cost;
  return {enabled:false,mp_delta_raw:raw.getInt32(0x14f,true),...parameters};
}

export function validateSourceOnlySkillParameters(parameters,original,id){
  fields(parameters,Object.keys(original),`${id}.parameters`);
  fail(parameters.enabled===false,`${id}只有来源记录，行为尚未接入，不能启用`);
  const integer=(n,label)=>fail(Number.isInteger(n)&&n>=-2147483648&&n<=2147483647,`${id}.${label}必须为原始32位整数`);
  for(const [field,value]of Object.entries(parameters)){
    if(field==='enabled')continue;
    if(Array.isArray(original[field])){
      fail(Array.isArray(value)&&value.length===6,`${id}.${field}必须是原六槽`);
      value.forEach(n=>integer(n,field));
    }else if(object(original[field])){
      fields(value,['minimum','maximum_exclusive'],`${id}.${field}`);
      integer(value.minimum,field);integer(value.maximum_exclusive,field);
      // Unimplemented records may contain reversed/native sentinel ranges.
      // Preserve those bytes; the executable compiler must not normalize them.
    }else integer(value,field);
  }
}

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
  const registry=createSkillRegistry(data),entries=Object.fromEntries(Object.entries(registry).map(([id,{skill,owner}])=>{
    const parameters=runtimeSkillParameters(skill);
    return [id,{name:skill.name,owner:copy(owner),source:copy(skill.source),original:copy(parameters),parameters:copy(parameters)}];
  }));
  const catalog=data.source_skills;
  if(catalog!==undefined){
    fail(catalog?.schema==='seventh-seal-source-skills'&&catalog.version===1&&object(catalog.skills)&&object(catalog.source_hashes),'全量技能源目录版本或字段无效');
    const byOwner=new Map(Object.entries(registry).map(([id,{skill}])=>[skillOwnerKey(skill),id])),seen=new Set();
    for(const [id,skill]of Object.entries(catalog.skills)){
      const role_id=skill.actor_id,skill_index=skill.original_skill_index,key=`${role_id}:${skill_index}`,source=skill.source;
      fail(typeof role_id==='string'&&/^[a-zA-Z0-9_]+$/.test(role_id)&&Number.isInteger(skill_index)&&skill_index>=0&&skill_index<200,`${id}来源角色或技能索引无效`);
      fail(id===`${role_id}_${skill_index}`&&skill.id===id&&skill.index===skill_index&&!seen.has(key),`${id}来源技能ID、索引或绑定重复`);seen.add(key);
      fail(source?.path===`Fight_Role/${role_id}.CHR`&&/^[0-9a-f]{64}$/.test(source.sha256??'')&&source.sha256===catalog.source_hashes[source.path],`${id}来源CHR指纹不同`);
      fail(Number.isInteger(source.fixed_record_offset)&&source.fixed_record_offset>=8&&source.fixed_bytes===1053,`${id}原记录偏移或长度无效`);
      fail(typeof skill.name==='string',`${id}来源名称无效`);
      const implemented=byOwner.get(key);
      if(implemented){
        const retained=registry[implemented].skill;
        fail(same(source,retained.source)&&skill.fixed_raw_hex===retained.fixed_raw_hex,`${id}全量来源与已接入技能记录不同`);
        continue; // Keep the stable historical ID instead of duplicating aliases.
      }
      fail(!Object.hasOwn(entries,id),`${id}来源技能ID与已接入技能冲突`);
      // The source catalog is read once at boot. Cache only decoded numbers;
      // identity/fingerprint checks still run and changed bytes invalidate it.
      let decoded=sourceOnlyParameterCache.get(skill);
      if(!decoded||decoded.raw!==skill.fixed_raw_hex){decoded={raw:skill.fixed_raw_hex,parameters:sourceOnlySkillParameters(skill)};sourceOnlyParameterCache.set(skill,decoded);}
      const parameters=decoded.parameters,owner={role_id,skill_index,side:/^00[1-6]$/.test(role_id)?'player':'source'};
      entries[id]={name:skill.name,owner,source:copy(source),original:copy(parameters),parameters:copy(parameters)};
    }
  }
  const magic=data.source_magic;
  if(magic!==undefined){
    fail(magic?.schema==='seventh-seal-source-magic'&&magic.version===1&&object(magic.magic)&&object(magic.source_hashes),'全局魔法来源目录版本或字段无效');
    for(const [recordIndex,record]of Object.entries(magic.magic)){
      const magic_index=Number(recordIndex),id=`system_magic_${recordIndex}`,source=record.source;
      // Native DWORD IDs are not unique (source records 27 and 28 both carry
      // 28). Bind the physical record index so no duplicate source is lost.
      fail(Number.isInteger(magic_index)&&magic_index>=0&&String(magic_index)===recordIndex&&Number(record.id)===magic_index,`${id}原魔法记录索引无效`);
      fail(typeof record.name==='string'&&!Object.hasOwn(entries,id),`${id}来源名称或编号无效`);
      fail(source?.path==='SYSTEM/System.MAG'&&/^[0-9a-f]{64}$/.test(source.sha256??'')&&source.sha256===magic.source_hashes[source.path],`${id}来源MAG指纹不同`);
      fail(source.record_offset===18+magic_index*542&&source.record_bytes===542,`${id}原记录偏移或长度无效`);
      const parameters={enabled:false};
      entries[id]={name:record.name,owner:{source_kind:'system-magic',magic_index},source:copy(source),original:copy(parameters),parameters:copy(parameters)};
    }
  }
  return {schema:'seventh-seal-skills-parameters',version:2,
    notes:'全部来源技能与已接入角色技能共用此表；owner按角色编号与原技能索引绑定，已有ID保持稳定。只修改parameters；source、owner和original只读。source-only记录保留原32位数值和MP增量，enabled必须为false；登记不开放行为。已实现技能随机上限不包含；六元素槽保持原顺序。preparation_delay_raw=0使用battle.json默认准备量。动作、目标、学习条件和特效规则保留原来源；敌方耗蓝当前只支持0。',entries};
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
  if(isParameterOverrideFile(config)){
    // A newly implemented enemy retains its canonical source-catalog ID.
    // Validate the old source-only owner/defaults before promoting that same
    // source record; never accept arbitrary owner or fingerprint changes.
    const previous=copy(defaults),promoted=[];
    for(const [id,row]of Object.entries(config.entries??{})){
      const target=defaults.entries[id];
      if(row.owner?.side!=='source'||target?.owner?.side!=='enemy')continue;
      const original=data.source_skills?.skills?.[id];
      fail(original&&id===`${target.owner.role_id}_${target.owner.skill_index}`
        &&same(original.source,target.source)&&row.name===original.name
        &&same(row.owner,{...target.owner,side:'source'}),`${id}来源接入迁移身份不匹配`);
      const parameters=sourceOnlySkillParameters(original);
      previous.entries[id]={...copy(target),owner:copy(row.owner),original:copy(parameters),parameters:copy(parameters)};
      promoted.push(id);
    }
    const expanded=expandParameterOverrides(previous,config,{allowNewEntries:true});
    for(const id of promoted){
      const old=expanded.entries[id],target=copy(defaults.entries[id]),parameters={};
      fail(old.parameters.enabled===false,`${id}未接入来源不能提前启用`);
      for(const key of Object.keys(target.original)){
        if(key==='mp_cost'){
          const delta=old.parameters.mp_delta_raw;
          fail(Number.isInteger(delta)&&(delta<=0||delta===old.original.mp_delta_raw),`${id}正向MP增量修改无法映射为战斗耗蓝`);
          parameters[key]=delta===old.original.mp_delta_raw?target.original.mp_cost:-delta;
        }else{
          fail(Object.hasOwn(old.parameters,key),`${id}来源参数缺失：${key}`);parameters[key]=copy(old.parameters[key]);
        }
      }
      target.parameters=parameters;expanded.entries[id]=target;
    }
    return expanded;
  }
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
