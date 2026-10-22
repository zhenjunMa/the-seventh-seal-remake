// Shared by Python exporters and the final content compiler. No generated
// party output is needed to resolve the authoring choices.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {resolveContentDefinition} from '../web/core/content_definition.mjs';
const web=new URL('../web/',import.meta.url);
export async function readContentDefinition(){
  const input_sha256={},hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const read=async name=>{const bytes=await readFile(new URL(name,web));input_sha256[name]=hash(bytes);return JSON.parse(bytes);};
  const definition=await read('data/runtime_content.json');
  const [seed,forest,story]=await Promise.all(['opening_seed','forest_combat','chapter_story'].map(name=>read(`data/${name}.json`)));
  const maps=Object.fromEntries(await Promise.all(Object.keys(definition.maps).map(async id=>{
    const map=await read(`data/maps/${id.toLowerCase()}.json`),source=map.source;
    if(source?.path?.toLowerCase()!==`map/${id.toLowerCase()}.dat`)throw new Error(`地图 ${id} 原始来源缺失`);
    const bytes=await readFile(new URL('../../../'+source.path,import.meta.url));
    if(hash(bytes)!==source.sha256||bytes.length<0x96)throw new Error(`地图 ${id} 原输入已变化`);
    input_sha256[`original/${source.path}`]=source.sha256;
    // Reuse the established DAT+0x92 field; old route map JSON omitted it.
    const flag_index=bytes.readUInt32LE(0x92);
    if(map.map_flag_index!==undefined&&map.map_flag_index!==flag_index)throw new Error(`地图 ${id} 旗标字段与来源不同`);
    return [id,{...map,map_flag_index:flag_index}];
  })));
  const sources={seed,forest,story,maps};
  return {definition,content:resolveContentDefinition(definition,sources),sources,input_sha256};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify((await readContentDefinition()).content));
