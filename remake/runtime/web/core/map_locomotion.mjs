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
  advance(action,{dx=0,dy=0,elapsedMs=0,stride=1}={}) {
    const count=logicalCount(action),moving=action.index!==0;
    if(this.action!==action.index){
      if(!moving||this.action===0)this.phase=0;
      this.elapsed=0;this.action=action.index;
    }
    if(moving){
      // Native diagonal steps change both axes by stepSize. The controller
      // normalizes speed; using per-axis travel also scales diagonal gait.
      this.phase+=Math.max(Math.abs(dx),Math.abs(dy))/(stride*count);
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

// Contact feedback has no world displacement or independent render clock.
// Hold a contact until it is released, so RAF frequency / tile seams cannot
// repeatedly restart the recoil while the player keeps pressing a wall.
export class CollisionFeedback {
  constructor(){this.reset();}
  reset(){this.contact=false;this.age=Infinity;this.cooldown=0;this.normal={x:0,y:0};this.amplitude=0;}
  advance(result,{dx=0,dy=0,running=false,elapsedMs=0}={}){
    const dt=Math.max(0,elapsedMs);this.age+=dt;this.cooldown=Math.max(0,this.cooldown-dt);
    const hits=result?.contacts??[],contact=hits.length>0&&(dx!==0||dy!==0);
    if(contact&&!this.contact&&!this.cooldown){
      const x=hits[0].nx,y=hits[0].ny,length=Math.hypot(x,y)||1;
      this.normal={x:x/length,y:y/length};this.amplitude=running?2.5:1;
      this.age=0;this.cooldown=220;
    }
    this.contact=contact;
    if(!dx&&!dy){this.age=Infinity;this.amplitude=0;}
    const phase=Math.min(1,this.age/160),amount=this.amplitude*Math.sin(phase*Math.PI);
    return {x:this.normal.x*amount,y:this.normal.y*amount};
  }
}
// Older route assets retain their original exporter. The verified story table
// already carries the complete DAT header; recover its two movement bytes
// without rebuilding pixels, modifying the asset file, or guessing a default.
export function nativeMapMovement(movement,table){
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
  if(cells.size)result.native_entry_cells=[...cells.values()];
  return result;
}
