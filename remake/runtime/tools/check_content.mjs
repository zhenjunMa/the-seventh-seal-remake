// Read-only capability check against exported source records, before art builds.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {resolveContentDefinition} from '../web/core/content_definition.mjs';
import {validateContentRegistration} from '../web/core/content_registry.mjs';
import {validateStoryBindings} from '../web/core/content_dependencies.mjs';
import {inspectContentReadiness} from '../web/core/content_readiness.mjs';

export async function checkContent(){
  const read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
  const [definition,seed,forest,story,resources]=await Promise.all(['runtime_content','opening_seed','forest_combat','chapter_story','chapter_map_resources'].map(read));
  const maps=Object.fromEntries(await Promise.all(Object.keys(definition.maps).map(async id=>[id,await read(`maps/${id.toLowerCase()}`)])));
  const content=resolveContentDefinition(definition,{seed,forest,story,maps});
  validateContentRegistration(content);validateStoryBindings(content,story,resources);
  return inspectContentReadiness(content,story,resources);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const report=await checkContent();
    if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
    else{
      console.log(`剧情能力预检查：${report.passed?'通过':'未通过'}；入口 ${report.entrances.length}，阻断 ${report.errors.length}，旧 NPC 分支提示 ${report.warnings.length}`);
      for(const row of [...report.errors,...report.warnings])console.log(`${report.errors.includes(row)?'阻断':'提示'} ${row.map_id} ${row.entrance} ${row.entrance_id} → TLK ${row.record_id}: ${row.message}`);
    }
    if(!report.passed)process.exitCode=1;
  }catch(error){console.error(`内容预检查失败：${error.message}`);process.exitCode=1;}
}
