// Generate missing config files, preserve edits, or explicitly restore defaults.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {deriveRuntimeConfiguration,compileRuntimeConfiguration,CONFIG_FILES} from '../web/core/runtime_config.mjs';
import {upgradeSkillConfiguration} from '../web/core/skill_registry.mjs';
import {upgradeItemConfiguration} from '../web/core/item_registry.mjs';
import {sourceSkillParameters} from '../web/core/skill_config.mjs';
export async function exportRuntimeConfiguration({dataDirectory=new URL('../web/data/',import.meta.url),outputDirectory=new URL('config/',dataDirectory),reset=false}={}){
const root=dataDirectory,read=async file=>JSON.parse(await readFile(new URL(file,root),'utf8'));
const names={combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'forest_rewards',party_skills:'party_skills',items:'items'};
const data=Object.fromEntries(await Promise.all(Object.entries(names).map(async([id,name])=>[id,await read(`${name}.json`)])));
const defaults=deriveRuntimeConfiguration(data),files={manifest:'index.json',...CONFIG_FILES},output=outputDirectory,pending=[],bundle={};
let fresh=false;
for(const [id,file]of Object.entries(files)){
  try{bundle[id]=reset?defaults[id]:JSON.parse(await readFile(new URL(file,output),'utf8'));if(reset)pending.push(id);}
  catch(error){if(error.code!=='ENOENT')throw error;bundle[id]=structuredClone(defaults[id]);pending.push(id);if(id==='manifest')fresh=true;}
}
if(!reset){
  const upgraded=upgradeSkillConfiguration(data,bundle.skills);
  if(JSON.stringify(upgraded)!==JSON.stringify(bundle.skills)){bundle.skills=upgraded;if(!pending.includes('skills'))pending.push('skills');}
  const itemUpgrade=upgradeItemConfiguration(data.items,bundle.items);
  if(JSON.stringify(itemUpgrade)!==JSON.stringify(bundle.items)){bundle.items=itemUpgrade;if(!pending.includes('items'))pending.push('items');}
}
// One-time migration of existing skill edits; the old file becomes historical.
if(fresh&&!reset){
  const old=await read('skills.json'),map={yantu:'yantu',snow_attack:'012_14'};
  for(const [oldId,newId]of Object.entries(map)){
    const legacy=old.skills[oldId],row=bundle.skills.entries[newId];
    const retained=oldId==='yantu'?data.combat.skills.yantu:data.ai.roles['012'].skills[14];
    if(JSON.stringify(legacy.source)!==JSON.stringify(retained.source)||JSON.stringify(legacy.original)!==JSON.stringify(sourceSkillParameters(retained)))throw new Error('旧技能配置来源或基线不匹配，未写入新配置');
    Object.assign(row.parameters,legacy.parameters);
  }
  bundle.manifest.mode=old.mode;
}
compileRuntimeConfiguration(data,bundle); // Validate everything before writing.
await mkdir(output,{recursive:true});
for(const id of pending)await writeFile(new URL(files[id],output),JSON.stringify(bundle[id],null,2)+'\n','utf8');
return {directory:fileURLToPath(output),mode:bundle.manifest.mode,written:pending.map(id=>files[id]),preserved:Object.keys(files).filter(id=>!pending.includes(id)).map(id=>files[id]),skills:Object.keys(bundle.skills.entries).length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await exportRuntimeConfiguration({reset:process.argv.includes('--reset')})));
