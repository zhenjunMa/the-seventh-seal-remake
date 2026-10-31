// Presentation clocks for source ordinary objects. Triggering/collecting an
// object remains an event transaction, never an animation side effect.
import {createNativeRng} from './combat_rules.mjs';

function sourceBytes(hex,size,label){
  if(typeof hex!=='string'||!new RegExp(`^[0-9a-f]{${size*2}}$`,'i').test(hex))throw new Error(`${label}原始记录缺失`);
  const raw=Uint8Array.from(hex.match(/../g),value=>parseInt(value,16));return {raw,view:new DataView(raw.buffer)};
}
function cf1Source(row){
  const {resource}=row,{raw,view}=sourceBytes(row.source_record_raw_hex,0x112,'地图物件');
  if(raw[0xcf]!==1||raw[0xb4]!==row.fixed_clock_raw_b4
    ||view.getUint32(0x3c,true)!==row.initial_frame_raw)throw new Error('CF1地图物件源字段不匹配');
  if(resource.actions?.length!==1)throw new Error('CF1地图物件多动作尚未恢复');
  const action=resource.actions[0],{raw:a,view:v}=sourceBytes(action.source_action_raw_hex,0xac,'地图物件动作');
  const count=v.getUint32(0x0e,true),interval=v.getUint32(1,true),first=v.getUint32(0x72,true);
  const sound=String.fromCharCode(...a.slice(0x56,0x6a)).split('\0')[0];
  const explicit=(a[13]&15)===0,logicalCount=explicit?v.getUint32(0x12,true):count;
  if(a[0]!==0||![0,1].includes(a[13]&15)||(a[13]>>>4)>2||count<1||count>255||first!==0||action.index!==0||action.directions!==1
    ||action.frame_count!==count||action.interval_raw!==interval||action.first_frame!==first
    ||logicalCount<1||(explicit&&logicalCount>0x5c)
    ||action.logical_frames?.length!==logicalCount
    ||action.logical_frames.some((frame,i)=>frame!==(explicit?a[0x16+i]:i)||frame>=count)
    ||(sound&&!/^[A-Za-z0-9_-]+\.wav$/i.test(sound))||a[0x84]||interval===1||interval>0x7fffffff)
    throw new Error('CF1地图物件动作/时钟模式尚未恢复');
  return {count:logicalCount,interval:interval||120,fixed:raw[0xb4]!==0,layer:raw[0xce],restoredLayer:[2,3,1][a[13]>>>4],interactionRecord:view.getUint32(0xf6,true),
    sound:{token:sound,enabled:view.getUint32(0x9e,true)!==0,frame:v.getUint32(0x6a,true),x:view.getInt32(0x26,true),y:view.getInt32(0x2a,true)}};
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
  return {count:parsed[0].count,interval:parsed[0].interval,fixed:raw[0xb4]!==0,layer:raw[0xce],restoredLayer:parsed[1].restoredLayer};
}
function activeObjectSource(row){
  const {resource}=row,{raw,view}=sourceBytes(row.source_record_raw_hex,0x112,'机关物件');
  const behavior=raw[0xcf];
  if(![2,9].includes(behavior)||resource.actions?.length!==(behavior===9?3:1))throw new Error('机关物件源动作数量未恢复');
  const actions=resource.actions.map((action,index)=>{
    const {raw:a,view:v}=sourceBytes(action.source_action_raw_hex,0xac,'机关动作');
    const explicit=(a[13]&15)===0,count=v.getUint32(explicit?0x12:0x0e,true);
    if(action.index!==index||a[0]!==0||![0,1].includes(a[13]&15)||(a[13]>>>4)>2||action.directions!==1
      ||count<1||action.logical_frames?.length!==count||action.first_frame!==v.getUint32(0x72,true)
      ||action.interval_raw!==v.getUint32(1,true)||action.interval_raw<1
      ||action.logical_frames.some((frame,i)=>frame!==(explicit?a[0x16+i]:i)||frame>=action.frame_count)
      ||a.slice(0x56,0x6a).some(Boolean)||a[0x84]||view.getUint32(0x9e+index*4,true)!==0)
      throw new Error('机关物件动作或声音模式未恢复');
    return {count,interval:action.interval_raw,restoredLayer:[2,3,1][a[13]>>>4]};
  });
  return {...actions[0],layer:raw[0xce],restoredLayer:actions.at(-1).restoredLayer,fixed:raw[0xb4]!==0};
}

