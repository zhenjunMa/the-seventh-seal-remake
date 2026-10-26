import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {resolveContentDefinition} from '../../web/core/content_definition.mjs';
import {admitPartyMember} from '../../web/core/party_members.mjs';
import {initializeChapterItem,chapterChoices,validateChapterStory} from '../../web/core/chapter.mjs';
import {compileTlkFlow} from '../../web/core/story_flow_compiler.mjs';
const web=new URL('../../web/',import.meta.url),original=new URL('../../../../',import.meta.url);
const isolated=process.env.FIRST_RETURN_RUNTIME?new URL('web/',pathToFileURL(process.env.FIRST_RETURN_RUNTIME.replace(/[/\\]?$/,'/'))):null;
export async function firstReturnRead(path){
  path=path.replace(/^\//,'');
  if(isolated)try{return JSON.parse(await readFile(new URL(path,isolated),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  return JSON.parse(await readFile(new URL(path,web),'utf8'));
}
export async function firstReturnBytes(path){
  path=path.replace(/^\//,'');
  if(isolated)try{return await readFile(new URL(path,isolated));}catch(error){if(error.code!=='ENOENT')throw error;}
  return readFile(new URL(path,web));
}
export async function firstReturnSource(){
  const [story,seed,forest,definition]=await Promise.all(['chapter_story','opening_seed','forest_combat','runtime_content'].map(name=>firstReturnRead(`data/${name}.json`)));
  const maps=Object.fromEntries(await Promise.all(Object.keys(definition.maps).map(async id=>{
    if(id==='M01050')return [id,{id,map_flag_index:story.maps[id].map_flag_index}];
    return [id,await firstReturnRead(`data/maps/${id.toLowerCase()}.json`)];
  })));
  const content=resolveContentDefinition(definition,{seed,forest,story,maps});
  validateChapterStory(story);
  story.flows=Object.fromEntries(Object.values(story.maps).filter(table=>table.records.length)
    .map(table=>{const flow=compileTlkFlow(table,{choices:chapterChoices});return [flow.id,flow];}));
  return {story,seed,definition,content};
}
export function firstReturnWorld({story,seed,content},{returnedItem=true,accepted=true}={}){
  const world=structuredClone(seed);world.opening.status='complete';
  admitPartyMember(world,'002',{definitions:story.role_definitions,content});
  world.location={map_id:'M01050',x:984,y:648,direction:0};
  // Development handoff: original writer M01051:r29, DAT flag index31.
  world.flags[31]|=2;
  // Source M01050:r14 accepts the request; r24 sets completion bit3 later.
  if(accepted)world.flags[5]|=1;else world.flags[5]&=~1;
  world.flags[5]&=~4;
  if(returnedItem){
    const def=story.item_definitions[299],raw=initializeChapterItem(def);new DataView(raw.buffer).setUint32(4,1,true);
    world.inventory.push({instance_id:'development-external-return299',id:299,name:def.name,quantity:1,
      source_raw_hex:Array.from(raw,x=>x.toString(16).padStart(2,'0')).join(''),source_definition:structuredClone(def.source),
      initialization_source:'native-TLK-case5-0xCC-buffer-0x47B3C0-0x47BDC0'});
  }
  return world;
}
export async function originalTlk(mapId,id){
  const path=`Map/${mapId}.TLK`,bytes=await readFile(new URL(path,original)),base=0x1a+bytes.readUInt32LE(2)*4,offset=base+(id-1)*0x66f,raw=bytes.subarray(offset,offset+0x66f);
  const fields={id:0x13,kind:0,style:1,condition_type:0x17,condition_index:0x1b,condition_bit:0x1f,mutation_type:0x23,mutation_index:0x27,mutation_bit:0x2b,if_true:0x2f,next:0x33};
  return {...Object.fromEntries(Object.entries(fields).map(([key,at])=>[key,at<2?raw[at]:raw.readUInt32LE(at)])),raw_hex:raw.toString('hex'),
    source:{path,sha256:createHash('sha256').update(bytes).digest('hex'),offset,record_id:id,record_bytes:0x66f}};
}
