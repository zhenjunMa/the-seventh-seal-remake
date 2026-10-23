// Generate missing config files, preserve edits, or explicitly restore defaults.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {deriveRuntimeConfiguration,compileRuntimeConfiguration,compactRuntimeConfiguration,expandRuntimeConfiguration,loadRuntimeConfiguration,CONFIG_FILES} from '../web/core/runtime_config.mjs';
import {expandParameterOverrides} from '../web/core/config_overrides.mjs';
import {upgradeSkillConfiguration} from '../web/core/skill_registry.mjs';
import {upgradeItemConfiguration} from '../web/core/item_registry.mjs';
import {sourceSkillParameters} from '../web/core/skill_config.mjs';
const sourceNames={combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'forest_rewards',party_skills:'party_skills',items:'items'};
const readJson=async url=>JSON.parse(await readFile(url,'utf8'));
async function readSources(directory){
  return Object.fromEntries(await Promise.all(Object.entries(sourceNames).map(async([id,name])=>[id,await readJson(new URL(`${name}.json`,directory))])));
}

export async function exportRuntimeConfiguration({dataDirectory=new URL('../web/data/',import.meta.url),outputDirectory=new URL('config/',dataDirectory),reset=false}={}){
  const data=await readSources(dataDirectory),defaults=deriveRuntimeConfiguration(data);
  const files={manifest:'index.json',...CONFIG_FILES},previous={},bundle={};
  let fresh=false;
  for(const [id,file]of Object.entries(files)){
    if(reset){bundle[id]=structuredClone(defaults[id]);continue;}
    try{previous[id]=await readJson(new URL(file,outputDirectory));}
    catch(error){if(error.code!=='ENOENT')throw error;if(id==='manifest')fresh=true;}
    bundle[id]=structuredClone(previous[id]??defaults[id]);
  }
  if(!reset){
    bundle.skills=upgradeSkillConfiguration(data,bundle.skills);
    bundle.items=upgradeItemConfiguration(data.items,bundle.items);
    for(const section of ['battle','rewards']){
      const expanded=expandParameterOverrides(defaults[section],bundle[section],{allowNewEntries:true});
      if(!expanded.entries||typeof expanded.entries!=='object'||Array.isArray(expanded.entries))throw new Error(`参数配置：${section}.entries须为对象`);
      // New enemies get defaults in both sections; existing rows still pass
      // the normal immutable-source and numeric validation before any write.
      bundle[section]={...expanded,entries:{...defaults[section].entries,...expanded.entries}};
    }
  }
  // One-time migration of existing skill edits; the old file stays historical.
  if(fresh&&!reset){
    let old;
    try{old=await readJson(new URL('skills.json',dataDirectory));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(old){
      for(const [oldId,newId]of Object.entries({yantu:'yantu',snow_attack:'012_14'})){
        const legacy=old.skills[oldId],row=bundle.skills.entries[newId];
        const retained=oldId==='yantu'?data.combat.skills.yantu:data.ai.roles['012'].skills[14];
        if(JSON.stringify(legacy.source)!==JSON.stringify(retained.source)||JSON.stringify(legacy.original)!==JSON.stringify(sourceSkillParameters(retained)))throw new Error('旧技能配置来源或基线不匹配，未写入新配置');
        Object.assign(row.parameters,legacy.parameters);
      }
      bundle.manifest.mode=old.mode;
    }
  }
  // Compaction validates the complete expanded bundle before writing anything.
  const output=compactRuntimeConfiguration(data,bundle),pending=Object.keys(files).filter(id=>reset||JSON.stringify(previous[id])!==JSON.stringify(output[id]));
  await mkdir(outputDirectory,{recursive:true});
  for(const id of pending)await writeFile(new URL(files[id],outputDirectory),JSON.stringify(output[id],null,2)+'\n','utf8');
  return {directory:fileURLToPath(outputDirectory),mode:output.manifest.mode,written:pending.map(id=>files[id]),
    preserved:Object.keys(files).filter(id=>!pending.includes(id)).map(id=>files[id]),
    entries:Object.fromEntries(Object.keys(CONFIG_FILES).map(section=>[section,Object.keys(output[section].entries).length])),skills:Object.keys(output.skills.entries).length};
}

/** Read-only reference for editing: show defaults beside effective values. */
export async function inspectRuntimeConfiguration({dataDirectory=new URL('../web/data/',import.meta.url),outputDirectory=new URL('config/',dataDirectory),section,id}={}){
  if(!Object.hasOwn(CONFIG_FILES,section))throw new Error('参数配置：--reference须选择skills、battle、rewards或items');
  const data=await readSources(dataDirectory);
  const bundle=await loadRuntimeConfiguration(file=>readJson(new URL(file,outputDirectory)),'index.json');
  compileRuntimeConfiguration(data,bundle);
  const expanded=expandRuntimeConfiguration(data,bundle),entries=expanded[section].entries;
  if(id!==undefined&&!Object.hasOwn(entries,id))throw new Error(`参数配置：未登记${section}.${id}`);
  return {section,mode:expanded.manifest.mode,readonly:true,
    entries:Object.fromEntries(Object.entries(entries).filter(([key])=>id===undefined||key===id).map(([key,row])=>[key,{
      name:row.name,...(row.owner?{owner:row.owner}:{}),source:row.source,original:row.original,parameters:row.parameters,
    }]))};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args[0]==='--reference'){
    if(args.length<2||args.length>3)throw new Error('用法：--reference <skills|battle|rewards|items> [编号]');
    console.log(JSON.stringify(await inspectRuntimeConfiguration({section:args[1],id:args[2]}),null,2));
  }else{
    if(args.some(arg=>arg!=='--reset'))throw new Error('用法：export_runtime_config.mjs [--reset] 或 --reference <分类> [编号]');
    console.log(JSON.stringify(await exportRuntimeConfiguration({reset:args.includes('--reset')})));
  }
}
