/** Source-backed forest effect lifecycle: 508BB0, 508300, 509E10, 507E20.
 * Pure actor copies. The caller runs apply after a non-rejected contact, before
 * HP submission, and clears effects at finalized death / battle cleanup.
 * Only fresh mode0 status43 and dormant id0 blocks occur in this slice.
 */
import {runtimeContent} from './content_registry.mjs';
const ZERO='00'.repeat(0xc6),FLAG_ADDRESS='0x0521f52a';
const validatedData=new WeakMap();
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
export function validateForestStatusData(data,content=runtimeContent){
  if(data&&typeof data==='object'&&validatedData.get(data)===content)return data;
  need(data?.schema==='seventh-seal-forest-status'&&data.version===1&&data.slots===100&&data.effect_bytes===0xc6&&data.skill_block_offset===0x16b,'Forest status metadata incompatible');
  need(data.skills&&Object.keys(data.skills).length>0,'Original skill blocks required');
  const active=[];
  for(const[key,skill]of Object.entries(data.skills)){
    const [role,index]=key.split(':');need(content.roles[role]&&/^\d+$/.test(index)&&Number(index)<200,'Status skill owner is not registered');
    const fixed=bytes(skill.fixed_raw_hex,0x41d,'skill'),block=bytes(skill.effect_raw_hex,0xc6,'skill effect');
    need(hex(fixed.slice(0x16b,0x231))===hex(block)&&block[1]===skill.effect_id_raw&&block[0xb]===0&&skill.mode_raw===0,'Original effect block mismatch');
    if(block[1]){need(block[1]===43,'Status effect handler is not implemented');active.push(key);}
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
  const template=bytes(data.status43.effect_raw_hex,0xc6,'status43');
  const empty=rawView(ZERO);
  return actor.native_status_slots.map((record,index)=>{
    // This read-only local view is shared by empty slots. Writers replace a
    // slot record; neither application nor ticking mutates an empty view.
    if(record?.raw_hex===ZERO)return empty;
    const b=rawView(record?.raw_hex);
    if(b.raw[1]===0)need(record.raw_hex===ZERO,'Empty effect slot contains unsupported residual bytes');
    else need(b.raw[1]===43&&b.raw[0xb]===0&&templateEquals(b.raw,template)&&b.view.getInt32(2,true)>0&&b.view.getInt32(2,true)<=10,`Unsupported native effect at slot ${index}; mode2 removal RNG is not ported`);
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
  return Boolean(actor.side_raw&&(actor.immune_raw||[4,5,6,7,11].includes(actor.state_raw)||(actor.status_flags_raw&0xe0)));
}
export function clearNativeStatuses(actor,data){
  validateForestStatusData(data);need(actor&&typeof actor==='object','Native actor missing');
  const out=clone(actor);out.status_by_address??={};out.native_status_slots=Array.from({length:100},()=>({raw_hex:ZERO}));resetAggregate(out,data);return out;
}
export function initializeNativeStatuses(actor,data){return clearNativeStatuses(actor,data);}
/** 50FA00 calls 508A90 first. The source forest never produces mode2,
 * so supported slots have no removal effects and consume no removal RNG.
 */
export function applyNativeSkillStatus({actor,skill,data,rng,now}){
  validateForestStatusData(data);integer(now,'native elapsed time');
  const records=slots(actor,data),out=clone(actor),trace=[];let cancel_command=false;
  const fixed=bytes(skill?.fixed_raw_hex,0x41d,'skill'),block=rawView(hex(fixed.slice(0x16b,0x231))),id=block.raw[1],mode=block.raw[0xb];
  const result=(native_return,reason,applied=false)=>({actor:out,native_return,reason,applied,cancel_command,trace,evidence:data.evidence['0x508bb0']});
  need(mode===0,'Only source mode0 skill effects are implemented');
  // 508E97 -> 50924D. Dormant hunter payload is not an active modifier.
  if(id===0)return result(1,'effect-id-zero');
  need(id===43&&hex(block.raw)===data.status43.effect_raw_hex,'Only the original snow status43 block is implemented');
  if(records.some(s=>s.raw[1]===id&&s.raw[0xb]===mode))return result(0,'duplicate-id-and-mode');
  const next=typeof rng==='function'?rng:rng?.next?.bind(rng);need(next,'Explicit native RNG provider required');
  const draw=integer(next(),'native RNG output',0,32767),roll=draw%100,chance=block.raw[0x11];
  trace.push({kind:'rng',label:'status-application-chance',raw:draw,modulus:100,result:roll});
  if(chance!==0&&roll>chance)return result(0,'chance-failed');
  // Mode6/7 immunity and effect10 would occur here in the full game; slots()
  // rejects those unexported contexts rather than silently skipping their RNG.
  if(flags(out)&0x2e0)return result(0,'target-status-flags');
  const index=records.findIndex(s=>s.raw[1]===0||(s.raw[1]===id&&s.raw[0xb]!==mode));
  if(index<0)return result(0,'no-empty-slot');
  records[index]=block;out.native_status_slots[index]={raw_hex:hex(block.raw)};cancel_command=recalculate(out,records,data);
  if(cancel_command)trace.push({kind:'native-command-cancel',function:'0x42fe40',command_kind_raw:6});
  trace.push({kind:'status-applied',slot:index,effect_id_raw:id,mode_raw:mode,last_tick_ms_raw:block.view.getInt32(0x17,true)});
  return result(1,'applied',true);
}
export function tickNativeStatuses({actor,threshold,now,data}){
  validateForestStatusData(data);integer(threshold,'native status threshold');integer(now,'native elapsed time');
  const records=slots(actor,data),out=clone(actor),trace=[],expired=[];let ticks=0,cancel_command=false;
  need(!(flags(out)&0xe0),'Controlling status tick branch is outside the source43 slice');
  for(let index=0;index<records.length;index++){
    const b=records[index];if(!b.raw[1])continue;
    if(((now-b.view.getInt32(0x17,true))|0)<data.status43.interval_ms)continue;
    b.view.setInt32(0x17,now,true);
    b.view.setUint32(0x13,((b.view.getInt32(0x13,true)+1)>>>0)%data.status43.frame_count,true);
    const speed=integer(out.status_by_address['0x0521f56d'],'status speed');
    const before=b.view.getInt32(0x1b,true),gauge=(before+b.view.getInt32(6,true)+speed)|0;
    b.view.setInt32(0x1b,gauge,true);ticks++;
    if(gauge>=threshold){
      b.view.setInt32(0x1b,0,true);const count=(b.view.getInt32(2,true)-1)|0;b.view.setInt32(2,count,true);
      if(count===0){expired.push(index);records[index]=rawView(ZERO);out.native_status_slots[index]={raw_hex:ZERO};cancel_command=recalculate(out,records,data)||cancel_command;}
    }
    out.native_status_slots[index]={raw_hex:hex(records[index].raw)};
    trace.push({kind:'status-tick',slot:index,now,gauge_before:before,gauge_added:gauge-before,gauge_after:records[index].view.getInt32(0x1b,true),duration_count_after:records[index].view.getInt32(2,true),expired:expired.includes(index)});
  }
  if(cancel_command)trace.push({kind:'native-command-cancel',function:'0x42fe40',command_kind_raw:6});
  return {actor:out,ticks,expired,cancel_command,trace,evidence:data.evidence['0x509e10']};
}
