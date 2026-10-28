// Source-based rule fixtures. They do not assert a natural prior playthrough,
// render actor poses, decode video, or replace the browser acceptance run.
import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import {WorldStore} from '../../web/core/world.mjs';
import {ChapterRunner} from '../../web/core/chapter.mjs';
import {ChapterAnimationRunner} from '../../web/core/chapter_animation.mjs';
import {admitPartyMember} from '../../web/core/party_members.mjs';
import {runtimeContent} from '../../web/core/content_registry.mjs';
import {worldMapEntry} from '../../web/core/map_connections.mjs';

globalThis.crypto??=webcrypto;
const copy=structuredClone;
const original=new URL('../../../../',import.meta.url);
export const lakeMapIds=['M71010','M71011','M71011-1','M71012','M71012-1','M71012-2','M71013','M71014','M71020','M71030','M71040','M71050','M71060'];
const mapIds=[...lakeMapIds,'M01060','M01065'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const jadeLakeRead=async name=>JSON.parse(await readFile(new URL(`../../web/data/${name}.json`,import.meta.url),'utf8'));
export const jadeLakeOriginal=name=>readFile(new URL(name,original));

export async function jadeLakeSource(){
  const [seed,registeredStory,worldMap,resources]=await Promise.all(['opening_seed','chapter_story','world_map','chapter_map_resources'].map(jadeLakeRead));
  const content=copy(runtimeContent),story={schema:'seventh-seal-chapter-story',version:1,maps:{},programs:{},source_hashes:{},item_definitions:{},role_definitions:registeredStory.role_definitions};
  for(const mapId of mapIds){
    const path=`Map/${mapId.toLowerCase()}.dat`,dat=await jadeLakeOriginal(path),sha256=digest(dat),width=dat.readUInt32LE(0x146),height=dat.readUInt32LE(0x14a),cells={},markers={};
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const offset=0x172+(y*width+x)*64,trigger=dat.readUInt32LE(offset+0x38),marker=dat[offset+0x21];
      if(trigger)(cells[trigger]??=[]).push({x,y,offset});
      if(marker)(markers[marker]??=[]).push({x,y,offset});
    }
    const size=dat.readUInt32LE(0x18)===1?0x42:0x2b,base=0x172+width*height*64+32*0x2a,descriptors=[];
    for(let index=0;index<32;index++){
      const offset=base+index*size,raw=dat.subarray(offset,offset+size);
      if(!raw.some(Boolean))continue;
      const field=at=>size===0x42?raw.readUInt32LE(at):raw[0x26+(at-0x26)/4];
      descriptors.push({id:index+1,state_raw:raw[0],filename_raw:raw.subarray(0x11,0x26).toString('ascii').split('\0')[0],
        field_26_raw:field(0x26),field_2a_raw:field(0x2a),field_2e_raw:field(0x2e),cells:cells[index+1]??[],raw_hex:raw.toString('hex'),
        source:{path,sha256,offset,bytes:size}});
    }
    story.source_hashes[path]=sha256;
    const table={id:mapId,map_flag_index:dat.readUInt32LE(0x92),map_source:{path,sha256,bytes:dat.length},descriptors,entry_markers:markers,
      header_setup_tlk_raw:dat.readUInt32LE(0x8a),header_entry_tlk_raw:dat.readUInt32LE(0x13a),objects:[],index_nonzero:[],records:[]};
    try{
      const tlkPath=`Map/${mapId.toLowerCase()}.TLK`,tlk=await jadeLakeOriginal(tlkPath),hash=digest(tlk),count=tlk.readUInt32LE(2),recordBase=0x1a+count*4;
      table.source={path:tlkPath,sha256:hash,bytes:tlk.length};table.record_base=recordBase;
      story.source_hashes[tlkPath]=hash;
      for(let slot=0;slot<count;slot++){const record=tlk.readUInt32LE(0x1a+slot*4);if(record)table.index_nonzero.push({slot,record});}
      const fields={id:0x13,speaker:0x0f,condition_type:0x17,condition_index:0x1b,condition_bit:0x1f,mutation_type:0x23,mutation_index:0x27,mutation_bit:0x2b,if_true:0x2f,next:0x33};
      table.records=Array.from({length:tlk.readUInt32LE(6)},(_,index)=>{
        const offset=recordBase+index*0x66f,raw=tlk.subarray(offset,offset+0x66f);
        return {...Object.fromEntries(Object.entries(fields).map(([key,at])=>[key,raw.readUInt32LE(at)])),offset,kind:raw[0],style:raw[1],region_byte_raw:raw[7],condition_byte_raw_0b:raw[11],
          text_raw:new TextDecoder('gbk').decode(raw.subarray(0x37,0x137)).split('\0')[0],raw_hex:raw.toString('hex'),source:{path:tlkPath,sha256:hash,offset,record_id:index+1}};
      });
    }catch(error){if(error.code!=='ENOENT')throw error;Object.assign(table,{dialogue_status:'source-file-absent',source:null,record_count:0,index_count:0});}
    story.maps[mapId]=table;
    content.maps[mapId]={path:`data/maps/${mapId.toLowerCase()}.json`,triggers:[],objects:[],rests:[],routes:[],npcs:[]};
  }
  content.maps.M71014.triggers=[1,2,3];content.maps.M71014.npcs=[10];
  content.maps.M71013.triggers=[1,2];content.maps.M71050.triggers=[3];
  content.maps.M01065.triggers=[31];content.maps.M01060.npcs=[19];content.maps.M01060.triggers=[6];
  for(const [id,callerMaps]of [['m71014-1',['M71014']],['m71050-1',['M01060','M01065']]]){
    const path=`Animate/${id}.anm`,bytes=await jadeLakeOriginal(path),source={path,sha256:digest(bytes),bytes:bytes.length};
    const commands=Array.from({length:bytes.readUInt32LE(2)},(_,index)=>{
      const offset=67+index*74,raw=bytes.subarray(offset,offset+74),row={index,opcode:raw[0],raw_hex:raw.toString('hex'),source:{...source,offset}};
      for(const at of [1,5,9,13,17,21,25])row[`u32_plus${at}`]=raw.readUInt32LE(at);
      for(let at=29;at<34;at++)row[`byte_plus${at}`]=raw[at];
      if(row.opcode===10)row.filename=raw.subarray(54).toString('ascii').split('\0')[0];
      return row;
    });
    const controlMaps=[...new Set(commands.filter(row=>row.opcode===10).map(row=>row.filename.slice(0,-4).toUpperCase()))];
    story.source_hashes[path]=source.sha256;content.programs[id]=copy(source);
    story.programs[id]={schema:'seventh-seal-chapter-anm',version:1,id,source,commands,maps:[...new Set([...callerMaps,...controlMaps])],expected:{control_map:controlMaps.at(-1),control_maps:controlMaps,caller_maps:callerMaps}};
  }
  return {seed,story,content,worldMap,resources,mapIds:Object.keys(content.maps)};
}

