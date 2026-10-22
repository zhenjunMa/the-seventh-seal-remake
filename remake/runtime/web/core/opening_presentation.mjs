// Keep the recovered map border and focus offset, but follow continuous actor
// coordinates. Quantizing this moving camera to terrain cells produces a 16px
// sawtooth in the actor's screen position. A static native crop cannot establish
// that the camera scrolls in whole cells during motion.
export function openingCamera(actor, width, height) {
  const clamp=(value,low,high)=>Math.max(low,Math.min(Math.max(low,high),value));
  return {x:clamp(actor.x-16,320,width-32-320),
    y:clamp(actor.y-16,240,height-32-240)};
}

export function approachPoint(from,to,t,axisApproach=false) {
  const dx=to.x-from.x,dy=to.y-from.y;
  if(!axisApproach)return {x:from.x+dx*t,y:from.y+dy*t,dx,dy};
  const distance=(Math.abs(dx)+Math.abs(dy))*t;
  return distance<Math.abs(dx)?{x:from.x+Math.sign(dx)*distance,y:from.y,dx,dy:0}:
    {x:to.x,y:from.y+Math.sign(dy)*(distance-Math.abs(dx)),dx:dy?0:dx,dy};
}

// User-requested presentation: followers take one direct arrival instead of
// visibly traversing both source waypoints. Keep every source command/barrier
// in the VM. Only coalesce consecutive move groups separated by barriers;
// dialogue, placement, animation, waits and map changes end a group.
export function directArrivalMoves(program,staging={}) {
  const result=new Map();let mapId=null,group=[];
  const finish=()=>{
    const policy=staging[mapId]?.direct_arrivals;
    if(policy)for(const actor of policy.slots){
      const moves=group.filter(command=>command.u32_plus5===actor);
      if(moves.length<2)continue;
      for(const [index,command] of moves.entries())result.set(command.index,{
        defer:index<moves.length-1,arrivalDirection:policy.direction,
        sourceCommands:moves.map(move=>move.index)});
    }
    group=[];
  };
  for(const command of program?.commands??[]){
    if(command.opcode===33)group.push(command);
    else if(command.opcode!==31){
      finish();
      if(command.opcode===10)mapId=command.filename.slice(0,-4).toUpperCase();
    }
  }
  finish();return result;
}

// Local presentation seed, independent of the persistent world's random state.
export function particleColumns(width,seed=13) {
  let value=seed>>>0;
  const random=()=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value;};
  return Array.from({length:width},()=>({fallSpeed:(random()&6)+4,
    fallOffset:(random()&0x6f)+40,riseSpeed:-2-(random()&3)}));
}
