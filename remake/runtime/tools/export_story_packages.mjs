// Compile retained source ledgers and explicitly registered authoring files.
// This step needs no game installation or media; it does not re-extract or
// claim to re-verify the original executable and resource fingerprints.
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {runtimeContent,runtimeContentDefinition} from '../web/core/content_registry.mjs';
import {validateStoryBindings} from '../web/core/content_dependencies.mjs';
import {requireContentReadiness} from '../web/core/content_readiness.mjs';
import {chapterChoices} from '../web/core/chapter.mjs';
import {validateOpeningProgram} from '../web/core/opening.mjs';
import {validateProgram} from '../web/core/events.mjs';
import {validateQuests} from '../web/core/story_quests.mjs';
import {STORY_RESOURCE_TABLES,storyTextId,validateStorySelection,hydrateStoryTable} from '../web/core/story_packages.mjs';
import {compileTlkFlow,compileEventFlow} from '../web/core/story_flow_compiler.mjs';
import {scriptedBattleSource} from '../web/core/scripted_battle.mjs';

const web=fileURLToPath(new URL('../web/',import.meta.url));
const need=(ok,message)=>{if(!ok)throw new Error(`剧情构建：${message}`);};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const local=name=>path.join(web,name);
const read=async name=>JSON.parse(await readFile(local(name),'utf8'));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function packFlow(source){
  const flow=structuredClone(source);
  for(const command of flow.commands){
    if(command.text_id!==undefined)delete command.text;
    for(const choice of command.choices??[])if(choice.text_id!==undefined)delete choice.text;
  }
  return flow;
}
function putText(texts,id,text){need(typeof text==='string'&&(!Object.hasOwn(texts,id)||texts[id]===text),`文本 ${id} 冲突或无效`);texts[id]=text;}
function compileTable(mapId,source,texts){
  const table=structuredClone(source);table.id=mapId;
  table.records=table.records.map(record=>{
    const raw=Uint8Array.from(record.raw_hex.match(/../g),part=>parseInt(part,16));
    const {raw_hex,evidence,header_bytes_2_to14_raw,text_raw,...row}=record;
    if(record.kind===5)row.scripted_battle=scriptedBattleSource(record);
    row.text_id=storyTextId(mapId,record.id);row.portrait_id=raw[2];putText(texts,row.text_id,text_raw);
    row.choices=record.kind===0&&record.style===1?chapterChoices(record).map(({text,...choice})=>{
      const text_id=`${row.text_id}:choice:${choice.index}`;putText(texts,text_id,text);return {...choice,text_id};
    }):[];
    return row;
  });
  hydrateStoryTable(table,texts);return table;
}
function sourceEventSample(event,map){
  if(!event.npc||!event.sample_initial_flags)return;
  const {npc}=event,{width,terrain_rows:rows,triggers}=map.movement;
  const blocked=new Set(triggers.filter(row=>row.path_gate).map(row=>`${row.x},${row.y}`));
  const candidates=[32,16,48,0,-16,-32].flatMap(dy=>[0,-16,16,-32,32].map(dx=>[npc.x+dx,npc.y+dy]));
  const point=candidates.find(([x,y])=>Number.isInteger(x)&&Number.isInteger(y)&&x>=0&&y>=0&&x/16<width&&y/16<rows.length
    &&rows[Math.floor(y/16)][Math.floor(x/16)]==='0'&&!blocked.has(`${Math.floor(x/16)},${Math.floor(y/16)}`));
  need(point,`${event.id} 缺少可通行的调试交互点`);
  event.sample={clear_bits:event.sample_initial_flags.filter(row=>!row.value).map(({index,bit})=>({index,bit})),
    probe:{name:`${npc.name} · 交互样本`,x:point[0],y:point[1],direction:3,purpose:'Development relocation to an open interaction approach cell; not native approach/pathfinding.'},
    scope:event.sample_initial_flags_scope};
}
function compileEvent(source,file,texts,content,map,resources){
  const event=structuredClone(source),authored=event.schema==='seventh-seal-story-event';
  need((authored||event.schema==='seventh-seal-event')&&event.version===1,`${file} 事件版本无效`);
  need(typeof event.id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(event.id)&&content.maps[event.map_id],`${file} 事件编号或地图无效`);
  if(authored){
    need(Object.keys(event).every(key=>['schema','version','id','name','map_id','npc_slot','npc','conditions','program'].includes(key)),`${file} 包含未知字段`);
    need(Boolean(event.npc)!==Number.isInteger(event.npc_slot),`${file} 必须指定 npc 或 npc_slot`);
    if(event.npc_slot!==undefined)need((resources.npcs_by_map[event.map_id]??map.opening_npcs??[]).some(row=>row.slot_zero_based===event.npc_slot),`${file} NPC 槽未导出`);
    const labels=new Map();
    need(Array.isArray(event.program),`${file} 缺少程序`);
    for(const [pc,command]of event.program.entries())if(command.label!==undefined){need(typeof command.label==='string'&&!labels.has(command.label),`${file} 标签重复`);labels.set(command.label,pc);}
    const lineIds=new Set();
    event.program.forEach((command,pc)=>{
      if(command.op==='say'){
        need(typeof command.id==='string'&&/^[A-Za-z0-9_.:-]+$/.test(command.id)&&!lineIds.has(command.id),`${file} 每句对白必须有稳定且唯一的 id`);lineIds.add(command.id);
        need(command.speaker===undefined||typeof command.speaker==='string',`${file} 说话人无效`);
        need(command.style_raw===undefined||Number.isInteger(command.style_raw)&&command.style_raw>=0&&command.style_raw<=3,`${file} 对白样式无效`);
        need(command.portrait_id===undefined||Number.isInteger(command.portrait_id)&&command.portrait_id>=0,`${file} 画像编号无效`);
        need(command.portrait_left===undefined||typeof command.portrait_left==='boolean',`${file} 画像方向无效`);
        const slot=event.npc_slot??event.npc?.slot_zero_based;
        command.presentation={speaker:slot===undefined?500:slot+1,style:command.style_raw??0,
          portrait_id:command.portrait_id??0,region_byte_raw:command.portrait_left?1:0};
      }
      for(const key of ['target','if_true','if_false'])if(typeof command[key]==='string'){need(labels.has(command[key]),`${file} 跳转标签 ${command[key]} 缺失`);command[key]=labels.get(command[key]);}
      command.source={kind:'authored',path:file,command_id:command.id??command.label??String(pc)};
      command.evidence=['authored-content'];
    });
    event.schema='seventh-seal-event';event.commit_policy='remake-atomic-success';
  }else sourceEventSample(event,map);
  if(event.npc){
    need(typeof event.npc.id==='string'&&typeof event.npc.name==='string'&&Number.isFinite(event.npc.x)&&Number.isFinite(event.npc.y)
      &&event.npc.resource&&typeof event.npc.resource.sheet==='string',`${file} NPC 显示定义无效`);
    const resource=event.npc.resource;
    need(['frame_width','frame_height','frames_per_direction','directions','interval_ms'].every(key=>Number.isInteger(resource[key])&&resource[key]>0)
      &&Number.isFinite(resource.anchor_x)&&Number.isFinite(resource.anchor_y)&&Number.isInteger(event.npc.direction)&&event.npc.direction>=0&&event.npc.direction<8,`${file} NPC 图集或朝向无效`);
  }
  need(event.npc||Number.isInteger(event.npc_slot),`${file} 缺少 NPC 交互入口`);
  need((event.conditions??[]).every(row=>Number.isInteger(row.index)&&row.index>=0&&row.index<2000&&Number.isInteger(row.value)&&row.value>=0&&row.value<=0xffffffff),`${file} NPC 显示条件无效`);
  validateProgram(event);
  need(event.program.some(command=>command.op==='end'),`${file} 缺少结束指令`);
  for(const command of event.program)if(command.op==='say'&&!command.presentation){
    const record=event.records?.[command.source.record_id],bytes=record?.raw_hex?.match(/../g)?.map(part=>parseInt(part,16));
    command.presentation={speaker:command.speaker_slot??record?.speaker??500,style:command.style_raw??0,
      portrait_id:bytes?.[2]??0,region_byte_raw:bytes?.[6]??0};
  }
  delete event.records;delete event.labels;delete event.expected;
  for(const command of event.program){
    delete command.raw_hex;
    if(command.op!=='say')continue;
    const id=authored?`${event.id}:line:${command.id}`:storyTextId(event.map_id,command.source.record_id);
    putText(texts,id,command.text);command.text_id=id;
  }
  const flow=compileEventFlow(event);
  delete event.program;delete event.commit_policy;
  event.schema='seventh-seal-story-event-binding';event.flow_id=flow.id;
  return {event,flow:packFlow(flow)};
}

