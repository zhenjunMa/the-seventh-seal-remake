// Shared package contracts. Source TLK/ANM validation belongs to the compiler;
// the browser validates compact records, references and package fingerprints.
import {isNativeScriptedBattleNames} from './native_battle_filenames.mjs';
export const STORY_RESOURCE_TABLES=['npcs_by_map','exits_by_map','trigger_regions','interactive_objects','object_animations'];
export const storyTextId=(mapId,recordId)=>`${mapId}:TLK:${recordId}`;
const need=(ok,message)=>{if(!ok)throw new Error(`剧情包：${message}`);};
export async function storyDigest(value){
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
}
export function validateStorySelection(selection={events:[],quests:[]}){
  need(selection&&typeof selection==='object'&&!Array.isArray(selection)&&Object.keys(selection).every(key=>['events','quests'].includes(key)),'登记包含未知字段');
  for(const kind of ['events','quests'])need(Array.isArray(selection[kind])&&new Set(selection[kind]).size===selection[kind].length
    &&selection[kind].every(file=>typeof file==='string'&&/^(?:content|data\/events)\/[A-Za-z0-9_/-]+\.json$/.test(file)&&!file.split('/').includes('..')),`${kind} 文件登记重复或路径无效`);
  return selection;
}
export function validateCompactRecords(table){
  if(table?.dialogue_status==='source-file-absent'){
    need(/^M\d{5}(?:-\d+)?$/.test(table.id)&&table.source===null&&Array.isArray(table.records)
      &&table.records.length===0&&table.record_count===0&&table.index_count===0
      &&table.index_nonzero?.length===0&&/^[a-f0-9]{64}$/.test(table.map_source?.sha256??'')
      &&table.map_source.path?.toLowerCase()===`map/${table.id.toLowerCase()}.dat`,'无对白地图来源无效');
    return table;
  }
  need(table&&/^M\d{5}(?:-\d+)?$/.test(table.id)&&Array.isArray(table.records)&&table.records.length>0&&table.records.length<=10000,'对白表无效');
  const ids=new Set();
  for(const row of table.records){
    need(Number.isInteger(row.id)&&row.id>0&&!ids.has(row.id)&&row.text_id===storyTextId(table.id,row.id),'对白编号重复或文本编号无效');ids.add(row.id);
    need(typeof row.text_raw==='string'&&['kind','style','region_byte_raw','speaker','condition_type','condition_index','condition_bit','mutation_type','mutation_index','mutation_bit','if_true','next'].every(key=>Number.isInteger(row[key])&&row[key]>=0&&row[key]<=0xffffffff),'对白字段无效');
    need(row.raw_hex===undefined,'运行对白不能携带原始 TLK 字节');
    if(row.kind===5)need(isNativeScriptedBattleNames(row.scripted_battle),'原剧情战斗文件名缺失');
    need(Array.isArray(row.choices)&&row.choices.length<=3&&new Set(row.choices.map(choice=>choice.index)).size===row.choices.length,'选择表无效');
    for(const choice of row.choices)need(Number.isInteger(choice.index)&&choice.index>=0&&choice.index<3&&typeof choice.text==='string'
      &&choice.text_id===`${row.text_id}:choice:${choice.index}`&&Number.isInteger(choice.recordId)&&choice.recordId>=0,'选择字段无效');
  }
  // kind2 +2F is a destination map marker and may exceed this TLK's row count.
  for(const row of table.records)for(const target of [...(row.kind===2?[]:[row.if_true]),row.next,...row.choices.map(choice=>choice.recordId)])need(target===0||ids.has(target),`${table.id}:${row.id} 跳转 ${target} 缺失`);
  return table;
}
export function hydrateStoryTable(table,texts){
  if(!table)return null;
  const result=structuredClone(table);
  const text=id=>{need(typeof texts?.[id]==='string',`文本 ${id} 缺失`);return texts[id];};
  for(const record of result.records){
    record.text_raw=text(record.text_id);
    for(const choice of record.choices)choice.text=text(choice.text_id);
  }
  return validateCompactRecords(result);
}
