// Source-bound ordinary map actors. Native evidence: npc_motion_20261021.
// Coordinates exposed to views are doubled native coordinates. All timers,
// goals, paths and RNG belong to this scene, never to WorldStore or encounters.
import {createNativeRng} from './combat_rules.mjs';
import {DistanceGait,mapStepGeometry,mapMotionProfile} from './map_locomotion.mjs';
import {moveActorAgainst} from './movement.mjs';

const EXPAND=[[-1,0],[-1,-1],[-1,1],[0,-1],[0,1],[1,0],[1,-1],[1,1]];
const BACKTRACK=[[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[-1,1],[1,-1],[1,1]];
const distance=(x,y,tx,ty)=>Math.max(Math.abs(x-tx),Math.abs(y-ty));
const clamp=(x,low,high)=>Math.max(low,Math.min(high,x));
const bytes=hex=>Uint8Array.from(hex.match(/../g)??[],x=>parseInt(x,16));
const direction=(dx,dy)=>dy<0?(dx>0?2:dx<0?4:3):dy>0?(dx>0?0:dx<0?6:7):dx>0?1:5;

// 469F50 initializes all20 channels from the first DGP action whose +7E
// identifier matches. DAT +46..59 bytes are a source template, not live state.
export function nativeNpcActionBindings(role) {
  const actions=role?.actions;
  if(!Array.isArray(actions)||!actions.length)throw new Error('人物原动作表缺失');
  const ordered=[...actions].sort((a,b)=>a.index-b.index),bindings=Array(20).fill(-1);
  const seen=new Set();
  for(const [position,action]of ordered.entries()){
    if(!Number.isInteger(action.index)||action.index<0||action.index>127||seen.has(action.index)
      ||action.index!==position
      ||typeof action.raw_hex!=='string'||!/^[0-9a-f]{344}$/i.test(action.raw_hex))throw new Error('人物原动作绑定记录无效');
    seen.add(action.index);
    const channel=parseInt(action.raw_hex.slice(0x7e*2,0x7e*2+2),16);
    if(channel<20&&bindings[channel]===-1)bindings[channel]=action.index;
  }
  if(bindings[1]===-1)bindings[1]=bindings[0];
  // Original +48==FF branch writes +47 back to itself, not run=walk.
  return bindings;
}

export function decodeNpcBehavior(record) {
  if(!/^[0-9a-f]{2442}$/i.test(record?.raw_hex??''))return null;
  const raw=bytes(record.raw_hex),view=new DataView(raw.buffer),int=offset=>view.getInt32(offset,true);
  return {slot:record.slot_zero_based,type:raw[0x2c],locked:raw[0x2e]!==0,fixed:raw[0xf5]!==0,
    turnMask:raw[0xf6],bindings:Array.from(raw.slice(0x46,0x5a),x=>x===255?-1:x),raw_hex:record.raw_hex,
    speedBias:int(0x4b5),routeCount:int(0x14b),wait:raw[0xdf],waitLatch:raw[0xe0]!==0};
}

// 490DA0/491F10 flood distances and 48C070 backtrace. NPC expansion tests
// the diagonal destination, not the player's conservative corner policy.
export function npcPath({width,height,rows,triggers},start,target,{flying=false,occupied=()=>false}={}) {
  const inside=(x,y)=>x>=0&&y>=0&&x<width&&y<height;
  if(!inside(start.x,start.y)||!inside(target.x,target.y))return [];
  const triggerAt=(x,y)=>triggers?.get(y*width+x);
  const walkable=(x,y)=>inside(x,y)&&(flying||(rows[y][x]==='0'&&!triggerAt(x,y)?.path_gate));
  const count=width*height,levels=new Int32Array(count),queue=new Int32Array(count);
  const startIndex=start.y*width+start.x,targetIndex=target.y*width+target.x;
  levels[startIndex]=1;queue[0]=startIndex;let head=0,tail=1,best=startIndex,bestDistance=distance(start.x,start.y,target.x,target.y);
  while(head<tail&&!levels[targetIndex]){
    const index=queue[head++],x=index%width,y=Math.floor(index/width),d=distance(x,y,target.x,target.y);
    // Native nearest fallback excludes the adjacent ring and replaces ties.
    if(d>1&&d<=bestDistance){best=index;bestDistance=d;}
    for(const [dx,dy] of EXPAND){
      const nx=x+dx,ny=y+dy,at=ny*width+nx;
      if(!walkable(nx,ny)||levels[at])continue;
      levels[at]=levels[index]+1;queue[tail++]=at;
    }
  }
  let end=levels[targetIndex]&&!occupied(target.x,target.y)?targetIndex:best;
  if(end===startIndex)return [];
  const reverse=[];
  while(end!==startIndex&&reverse.length<5000){
    const x=end%width,y=Math.floor(end/width);reverse.push({x,y});let previous=-1;
    for(const [dx,dy] of BACKTRACK){const nx=x+dx,ny=y+dy;
      if(inside(nx,ny)&&levels[ny*width+nx]===levels[end]-1){previous=ny*width+nx;break;}}
    if(previous<0)return [];end=previous;
  }
  return end===startIndex?reverse.reverse():[];
}

export class MapNpcRuntime {
  constructor({scene,table,roles,random=null}) {
    Object.assign(this,{scene,roles,actors:new Map(),held:new Set(),lastTime:null});
    this.rng=createNativeRng((Date.now()^Math.floor(Math.random()*0xffffffff))>>>0);
    this.random=random??(()=>this.rng.next());
    const movement=scene.data.movement;
    const geometry=mapStepGeometry(movement,table?.header_raw_hex);
    this.cellSize=geometry.cellSize;this.coordinateShift=geometry.coordinateShift;
    this.stepSize=geometry.stepSize;this.movement=movement;
    this.cellTicks=this.cellSize/this.stepSize;
    const sources=new Map((table?.npc_records??[]).map(row=>[row.slot_zero_based,row]));
    for(const npc of scene.npcs){
      let source=decodeNpcBehavior(sources.get(npc.slot_zero_based));const role=roles?.[npc.resource_id];
      if(!source||!role)continue;
      source={...source,bindings_raw:[...source.bindings],bindings:nativeNpcActionBindings(role),bindings_initialized:true};
      const idle=role.actions.find(action=>action.index===source.bindings[0]);
      if(!idle)throw new Error('人物缺少源初始化待机动作');
      const a={npc,source,role,home:{x:npc.x,y:npc.y},goal:{x:npc.x,y:npc.y},path:[],step:null,
        wait:source.wait,waitLatch:source.waitLatch,logicalFrame:0,action:idle.index,interval:80,
        elapsed:0,animationCountdown:0,contactBlocked:false,
        visual:{x:npc.x,y:npc.y,direction:npc.direction},gait:new DistanceGait()};
      this.actors.set(npc.id,a);this.project(a);
    }
  }
  action(a,channel){return a.role.actions.find(action=>action.index===a.source.bindings[channel]);}
  logicalCount(action){return action.logical_count??(action.uses_sequence?action.sequence_length_raw:action.frame_count);}
  setAction(a,channel){
    const action=this.action(a,channel)??this.action(a,0)??a.role.actions[0];
    if(a.action!==action.index){a.action=action.index;a.logicalFrame=0;}
    return action;
  }
  project(a,delta=0,player=null){
    const action=a.role.actions.find(action=>action.index===a.action),count=this.logicalCount(action);
    a.logicalFrame=((a.logicalFrame%count)+count)%count;
    const walk=this.action(a,1),motion=walk?mapMotionProfile(walk,this.movement,'',a.source.speedBias):null;
    const dx=a.npc.x-a.visual.x,dy=a.npc.y-a.visual.y;
    // Smooth only accepted logical travel, at the source per-axis speed.
    // Source occupancy/RNG retain the logical route. The accepted visual
    // ground path is swept against the player and used for both colliders.
    const travel=Math.max(Math.abs(dx),Math.abs(dy));
    const amount=this.held.has(a.npc.id)?0:Math.min(1,travel&&motion?motion.speed*delta/1000/travel:0);
    const accepted=moveActorAgainst(a.visual.x,a.visual.y,dx*amount,dy*amount,
      player?this.scene.movement.actorObstacles([player]):[]);
    const movedX=accepted.x-a.visual.x,movedY=accepted.y-a.visual.y;
    a.visual.x=accepted.x;a.visual.y=accepted.y;
    if(delta>0)a.contactBlocked=accepted.blocked;
    if(movedX||movedY)a.visual.direction=direction(movedX,movedY);
    const walking=walk&&!this.held.has(a.npc.id)&&(movedX||movedY||a.action===walk.index&&!a.contactBlocked);
    const display=walking?walk:a.contactBlocked?this.action(a,0):action;
    const frame=walking?a.gait.advance(walk,{dx:movedX,dy:movedY,stride:motion.stride})
      :display.uses_sequence?display.sequence_raw[a.logicalFrame%this.logicalCount(display)]:a.logicalFrame%this.logicalCount(display);
    if(!walking){a.gait.reset();a.visual.direction=a.npc.direction;}
    a.npc.motion={role:a.role,action:display.index,frame,...a.visual};
  }
  idle(a){const action=this.setAction(a,0);a.interval=Math.max(1,action.interval_raw);
    a.logicalFrame=(a.logicalFrame+1)%this.logicalCount(action);}
  animateWalk(a){const action=this.setAction(a,1);
    // 46B690 sets action cadence; 46CED0 scales it for movement/cell size.
    a.interval=mapMotionProfile(action,{native_coordinate_shift:this.coordinateShift},'',a.source.speedBias).tickMs;
    a.logicalFrame=(a.logicalFrame+1)%this.logicalCount(action);a.animationCountdown=2;}
  canWander(a){return a.source.slot>=10&&!a.source.fixed&&!a.source.locked&&a.source.type<=1
    &&a.source.routeCount===0&&Boolean(this.action(a,1));}
  occupied(x,y,except,player){
    if(player&&Math.floor(player.x/this.cellSize)===x&&Math.floor(player.y/this.cellSize)===y)return true;
    for(const a of this.actors.values()){
      if(a===except||a.npc.hidden||!this.visible(a.npc))continue;
      if(Math.floor(a.npc.x/this.cellSize)===x&&Math.floor(a.npc.y/this.cellSize)===y)return true;
      if(a.step&&a.step.cell.x===x&&a.step.cell.y===y)return true;
    }
    return false;
  }
  chooseGoal(a){
    // 47F780: this is a bitwise &10, not rand()%10.
    if(!a.waitLatch&&a.wait===0&&this.random()%5>2){a.wait=(this.random()&10)+10;a.waitLatch=true;return false;}
    a.waitLatch=false;
    const sx=(this.random()&15)>7?1:-1,sy=(this.random()&15)>7?1:-1;
    const x=Math.floor(a.home.x/this.cellSize)+(this.random()%20)*sx;
    const y=Math.floor(a.home.y/this.cellSize)+(this.random()%20)*sy;
    a.goal={x:clamp(x,0,this.scene.movement.width-1)*this.cellSize,
      y:clamp(y,0,this.scene.movement.height-1)*this.cellSize};return true;
  }
  tick(a,player){
    if(this.held.has(a.npc.id)){this.idle(a);return;}
    if(!this.canWander(a)){this.idle(a);return;}
    if(a.wait>0){a.wait--;this.idle(a);return;}
    if(a.step){
      a.npc.x+=a.step.dx;a.npc.y+=a.step.dy;a.step.left--;
      if(--a.animationCountdown===0)this.animateWalk(a);
      if(!a.step.left){a.npc.x=a.step.x;a.npc.y=a.step.y;a.step=null;}
      return;
    }
    if(!a.path.length){
      this.chooseGoal(a);
      if(a.wait){this.idle(a);return;}
      const start={x:Math.floor(a.npc.x/this.cellSize),y:Math.floor(a.npc.y/this.cellSize)};
      const target={x:Math.floor(a.goal.x/this.cellSize),y:Math.floor(a.goal.y/this.cellSize)};
      a.path=npcPath(this.scene.movement,start,target,{flying:a.source.type===1,
        occupied:(x,y)=>a.source.type!==1&&this.occupied(x,y,a,player)});
      if(!a.path.length){a.goal={x:a.npc.x,y:a.npc.y};this.idle(a);return;}
      // 494DD0 builds/reverses the path on one tick, starts moving next tick.
      return;
    }
    const cell=a.path.shift();
    if(a.source.type!==1&&this.occupied(cell.x,cell.y,a,player)){
      // Replan around live occupancy (493B70) without crossing another actor.
      const start={x:Math.floor(a.npc.x/this.cellSize),y:Math.floor(a.npc.y/this.cellSize)};
      const target={x:Math.floor(a.goal.x/this.cellSize),y:Math.floor(a.goal.y/this.cellSize)};
      const rows=this.scene.movement.rows.map((row,y)=>Array.from(row,(value,x)=>
        this.occupied(x,y,a,player)&&!(x===start.x&&y===start.y)?'1':value).join(''));
      a.path=npcPath({...this.scene.movement,rows},start,target);
      this.idle(a);return;
    }
    const dx=Math.sign(cell.x-Math.floor(a.npc.x/this.cellSize)),dy=Math.sign(cell.y-Math.floor(a.npc.y/this.cellSize));
    a.npc.direction=direction(dx,dy);
    a.step={cell,dx:dx*this.stepSize,dy:dy*this.stepSize,left:this.cellTicks-1,
      x:a.npc.x+dx*this.cellSize,y:a.npc.y+dy*this.cellSize};
    a.npc.x+=a.step.dx;a.npc.y+=a.step.dy;this.animateWalk(a);
    if(!a.step.left)a.step=null;
  }
  update(now,{player=null,visible=npc=>!npc.hidden,paused=false}={}){
    this.visible=visible;
    const delta=this.lastTime===null?0:Math.max(0,now-this.lastTime);this.lastTime=now;
    if(paused||delta>250){for(const a of this.actors.values())a.elapsed=0;return;}
    for(const a of this.actors.values()){
      if(!visible(a.npc)){a.elapsed=0;continue;}
      // A body waiting at contact must not accumulate a route backlog. Keep
      // its current goal/step and retry the continuous path every display frame.
      a.elapsed=a.contactBlocked?0:a.elapsed+delta;
      // Run the native actor clock independently of the display RAF rate.
      // Long suspension was discarded above; bounded normal frame deltas can
      // contain multiple 10ms visits without changing source step sizes.
      let visits=0;
      while(a.elapsed>=a.interval&&visits++<32){a.elapsed-=a.interval;this.tick(a,player);}
      this.project(a,delta,player);
    }
  }
  hold(id){
    const a=this.actors.get(id);if(!a)return ()=>{};
    this.held.add(id);a.path=[];a.step=null;a.goal={x:a.npc.x,y:a.npc.y};a.elapsed=0;
    this.setAction(a,0);this.project(a);
    return ()=>{this.held.delete(id);a.elapsed=0;};
  }
  inherit(other){
    if(!other)return;
    this.rng=createNativeRng(other.rng.state);
    for(const [id,a] of this.actors){const previous=other.actors.get(id);if(!previous)continue;
      for(const key of ['home','goal','path','step'])a[key]=structuredClone(previous[key]);
      for(const key of ['wait','waitLatch','logicalFrame','action','interval','elapsed','animationCountdown','contactBlocked'])a[key]=previous[key];
      for(const key of ['x','y','direction','hidden'])a.npc[key]=previous.npc[key];
      a.visual={...previous.visual};Object.assign(a.gait,previous.gait);this.project(a);
    }
  }
  adoptActors(actors){
    for(const a of this.actors.values()){
      const actor=actors.get(a.source.slot);if(!actor)continue;
      a.npc.x=actor.x;a.npc.y=actor.y;a.npc.direction=actor.direction;a.npc.hidden=!actor.visible;
      a.goal={x:actor.x,y:actor.y};a.path=[];a.step=null;a.elapsed=0;a.contactBlocked=false;
      a.action=actor.action;
      const action=a.role.actions.find(action=>action.index===a.action);
      a.logicalFrame=action?.uses_sequence?Math.max(0,action.sequence_raw.indexOf(actor.frame)):actor.frame;
      a.visual={x:actor.x,y:actor.y,direction:actor.direction};a.gait.reset();
      if(a.action===this.action(a,1)?.index)Object.assign(a.gait,{action:a.action,phase:a.logicalFrame/this.logicalCount(action)});
      this.project(a);
    }
    this.lastTime=null;
  }
  snapshot(){return [...this.actors.values()].map(a=>({id:a.npc.id,slot:a.source.slot,
    x:a.npc.x,y:a.npc.y,direction:a.npc.direction,hidden:a.npc.hidden,action:a.action,frame:a.npc.motion.frame,
    fixed:a.source.fixed,wait:a.wait,goal:{...a.goal}}));}
}
