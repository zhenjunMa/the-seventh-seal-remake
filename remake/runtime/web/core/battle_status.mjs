/** Source-backed forest effect lifecycle: 508BB0, 508300, 509E10, 507E20.
 * Pure actor copies. The caller runs apply after a non-rejected contact, before
 * HP submission, and clears effects at finalized death / battle cleanup.
 * Source modes0/2 share application, aggregation, removal and periodic rules.
 */
import {runtimeContent} from './content_registry.mjs';
import {applyNativeRevivalRecoveryBlock} from './battle_revival.mjs';
import {idiv} from './combat_rules.mjs';
const ZERO='00'.repeat(0xc6),FLAG_ADDRESS='0x0521f52a';
const validatedData=new WeakMap();
const templateCache=new WeakMap();
const clone=value=>structuredClone(value);
function need(ok,message){if(!ok)throw new TypeError(message);}
function integer(value,name,min=-2147483648,max=2147483647){need(Number.isInteger(value)&&value>=min&&value<=max,`Invalid ${name}`);return value;}
function bytes(hex,length,name){need(typeof hex==='string'&&new RegExp(`^([a-f0-9]{2}){${length}}$`,'i').test(hex),`${name} source bytes missing`);return Uint8Array.from(hex.match(/../g),h=>parseInt(h,16));}
function rawView(hex){const raw=bytes(hex,0xc6,'effect');return {raw,view:new DataView(raw.buffer)};}
function hex(raw){return Array.from(raw,b=>b.toString(16).padStart(2,'0')).join('');}
function freezeMetadata(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freezeMetadata(child);Object.freeze(value);}return value;}
function templateEquals(raw,template){
  // 509E10 changes duration, display frame, timestamp and gauge only.
  const mutable=new Set([2,3,4,5,0x13,0x14,0x15,0x16,0x17,0x18,0x19,0x1a,0x1b,0x1c,0x1d,0x1e]);
  return raw.every((b,i)=>mutable.has(i)||b===template[i]);
}
function effectMetadata(data,id){return id===43?data.status43:data.effects?.[String(id)];}
export function validateNativeSkillStatus(skill,data){
  const fixed=bytes(skill?.fixed_raw_hex,0x41d,'skill'),block=rawView(hex(fixed.slice(0x16b,0x231))),id=block.raw[1],mode=block.raw[0xb];
  if(skill.effect_raw_hex!==undefined)need(skill.effect_raw_hex===hex(block.raw),'Original effect block mismatch');
  if(skill.effect_id_raw!==undefined)need(skill.effect_id_raw===id,'Original effect block mismatch');
  if(skill.mode_raw!==undefined)need(skill.mode_raw===mode,'Original effect block mismatch');
  need([0,2].includes(mode),'Native status application mode is not implemented');
  if(id){
    const metadata=effectMetadata(data,id);need(metadata&&metadata.id_raw===id,'Status effect handler/source metadata is not implemented');
    integer(metadata.interval_ms,'status interval',1,2147483647);integer(metadata.frame_count,'status frame count',0,2147483647);
    need(block.raw[0x10]<=1,'Native periodic status mode is not implemented');
  }
  return {id,mode,block};
}
export function validateForestStatusData(data,content=runtimeContent){
  if(data&&typeof data==='object'&&validatedData.get(data)===content)return data;
  need(data?.schema==='seventh-seal-forest-status'&&data.version===1&&data.slots===100&&data.effect_bytes===0xc6&&data.skill_block_offset===0x16b,'Forest status metadata incompatible');
  need(data.skills&&Object.keys(data.skills).length>0,'Original skill blocks required');
  const active=[];
  for(const[key,skill]of Object.entries(data.skills)){
    const [role,index]=key.split(':');need(content.roles[role]&&/^\d+$/.test(index)&&Number(index)<200,'Status skill owner is not registered');
    const {id}=validateNativeSkillStatus(skill,data);if(id===43)active.push(key);
  }
  const s=data.status43,b=rawView(s?.effect_raw_hex),v=b.view;
  need(s.id_raw===43&&s.mode_raw===0&&s.interval_ms===80&&s.frame_count===10&&b.raw[1]===43&&b.raw[0xb]===0&&b.raw[0x10]===0&&b.raw[0x11]===80&&v.getInt32(2,true)===10&&v.getInt32(6,true)===500&&v.getInt32(0x17,true)===0&&v.getInt32(0x1b,true)===0&&v.getInt32(0x8f,true)===200&&v.getInt32(0xb8,true)===0,'Status43 source fields incompatible');
  need(active.every(key=>data.skills[key].effect_raw_hex===s.effect_raw_hex),'Status43 source identity differs');
  need(Array.isArray(data.aggregation)&&data.aggregation.length===38&&data.aggregation.some(x=>x.block_offset===0x8f&&x.address==='0x0521f5bd'&&x.bits===32),'Native aggregate field table missing');
  for(const address of ['0x508bb0','0x508300','0x509e10','0x507e20','0x508a90'])need(/^ev_[a-f0-9]{64}$/.test(data.evidence?.[address]),'Status source evidence missing');
  // The cache only contains source metadata that passed validation and was
  // recursively frozen. A separately cloned fixture is always checked again.
  freezeMetadata(data);validatedData.set(data,content);return data;
}
function flags(actor){
  const n=integer(actor.status_flags_raw,'status_flags_raw',0,0xffffffff);
  const addressed=actor.status_by_address?.[FLAG_ADDRESS];
  if(addressed!==undefined)need(integer(addressed,FLAG_ADDRESS,0,0xffffffff)===n,'Status flag representations differ');
  return n;
}
function slots(actor,data){
  need(actor&&typeof actor==='object'&&actor.status_by_address&&Array.isArray(actor.native_status_slots)&&actor.native_status_slots.length===100,'Native status slots must be explicitly initialized');
  flags(actor);
  let templates=templateCache.get(data);
  if(!templates){templates=Object.values(data.skills).map(skill=>rawView(skill.effect_raw_hex));templateCache.set(data,templates);}
  const passiveTemplates=(actor.equipment_passives??[]).map(passive=>passiveBlock(passive));
  const empty=rawView(ZERO);
  return actor.native_status_slots.map((record,index)=>{
    // This read-only local view is shared by empty slots. Writers replace a
    // slot record; neither application nor ticking mutates an empty view.
    if(record?.raw_hex===ZERO)return empty;
    const b=rawView(record?.raw_hex);
    if(b.raw[1]===0)need(record.raw_hex===ZERO||(b.view.getInt32(2,true)===-1&&b.raw.every((value,at)=>at>=2&&at<=5||value===0)),
      'Empty effect slot contains unsupported residual bytes');
    else need([...templates,...passiveTemplates].some(template=>b.raw[1]===template.raw[1]&&b.raw[0xb]===template.raw[0xb]&&templateEquals(b.raw,template.raw)
      &&(template.view.getInt32(2,true)>0?b.view.getInt32(2,true)>0&&b.view.getInt32(2,true)<=template.view.getInt32(2,true):b.view.getInt32(2,true)<=template.view.getInt32(2,true))),
      `Unsupported native effect at slot ${index}; source id/mode${b.raw[0xb]} is not admitted`);
    return b;
  });
}
function resetAggregate(actor,data){
  for(const key of Object.keys(actor.status_by_address)){
    const address=Number(key);if(address>=0x521f52e&&address<0x521f5f4)actor.status_by_address[key]=0;
  }
  for(const field of data.aggregation)actor.status_by_address[field.address]=0;
  actor.status_flags_raw=0;actor.status_by_address[FLAG_ADDRESS]=0;
  actor.native_status_aggregate_raw_hex=ZERO;
}
function recalculate(actor,records,data){
  resetAggregate(actor,data);
  for(const {raw,view}of records){
    if(!raw[1])continue;
    actor.status_flags_raw=(actor.status_flags_raw|(view.getUint32(0xb8,true)&0x3ff))>>>0;
    if(raw[0x10]===0)for(const field of data.aggregation){
      const old=actor.status_by_address[field.address],n=field.bits===8?raw[field.block_offset]:view.getInt32(field.block_offset,true);
      actor.status_by_address[field.address]=field.bits===8?(old+n)&255:(old+n)|0;
    }
  }
  actor.status_by_address[FLAG_ADDRESS]=actor.status_flags_raw;
  // Represent the complete memset/copy aggregate as well as numeric fields.
  const aggregate=rawView(ZERO);for(const field of data.aggregation){const offset=Number(field.address)-0x521f52e;
    if(field.bits===8)aggregate.raw[offset]=actor.status_by_address[field.address];else aggregate.view.setInt32(offset,actor.status_by_address[field.address],true);
  }
  actor.native_status_aggregate_raw_hex=hex(aggregate.raw);
  // 508300 sets command kind6 then 42FE40 case5 clears a player command.
  // UI selection globals belong to the controller; surface their cancellation
  // as a descriptor instead of silently dropping the source callback.
  return Boolean(actor.side_raw&&(records.some(record=>record.raw[1]&&record.view.getInt32(2,true)<0)
    ||actor.immune_raw||[4,5,6,7,11].includes(actor.state_raw)||(actor.status_flags_raw&0xe0)));
}
export function clearNativeStatuses(actor,data,content=runtimeContent){
  validateForestStatusData(data,content);need(actor&&typeof actor==='object','Native actor missing');
  const out=clone(actor);out.status_by_address??={};out.native_status_slots=Array.from({length:100},()=>({raw_hex:ZERO}));resetAggregate(out,data);return out;
}
function passiveBlock(passive){
  const block=rawView(passive?.effect_raw_hex);
  need(passive.kind==='status-immunity'&&passive.mode_raw===6&&passive.effect_id_raw===block.raw[1]
    &&block.raw[1]!==0&&block.raw[0xb]===6&&block.raw[0x10]<=1&&block.view.getInt32(2,true)===-1
    &&block.view.getUint32(0xb8,true)===0&&(block.raw[0x10]===1||!block.raw.slice(0x23,0xb8).some(Boolean)),
    'Native equipment passive source is not implemented');
  return block;
}
export function initializeNativeStatuses(actor,data,content=runtimeContent,rng){
  let out=clearNativeStatuses(actor,data,content);
  const trace=[];
  for(const passive of out.equipment_passives??[]){
    const block=passiveBlock(passive),result=applyNativeBlock({actor:out,data,rng,
      records:slots(out,data),block,id:block.raw[1],mode:6,trace:[],remove_on_contact:false});
    out=result.actor;trace.push({kind:'equipment-passive',item_id:passive.item_id,
      group_index:passive.group_index,entry_index:passive.entry_index,reason:result.reason,
      native_return:result.native_return,trace:result.trace});
  }
  if(trace.length)out.equipment_passive_initialization=trace;
  return out;
}
/** 508BB0 mode1: remove only the first matching source ID, then 508300.
 * Item contacts call this directly, without 50FA00's preceding 508A90 roll.
 * Removal needs no effect animation/tick metadata for the removed ID: all
 * C6 aggregation fields are known, while later ticking keeps its own strict
 * admitted-template checks. This does not admit a new incoming status skill.
 */
