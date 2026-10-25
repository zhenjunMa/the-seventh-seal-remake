// Presentation clocks for source CF1 single-action and CF4 idle objects. Triggering/collecting an
// object remains an event transaction, never an animation side effect.
import {createNativeRng} from './combat_rules.mjs';

function sourceBytes(hex,size,label){
  if(typeof hex!=='string'||!new RegExp(`^[0-9a-f]{${size*2}}$`,'i').test(hex))throw new Error(`${label}原始记录缺失`);
  const raw=Uint8Array.from(hex.match(/../g),value=>parseInt(value,16));return {raw,view:new DataView(raw.buffer)};
}
function cf1Source(row){
  const {resource}=row,{raw,view}=sourceBytes(row.source_record_raw_hex,0x112,'地图物件');
  if(raw[0xcf]!==1||view.getUint32(0xf6,true)!==0||raw[0xb4]!==row.fixed_clock_raw_b4
    ||view.getUint32(0x3c,true)!==row.initial_frame_raw)throw new Error('CF1地图物件源字段不匹配');
  if(resource.actions?.length!==1)throw new Error('CF1地图物件多动作尚未恢复');
  const action=resource.actions[0],{raw:a,view:v}=sourceBytes(action.source_action_raw_hex,0xac,'地图物件动作');
  const count=v.getUint32(0x0e,true),interval=v.getUint32(1,true),first=v.getUint32(0x72,true);
  if(a[0]!==0||a[13]!==1||count<1||count>255||first!==0||action.index!==0||action.directions!==1
    ||action.frame_count!==count||action.interval_raw!==interval||action.first_frame!==first
    ||action.logical_frames?.length!==count||action.logical_frames.some((frame,i)=>frame!==i)
    ||a.slice(0x56,0x6a).some(Boolean)||a[0x84]||interval===1||interval>0x7fffffff)
    throw new Error('CF1地图物件动作/时钟模式尚未恢复');
  return {count,interval:interval||120,fixed:raw[0xb4]!==0};
}

export class MapObjectRuntime {
  constructor({objects,resources,mapFlagIndex,mapId=null,random=null}) {
    this.mapFlagIndex=mapFlagIndex;this.mapId=mapId;this.lastTime=null;
    // Scene-local visual CRT, like MapNpcRuntime. The original complete global
    // CRT stream has not been observed; never consume WorldStore/encounter RNG.
    this.rng=createNativeRng((Date.now()^Math.floor(Math.random()*0xffffffff))>>>0);
    this.random=random??(()=>this.rng.next());
    const draw=()=>{const value=this.random();if(!Number.isInteger(value)||value<0||value>32767)throw new Error('地图物件CRT随机值无效');return value;};
    const rows=[...resources].sort((a,b)=>a.index-b.index);
    if(new Set(rows.map(row=>row.index)).size!==rows.length)throw new Error('地图物件索引重复');
    this.actors=rows.map(row=>{
      const {index,resource,behavior_raw_cf}=row;
      if(![1,4].includes(behavior_raw_cf))throw new Error('地图物件待机类型尚未恢复');
      const source=behavior_raw_cf===1?cf1Source(row):null;
      if(mapId&&row.map_id&&mapId!==row.map_id)throw new Error('地图物件源地图不匹配');
      const object=objects.find(object=>object.index===index);
      if(!object)throw new Error('地图光效没有对应物件');
      const actor={object,resource,behavior:behavior_raw_cf,state:null,frame:0,elapsed:0,loaded:false};
      if(source){
        // 410850 draws FF first, but resets logical +22 and displayed +3C to0.
        // FF is retained native metadata, not the initial displayed frame.
        actor.ffRaw=draw()%source.count;
        actor.interval=source.interval+(source.fixed?0:draw()%(source.interval>>>1));
      }
      this.project(actor,0);return actor;
    });
  }
  project(actor,state) {
    // 4137C0: CF4 states 0/1 loop action0; 40CFE0 restores state3 at
    // action1's last logical frame. Never loop the collection action.
    const action=actor.resource.actions.find(action=>action.index===(actor.behavior===4&&state===3?1:0));
    if(!action)throw new Error('地图物件动作缺失');
    actor.state=state;
    if(actor.behavior===4&&state===3)actor.frame=action.logical_frames.length-1;
    actor.object.motion={main:action.main_bitmap,intrinsic:action.intrinsic_bitmap,
      width:actor.resource.frame_width,height:actor.resource.frame_height,
      frame:action.logical_frames[actor.frame]};
    return action;
  }
  update(now,{world,paused=false}) {
    const delta=this.lastTime===null?0:Math.max(0,now-this.lastTime);this.lastTime=now;
    for(const actor of this.actors){
      const record=world.event_records?.[this.mapFlagIndex]?.[actor.object.index];
      const state=record?parseInt(record.slice(0,2),16):0;
      if(actor.behavior===1){
        // 40CFE0 restores completed state3 at action0's last frame on load.
        // CF1 keeps animating in that state; it has no collection transition.
        const action=actor.resource.actions[0];
        if(!actor.loaded){actor.frame=state===3?action.logical_frames.length-1:0;actor.loaded=true;}
        actor.state=state;
        // 418E60 visits the update queue even for render-hidden objects.
        // Suspend/discard only at the existing scene-clock adaptation boundary.
        if(paused||delta>250){actor.elapsed=0;this.project(actor,state);continue;}
        actor.elapsed+=delta;
        if(actor.elapsed>=actor.interval){
          // 4137C0 writes DD=now, advances once, and discards overshoot.
          actor.elapsed=0;actor.frame=(actor.frame+1)%action.logical_frames.length;
        }
        this.project(actor,state);continue;
      }
      if(state!==actor.state){actor.frame=0;actor.elapsed=0;}
      if(![0,1,3].includes(state)){
        // Active collection has its own event playback; do not fabricate it.
        actor.state=state;actor.object.motion=null;actor.elapsed=0;continue;
      }
      const action=this.project(actor,state);
      if(paused||delta>250){actor.elapsed=0;continue;}
      if(state===3)continue;
      actor.elapsed+=delta;
      const interval=Math.max(1,action.interval_raw),ticks=Math.floor(actor.elapsed/interval);
      actor.elapsed%=interval;
      actor.frame=(actor.frame+ticks)%action.logical_frames.length;this.project(actor,state);
    }
  }
}