export class MapObjectRuntime {
  constructor({objects,resources,mapFlagIndex,mapId=null,movement=null,random=null,onSound=null}) {
    this.mapFlagIndex=mapFlagIndex;this.mapId=mapId;this.lastTime=null;
    this.onSound=onSound;this.movement=movement;
    // Scene-local visual CRT, like MapNpcRuntime. The original complete global
    // CRT stream has not been observed; never consume WorldStore/encounter RNG.
    this.rng=createNativeRng((Date.now()^Math.floor(Math.random()*0xffffffff))>>>0);
    this.random=random??(()=>this.rng.next());
    const draw=()=>{const value=this.random();if(!Number.isInteger(value)||value<0||value>32767)throw new Error('地图物件CRT随机值无效');return value;};
    const rows=[...resources].sort((a,b)=>a.index-b.index);
    if(new Set(rows.map(row=>row.index)).size!==rows.length)throw new Error('地图物件索引重复');
    this.actors=rows.map(row=>{
      const {index,resource,behavior_raw_cf}=row;
      if(![1,2,4,7,9].includes(behavior_raw_cf))throw new Error('地图物件待机类型尚未恢复');
      const source=behavior_raw_cf===1?cf1Source(row):behavior_raw_cf===7?cf7Source(row):[2,9].includes(behavior_raw_cf)?activeObjectSource(row):null;
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
        if(behavior_raw_cf===1){actor.interactionRecord=source.interactionRecord;actor.sound=source.sound;}
        if(behavior_raw_cf===7){actor.actionIndex=0;actor.displayActionIndex=0;actor.displayFrame=0;actor.fixed=source.fixed;}
        if([2,9].includes(behavior_raw_cf)){actor.actionIndex=0;actor.displayActionIndex=0;actor.displayFrame=0;}
      }
      this.project(actor,0);return actor;
    });
    this.draw=draw;
  }
  animate({objectIndex,state,signal}){
    const actor=this.actors.find(actor=>actor.object.index===objectIndex);
    if(![2,7,9].includes(actor?.behavior)||![2,5].includes(state)||actor.behavior===9&&state===5)throw new Error('剧情物件主动类型尚未恢复');
    if(actor.pending)throw new Error('剧情物件上一个动作尚未结束');
    if(signal?.aborted)return Promise.reject(signal.reason);
    // 40C5C0 starts action0 at logical0; closing CF7 restores action0's
    // last logical cursor, leaving its displayed image until the next tick.
    const before={commandState:actor.commandState,actionIndex:actor.actionIndex,displayActionIndex:actor.displayActionIndex,
      displayFrame:actor.displayFrame,frame:actor.frame,state:actor.state,elapsed:actor.elapsed,interval:actor.interval};
    const terrainBefore=actor.resource.terrain_frames&&this.movement?[...this.movement.rows]:null;
    actor.commandState=state;actor.actionIndex=actor.behavior===9?1:0;
    actor.frame=state===2?0:actor.resource.actions[0].logical_frames.length-1;
    if(state===2){actor.displayActionIndex=actor.actionIndex;actor.displayFrame=actor.resource.actions[actor.actionIndex].logical_frames[0];}
    this.project(actor,state);
    return new Promise((resolve,reject)=>{
      const abort=()=>{
        signal.removeEventListener('abort',abort);actor.pending=null;Object.assign(actor,before);
        if(terrainBefore)this.movement.rows=terrainBefore;
        this.project(actor,before.state);reject(signal.reason);
      };
      signal?.addEventListener('abort',abort,{once:true});
      actor.pending=()=>{signal?.removeEventListener('abort',abort);actor.pending=null;resolve();};
    });
  }
  project(actor,state) {
    if([2,7,9].includes(actor.behavior)){
      const action=actor.resource.actions[actor.displayActionIndex];actor.state=state;
      actor.object.motion={main:action.main_bitmap,intrinsic:action.intrinsic_bitmap,shadow:action.shadow_bitmap,
        width:actor.resource.frame_width,height:actor.resource.frame_height,frame:actor.displayFrame};
      // 411420 writes nonzero DGP volume cells into DAT terrain. Raw2 clears
      // a cell; raw0 leaves it untouched. Positions are the exported DAT grid.
      if(this.movement&&actor.resource.terrain_frames){
        const physical=action.first_frame+actor.displayFrame;
        for(const [dx,dy,raw]of actor.resource.terrain_frames[physical]){
          const x=actor.object.cell_x+dx,y=actor.object.cell_y+dy,row=this.movement.rows[y];
          this.movement.rows[y]=row.slice(0,x)+(raw===2?'0':'1')+row.slice(x+1);
        }
      }
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
    actor.object.motion={main:action.main_bitmap,intrinsic:action.intrinsic_bitmap,shadow:action.shadow_bitmap,
      width:actor.resource.frame_width,height:actor.resource.frame_height,
      frame:actor.behavior===1&&actor.nativeDisplayZero?0:action.logical_frames[actor.frame]};
    return action;
  }
  update(now,{world,paused=false}) {
    const delta=this.lastTime===null?0:Math.max(0,now-this.lastTime);this.lastTime=now;
    for(const actor of this.actors){
      const record=world.event_records?.[this.mapFlagIndex]?.[actor.object.index];
      const state=actor.commandState??(record?parseInt(record.slice(0,2),16):0);
      if([2,9].includes(actor.behavior)){
        if(![0,2,3,5].includes(state)||[2,5].includes(state)&&!actor.pending)throw new Error('机关物件主动状态缺少剧情时钟');
        if(!actor.loaded){
          actor.loaded=true;actor.object.layer=state===3?actor.restoredLayer:actor.sourceLayer;
          actor.actionIndex=state===3&&actor.behavior===9?2:0;
          actor.frame=state===3&&actor.behavior===2?actor.resource.actions[0].logical_frames.length-1:0;
          actor.displayActionIndex=actor.actionIndex;actor.displayFrame=actor.resource.actions[actor.actionIndex].logical_frames[actor.frame];
        }
        if(paused||delta>250){actor.elapsed=0;this.project(actor,state);continue;}
        actor.elapsed+=delta;
        if(actor.elapsed>=actor.interval){
          actor.elapsed=0;
          if(state===2||state===5){
            const action=actor.resource.actions[actor.actionIndex],done=state===2?actor.frame===action.logical_frames.length-1:actor.frame===0;
            if(done){actor.commandState=state===2?3:0;actor.object.layer=state===2?actor.restoredLayer:actor.sourceLayer;actor.pending();}
            else actor.frame+=state===2?1:-1;
            actor.displayActionIndex=actor.actionIndex;actor.displayFrame=action.logical_frames[actor.frame];
          }else if(actor.behavior===9){
            const index=state===3?2:0,action=actor.resource.actions[index];
            // 4137C0 selects action2 and advances logical1, but computes that
            // first displayed frame with the previous action's bank pointer.
            const display=actor.actionIndex;
            if(display!==index){actor.actionIndex=index;actor.frame=0;}
            actor.frame=(actor.frame+1)%action.logical_frames.length;
            actor.displayActionIndex=display;actor.displayFrame=actor.resource.actions[display].logical_frames[actor.frame];
          }
        }
        this.project(actor,state);continue;
      }
      if(actor.behavior===7){
        if(![0,3,4].includes(state)&&!actor.pending)throw new Error('CF7地图物件主动交互状态尚未恢复');
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
          if(state===2||state===5){
            const action=actor.resource.actions[0],complete=state===2?actor.frame===action.logical_frames.length-1:actor.frame===0;
            if(complete){
              actor.commandState=state===2?3:0;
              if(state===2){actor.interval=action.interval_raw+(actor.fixed?0:this.draw()%((action.interval_raw>>>4)+1));actor.actionIndex=1;}
              actor.pending();
            }else actor.frame+=state===2?1:-1;
            actor.displayActionIndex=0;actor.displayFrame=action.logical_frames[actor.frame];
          }else if(state===3||state===4){
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
        // F6 does not run automatically in state0. Its state1 TLK dispatch
        // belongs to an explicit object interaction, outside this idle adapter.
        if(actor.interactionRecord&&state!==0)throw new Error('CF1地图物件主动交互状态尚未恢复');
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
          // 417C49 gates by DAT+9E, then compares the logical cursor to
          // DGP+6A. An unused DGP filename alone must never make a sound.
          if(actor.sound.enabled&&actor.frame===actor.sound.frame)this.onSound?.({mapId:this.mapId,objectIndex:actor.object.index,...actor.sound});
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
