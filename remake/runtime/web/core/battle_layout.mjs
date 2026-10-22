// Native UI uses a 640x480 plane. Keep hit testing, sprites and HUD on one fit.
export function battleViewport(width,height){
  const scale=Math.min(width/640,height/480);
  return {scale,x:(width-640*scale)/2,y:(height-480*scale)/2,width:640*scale,height:480*scale};
}
// 42EAD0's two clipped phases. Zero charge leaves only the glass visible.
export function battleBallState(charge,threshold){
  if(!charge||!(threshold>0))return null;
  const byte=n=>((n&255)^128)-128;
  if(charge.delay===0){
    if(charge.gauge===0)return null;
    const level=Math.trunc(Math.min(charge.gauge,threshold)*23/threshold),top=23-level;
    const b=byte(Math.trunc(top*255/23)),r=Math.max(0,byte(255-2*b));
    return {top,color:[r,128,b&255],phase:'charge',level};
  }
  if(charge.delay>=threshold)return null;
  const level=Math.trunc((threshold-charge.delay)*23/threshold);if(!level)return null;
  const top=46-level,r=byte(Math.trunc(top*255/23)),g=Math.max(0,byte(255-2*r)),b=((r&0x7fffffff)>>>7)<<8;
  return {top,color:[r&255,g,b&255],phase:'preparation',level};
}
// 5181D0's four fixed player slots, indexed by the persisted formation record.
// The retained zero camera projects X from center320 and Y from ground origin80.
// Enemy placement and movement choreography remain presentation adapters.
export function battleActorPositions(roster){
  const players=roster.filter(a=>a.side==='player'),enemies=roster.filter(a=>a.side==='enemy');
  const playerSlots=[[140,200],[220,170],[190,250],[270,210]].map(([x,y])=>[320+x,80+y]);
  const enemySlots=enemies.length===1?[[174,289]]:enemies.length===2?[[170,232],[103,324]]:[[179,225],[101,324],[277,301],[265,194]];
  return Object.fromEntries([...players.map((a,i)=>[a.id,playerSlots[a.party_slot_zero_based??i]]),...enemies.map((a,i)=>[a.id,enemySlots[i]])]);
}
