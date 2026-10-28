// Presentation clocks for source CF1, CF4 and CF7 idle objects. Triggering/collecting an
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
  const explicit=a[13]===0,logicalCount=explicit?v.getUint32(0x12,true):count;
  if(a[0]!==0||![0,1].includes(a[13])||count<1||count>255||first!==0||action.index!==0||action.directions!==1
    ||action.frame_count!==count||action.interval_raw!==interval||action.first_frame!==first
    ||logicalCount<1||(explicit&&logicalCount>0x5c)
    ||action.logical_frames?.length!==logicalCount
    ||action.logical_frames.some((frame,i)=>frame!==(explicit?a[0x16+i]:i)||frame>=count)
    ||a.slice(0x56,0x6a).some(Boolean)||a[0x84]||interval===1||interval>0x7fffffff)
    throw new Error('CF1地图物件动作/时钟模式尚未恢复');
  return {count:logicalCount,interval:interval||120,fixed:raw[0xb4]!==0,layer:raw[0xce],restoredLayer:[2,3,1][a[13]>>>4]};
}
function cf7Source(row){
  const {resource}=row,{raw,view}=sourceBytes(row.source_record_raw_hex,0x112,'CF7地图物件');
  if(raw[0xcf]!==7||raw[0xce]>3||view.getUint32(0xf6,true)!==0
    ||raw[0xb4]!==row.fixed_clock_raw_b4||view.getUint32(0x3c,true)!==row.initial_frame_raw)
    throw new Error('CF7地图物件源字段不匹配或交互尚未恢复');
  if(resource.actions?.length!==2)throw new Error('CF7地图物件动作数量尚未恢复');
  const parsed=resource.actions.map((action,index)=>{
    const {raw:a,view:v}=sourceBytes(action.source_action_raw_hex,0xac,'CF7地图物件动作');
    const physical=v.getUint32(0x0e,true),first=v.getUint32(0x72,true),interval=v.getUint32(1,true);
    const explicit=a[13]===0,count=explicit?v.getUint32(0x12,true):physical;
    if(action.index!==index||a[0]!==0||![0,1].includes(a[13])||physical<1||physical>255
      ||action.frame_count!==physical||action.directions!==1||action.first_frame!==first||action.interval_raw!==interval
      ||interval>0x7fffffff||count<1||(explicit&&count>0x5c)||action.logical_frames?.length!==count
      ||action.logical_frames.some((frame,i)=>frame!==(explicit?a[0x16+i]:i)||frame>=physical)
      ||a.slice(0x56,0x6a).some(Boolean)||a[0x84]||view.getUint32(0x9e+index*4,true)!==0)
      throw new Error('CF7地图物件动作/声音模式尚未恢复');
    return {count,interval,restoredLayer:[2,3,1][a[13]>>>4]};
  });
  if(resource.actions[0].first_frame!==0)throw new Error('CF7地图物件初始物理帧尚未恢复');
  return {count:parsed[0].count,interval:parsed[0].interval,layer:raw[0xce],restoredLayer:parsed[1].restoredLayer};
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
      if(![1,4,7].includes(behavior_raw_cf))throw new Error('地图物件待机类型尚未恢复');
      const source=behavior_raw_cf===1?cf1Source(row):behavior_raw_cf===7?cf7Source(row):null;
      if(mapId&&row.map_id&&mapId!==row.map_id)throw new Error('地图物件源地图不匹配');
      const object=objects.find(object=>object.index===index);
      if(!object)throw new Error('地图光效没有对应物件');
      const actor={object,resource,behavior:behavior_raw_cf,state:null,frame:0,elapsed:0,loaded:false};
      if(behavior_raw_cf===4){
        const {raw}=sourceBytes(row.source_record_raw_hex,0x112,'CF4地图物件');
        if(raw[0xcf]!==4||raw[0xce]>3)throw new Error('CF4地图物件源类型或绘制层无效');
        actor.sourceLayer=raw[0xce];
        const action=resource.actions.find(action=>action.index===1);
        const {raw:completed}=sourceBytes(action?.source_action_raw_hex??action?.raw_hex,0xac,'CF4完成动作');
        actor.restoredLayer=[2,3,1][completed[13]>>>4];
        if(actor.restoredLayer===undefined)throw new Error('CF4恢复绘制层模式尚未接入');
      }
      if(source){
        // 410850 draws FF first, but resets logical +22 and displayed +3C to0.
        // FF is retained native metadata, not the initial displayed frame.
        actor.ffRaw=draw()%source.count;
        actor.interval=source.interval+(behavior_raw_cf===1&&!source.fixed?draw()%(source.interval>>>1):0);
        actor.sourceLayer=source.layer;actor.restoredLayer=source.restoredLayer;actor.nativeDisplayZero=true;
        if(behavior_raw_cf===7){actor.actionIndex=0;actor.displayActionIndex=0;actor.displayFrame=0;}
      }
      this.project(actor,0);return actor;
    });
  }
  project(actor,state) {
    if(actor.behavior===7){
      const action=actor.resource.actions[actor.displayActionIndex];actor.state=state;
      actor.object.motion={main:action.main_bitmap,intrinsic:action.intrinsic_bitmap,
        width:actor.resource.frame_width,height:actor.resource.frame_height,frame:actor.displayFrame};
      return action;
    }
    // 4137C0: CF4 states 0/1 loop action0; 40CFE0 restores state3 at
    // action1's last logical frame. Never loop the collection action.
    const action=actor.resource.actions.find(action=>action.index===(actor.behavior===4&&state===3?1:0));
    if(!action)throw new Error('地图物件动作缺失');
    actor.state=state;
    if(actor.behavior===4){
      // Live 4137C0 completion hard-writes CE=1. Save load 40CFE0 instead
      // maps the completed action+0D high nibble through [2,3,1]. The scoped
      // forest resources restore layer2; retain that actual source difference.
      actor.object.layer=state===3?(actor.restoredCompleted?actor.restoredLayer:1):actor.sourceLayer;
      if(state===3)actor.frame=action.logical_frames.length-1;
    }
    actor.object.motion={main:action.main_bitmap,intrinsic:action.intrinsic_bitmap,
      width:actor.resource.frame_width,height:actor.resource.frame_height,
      frame:actor.behavior===1&&actor.nativeDisplayZero?0:action.logical_frames[actor.frame]};
    return action;
  }
  update(now,{world,paused=false}) {
    const delta=this.lastTime===null?0:Math.max(0,now-this.lastTime);this.lastTime=now;
    for(const actor of this.actors){
      const record=world.event_records?.[this.mapFlagIndex]?.[actor.object.index];
      const state=record?parseInt(record.slice(0,2),16):0;
      if(actor.behavior===7){
        if(![0,3,4].includes(state))throw new Error('CF7地图物件主动交互状态尚未恢复');
        if(!actor.loaded){
          actor.loaded=true;actor.object.layer=state===3?actor.restoredLayer:actor.sourceLayer;
          if(state===3){
            // 40CFE0: CF7 completed state starts action1 at logical0.
            actor.actionIndex=1;actor.displayActionIndex=1;actor.frame=0;
            actor.displayFrame=actor.resource.actions[1].logical_frames[0];
          }
        }
        if(paused||delta>250){actor.elapsed=0;this.project(actor,state);continue;}
        actor.elapsed+=delta;
        if(actor.elapsed>=actor.interval){
          // 4137C0 resets DD even when state0 has no animation step. For
          // states3/4 the first eligible visit only selects action1; its
          // displayed physical frame is retained until the following visit.
          actor.elapsed=0;
          if(state===3||state===4){
            if(actor.actionIndex!==1)actor.actionIndex=1;
            else{
              const action=actor.resource.actions[1];actor.frame=(actor.frame+1)%action.logical_frames.length;
              actor.displayActionIndex=1;actor.displayFrame=action.logical_frames[actor.frame];
            }
          }
        }
        this.project(actor,state);continue;
      }
      if(actor.behavior===1){
        // 40CFE0 restores completed state3 at action0's last frame on load.
        // CF1 keeps animating in that state; it has no collection transition.
        const action=actor.resource.actions[0];
        if(!actor.loaded){
          actor.frame=state===3?action.logical_frames.length-1:0;actor.loaded=true;
          actor.nativeDisplayZero=state!==3;actor.object.layer=state===3?actor.restoredLayer:actor.sourceLayer;
        }
        actor.state=state;
        // 418E60 visits the update queue even for render-hidden objects.
        // Suspend/discard only at the existing scene-clock adaptation boundary.
        if(paused||delta>250){actor.elapsed=0;this.project(actor,state);continue;}
        actor.elapsed+=delta;
        if(actor.elapsed>=actor.interval){
          // 4137C0 writes DD=now, advances once, and discards overshoot.
          actor.elapsed=0;actor.frame=(actor.frame+1)%action.logical_frames.length;actor.nativeDisplayZero=false;
        }
        this.project(actor,state);continue;
      }
      if(!actor.loaded){actor.loaded=true;actor.restoredCompleted=state===3;}
      else if(state!==3)actor.restoredCompleted=false;
      if(state!==actor.state){actor.frame=0;actor.elapsed=0;}
      if(![0,1,3].includes(state)){
        // Active collection has its own event playback; do not fabricate it.
        actor.state=state;actor.object.layer=actor.sourceLayer;actor.object.motion=null;actor.elapsed=0;continue;
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
