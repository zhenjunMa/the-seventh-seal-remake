// Remake bug fixes are applied to live copies after source/config validation.
// The original CHR records and their fingerprints remain unchanged.
import {compileNativeSequence,directSequence,recordBytes} from './skill_sequence.mjs';
const corrections=new Map([['005:29',71],['005:30',72]]);
export function isStoryGrantedPartySkill(skill){
  return /^00[1-6]$/.test(skill.actor_id)&&[71,72].includes(parseInt(skill.fixed_raw_hex.slice(0,2),16));
}
export function hasPartySkillTypeCorrection(skill){
  const index=skill.original_skill_index??skill.index,id=corrections.get(`${skill.actor_id}:${index}`);
  const sourceId=typeof skill.fixed_raw_hex==='string'?parseInt(skill.fixed_raw_hex.slice(0,2),16):skill.original_id_raw??skill.id;
  return id!==undefined&&sourceId===id;
}
export function correctPartySkillType(skill){
  if(!hasPartySkillTypeCorrection(skill))return skill;
  const flags=parseInt(skill.fixed_raw_hex.slice(0x32*2,0x33*2),16);
  if((flags&15)!==0)return skill;
  const corrected=(flags&0xf0)|3,raw=skill.fixed_raw_hex;
  const originalFlags=skill.type_flags_u32_0x32??Array.from({length:4},(_,i)=>parseInt(raw.slice((0x32+i)*2,(0x33+i)*2),16)*2**(i*8)).reduce((a,b)=>a+b,0);
  return {...skill,fixed_raw_hex:raw.slice(0,0x32*2)+corrected.toString(16).padStart(2,'0')+raw.slice(0x33*2),
    type_raw:3,type_flags_u32_0x32:originalFlags|3,
    remake_correction:'aid-command-type'};
}

/** Older exported catalogs retain the two complete records only in roles.
 * Explicit admission selects them; the ordinary carrier handles their actions.
 */
export function supplementalPartyCommands(commands,content){
  const out={};
  for(const [roleId,role]of Object.entries(commands.roles??{}))for(const binding of content.roles[roleId]?.battle_skills??[]){
    const skill=role.skills[binding.index];
    if(commands.skills[binding.id]||!skill||!hasPartySkillTypeCorrection(skill))continue;
    out[binding.id]={...structuredClone(skill),id:binding.id,battle_handler:binding.handler,
      effect_context:{effect_token:1,effect_source_skill_index:binding.index,effect_lookup:'same-index-source-table'}};
  }
  return out;
}

/** Reuse retained lifecycle action atlases and the existing aid effects when
 * loading an older media export. Every frame/control still comes from CHR/DGP.
 */
export function addCorrectedPartyPresentations(meta,skills){
  let added=0;
  for(const skill of Object.values(skills??{})){
    if(!hasPartySkillTypeCorrection(skill))continue;
    const role=meta.roles.find(row=>row.id===skill.actor_id);
    if(!role||role.skill.runtime_skill_id===skill.id||role.alternate_skills?.some(row=>row.runtime_skill_id===skill.id))continue;
    const compiled=compileNativeSequence(meta,role.id,directSequence(skill));
    const segments=compiled.segments.map(segment=>{
      const action=role.actions.find(row=>row.index===segment.action_index),b=recordBytes(skill.actions[segment.chr_record_index].raw_hex),v=new DataView(b.buffer);
      const d=Uint8Array.from(action.native_raw_hex.match(/../g),h=>parseInt(h,16));
      return {...segment,interval_raw:new DataView(d.buffer).getUint32(1,true),reverse_raw:b[0x1d],
        raw_hex:skill.actions[segment.chr_record_index].raw_hex,source_skill_index:skill.original_skill_index,
        event:v.getUint32(0x49,true)?{frame:v.getUint32(0x49,true),field:'0x49'}:null};
    });
    const controls=skill.actions.flatMap(action=>{
      const b=recordBytes(action.raw_hex),v=new DataView(b.buffer);if(b[0]===0)return [];
      const command=v.getUint32(1,true),out={chr_record_index:action.index,type_raw:1,command_raw:command,raw_hex:action.raw_hex,immediate:command!==4||!b[0x1d]};
      if(command===4){
        const token=new TextDecoder().decode(b.slice(9,29)).split('\0')[0].replace(/\.dgp$/i,''),asset=meta.effects.find(row=>row.id===token);
        out.effect_asset_id=token;
        if(!asset){out.missing_source_file=true;return [out];}
        const d=Uint8Array.from(asset.native_raw_hex.match(/../g),h=>parseInt(h,16)),start=v.getUint32(0x26,true),end=v.getUint32(0x2a,true)||asset.frame_count,contact=v.getUint32(0x49,true);
        Object.assign(out,{wait_raw:b[0x1d],slot:b[0x22]?'target':'actor',start,end_exclusive:end,
          frames:Array.from({length:end-start},(_,i)=>{const frame=d[0xd]&15?start+i:d[0x16+start+i];return frame<asset.frame_count?frame:null;}),
          event:contact?{frame:contact,field:'0x49'}:null});
      }
      return [out];
    });
    role.alternate_skills??=[];
    role.alternate_skills.push({role_id:role.id,chr_skill_index:skill.original_skill_index,skill_id_raw:parseInt(skill.fixed_raw_hex.slice(0,2),16),
      name:skill.name,runtime_skill_id:skill.id,segments,command_effects:controls,terminal_commands:[]});
    added++;
  }
  return added;
}
