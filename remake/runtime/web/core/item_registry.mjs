// One editable item catalog; source records and saved rolls stay immutable.
import {isSupportedCrystalDefinition} from './crystal_catalog.mjs';
import {expandParameterOverrides,isParameterOverrideFile} from './config_overrides.mjs';
const copy=structuredClone;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const canonical=v=>JSON.stringify(Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
const same=(a,b)=>canonical(a)===canonical(b);
const need=(ok,message)=>{if(!ok)throw new Error(`道具配置：${message}`);};
const fields=(v,keys,label)=>need(object(v)&&same(Object.keys(v).sort(),[...keys].sort()),`${label}字段缺失或未知`);
const integer=(n,label,min,max)=>need(Number.isInteger(n)&&n>=min&&n<=max,`${label}范围无效`);
// These instance fields actually participate in the recovered linked getters.
export const EQUIPMENT_ATTRIBUTES=Object.freeze([
  ['hp_current_flat',0x0d],['hp_maximum_flat',0x11],['mp_current_flat',0x15],['mp_maximum_flat',0x19],
  ['attack_flat',0x1d],['defense_flat',0x21],['term3_flat',0x25],['speed_flat',0x29],['term4_flat',0x2d],
  ['hp_percent',0x35],['mp_percent',0x3d],['attack_percent',0x41],['defense_percent',0x45],
  ['term3_percent',0x49],['speed_percent',0x4d],['term4_percent',0x51],
  ['native_55',0x55],['native_59',0x59],['native_5d',0x5d],['native_61',0x61],
  ...Array.from({length:6},(_,i)=>[`element_${i}`,0x65+i*4])]);

export function deriveItemConfiguration(data,{socketSupport=true}={}){
  need(data?.definitions,'原始道具目录缺失');
  const entries=Object.fromEntries(Object.entries(data.definitions).map(([id,def])=>{
    const crystal=socketSupport&&isSupportedCrystalDefinition(def);
    const parameters={drop_rate:def.drop_rate,enabled:def.availability.enabled||crystal};
    if(def.behavior.kind==='equip'||crystal){
      if(def.behavior.kind==='equip')parameters.allowed_role_mask=def.allowed_role_mask_raw_13e;
      parameters.attributes=Object.fromEntries(EQUIPMENT_ATTRIBUTES.map(([name,offset])=>{
        const r=def.value_ranges.find(r=>r.instance_offset===offset);
        return [name,{minimum:r.minimum,maximum_exclusive:r.maximum}];
      }));
    }else if(def.behavior.kind==='simple-restore'){
      parameters.use_in_field=true;parameters.use_in_battle=true;
      parameters.effect=copy(def.effect);
    }
    return [id,{name:def.name,owner:{item_id:def.id},source:copy(def.source),
      catalog:{category:def.category,description:def.description,type:def.type_raw_24,subtype:def.subtype_raw_25,
        slot_id:def.slot_id??null,role_mask:def.allowed_role_mask_raw_13e,unique_raw:def.unique_raw,
        behavior:copy(def.behavior),availability:copy(def.availability),raw_fields:copy(def.raw_fields),
        value_ranges:copy(def.value_ranges),initialization:copy(def.initialization),validation:copy(def.validation)},
      original:copy(parameters),parameters:copy(parameters)}];
  }));
  return {schema:'seventh-seal-items-parameters',version:2,
    notes:'全部原版道具按编号统一登记。只编辑parameters；catalog/source/original只读。已确证的简单晶石支持镶嵌及链接属性；复杂晶石被动、合成等未还原作用不可启用。装备／晶石属性作用于临时计算副本，不改存档原始实例；maximum_exclusive相等为固定值。',entries};
}

export function compileItemConfiguration(data,cfg,mode){
  const baseline=deriveItemConfiguration(data),result=copy(data),differences=[];
  cfg=expandParameterOverrides(baseline,cfg);
  fields(cfg,['schema','version','notes','entries'],'items.json');
  need(cfg.schema===baseline.schema&&cfg.version===2&&typeof cfg.notes==='string','版本不兼容，请运行统一配置导出器迁移');
  fields(cfg.entries,Object.keys(baseline.entries),'entries');
  for(const [id,b]of Object.entries(baseline.entries)){
    const row=cfg.entries[id],p=row.parameters,def=result.definitions[id];
    fields(row,['name','owner','source','catalog','original','parameters'],id);
    for(const key of ['name','owner','source','catalog','original'])need(same(row[key],b[key]),`${id}.${key}来源或基线不匹配`);
    fields(p,Object.keys(b.original),`${id}.parameters`);
    integer(p.drop_rate,`${id}.drop_rate`,-1,100);need(typeof p.enabled==='boolean',`${id}.enabled须为布尔值`);
    const crystal=isSupportedCrystalDefinition(def);
    need(!p.enabled||def.behavior.kind!=='source-only'||crystal,`${id}作用未还原，不能启用`);
    if(def.behavior.kind==='equip'||crystal){
      if(def.behavior.kind==='equip')integer(p.allowed_role_mask,`${id}.allowed_role_mask`,0,255);
      fields(p.attributes,Object.keys(b.original.attributes),`${id}.attributes`);
      for(const [name,r]of Object.entries(p.attributes)){
        fields(r,['minimum','maximum_exclusive'],`${id}.${name}`);
        integer(r.minimum,`${id}.${name}.minimum`,-1000000,1000000);
        integer(r.maximum_exclusive,`${id}.${name}.maximum_exclusive`,-1000000,1000000);
        need(r.minimum<=r.maximum_exclusive,`${id}.${name}上下限无效`);
      }
      if(def.behavior.kind==='equip')def.allowed_role_mask_raw_13e=p.allowed_role_mask;
      def.runtime_attributes=copy(p.attributes);
      if(crystal)def.runtime_socket_supported=true;
    }else if(def.behavior.kind==='simple-restore'){
      need(typeof p.use_in_field==='boolean'&&typeof p.use_in_battle==='boolean',`${id}使用场景须为布尔值`);
      fields(p.effect,Object.keys(b.original.effect),`${id}.effect`);
      for(const [key,n]of Object.entries(p.effect))if(key!=='revive')integer(n,`${id}.${key}`,0,1000000);
      need(p.effect.revive===false,`${id}复活专用行为尚未还原`);
      def.effect=copy(p.effect);def.use_in_field=p.use_in_field;def.use_in_battle=p.use_in_battle;
    }
    def.drop_rate=p.drop_rate;def.runtime_enabled=p.enabled;
    for(const field of Object.keys(b.original))if(!same(b.original[field],p[field]))differences.push({section:'items',id,field,original:copy(b.original[field]),current:copy(p[field])});
  }
  need(mode==='debug'||differences.length===0,'原版模式有参数差异，请切换debug或恢复original');
  result.runtime_configuration={mode,differences:copy(differences)};
  return {data:result,differences};
}

export function upgradeItemConfiguration(data,existing){
  const next=deriveItemConfiguration(data);
  if(isParameterOverrideFile(existing))return expandParameterOverrides(next,existing,{allowNewEntries:true});
  if(existing.version===2){
    const legacy=deriveItemConfiguration(data,{socketSupport:false});
    for(const [id,row]of Object.entries(existing.entries)){
      need(next.entries[id],`${id}编号未登记`);
      if(isSupportedCrystalDefinition(data.definitions[id])&&!same(row.original,next.entries[id].original)){
        fields(row,['name','owner','source','catalog','original','parameters'],id);
        for(const key of ['name','owner','source','catalog','original'])need(same(row[key],legacy.entries[id][key]),`${id}.${key}旧晶石来源或基线不匹配`);
        fields(row.parameters,['drop_rate','enabled'],`${id}.parameters`);integer(row.parameters.drop_rate,`${id}.drop_rate`,-1,100);need(typeof row.parameters.enabled==='boolean',`${id}.enabled须为布尔值`);
        next.entries[id].parameters.drop_rate=row.parameters.drop_rate;
        // The former disabled default described missing mechanics. Promote that
        // default after source recovery, while preserving existing numeric edits.
        next.entries[id].parameters.enabled=row.parameters.enabled===row.original.enabled?next.entries[id].original.enabled:row.parameters.enabled;
      }else next.entries[id]=copy(row);
    }
    compileItemConfiguration(data,next,'debug');return next;
  }
  need(existing.schema===next.schema&&existing.version===1,'旧版本无效');
  fields(existing,['schema','version','notes','entries'],'旧items.json');
  for(const [id,row]of Object.entries(existing.entries)){
    const def=data.definitions[id];need(def,`${id}编号未登记`);
    fields(row,['name','source','original','parameters'],id);fields(row.original,['drop_rate'],id);fields(row.parameters,['drop_rate'],id);
    const source={path:def.source.path,sha256:def.source.sha256,definition_file_offset:def.source.definition_file_offset};
    need(row.name===def.name&&same(row.source,source)&&row.original.drop_rate===def.drop_rate,`${id}旧来源或基线不匹配`);
    next.entries[id].parameters.drop_rate=row.parameters.drop_rate;
  }
  compileItemConfiguration(data,next,'debug');return next;
}

export function configuredEquipmentHex(raw,definition){
  if(!definition?.runtime_attributes)return raw;
  const bytes=Uint8Array.from(raw.match(/../g),h=>parseInt(h,16)),view=new DataView(bytes.buffer);
  for(const [name,offset]of EQUIPMENT_ATTRIBUTES){
    const from=definition.value_ranges.find(r=>r.instance_offset===offset),to=definition.runtime_attributes[name],value=view.getInt32(offset,true);
    // Retain the saved roll's position; tuning never draws RNG or changes raw provenance.
    const span=to.maximum_exclusive-to.minimum;
    const delta=from.maximum>from.minimum?Math.floor((value-from.minimum)*span/(from.maximum-from.minimum)):0;
    view.setInt32(offset,span?to.minimum+Math.max(0,Math.min(span-1,delta)):to.minimum,true);
  }
  return Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
}
