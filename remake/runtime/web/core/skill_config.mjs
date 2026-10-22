// Human-readable parameters compile into an isolated numeric input record.
// Retained source bytes are never edited; original mode rejects source drift.
const copy=value=>structuredClone(value);
function requireValue(ok,message){if(!ok)throw new Error(`技能配置：${message}`);}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const FIELDS=['mp_cost','physical_multiplier_percent','element_power','defense_bonus','term4_bonus','hp_term_bonus','hp_max_term_bonus'];
function fields(value,keys,label){requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)),`${label}字段缺失或未知`);}
function integer(value,label,minimum=-2147483648){requireValue(Number.isInteger(value)&&value>=minimum&&value<=2147483647,`${label}必须为有效整数`);}
function parameters(value){
  fields(value,FIELDS,'parameters');integer(value.mp_cost,'mp_cost',0);
  for(const field of ['physical_multiplier_percent','defense_bonus','term4_bonus']){
    const range=value[field];fields(range,['minimum','maximum_exclusive'],field);
    integer(range.minimum,`${field}.minimum`,field==='physical_multiplier_percent'?0:-2147483648);
    integer(range.maximum_exclusive,`${field}.maximum_exclusive`,field==='physical_multiplier_percent'?0:-2147483648);
    requireValue(range.minimum<=range.maximum_exclusive&&range.maximum_exclusive-range.minimum<=2147483647,`${field}范围无效`);
  }
  requireValue(Array.isArray(value.element_power)&&value.element_power.length===6,'element_power必须是原六槽');
  value.element_power.forEach((n,i)=>integer(n,`element_power[${i}]`,0));
  integer(value.hp_term_bonus,'hp_term_bonus');integer(value.hp_max_term_bonus,'hp_max_term_bonus');
}
function sourceView(skill){
  requireValue(typeof skill.fixed_raw_hex==='string'&&/^([0-9a-f]{2}){1053}$/i.test(skill.fixed_raw_hex),'原始技能记录无效');
  const bytes=Uint8Array.from(skill.fixed_raw_hex.match(/../g),v=>parseInt(v,16));
  return new DataView(bytes.buffer);
}
export function sourceSkillParameters(skill){
  const view=sourceView(skill),get=o=>view.getInt32(o,true),range=(a,b)=>({minimum:get(a),maximum_exclusive:get(b)});
  return {mp_cost:skill.mp_cost,physical_multiplier_percent:range(0xcb,0xcf),element_power:Array.from({length:6},(_,i)=>get(0x105+i*4)),
    defense_bonus:range(0xd3,0xd7),term4_bonus:range(0xe3,0xe7),hp_term_bonus:get(0xab),hp_max_term_bonus:get(0xaf)};
}
function sameParameters(a,b){return FIELDS.every(key=>key==='element_power'?equal(a[key],b[key]):typeof a[key]==='object'?
  a[key].minimum===b[key].minimum&&a[key].maximum_exclusive===b[key].maximum_exclusive:a[key]===b[key]);}
export function configureSkills(skills,config){
  requireValue(config?.schema==='seventh-seal-skill-config'&&config.version===1,'版本不兼容');
  requireValue(['original','debug'].includes(config.mode),'mode须为original或debug');
  requireValue(config.skills&&equal(Object.keys(config.skills).sort(),Object.keys(skills).sort()),'技能集合不匹配');
  const compiled={};
  for(const [id,skill] of Object.entries(skills)){
    const entry=config.skills[id];fields(entry,['name','source','original','parameters'],id);
    requireValue(entry.name===skill.name,`${id}名称不匹配`);
    requireValue(entry.source?.path===skill.source.path&&entry.source?.sha256===skill.source.sha256&&entry.source?.fixed_record_offset===skill.source.fixed_record_offset&&entry.source?.fixed_bytes===skill.source.fixed_bytes,`${id}原始来源不匹配`);
    parameters(entry.original);parameters(entry.parameters);
    const original=sourceSkillParameters(skill);
    requireValue(sameParameters(entry.original,original),`${id}original基线与原始记录不一致`);
    const current=entry.parameters,differences=FIELDS.filter(field=>!sameParameters({...original,[field]:current[field]},original))
      .map(field=>({field,original:copy(original[field]),current:copy(current[field])}));
    requireValue(config.mode==='debug'||differences.length===0,`${id}原版模式有参数差异，请切换debug或恢复original值`);
    const view=sourceView(skill),set=(offset,value)=>view.setInt32(offset,value,true);
    for(const [field,low,high] of [['physical_multiplier_percent',0xcb,0xcf],['defense_bonus',0xd3,0xd7],['term4_bonus',0xe3,0xe7]]){
      set(low,current[field].minimum);set(high,current[field].maximum_exclusive);
    }
    current.element_power.forEach((value,index)=>set(0x105+index*4,value));set(0xab,current.hp_term_bonus);set(0xaf,current.hp_max_term_bonus);
    set(0x14f,config.mode==='debug'?-current.mp_cost:view.getInt32(0x14f,true));
    const hex=Array.from(new Uint8Array(view.buffer),n=>n.toString(16).padStart(2,'0')).join('');
    compiled[id]={...copy(skill),fixed_raw_hex:hex,mp_cost:current.mp_cost,mp_delta_raw:view.getInt32(0x14f,true),
      configuration:{mode:config.mode,version:config.version,original:copy(original),parameters:copy(current),differences,
        authority:config.mode==='debug'?'development-parameters; not original skill values':'retained-original-record'}};
  }
  return compiled;
}