export async function compileStoryPackages({content=runtimeContent,definition:compiledDefinition=runtimeContentDefinition}={}){
  const definition=await read('data/runtime_content.json');
  const selection=validateStorySelection(definition.story);
  if(!same(definition,compiledDefinition)){
    const {story:previousSelection,...previous}=compiledDefinition,{story:nextSelection,...next}=definition;
    need(same(previous,next),'地图、角色或演出登记已改变，请先构建 content');
    // Event/quest admission does not change native map/role identities. This
    // narrow refresh reuses the verified compiled identity table unchanged.
    content={...content,story:selection};
  }
  const [story,resources,opening,routes]=await Promise.all(['chapter_story','chapter_map_resources','opening_program','route_events'].map(name=>read(`data/${name}.json`)));
  validateStoryBindings(content,story,resources);validateOpeningProgram(opening);
  const readiness=requireContentReadiness(content,story,resources);
  const output=new Map(),maps={},eventsByMap={},eventIds=new Set(),npcIds=new Set(),quests=[];
  for(const id of Object.keys(definition.maps))maps[id]=await read(`data/maps/${id.toLowerCase()}.json`);
  for(const file of selection.events){
    const event=await read(file),mapId=event.map_id;
    need(maps[mapId],`${file} 地图未登记`);
    const key=`${mapId}:${event.npc_slot??event.npc?.slot_zero_based??event.npc?.id}`;
    need(!eventIds.has(event.id)&&!npcIds.has(key),`${file} 事件编号或 NPC 入口重复`);eventIds.add(event.id);npcIds.add(key);
    (eventsByMap[mapId]??=[]).push({file,event});
  }
  for(const file of selection.quests){
    const value=await read(file);need(value.schema==='seventh-seal-quests'&&value.version===1&&Array.isArray(value.quests),`${file} 任务文件无效`);quests.push(...value.quests);
  }
  validateQuests(quests,content);
  const add=(name,value)=>{output.set(name,JSON.stringify(value,null,2)+'\n');return {path:name,sha256:hash(value)};};
  output.set('data/runtime_content.mjs','// Generated by tools/export_content_registry.mjs; edit runtime_content.json.\nexport const definition = '+JSON.stringify(definition,null,2)+';\nexport default '+JSON.stringify(content,null,2)+';\n');
  const shared=add('data/story/shared.json',{schema:'seventh-seal-story-shared',version:1,
    chapter:{source_hashes:story.source_hashes,item_definitions:story.item_definitions,role_definitions:story.role_definitions},roles:resources.roles,quests});
  const index={schema:'seventh-seal-story-index',version:2,definition_sha256:hash(definition),shared,maps:{}};
  for(const [id,map]of Object.entries(maps)){
    const texts={};
    const chapter=story.maps[id]?compileTable(id,story.maps[id],texts):null;
    const programs=Object.fromEntries(Object.entries(story.programs).filter(([,value])=>value.maps.includes(id)).map(([key,value])=>{
      const {dialogues,...program}=structuredClone(value);return [key,program];
    }));
    const flows={},events=[];
    if(chapter?.records.length){
      const flow=compileTlkFlow(hydrateStoryTable(chapter,texts),{choices:chapterChoices});
      chapter.flow_id=flow.id;flows[flow.id]=packFlow(flow);
    }
    for(const {event:source,file}of eventsByMap[id]??[]){
      const {event,flow}=compileEvent(source,file,texts,content,map,resources);
      need(!Object.hasOwn(flows,flow.id),`${file} 流程编号 ${flow.id} 与地图剧情冲突`);events.push(event);flows[flow.id]=flow;
    }
    index.maps[id]=add(`data/story/maps/${id.toLowerCase()}.json`,{schema:'seventh-seal-story-map',version:2,map_id:id,chapter,programs,flows,events,
      resources:Object.fromEntries(STORY_RESOURCE_TABLES.map(key=>[key,resources[key]?.[id]??[]])),route:chapter?null:routes[id]??null,texts});
  }
  const texts={},program=structuredClone(opening);program.version=2;
  program.dialogues=Object.fromEntries(Object.entries(opening.dialogues).map(([id,table])=>[id,compileTable(id,table,texts)]));
  index.opening=add('data/story/opening.json',{schema:'seventh-seal-story-opening',version:1,program,texts});
  add('data/story/index.json',index);
  return {output,report:{maps:Object.keys(maps).length,events:eventIds.size,quests:quests.length,source_bytes:Buffer.byteLength(JSON.stringify(story)),runtime_bytes:[...output].filter(([name])=>name.startsWith('data/story/')).reduce((sum,[,text])=>sum+Buffer.byteLength(text),0),readiness_warnings:readiness.warnings.length}};
}
export async function exportStoryPackages({check=false,compiled=null,...options}={}){
  const {output,report}=compiled??await compileStoryPackages(options);
  const changed=[];
  for(const [name,text]of output){
    const current=await readFile(local(name),'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    if(current!==text)changed.push(name);
  }
  if(check&&changed.length)throw new Error(`剧情包未构建或已过期：${changed.join('、')}。请运行 node remake/runtime/tools/export_story_packages.mjs`);
  if(!check)for(const name of changed){
    await mkdir(path.dirname(local(name)),{recursive:true});await writeFile(local(name)+'.tmp',output.get(name));await rename(local(name)+'.tmp',local(name));
  }
  return {passed:true,check_only:check,changed:changed.length,...report};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log(JSON.stringify(await exportStoryPackages({check:process.argv.includes('--check')})));
}
