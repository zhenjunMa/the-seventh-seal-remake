// Editable overlays over retained extraction data. No source/world mutation.
import {createSkillRegistry,deriveSkillConfiguration,applyRegisteredSkillParameters,skillOwnerKey} from './skill_registry.mjs';
import {deriveItemConfiguration,compileItemConfiguration} from './item_registry.mjs';
import {expandParameterOverrides,compactParameterConfiguration} from './config_overrides.mjs';
const copy=structuredClone;
const fail=(ok,message)=>{if(!ok)throw new Error(`运行配置：${message}`);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const canonical=v=>JSON.stringify(Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
const same=(a,b)=>canonical(a)===canonical(b);
function fields(v,keys,label){fail(object(v)&&same(Object.keys(v).sort(),[...keys].sort()),`${label}字段缺失或未知`);}
function integer(n,label,min=0,max=0x7fffffff){fail(Number.isInteger(n)&&n>=min&&n<=max,`${label}范围无效`);}
const view=s=>new DataView(Uint8Array.from(s.fixed_raw_hex.match(/../g),h=>parseInt(h,16)).buffer);
const rawHex=v=>Array.from(new Uint8Array(v.buffer),n=>n.toString(16).padStart(2,'0')).join('');
const address=n=>'0x'+n.toString(16).padStart(8,'0');
const entry=(name,source,parameters)=>({name,source:copy(source),original:copy(parameters),parameters:copy(parameters)});
const category=(name,entries,notes)=>({schema:`seventh-seal-${name}-parameters`,version:1,notes,entries});
export const CONFIG_FILES=Object.freeze({skills:'skills.json',battle:'battle.json',rewards:'rewards.json',items:'items.json'});

function enemyParameters(a){
  const raw=n=>a.raw_by_address[address(n)],range=n=>({minimum:raw(n),maximum_exclusive:raw(n+4)});
  return {hp_maximum:a.raw_hp_maximum,mp_maximum:a.raw_mp_maximum,attack:range(0x0524a711),defense:range(0x0524a719),speed:range(0x0524a729),element_resistance:Array.from({length:6},(_,i)=>raw(0x0524a74b+i*4))};
}
const sourceHeader=(a,sha)=>({path:a.source.path,sha256:sha,header_offset:8,header_bytes:779});

/** Generate readable baselines from the already retained records only. */
export function deriveRuntimeConfiguration(data){
  const skills=deriveSkillConfiguration(data);
  const battle={scheduler:entry('行动充能',{path:'GAME.exe',sha256:data.scheduler.source_hashes['GAME.exe']},
    {average_speed_factor:data.scheduler.average_speed_factor,default_preparation_delay:800})};
  for(const [id,a]of Object.entries(data.forest.actors)){
    battle[`enemy_${id}`]=entry(a.name,sourceHeader(a,data.ai.source_hashes[a.source.path]),enemyParameters(a));
    const role=data.ai.roles[id],weights=Object.fromEntries(role.learned_indices.map(i=>[i,view(role.skills[i]).getUint8(0x27)]));
    battle[`ai_${id}`]=entry(`${a.name}选招`,sourceHeader(a,data.ai.source_hashes[a.source.path]),{combination_chance_percent:20,skill_weights:weights});
  }
  const rewards=Object.fromEntries(Object.entries(data.rewards.enemies).map(([id,e])=>[id,entry(e.name,
    {path:e.source.path,sha256:data.rewards.source_hashes[e.source.path],header_offset:e.source.header_file_offset},
    {experience:e.experience,money:e.reward_slots.filter(n=>n<0).reduce((sum,n)=>sum-n,0),drop_item_ids:e.reward_slots.filter(n=>n>0)})]));
  const items=deriveItemConfiguration(data.items);
  return {manifest:{schema:'seventh-seal-runtime-config',version:1,mode:'original',files:copy(CONFIG_FILES),
    notes:'只在parameters填写修改项；空对象沿用来源默认值。source_hashes用于核对，默认值用--reference查看。original模式禁止数值差异，debug模式应用调参。每次入口重新读取并保留快照。'},
    skills,
    battle:category('battle',battle,'敌人属性为生成时初值，不覆盖玩家存档。speed为原充能属性范围；调度保持20ms单tick。AI权重保留原加权与后备选招规则；组合长度仍为3～5招。'),
    rewards:category('rewards',rewards,'每种敌人经验、金钱和掉落候选。drop_item_ids允许重复，保留候选顺序；每次候选抽签的概率在items.json。候选与非零金钱合计最多六槽。只发一次由代码保证。'),
    items};
}

function validateRange(v,label,min=0){fields(v,['minimum','maximum_exclusive'],label);integer(v.minimum,label,min);integer(v.maximum_exclusive,label,min);fail(v.minimum<=v.maximum_exclusive&&v.maximum_exclusive-v.minimum<=0x7fffffff,`${label}上下限无效`);}

function expandBundle(baseline,bundle){
  fields(bundle,['manifest',...Object.keys(CONFIG_FILES)],'配置文件集合');
  return {...bundle,...Object.fromEntries(Object.keys(CONFIG_FILES).map(section=>
    [section,expandParameterOverrides(baseline[section],bundle[section])]))};
}

export function expandRuntimeConfiguration(data,bundle){
  return expandBundle(deriveRuntimeConfiguration(data),bundle);
}

export function compactRuntimeConfiguration(data,bundle){
  const baseline=deriveRuntimeConfiguration(data),expanded=expandBundle(baseline,bundle);
  compileRuntimeConfiguration(data,expanded);
  return {manifest:{...copy(expanded.manifest),notes:baseline.manifest.notes},...Object.fromEntries(Object.keys(CONFIG_FILES).map(section=>
    [section,compactParameterConfiguration(baseline[section],expanded[section])]))};
}
function validateParameters(section,id,p,baseline,data,owner){
  fields(p,Object.keys(baseline),`${section}.${id}.parameters`);
  if(section==='skills'){
    // The established skill compiler validates all existing numeric fields.
    integer(p.preparation_delay_raw,`${id}.preparation_delay_raw`,0,1000000);
    fail(owner.side!=='enemy'||p.mp_cost===0,`${id}敌方非零耗蓝及后备规则尚未接入`);
  }else if(section==='battle'){
    if(id==='scheduler'){integer(p.average_speed_factor,'average_speed_factor',1,10000);integer(p.default_preparation_delay,'default_preparation_delay',1,1000000);}
    else if(id.startsWith('enemy_')){
      integer(p.hp_maximum,`${id}.hp_maximum`,1,1000000);integer(p.mp_maximum,`${id}.mp_maximum`,0,1000000);
      for(const k of ['attack','defense','speed'])validateRange(p[k],`${id}.${k}`,k==='speed'?1:0);
      for(const k of ['attack','defense','speed'])fail(p[k].maximum_exclusive<=1000000,`${id}.${k}超出当前运行范围`);
      fail(Array.isArray(p.element_resistance)&&p.element_resistance.length===6,`${id}.element_resistance须为六槽`);p.element_resistance.forEach(n=>integer(n,`${id}.element_resistance`,0,1000000));
    }else{
      integer(p.combination_chance_percent,`${id}.combination_chance_percent`,0,100);
      fields(p.skill_weights,Object.keys(baseline.skill_weights),`${id}.skill_weights`);Object.values(p.skill_weights).forEach(n=>integer(n,`${id}.skill_weights`,0,100));
    }
  }else if(section==='rewards'){
    integer(p.experience,`${id}.experience`,0,10000000);integer(p.money,`${id}.money`,0,10000000);
    fail(Array.isArray(p.drop_item_ids)&&p.drop_item_ids.length+(p.money>0?1:0)<=6,`${id}奖励超过六槽`);
    p.drop_item_ids.forEach(n=>{integer(n,`${id}.drop_item_ids`,1);fail(Object.hasOwn(data.rewards.items,n),`${id}未知或未接入道具${n}`);});
  }else integer(p.drop_rate,`${id}.drop_rate`,-1,100);
}

/** Validate all files before returning one isolated, per-battle snapshot. */
export function compileRuntimeConfiguration(data,bundle){
  const baseline=deriveRuntimeConfiguration(data),manifest=bundle?.manifest;
  fields(bundle,['manifest',...Object.keys(CONFIG_FILES)],'配置文件集合');fields(manifest,['schema','version','mode','files','notes'],'index.json');
  fail(manifest.schema===baseline.manifest.schema&&manifest.version===1,'配置版本不兼容');fail(['original','debug'].includes(manifest.mode),'mode须为original或debug');
  fail(same(manifest.files,CONFIG_FILES)&&typeof manifest.notes==='string','配置文件路径无效');
  bundle=expandBundle(baseline,bundle);
  const differences=[],compiled=copy(data),registry=createSkillRegistry(data),skillsByOwner=new Map();
  compiled.skill_registry={};
  for(const section of Object.keys(CONFIG_FILES)){
    if(section==='items'){
      const configured=compileItemConfiguration(data.items,bundle.items,manifest.mode);
      compiled.items=configured.data;differences.push(...configured.differences);
      for(const [id,item]of Object.entries(compiled.rewards.items)){
        fail(item.drop_rate===data.items.definitions[id]?.drop_rate,`${id}奖励与道具原始掉落参数不同`);
        item.drop_rate=compiled.items.definitions[id].drop_rate;
      }
      continue;
    }
    const cfg=bundle[section],base=baseline[section];fields(cfg,['schema','version','notes','entries'],`${section}.json`);
    fail(cfg.schema===base.schema&&cfg.version===base.version&&typeof cfg.notes==='string',`${section}版本不兼容；技能旧版请先运行配置导出器迁移`);
    fields(cfg.entries,Object.keys(base.entries),`${section}.entries`);
    for(const [id,b]of Object.entries(base.entries)){
      const row=cfg.entries[id],label=`${section}.${id}`;fields(row,section==='skills'?['name','owner','source','original','parameters']:['name','source','original','parameters'],label);
      fail(row.name===b.name&&same(row.source,b.source),`${label}原始来源不匹配`);fail(same(row.original,b.original),`${label}.original基线与原始记录不一致`);
      if(section==='skills')fail(same(row.owner,b.owner),`${label}角色、技能索引或阵营不匹配`);
      validateParameters(section,id,row.parameters,b.original,data,row.owner);
      const changes=Object.keys(b.original).filter(k=>!same(b.original[k],row.parameters[k])).map(field=>({section,id,field,original:copy(b.original[field]),current:copy(row.parameters[field])}));
      fail(manifest.mode==='debug'||changes.length===0,`${label}原版模式有参数差异，请切换debug或恢复original`);differences.push(...changes);
      if(section==='skills'){
        const s=registry[id].skill,skill=applyRegisteredSkillParameters(s,row,manifest.mode);
        compiled.skill_registry[id]=skill;skillsByOwner.set(skillOwnerKey(s),row);
      }else if(section==='battle'){
        const p=row.parameters;
        if(id==='scheduler'){Object.assign(compiled.scheduler,{average_speed_factor:p.average_speed_factor,default_preparation_delay:p.default_preparation_delay,configuration:{mode:manifest.mode}});}
        else if(id.startsWith('enemy_')){
          const rid=id.slice(6),apply=a=>{
            Object.assign(a,{hp:{current:p.hp_maximum,maximum:p.hp_maximum},mp:{current:p.mp_maximum,maximum:p.mp_maximum},raw_hp:p.hp_maximum,raw_hp_maximum:p.hp_maximum,raw_mp:p.mp_maximum,raw_mp_maximum:p.mp_maximum});
            const raw=a.raw_by_address;for(const [n,value]of [[0x0524a701,p.hp_maximum],[0x0524a705,p.hp_maximum],[0x0524a709,p.mp_maximum],[0x0524a70d,p.mp_maximum]])raw[address(n)]=value;
            for(const [k,n]of [['attack',0x0524a711],['defense',0x0524a719],['speed',0x0524a729]]){raw[address(n)]=p[k].minimum;raw[address(n+4)]=p[k].maximum_exclusive;}
            p.element_resistance.forEach((value,i)=>raw[address(0x0524a74b+i*4)]=value);
          };apply(compiled.forest.actors[rid]);for(const a of compiled.combat.actors)if(a.side==='enemy'&&a.id===rid)apply(a);
        }else{
          const role=compiled.ai.roles[id.slice(3)];role.ai_parameters={combination_chance_percent:p.combination_chance_percent};
          for(const [index,weight]of Object.entries(p.skill_weights)){const s=role.skills[index],v=view(s);v.setUint8(0x27,weight);s.fixed_raw_hex=rawHex(v);}
        }
      }else if(section==='rewards'){
        const e=compiled.rewards.enemies[id],p=row.parameters;e.experience=p.experience;
        if(changes.length){e.reward_slots=[...p.drop_item_ids,...(p.money?[-p.money]:[])];while(e.reward_slots.length<6)e.reward_slots.push(0);}
      }else compiled.rewards.items[id].drop_rate=row.parameters.drop_rate;
    }
  }
  // Apply the same skill overlay to the single-skill and combo contact paths.
  const replace=s=>{const row=skillsByOwner.get(skillOwnerKey(s));return row?applyRegisteredSkillParameters(s,row,manifest.mode):s;};
  for(const [id,s]of Object.entries(compiled.party_skills.skills))compiled.party_skills.skills[id]=copy(compiled.skill_registry[id]);
  for(const [id,s]of Object.entries(compiled.party_skills.field_skills??{}))compiled.party_skills.field_skills[id]=copy(compiled.skill_registry[id]);
  for(const dataSkills of [compiled.combat.skills,compiled.forest.skills,compiled.forest.player_skills])for(const [id,s]of Object.entries(dataSkills))dataSkills[id]=replace(s);
  for(const a of [...compiled.combat.actors,...Object.values(compiled.forest.actors)])a.current_skill=replace(a.current_skill);
  for(const role of Object.values(compiled.ai.roles))role.skills=role.skills.map(s=>{
    // Weight is owned by battle.json; numeric skill overlay must retain it.
    const weight=view(s).getUint8(0x27),next=replace(s);if(next!==s){const v=view(next);v.setUint8(0x27,weight);next.fixed_raw_hex=rawHex(v);}return next;
  });
  for(const a of Object.values(compiled.forest.actors))fail(a.raw_by_address['0x0524a72d']*compiled.scheduler.average_speed_factor<=0x7fffffff,'敌人速度与充能系数的组合超出当前运行范围');
  const audit={schema:manifest.schema,version:1,mode:manifest.mode,differences,parameters:Object.fromEntries(Object.keys(CONFIG_FILES).map(section=>[section,Object.fromEntries(Object.entries(bundle[section].entries).map(([id,row])=>[id,copy(row.parameters)]))]))};
  compiled.combat.source.runtime_configuration=copy(audit);compiled.audit=audit;return compiled;
}

export async function loadRuntimeConfiguration(readJson,manifestPath='data/config/index.json'){
  // A restored file can have an older Last-Modified value than the browser's
  // cached debug profile. Every battle must read bytes rather than revalidate
  // that cache with a conditional request.
  const fresh={cache:'no-store'},manifest=await readJson(manifestPath,fresh);
  fail(manifest?.schema==='seventh-seal-runtime-config'&&manifest.version===1&&same(manifest.files,CONFIG_FILES),'配置入口版本或路径无效');
  const directory=manifestPath.slice(0,manifestPath.lastIndexOf('/')+1),sections=await Promise.all(Object.entries(CONFIG_FILES).map(async([key,file])=>[key,await readJson(directory+file,fresh)]));
  return {manifest,...Object.fromEntries(sections)};
}
