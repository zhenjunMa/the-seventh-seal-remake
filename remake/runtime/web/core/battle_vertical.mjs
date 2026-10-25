// Native actor-Z motion: 5130D0 case3 initialization and the isolated
// 51A4F0:51A622..51A969 update block. Z is signed native height (up < 0).
// Rendering/projection (513FC0), camera (5119F0), record advancement (51A240)
// and death/normal-response dispatch (51CC00) remain with their owners.
export const NATIVE_VERTICAL_EVIDENCE={
  initialize:'ev_28368650259f3980bb37bf5b679f3a547aa66aa025d16e78432827d87efb27ab',
  update:'ev_15074ba1e716dbee5de449c6c18c8af0dfb570150803f5138f7f9fe4991fe96f',
  camera:'ev_ce293bca8b0ffcfbadbc7ab928bccca37387e34e2977a2d165a022d5022de55a'
};
export const NATIVE_VERTICAL_TICK_MS=20;
const fields={
  target_z:['native_vertical_target_raw','0x0524a63a'],
  velocity:['native_vertical_velocity_raw','0x0524a63e'],
  counter:['native_vertical_counter_raw','0x0524a636'],
  wait_raw:['native_vertical_wait_raw','0x0524a635'],
  acceleration_raw:['native_vertical_acceleration_raw','0x0524a642'],
  render_z:['native_vertical_render_z_raw','0x0521a79d'],
  delay_ms:['native_vertical_delay_raw','0x0521a7b1']
};
const need=(value,message)=>{if(!value)throw new TypeError(message);};
const int=(value,name)=>{need(Number.isInteger(value)&&value>=-2147483648&&value<=2147483647,`Native vertical ${name} is not int32`);return value;};
const byte=(value,name)=>{need(Number.isInteger(value)&&value>=0&&value<=255,`Native vertical ${name} is not a byte`);return value;};
function derived(state){
  state.native_z_raw=state.z;
  state.reached=state.z===state.target_z;
  state.active=state.velocity!==0&&!state.reached;
  // The original checks its wait byte only inside the active motion block.
  // A stale wait byte with velocity0/equal target does not block the cursor.
  state.waiting=Boolean(state.active&&state.wait_raw);
  state.landed=state.z===0;
  return state;
}
function validate(state){
  need(state&&typeof state==='object','Native vertical state missing');
  for(const key of ['z','target_z','velocity','counter','render_z','delay_ms'])int(state[key],key);
  for(const key of ['wait_raw','acceleration_raw'])byte(state[key],key);
  need(Number.isFinite(state.tick_remainder_ms)&&state.tick_remainder_ms>=0&&state.tick_remainder_ms<20,'Native vertical clock remainder invalid');
  return state;
}
/** Rehydrate from current actor fields after any source dispatcher changes
 * its Z/velocity. The caller owns the remainder across adjacent draw frames. */
export function nativeVerticalState(actor){
  const state={z:int(actor?.native_z_raw,'actor Z'),tick_remainder_ms:0,ticks:0,updates:0,wrote_delay:false,wrote_render:false,camera_request:null};
  for(const [key,[field,address]]of Object.entries(fields)){
    const value=actor[field]??actor.native_after_raw?.[address]??actor.raw_by_address?.[address]??(key==='render_z'?state.z:0);
    state[key]=['wait_raw','acceleration_raw'].includes(key)?byte(value,key):int(value,key);
  }
  return derived(state);
}
/** Decode raw action bytes, rather than a separately authored motion curve.
 * Actor modes0/2 rise relative to current Z; modes1/3 return to ground.
 * Camera-only modes4/5 are deliberately a different command owner. */
export function createNativeVertical({actor,record}){
  const raw=typeof record==='string'?record:record?.raw_hex;
  need(typeof raw==='string'&&/^[0-9a-f]{352}$/i.test(raw),'Native vertical action bytes missing');
  const bytes=Uint8Array.from(raw.match(/../g),part=>parseInt(part,16)),view=new DataView(bytes.buffer);
  need(bytes[0]===1&&view.getUint32(1,true)===3,'Native vertical command3 source missing');
  const mode=bytes[0x47],speed=view.getInt32(5,true),multiplier=view.getInt32(0x1e,true),wait=bytes[0x1d],acceleration=bytes[0x23];
  need(mode<=3,'Camera-only command3 mode belongs to the camera executor');
  const state=nativeVerticalState(actor),height=Math.imul(speed,multiplier),up=(mode&1)===0;
  state.mode_raw=mode;state.counter=0;state.wait_raw=wait;state.acceleration_raw=acceleration;
  state.target_z=up?(state.z-height)|0:0;
  state.velocity=up?(-(acceleration?(height-(height>>1))|0:speed))|0:acceleration?1:speed;
  state.delay_ms=0;state.wrote_delay=true;
  if(mode<2)state.camera_request={procedure:'0x5119f0',x:-1,y:up?height:0,wait_raw:0,acceleration_raw:acceleration};
  return derived(state);
}
/** Pure 20ms frame updates. Keep this state between frames; when a source
 * dispatcher replaces vertical actor fields, rehydrate and retain the owner's
 * fractional frame remainder. No RNG, HP changes, callbacks or hidden landing. */
export function advanceNativeVertical(previous,deltaMs){
  validate(previous);need(Number.isFinite(deltaMs)&&deltaMs>=0&&Number.isSafeInteger(Math.floor(deltaMs)),'Native vertical elapsed time invalid');
  const state={...previous,wrote_delay:false,wrote_render:false},total=state.tick_remainder_ms+deltaMs,ticks=Math.floor(total/20);
  state.tick_remainder_ms=total-ticks*20;state.ticks=(state.ticks??0)+ticks;
  for(let i=0;i<ticks;i++){
    // Native top guard skips the complete block, including ground cleanup,
    // acceleration, render-Z copy, clock write and the wait-byte check.
    if(state.velocity===0||state.z===state.target_z)break;
    if(state.velocity<0){
      const next=(state.z+state.velocity)|0;
      if(next>state.target_z)state.z=next;
      else{state.z=state.target_z;state.wait_raw=0;state.velocity=0;}
    }
    if(state.velocity>0){
      const next=(state.z+state.velocity)|0;
      if(next<state.target_z)state.z=next;
      else{state.z=state.target_z;state.wait_raw=0;state.velocity=0;}
    }
    if(state.acceleration_raw!==0){
      state.counter=(state.counter+1)|0;
      if((state.counter&3)===1){
        if(state.velocity<0)state.velocity=(state.velocity-(state.velocity>>3))|0;
        if(state.velocity>0)state.velocity=Math.imul(state.velocity,3);
      }
    }
    if(state.z>=0){state.wait_raw=0;state.target_z=0;state.z=0;state.acceleration_raw=0;state.velocity=0;}
    state.render_z=state.z;state.delay_ms=20;state.wrote_delay=true;state.wrote_render=true;state.updates=(state.updates??0)+1;
  }
  return derived(state);
}
/** Merge exact vertical writes without discarding unrelated native fields.
 * delay/render are emitted only when this operation actually wrote them;
 * otherwise they must not overwrite the record executor's newer clock/pose. */
export function verticalActorPatch(state,actor={}){
  validate(state);const patch={native_z_raw:state.z,native_after_raw:{...actor.native_after_raw,'0x0521a785':state.z}};
  for(const [key,[field,address]]of Object.entries(fields)){
    if(key==='delay_ms'&&!state.wrote_delay||key==='render_z'&&!state.wrote_render)continue;
    patch[field]=state[key];patch.native_after_raw[address]=state[key];
  }
  return patch;
}