export function removeNativeStatus({actor,effect_raw_hex,data,content=runtimeContent}){
  validateForestStatusData(data,content);const block=rawView(effect_raw_hex),id=block.raw[1];
  need(block.raw[0xb]===1,'Native status removal requires mode1');
  need(Array.isArray(actor?.native_status_slots)&&actor.native_status_slots.length===100,'Native status slots must be explicitly initialized');flags(actor);
  const out=clone(actor),records=actor.native_status_slots.map(record=>rawView(record?.raw_hex)),trace=[];
  const result=(native_return,reason,cancel_command=false)=>({actor:out,native_return,applied:native_return===1,cancel_command,reason,trace,evidence:data.evidence['0x508bb0']});
  if(id&&records.some(record=>record.raw[1]===id&&record.raw[0xb]===1))return result(0,'duplicate-id-and-mode');
  const index=id?records.findIndex(record=>record.raw[1]===id):-1;
  if(index<0)return result(0,'matching-status-absent');
  records[index]=rawView(ZERO);out.native_status_slots[index]={raw_hex:ZERO};const cancel_command=recalculate(out,records,data);
  trace.push({kind:'status-cured',slot:index,effect_id_raw:id,mode_raw:1});
  if(cancel_command)trace.push({kind:'native-command-cancel',function:'0x42fe40',command_kind_raw:6});
  return result(1,'matching-status-removed',cancel_command);
}
/** 50FA00 calls 508A90 before 508BB0, including dormant id0 contacts. */
export function applyNativeSkillStatus({actor,skill,data,rng,now,content=runtimeContent}){
  validateForestStatusData(data,content);integer(now,'native elapsed time');
  const {block,id,mode}=validateNativeSkillStatus(skill,data);
  return applyNativeBlock({actor,data,rng,records:slots(actor,data),block,id,mode,trace:[],remove_on_contact:true});
}
function applyNativeBlock({actor,data,rng,records,block,id,mode,trace,remove_on_contact}){
  const out=clone(actor);let cancel_command=false;
  const result=(native_return,reason,applied=false)=>({actor:out,native_return,reason,applied,cancel_command,trace,evidence:data.evidence['0x508bb0']});
  const next=typeof rng==='function'?rng:rng?.next?.bind(rng);
  const rollFor=label=>{need(next,'Explicit native RNG provider required');const raw=integer(next(),'native RNG output',0,32767),result=raw%100;
    trace.push({kind:'rng',label,raw,modulus:100,result});return result;};
  const remove=index=>{records[index]=rawView(ZERO);out.native_status_slots[index]={raw_hex:ZERO};cancel_command=recalculate(out,records,data)||cancel_command;};
  if(remove_on_contact)for(let index=0;index<records.length;index++){
    const existing=records[index];if(!existing.raw[1]||existing.raw[0xb]!==2)continue;
    const roll=rollFor('status-removal-chance'),chance=existing.raw[0x12];
    if(chance===0||roll<=chance){remove(index);trace.push({kind:'status-removed-on-contact',slot:index});}
  }
  // 508E97 -> 50924D. Dormant hunter payload is not an active modifier.
  if(id===0)return result(1,'effect-id-zero');
  if(records.some(s=>s.raw[1]===id&&s.raw[0xb]===mode))return result(0,'duplicate-id-and-mode');
  const roll=rollFor('status-application-chance'),chance=block.raw[0x11];
  if(chance!==0&&roll>chance)return result(0,'chance-failed');
  if(records.some(existing=>existing.raw[0xb]===7||(existing.raw[1]===id&&mode!==6&&existing.raw[0xb]===6)))return result(0,'effect-immunity');
  if(id===1&&(flags(out)&0x40)){
    const index=records.findIndex(existing=>existing.raw[1]&&(existing.view.getUint32(0xb8,true)&0x40));
    if(index>=0){remove(index);return result(0,'opposing-effect-removed');}
  }
  if(block.view.getUint32(0xb8,true)&0x40){const index=records.findIndex(existing=>existing.raw[1]===1);
    if(index>=0){remove(index);return result(0,'opposing-effect-removed');}}
  if(flags(out)&0x2e0)return result(0,'target-status-flags');
  if(records.some(existing=>existing.raw[1]===10))return result(0,'effect10-immunity');
  const index=records.findIndex(s=>s.raw[1]===0||(s.raw[1]===id&&s.raw[0xb]!==mode));
  if(index<0)return result(0,'no-empty-slot');
  records[index]=block;out.native_status_slots[index]={raw_hex:hex(block.raw)};cancel_command=recalculate(out,records,data);
  if(cancel_command)trace.push({kind:'native-command-cancel',function:'0x42fe40',command_kind_raw:6});
  trace.push({kind:'status-applied',slot:index,effect_id_raw:id,mode_raw:mode,last_tick_ms_raw:block.view.getInt32(0x17,true)});
  return result(1,'applied',true);
}
function syncResources(actor){
  const address=n=>`0x${n.toString(16).padStart(8,'0')}`;
  need(actor.resource_bonuses&&actor.raw_by_address,'Periodic native resource snapshot missing');
  for(const [field,n]of [['raw_hp',0x524a701],['raw_hp_maximum',0x524a705],['raw_mp',0x524a709],['raw_mp_maximum',0x524a70d]]){
    integer(actor[field],field);actor.raw_by_address[address(n)]=actor[field];
  }
  const bonus=actor.resource_bonuses;
  actor.effective_hp_raw=(actor.raw_hp+bonus.hp_current)|0;actor.effective_mp_raw=(actor.raw_mp+bonus.mp_current)|0;
  actor.hp={current:Math.max(0,actor.effective_hp_raw),maximum:(actor.raw_hp_maximum+bonus.hp_maximum)|0};
  actor.mp={current:Math.max(0,actor.effective_mp_raw),maximum:(actor.raw_mp_maximum+bonus.mp_maximum)|0};
}
/** 41BFB0's raw-resource submission. Death selection and periodic reaction
 * selection run synchronously in the caller callback, preserving its CRT RNG. */
