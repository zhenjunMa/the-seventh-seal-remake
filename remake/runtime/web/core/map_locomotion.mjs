import {locomotion} from './movement.mjs';

// Native 46CED0 scales the movement visit interval, not the final atlas frame
// period. Keyboard motion stays continuous; gait phase follows accepted travel.
export function mapStepGeometry(movement={},headerRawHex='') {
  const sourceStep=/^[0-9a-f]+$/i.test(headerRawHex)&&headerRawHex.length>0x144*2+1
    ?parseInt(headerRawHex.slice(0x144*2,0x144*2+2),16):1;
  const coordinateShift=movement.native_coordinate_shift??3;
  const stepShift=movement.native_step_shift??sourceStep;
  const stepSize=2**stepShift*(movement.native_to_pixel_scale??2);
  return {coordinateShift,stepSize,cellSize:movement.cell_size??16};
}

export function mapMotionProfile(action,movement,headerRawHex='',speedBias=0) {
  const geometry=mapStepGeometry(movement,headerRawHex);
  const sourceInterval=action.interval_raw??action.interval_ms_preview;
  if(!Number.isFinite(sourceInterval)||sourceInterval<=0)throw new Error('移动动作缺少源节拍');
  const tickMs=Math.max(10,((sourceInterval-speedBias)>>3)-24+geometry.coordinateShift*8);
  // 4984E0 decrements BEFORE testing zero: walking changes pose every two
  // visits; the running channel uses three. Keep distance across cell turns.
  const gaitVisits=action.index===2?3:2;
  return {...geometry,tickMs,speed:geometry.stepSize*1000/tickMs,stride:geometry.stepSize*gaitVisits};
}

// Native movement visits advance both axes together. Axis-staged routes have
// two consecutive legs; direct routes retain their accepted straight path.
export function mapTravelDistance(from,to,axisApproach=false) {
  const dx=Math.abs(to.x-from.x),dy=Math.abs(to.y-from.y);
  return axisApproach?dx+dy:Math.max(dx,dy);
}

function logicalCount(action) {
  const count=action.logical_count??(action.uses_sequence
    ?action.sequence_length_raw??action.sequence_raw?.length
    :action.frames_per_direction??action.frame_count);
  if(!Number.isInteger(count)||count<1)throw new Error('地图动作帧数无效');
  return count;
}

// This state is presentation-only: it never enters saves, encounter counters or
// actor inventories. Direction changes and walk/run switches preserve gait phase.
export class DistanceGait {
  constructor(){this.reset();}
  reset(){this.action=0;this.phase=0;this.elapsed=0;}
  advance(action,{dx=0,dy=0,elapsedMs=0,stride=1,inPlaceSpeed=0}={}) {
    const count=logicalCount(action),moving=action.index!==0;
    if(this.action!==action.index){
      if(!moving||this.action===0)this.phase=0;
      this.elapsed=0;this.action=action.index;
    }
    if(moving){
      // Native diagonal steps change both axes by stepSize. The controller
      // normalizes speed; using per-axis travel also scales diagonal gait.
      const travel=Math.max(Math.abs(dx),Math.abs(dy))||Math.max(0,inPlaceSpeed)*Math.max(0,elapsedMs)/1000;
      this.phase+=travel/(stride*count);
    }else {
      const interval=Math.max(20,action.interval_raw??action.interval_ms_preview??180);
      this.elapsed+=Math.max(0,elapsedMs);
      const frames=Math.floor(this.elapsed/interval);
      this.phase+=frames/count;this.elapsed-=frames*interval;
    }
    this.phase=((this.phase%1)+1)%1;
    const logical=Math.floor(this.phase*count+1e-9)%count;
    return action.uses_sequence?action.sequence_raw[logical]:logical;
  }
}

// The initial body impact and gait-driven ground recoil are presentation only.
// Track normals rather than tiles so wall seams cannot restart the impact.
// The ground recoil carries the shadow and follow camera, then settles on release.
export class CollisionFeedback {
  constructor(){this.reset();}
  reset(){this.contacts=new Set();this.time=0;this.lastImpact=new Map();this.pulses=[];this.step={x:0,y:0};}
  advance(result,{dx=0,dy=0,running=false,elapsedMs=0,blocked=false,stepSize=0,stridePhase=0}={}){
    const dt=Math.max(0,elapsedMs);this.time+=dt;
    const contacts=new Map();
    for(const hit of dx||dy?result?.contacts??[]:[]){
      if(hit.nx)contacts.set(`${hit.nx},0`,{x:hit.nx,y:0});
      if(hit.ny)contacts.set(`0,${hit.ny}`,{x:0,y:hit.ny});
    }
    let nx=0,ny=0;
    for(const [key,normal]of contacts){
      if(this.contacts.has(key)||this.time-(this.lastImpact.get(key)??-Infinity)<220)continue;
      nx+=normal.x;ny+=normal.y;this.lastImpact.set(key,this.time);
    }
    if(nx||ny){const length=Math.hypot(nx,ny),approach=Math.max(0,-dx*nx-dy*ny)/(Math.hypot(dx,dy)*length||1);
      this.pulses.push({x:nx/length,y:ny/length,amplitude:(running?2.5:1)*approach,age:0});}
    this.contacts=new Set(contacts.keys());
    let x=0,y=0;
    for(const pulse of this.pulses){pulse.age+=dt;
      const amount=pulse.amplitude*Math.sin(Math.min(1,pulse.age/160)*Math.PI);
      x+=pulse.x*amount;y+=pulse.y*amount;}
    this.pulses=this.pulses.filter(pulse=>pulse.age<160);
    for(const [key,time]of this.lastImpact)if(this.time-time>=220)this.lastImpact.delete(key);
    let normalX=0,normalY=0;
    if(blocked)for(const normal of contacts.values()){normalX+=normal.x;normalY+=normal.y;}
    const length=Math.hypot(normalX,normalY)||1;
    const recoil=stepSize*(1-Math.cos(stridePhase*Math.PI))/2;
    const blend=1-Math.exp(-dt/24);
    this.step.x+=(normalX/length*recoil-this.step.x)*blend;
    this.step.y+=(normalY/length*recoil-this.step.y)*blend;
    const scale=Math.min(1,2.5/(Math.hypot(x,y)||1));
    return {x:x*scale,y:y*scale,step:{...this.step}};
  }
}

