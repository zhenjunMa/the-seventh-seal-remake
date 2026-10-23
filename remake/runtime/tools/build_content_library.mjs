// Build or inspect the source-content index without importing native code.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {buildContentLibrary,resolveContentReference,searchContentLibrary} from '../web/core/content_library.mjs';
import {createSkillRegistry} from '../web/core/skill_registry.mjs';
const directory=new URL('../web/data/',import.meta.url),output=new URL('library/index.json',directory);
const sources={roles:'library/roles.json',skills:'library/skills.json',magic:'library/magic.json',items:'items.json',registration:'runtime_content.json',partySkills:'party_skills.json',ai:'forest_ai.json',
  skillConfiguration:'config/skills.json',itemConfiguration:'config/items.json'};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function exportContentLibrary({dataDirectory=directory,check=false}={}){
  const input_sha256={},data={};
  for(const [key,name]of Object.entries(sources)){
    const bytes=await readFile(new URL(name,dataDirectory));input_sha256[`data/${name}`]=digest(bytes);data[key]=JSON.parse(bytes);
  }
  const runtimeSkillIds=Object.keys(createSkillRegistry({party_skills:data.partySkills,ai:data.ai}));
  const library={...buildContentLibrary({...data,runtimeSkillIds}),input_sha256},target=new URL('library/index.json',dataDirectory),text=JSON.stringify(library,null,2)+'\n';
  let previous;try{previous=await readFile(target,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(check){if(previous!==text)throw new Error('内容资料库索引过期，请运行 build_runtime.py --target content-library --run');}
  else if(previous!==text){await mkdir(new URL('library/',dataDirectory),{recursive:true});await writeFile(target,text,'utf8');}
  return {passed:true,check_only:check,written:!check&&previous!==text,counts:library.counts,index_sha256:digest(text)};
}
async function query(args){
  const library=JSON.parse(await readFile(output,'utf8'));
  if(args.length===0)return {counts:library.counts,companions:library.indexes.roles.companions.map(id=>resolveContentReference(library,{kind:'roles',id}))};
  if(args[0]==='search'){
    if(args.length>3)throw new Error('用法：--query search [文字] [roles|skills|items]');
    return searchContentLibrary(library,{text:args[1]??'',kind:args[2]});
  }
  if(args.length!==2)throw new Error('用法：--query [<roles|skills|items> <编号>] 或 --query search [文字] [分类]');
  return resolveContentReference(library,{kind:args[0],id:args[1]});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args[0]==='--query')console.log(JSON.stringify(await query(args.slice(1)),null,2));
  else{
    if(args.some(arg=>arg!=='--check'))throw new Error('用法：build_content_library.mjs [--check|--query ...]');
    console.log(JSON.stringify(await exportContentLibrary({check:args.includes('--check')})));
  }
}