export function applyNativePeriodicResourceBlock({actor,effect_raw_hex,global_055ee004=0}){
  const {view}=rawView(effect_raw_hex),get=at=>view.getInt32(at,true),out=clone(actor);
  if(out.state_raw>=4)return {actor:out,native_return:0,death_requested:false};
  if(get(0x23)>=0&&get(0x43)>=0){
    const recovered=applyNativeRevivalRecoveryBlock({actor:out,effect_raw_hex});return {...recovered,death_requested:false};
  }
  for(const [field,at]of [['raw_mp',0x2b],['raw_mp_maximum',0x2f],['raw_hp_maximum',0x27]])out[field]=(integer(out[field],field)+get(at))|0;
  if(integer(global_055ee004,'skill-test global')&&out.side_raw){syncResources(out);return {actor:out,native_return:0,death_requested:false};}
  let delta=get(0x23);
  if(delta===0){
    const base=(out.raw_hp_maximum+integer(out.status_by_address['0x0521f555'],'status HP maximum'))|0,
      divisor=integer(out.status_by_address['0x0521f575'],'status HP maximum percent');
    const maximum=(base+(divisor?idiv(Math.imul(base,100),divisor):0))|0;
    delta=idiv(Math.imul(maximum,get(0x43)),100);
  }
  out.raw_hp=(integer(out.raw_hp,'raw_hp')+delta)|0;
  const dead=out.raw_hp<=0;if(dead){out.raw_hp=0;out.state_raw=4;}
  syncResources(out);
  return {actor:out,native_return:dead?1:(-get(0x23))|0,death_requested:dead,hp_delta:delta};
}
export function tickNativeStatuses({actor,threshold,now,data,rng,onPeriodicEffect,global_055ee004=0,content=runtimeContent}){
  validateForestStatusData(data,content);integer(threshold,'native status threshold');integer(now,'native elapsed time');
  let records=slots(actor,data);const out=clone(actor),trace=[],expired=[],periodic_reactions=[];let ticks=0,cancel_command=false,death_requested=false;
  const controlling=flags(out)&0xe0;
  const controlledIndex=controlling?records.findIndex(record=>record.raw[1]&&record.raw[0xb]!==6&&(record.view.getUint32(0xb8,true)&0xe0)):-1;
  for(let index=0;index<records.length;index++){
    if(controlling&&index!==controlledIndex)continue;
    let b=records[index];if(!b.raw[1]||b.raw[0xb]===6)continue;
    const metadata=effectMetadata(data,b.raw[1]);
    if(((now-b.view.getInt32(0x17,true))|0)<metadata.interval_ms)continue;
    b.view.setInt32(0x17,now,true);
    if(metadata.frame_count)b.view.setUint32(0x13,((b.view.getInt32(0x13,true)+1)>>>0)%metadata.frame_count,true);
    const speed=integer(out.status_by_address['0x0521f56d'],'status speed');
    const before=b.view.getInt32(0x1b,true),gauge=(before+b.view.getInt32(6,true)+speed)|0;
    b.view.setInt32(0x1b,gauge,true);ticks++;
    if(gauge>=threshold){
      if(b.raw[0x10]){
        const effect={id_raw:b.raw[1],mode_raw:b.raw[0xb],raw_hex:hex(b.raw),reaction_argument_raw:b.view.getInt32(0xc,true)};
        const damageResult=applyNativePeriodicResourceBlock({actor:out,effect_raw_hex:effect.raw_hex,global_055ee004});Object.assign(out,damageResult.actor);
        death_requested||=damageResult.death_requested;
        const current=bytes(out.current_skill?.fixed_raw_hex,0x41d,'periodic actor current skill');
        const reaction_requested=current[0x23c]===0&&out.hp.current>0&&out.state_raw<4&&effect.reaction_argument_raw!==0;
        out.native_status_slots[index]={raw_hex:hex(b.raw)};
        if(damageResult.death_requested||reaction_requested){
          need(typeof onPeriodicEffect==='function','Native periodic death/reaction callback required');
          const result=onPeriodicEffect({actor:out,effect,damageResult,reaction_requested,rng});
          need(!result?.then,'Native periodic callback must be synchronous');
          if(result?.actor)Object.assign(out,result.actor);if(result?.trace)trace.push(...result.trace);
          if(result?.descriptor)periodic_reactions.push(result.descriptor);
          records=out.native_status_slots.map(record=>rawView(record.raw_hex));b=records[index];
        }
        trace.push({kind:'status-periodic-effect',slot:index,effect_id_raw:effect.id_raw,hp_delta:damageResult.hp_delta??0,
          native_return:damageResult.native_return,death_requested:damageResult.death_requested,reaction_requested});
      }
      b.view.setInt32(0x1b,0,true);const count=(b.view.getInt32(2,true)-1)|0;b.view.setInt32(2,count,true);
      if(count===0){expired.push(index);records[index]=rawView(ZERO);out.native_status_slots[index]={raw_hex:ZERO};cancel_command=recalculate(out,records,data)||cancel_command;}
    }
    out.native_status_slots[index]={raw_hex:hex(records[index].raw)};
    trace.push({kind:'status-tick',slot:index,now,gauge_before:before,gauge_added:gauge-before,gauge_after:records[index].view.getInt32(0x1b,true),duration_count_after:records[index].view.getInt32(2,true),expired:expired.includes(index)});
  }
  if(cancel_command)trace.push({kind:'native-command-cancel',function:'0x42fe40',command_kind_raw:6});
  return {actor:out,ticks,expired,cancel_command,death_requested,periodic_reactions,trace,evidence:data.evidence['0x509e10']};
}