// Shared exploration presentation for the formal controller and asset-free
// preview. Blocked stepping retains the chosen walk/run cadence. Only accepted
// world travel contributes encounter distance; recoil stays in presentation.
export class MapLocomotion {
  constructor(){this.gait=new DistanceGait();this.feedback=new CollisionFeedback();}
  get action(){return this.gait.action;}
  reset(){this.gait.reset();this.feedback.reset();}
  advance(result,{from,dx=0,dy=0,running=false,elapsedMs=0,role,movement,headerRawHex=''}={}){
    const travelX=result?result.x-from.x:0,travelY=result?result.y-from.y:0;
    const moving=Math.hypot(travelX,travelY)>1e-4,blocked=Boolean((dx||dy)&&result?.blocked&&!moving);
    const choice=locomotion({dx:moving?(Math.abs(travelX)>1e-4?travelX:0):dx,
      dy:moving?(Math.abs(travelY)>1e-4?travelY:0):dy,running},moving||blocked);
    const action=role.actions.find(action=>action.index===choice.action);
    const profile=choice.action?mapMotionProfile(action,movement,headerRawHex):null;
    const frame=this.gait.advance(action,{dx:travelX,dy:travelY,elapsedMs,stride:profile?.stride,
      inPlaceSpeed:blocked?profile.speed:0});
    return {...choice,frame,blocked,elapsed:this.gait.elapsed,
      feedback:this.feedback.advance(result,{dx,dy,running,elapsedMs,blocked,
        stepSize:profile?.stepSize,stridePhase:this.gait.phase*logicalCount(action)})};
  }
}
// Older route assets retain their original exporter. The verified story table
// already carries the complete DAT header; recover its two movement bytes
// without rebuilding pixels, modifying the asset file, or guessing a default.
export function nativeMapMovement(movement,table,programs={}){
  if(!table)return movement;
  const source=table.map_source,header=table.header_raw_hex;
  if(source?.sha256!==movement.source_sha256||source.path?.toLowerCase()!==movement.source?.toLowerCase()
    ||typeof header!=='string'||!/^(?:[a-f0-9]{2}){370}$/i.test(header))throw new Error('地图移动头与来源不一致');
  const result={...movement};
  for(const [key,offset]of [['native_step_shift',0x144],['native_camera_step_shift',0x145]]){
    const value=Number.parseInt(header.slice(offset*2,offset*2+2),16);
    if(value>30||movement[key]!==undefined&&movement[key]!==value)throw new Error('地图移动步长与来源不一致');
    result[key]=value;
  }
  // 4A5110 selects source markers without checking terrain. Continuous
  // movement may leave such a landing cell, but ordinary paths cannot enter it.
  const cells=new Map();
  for(const markers of Object.values(table.entry_markers??{}))for(const cell of markers){
    if(!Number.isInteger(cell.x)||!Number.isInteger(cell.y)||cell.x<0||cell.y<0
      ||cell.x>=movement.width||cell.y>=movement.height
      ||cell.offset!==0x172+(cell.y*movement.width+cell.x)*64)throw new Error('地图原入口格与来源不一致');
    if(movement.terrain_rows[cell.y][cell.x]==='1')cells.set(`${cell.x},${cell.y}`,{x:cell.x,y:cell.y});
  }
  // 473E30 case23 places actors directly, without a terrain test; case1E
  // restores control without changing that position. Programs have already
  // passed the story boundary's source validation. Keep their placed cells
  // eligible for entry/restore and escape, while ordinary movement stays shut.
  for(const program of Object.values(programs)){
    const callers=program.expected?.caller_maps??[program.expected?.control_map];
    let activeMap=callers.includes(table.id)?table.id:null;
    for(const command of program.commands){
      if(command.opcode===10)activeMap=command.filename.slice(0,-4).toUpperCase();
      if(activeMap!==table.id||command.opcode!==35||command.u32_plus1!==0||command.u32_plus5>=10)continue;
      const nativeX=command.u32_plus13|0,nativeY=command.u32_plus17|0;
      if(nativeX===-1||nativeY===-1)continue;
      const x=Math.floor(nativeX*2/movement.cell_size),y=Math.floor(nativeY*2/movement.cell_size);
      if(movement.terrain_rows[y]?.[x]==='1')cells.set(`${x},${y}`,{x,y});
    }
  }
  if(cells.size)result.native_entry_cells=[...cells.values()];
  return result;
}
