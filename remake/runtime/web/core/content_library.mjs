// Stable source references for content authoring. Extraction never unlocks rules.
const need=(value,message)=>{if(!value)throw new Error(`内容资料库：${message}`);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const add=(index,key,id)=>{(index[String(key)]??=[]).push(id);};
const ownerKey=(role,index)=>`${role}:${index}`;
const kinds=['roles','skills','items'];

export function buildContentLibrary({roles,skills,magic,items,registration,skillConfiguration,itemConfiguration,runtimeSkillIds}){
  need(roles?.schema==='seventh-seal-source-roles'&&roles.version===1&&object(roles.roles),'角色来源版本无效');
  need(skills?.schema==='seventh-seal-source-skills'&&skills.version===1&&object(skills.skills),'技能来源版本无效');
  need(object(items?.definitions)&&object(registration?.roles),'道具或接入登记缺失');
  need(object(skillConfiguration?.entries)&&object(itemConfiguration?.entries),'统一数值配置缺失');
  need(Array.isArray(runtimeSkillIds),'已实现技能源目录缺失');
  need(magic?.schema==='seventh-seal-source-magic'&&magic.version===1&&object(magic.magic),'全局法术来源版本无效');
  const runtimeIds=new Set(runtimeSkillIds);
  for(const id of runtimeIds)need(Object.hasOwn(skillConfiguration.entries,id),`已接入技能没有保留配置ID ${id}`);
  const configOwners=new Map(),aliases={};
  for(const [id,row]of Object.entries(skillConfiguration.entries)){
    if(row.owner?.source_kind==='system-magic')continue;
    need(row.owner&&typeof row.owner.role_id==='string'&&Number.isInteger(row.owner.skill_index),`技能配置归属无效 ${id}`);
    const key=ownerKey(row.owner.role_id,row.owner.skill_index);
    need(!configOwners.has(key),`技能配置归属重复 ${key}`);configOwners.set(key,id);
  }
  const entries={roles:{},skills:{},items:{}},indexes={roles:{by_name:{},companions:[]},skills:{by_name:{},by_role:{},by_source_id:{},by_source_kind:{}},items:{by_name:{},by_category:{}}};
  for(const [id,row]of Object.entries(roles.roles)){
    need(row.id===id&&typeof row.name==='string'&&row.source?.path&&row.eof_verified===true,`角色身份或来源不完整 ${id}`);
    const companion=row.classification?.kind==='companion',registered=registration.roles[id];
    entries.roles[id]={id,name:row.name,kind:row.classification?.kind??'source-role',
      source:row.source.path,definition:`data/library/roles.json#/roles/${id}`,
      native_slot:row.classification?.native_player_slot??null,registered:!!registered,
      runtime_side:registered?.side??null,skills:row.skill_ids??row.skills};
    need(Array.isArray(entries.roles[id].skills),`角色技能索引缺失 ${id}`);
    add(indexes.roles.by_name,row.name,id);if(companion)indexes.roles.companions.push(id);
  }
  for(const [id,row]of Object.entries(skills.skills)){
    const role=row.actor_id,index=row.original_skill_index;
    need(id===`${role}_${index}`&&row.id===id&&Object.hasOwn(entries.roles,role),`技能身份或角色不存在 ${id}`);
    need(row.source?.path===roles.roles[role].source.path&&row.source.sha256===roles.roles[role].source.sha256,`技能来源与角色不同 ${id}`);
    const configId=configOwners.get(ownerKey(role,index));
    need(configId!==undefined,`技能没有统一配置 ${id}`);
    const registered=registration.roles[role],bindings=[...(registered?.battle_skills??[]),...(registered?.field_skills??[])];
    // Runtime recovery/AI entries can be executable without an authored player binding.
    entries.skills[id]={id,name:row.name,source_kind:'chr',role_id:role,skill_index:index,
      source_id:row.original_id_raw??row.original_source_id??null,
      definition:`data/library/skills.json#/skills/${id}`,configuration_id:configId,
      configuration:`data/config/skills.json#/entries/${configId}`,
      runtime_registered:runtimeIds.has(configId),
      authored_binding:bindings.some(binding=>binding.index===index),
      handler:bindings.find(binding=>binding.index===index)?.handler??null};
    add(indexes.skills.by_name,row.name,id);add(indexes.skills.by_role,role,id);add(indexes.skills.by_source_kind,'chr',id);
    if(entries.skills[id].source_id!==null)add(indexes.skills.by_source_id,entries.skills[id].source_id,id);
    if(configId!==id){need(!Object.hasOwn(aliases,configId),`技能别名重复 ${configId}`);aliases[configId]=id;}
  }
  for(const [id,row]of Object.entries(entries.roles))for(const skill of row.skills){
    need(entries.skills[skill]?.role_id===id,`角色引用缺失或属于其他人物 ${id}/${skill}`);
  }
  for(const [role,ids]of Object.entries(indexes.skills.by_role)){
    need(ids.length===entries.roles[role].skills.length,`角色技能引用覆盖不完整 ${role}`);
  }
  const chrSkillCount=Object.keys(entries.skills).length;
  for(const [recordIndex,row]of Object.entries(magic.magic)){
    const id=`system_magic_${recordIndex}`,cfg=skillConfiguration.entries[id];
    need(String(row.id)===recordIndex&&cfg?.owner?.source_kind==='system-magic'&&cfg.owner.magic_index===Number(recordIndex)&&cfg.name===row.name,`全局法术身份或配置缺失 ${id}`);
    entries.skills[id]={id,name:row.name,source_kind:'system-magic',magic_index:row.id,source_id:row.original_source_id,
      source:row.source.path,definition:`data/library/magic.json#/magic/${recordIndex}`,
      configuration_id:id,configuration:`data/config/skills.json#/entries/${id}`,runtime_registered:false,authored_binding:false,handler:null};
    add(indexes.skills.by_name,row.name,id);add(indexes.skills.by_source_kind,'system-magic',id);
    add(indexes.skills.by_source_id,row.original_source_id,id);
  }
  for(const [id,row]of Object.entries(items.definitions)){
    need(String(row.id)===id&&itemConfiguration.entries[id]?.name===row.name,`道具身份或配置缺失 ${id}`);
    entries.items[id]={id:row.id,name:row.name,category:row.category,status:row.record_status,
      definition:`data/items.json#/definitions/${id}`,configuration:`data/config/items.json#/entries/${id}`,
      source:row.source.path,behavior:row.behavior?.kind??null};
    add(indexes.items.by_name,row.name,id);add(indexes.items.by_category,row.category,id);
  }
  need(configOwners.size===chrSkillCount&&Object.keys(skillConfiguration.entries).length===Object.keys(entries.skills).length,'技能配置与来源覆盖不同');
  need(Object.keys(itemConfiguration.entries).length===Object.keys(entries.items).length,'道具配置与来源覆盖不同');
  return {schema:'seventh-seal-content-library',version:1,
    files:{roles:'data/library/roles.json',skills:'data/library/skills.json',magic:'data/library/magic.json',items:'data/items.json',
      skill_configuration:'data/config/skills.json',item_configuration:'data/config/items.json'},
    counts:{companions:indexes.roles.companions.length,roles:Object.keys(entries.roles).length,skills:Object.keys(entries.skills).length,chr_skills:chrSkillCount,system_magic:Object.keys(magic.magic).length,items:Object.keys(entries.items).length,
      runtime_skills:Object.values(entries.skills).filter(row=>row.runtime_registered).length},
    entries,indexes,skill_aliases:aliases,
    limits:['索引覆盖原始内容；规则可执行、媒体已导出与正式剧情开放分别核对。',
      '技能以role_id和skill_index绑定；同名内容保留多个编号，不按名称静默选取。',
      'parameters.enabled=false的来源技能不进入运行技能表，需恢复处理器后接入。']};
}

export function resolveContentReference(library,{kind,id,name}){
  need(library?.schema==='seventh-seal-content-library'&&library.version===1,'索引版本无效');
  need(kinds.includes(kind),`分类须为 ${kinds.join('、')}`);
  need((id!==undefined)!==(name!==undefined),'请提供一个编号或一个精确名称');
  if(name!==undefined){
    const ids=library.indexes[kind].by_name[name]??[];
    need(ids.length===1,ids.length?`名称有多个编号，请使用ID：${ids.join('、')}`:`名称不存在：${name}`);
    id=ids[0];
  }
  const key=kind==='skills'?(library.skill_aliases[String(id)]??String(id)):String(id);
  need(Object.hasOwn(library.entries[kind],key),`未知${kind}编号 ${id}`);
  return structuredClone(library.entries[kind][key]);
}

export function searchContentLibrary(library,{kind,text='',roleId,category}={}){
  need(library?.schema==='seventh-seal-content-library'&&library.version===1,'索引版本无效');
  need(kind===undefined||kinds.includes(kind),'分类无效');
  const query=String(text).toLocaleLowerCase();
  return (kind?[kind]:kinds).flatMap(group=>Object.values(library.entries[group]).filter(row=>
    (!query||`${row.id} ${row.name}`.toLocaleLowerCase().includes(query))&&
    (roleId===undefined||row.role_id===roleId||group==='roles'&&row.id===roleId)&&
    (category===undefined||row.category===category)).map(row=>({kind:group,...structuredClone(row)})));
}