export function jadeLakeWorld(source,{mapId='M71014',flags=[],party=['001','002']}={}){
  const value=copy(source.seed);value.opening.status='complete';
  for(const id of party)admitPartyMember(value,id,{definitions:source.story.role_definitions,content:source.content});
  value.location={map_id:mapId,x:368,y:1632,direction:2};
  for(const [index,bit,on=true]of flags){const mask=1<<(bit-1);value.flags[index]=on?value.flags[index]|mask:value.flags[index]&~mask;}
  return new WorldStore(value,source.mapIds);
}

export function jadeLakeRunner(source,world,extra={}){
  const {animationHooks={},...runnerExtra}=extra;
  const trace={animations:[],transfers:[],media:[]};
  const runner=new ChapterRunner({world,data:source.story,content:source.content,say:async()=>{},choose:async({choices})=>choices[0].index,wait:async()=>{},
    worldMapState:()=>({areas:source.worldMap.areas.map(({id,selected_index,statuses})=>({id,selected_index,statuses:[...statuses]}))}),
    transfer:async({destination})=>{const location=worldMapEntry({},destination,source.story);trace.transfers.push(location);return {location};},
    animate:async({program,runTlk,joinActor,leaveActor,flagCommand,draft})=>{
      const hooks=Object.fromEntries(['map','actor','move','camera','wait','fade','sound'].map(name=>[name,async()=>{}]));
      let activeMap=draft.location.map_id;
      const initialActor=Number(draft.leader_id)-1,poses=new Map([[initialActor,{direction:draft.location.direction}]]);
      hooks.map=async({mapId})=>{activeMap=mapId;};
      hooks.actor=async row=>{
        if(row.kind!=='place')return;
        const id=row.actor<10?Object.keys(source.content.roles).find(id=>source.content.roles[id].side==='player'&&source.content.roles[id].native_slot===row.actor)
          :source.resources.npcs_by_map[activeMap]?.find(npc=>npc.slot_zero_based===row.actor)?.resource_id;
        const flat=Math.max(0,row.poseRaw-1),action=source.resources.roles[id]?.actions.find(action=>flat>=action.first_frame&&flat<action.first_frame+action.frame_count*action.directions);
        if(!action)throw Error(`Source actor pose unavailable ${activeMap}:${row.actor}:${row.poseRaw}`);
        poses.set(row.actor,{direction:Math.floor((flat-action.first_frame)/action.frame_count)});
      };
      hooks.move=async row=>{if(row.arrivalFacingRaw)poses.set(row.actor,{direction:row.arrivalFacingRaw-1});};
      hooks.media=async({filename})=>trace.media.push(filename);
      for(const [name,hook]of Object.entries(animationHooks)){
        const base=hooks[name];hooks[name]=async row=>{await base?.(row);return hook(row);};
      }
      const result=await new ChapterAnimationRunner({program,content:source.content,runTlk,joinActor,leaveActor,flagCommand,initialLocation:draft.location,initialActor,hooks}).run();
      const direction=poses.get(result.controlled_actor)?.direction;
      if(!Number.isInteger(direction))throw Error('Source controlled actor facing unavailable');
      draft.location={...result.location,direction};trace.animations.push({id:program.id,commands:result.commands});
    },...runnerExtra});
  return {runner,trace};
}
