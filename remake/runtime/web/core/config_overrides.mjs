// Editable files contain only overrides. Source records remain the authority
// for defaults; their shared fingerprints bind each file to the source set.
const copy=structuredClone;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>JSON.stringify(Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])):value);
const same=(a,b)=>canonical(a)===canonical(b);
const need=(ok,message)=>{if(!ok)throw new Error(`参数配置：${message}`);};
const fields=(value,keys,label)=>need(object(value)&&same(Object.keys(value).sort(),[...keys].sort()),`${label}字段缺失或未知`);
const versions=Object.freeze({
  'seventh-seal-skills-parameters':3,
  'seventh-seal-battle-parameters':2,
  'seventh-seal-rewards-parameters':2,
  'seventh-seal-items-parameters':3,
});
const notes=Object.freeze({
  'seventh-seal-skills-parameters':'按原角色编号＋技能索引绑定；敌我共用本表。',
  'seventh-seal-battle-parameters':'怪物生成属性、选招AI和公共充能参数；不覆盖玩家存档。',
  'seventh-seal-rewards-parameters':'怪物经验、金钱和有顺序的掉落候选；重复物品保留抽签次数，基础概率在items.json。',
  'seventh-seal-items-parameters':'全部原道具编号共用本表；装备、药品、晶石和材料按编号引用。未恢复效果不可启用。',
});

export const isParameterOverrideFile=config=>Object.hasOwn(versions,config?.schema??'')&&config.version===versions[config.schema];

function sourceHashes(entries){
  const hashes={};
  for(const row of Object.values(entries)){
    const {path,sha256}=row.source??{};
    need(typeof path==='string'&&/^[a-f0-9]{64}$/.test(sha256??''),'原始来源指纹缺失');
    need(!Object.hasOwn(hashes,path)||hashes[path]===sha256,`${path}来源指纹冲突`);
    hashes[path]=sha256;
  }
  return Object.fromEntries(Object.entries(hashes).sort(([a],[b])=>a.localeCompare(b)));
}

function mergeParameters(baseline,patch,label){
  if(!object(baseline))return copy(patch); // Arrays replace as a whole.
  need(object(patch),`${label}须为参数对象`);
  const result=copy(baseline);
  for(const [key,value]of Object.entries(patch)){
    need(Object.hasOwn(baseline,key),`${label}.${key}字段缺失或未知`);
    result[key]=mergeParameters(baseline[key],value,`${label}.${key}`);
  }
  return result;
}

function differences(baseline,current){
  return Object.fromEntries(Object.entries(current).flatMap(([key,value])=>{
    if(same(baseline[key],value))return [];
    return [[key,object(baseline[key])?differences(baseline[key],value):copy(value)]];
  }));
}

/** Reconstruct the established compiler input without mutating either file.
 * Runtime requires every registered ID. Export may add newly registered IDs,
 * but existing source fingerprints and identity bindings must still match.
 */
export function expandParameterOverrides(baseline,config,{allowNewEntries=false}={}){
  if(!isParameterOverrideFile(config))return config;
  fields(config,['schema','version','notes','source_hashes','entries'],baseline.schema);
  need(config.schema===baseline.schema&&typeof config.notes==='string','配置版本或类型不匹配');
  need(object(config.entries),'entries须为对象');
  if(!allowNewEntries)fields(config.entries,Object.keys(baseline.entries),'entries');
  const existing={};
  for(const id of Object.keys(config.entries)){
    need(Object.hasOwn(baseline.entries,id),`${id}编号未登记`);
    existing[id]=baseline.entries[id];
  }
  need(same(config.source_hashes,sourceHashes(existing)),'来源指纹不匹配，请核对原输入与配置');
  const result=copy(baseline);
  for(const [id,row]of Object.entries(config.entries)){
    const base=baseline.entries[id],keys=['name','parameters',...(base.owner?['owner']:[])];
    fields(row,keys,id);
    need(row.name===base.name&&(!base.owner||same(row.owner,base.owner)),`${id}名称或身份绑定不匹配`);
    need(object(row.parameters),`${id}.parameters须为对象`);
    result.entries[id].parameters=mergeParameters(base.original,row.parameters,`${id}.parameters`);
  }
  return result;
}

/** Serialize only deviations; callers validate the complete bundle first. */
export function compactParameterConfiguration(baseline,config=baseline){
  need(Object.hasOwn(versions,baseline.schema),'未支持的参数配置类型');
  return {schema:baseline.schema,version:versions[baseline.schema],
    notes:`${notes[baseline.schema]}只编辑parameters；空对象使用原版默认值，嵌套对象只填写修改项，数组整体替换。默认值和生效值可用配置导出器--reference查看。name、owner和source_hashes只读。`,
    source_hashes:sourceHashes(baseline.entries),
    entries:Object.fromEntries(Object.entries(baseline.entries).map(([id,row])=>[id,{
      name:row.name,...(row.owner?{owner:copy(row.owner)}:{}),
      parameters:differences(row.original,config.entries[id].parameters),
    }]))};
}
