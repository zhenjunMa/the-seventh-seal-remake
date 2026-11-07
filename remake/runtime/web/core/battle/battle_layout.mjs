// Native UI uses a 640x480 plane. Keep hit testing, sprites and HUD on one fit.
export function battleViewport(width,height){
  const scale=Math.min(width/640,height/480);
  return {scale,x:(width-640*scale)/2,y:(height-480*scale)/2,width:640*scale,height:480*scale};
}
// 42EAD0's two clipped phases. -threshold is empty; zero is the midpoint.
export function battleBallState(charge,threshold){
  if(!charge||!(threshold>0))return null;
  const byte=n=>((n&255)^128)-128;
  if(charge.delay===0){
    const level=Math.trunc(Math.min(charge.gauge,threshold)*23/threshold),top=23-level;
    const b=byte(Math.trunc(top*255/23)),r=Math.max(0,byte(255-2*b));
    return {top,color:[r,128,b&255],phase:'charge',level};
  }
  if(charge.delay>=threshold)return null;
  const level=Math.trunc((threshold-charge.delay)*23/threshold);if(!level)return null;
  const top=46-level,r=byte(Math.trunc(top*255/23)),g=Math.max(0,byte(255-2*r)),b=((r&0x7fffffff)>>>7)<<8;
  return {top,color:[r&255,g,b&255],phase:'preparation',level};
}
// 5173B0 uses the CHR category byte at header+18, independently of the
// current action's target class. Lightweight view rosters retain this byte.
export function battleActorCategory(actor){
  return actor.category_raw??parseInt(actor.header_raw_hex?.slice(0x18*2,0x18*2+2)||'00',16);
}
// 5173CE..5179F7: six pairs per row. The three families admit at most
// six ordinary enemies, five with one category2/3, or four with two.
const enemyFormations=[
  [
    [[-180,200]],
    [[-150,180],[-220,240]],
    [[-110,210],[-180,160],[-230,260]],
    [[-90,200],[-150,260],[-200,170],[-260,240]],
    [[-70,220],[-120,160],[-160,280],[-200,180],[-260,250]],
    [[-60,220],[-110,170],[-140,280],[-180,210],[-220,160],[-270,260]],
  ],
  [
    [[-120,220]],
    [[-160,180],[-200,260]],
    [[-180,240],[-70,180],[-120,280]],
    [[-200,220],[-70,180],[-120,260],[-220,280]],
    [[-200,220],[-70,180],[-120,260],[-220,280],[-260,160]],
  ],
  [
    null,
    [[-140,160],[-200,280]],
    [[-160,150],[-220,280],[-80,220]],
    [[-200,180],[-220,260],[-80,180],[-120,280]],
  ],
];
export function battleEnemyFormation(enemies){
  // 517B4B..517C4B: stable descending category sort changes placement,
  // while each actor keeps its original battle identity and RNG order.
  const ordered=enemies.map((actor,index)=>({actor,index,category:battleActorCategory(actor)}))
    .sort((a,b)=>b.category-a.category||a.index-b.index);
  const counts=[2,3].map(category=>ordered.filter(row=>row.category===category).length);
  const family=counts[0]===0&&counts[1]===0?0:
    counts[0]===1&&counts[1]===0||counts[0]===0&&counts[1]===1?1:
    counts[0]===2||counts[1]===2||counts[0]===1&&counts[1]===1?2:null;
  if(family===null)throw new Error('原版敌方阵型没有对应的类别组合');
  const rows=enemyFormations[family],count=Math.min(ordered.length,rows.length);
  if(!count)return [];
  const slots=rows[count-1];
  // 517C65/517E41/51801D disable overflow actors after sorting.
  return ordered.slice(0,count).map(({actor},index)=>({actor,position:[320+slots[index][0],80+slots[index][1]]}));
}
// 5181D0's four fixed player slots, indexed by the persisted formation record.
// Both sides use the same zero-camera X=center320, Y=ground-origin80 plane.
export function battleActorPositions(roster){
  const players=roster.filter(a=>a.side==='player'),enemies=roster.filter(a=>a.side==='enemy');
  const playerSlots=[[140,200],[220,170],[190,250],[270,210]].map(([x,y])=>[320+x,80+y]);
  return Object.fromEntries([...players.map((a,i)=>[a.id,playerSlots[a.party_slot_zero_based??i]]),
    ...battleEnemyFormation(enemies).map(({actor,position})=>[actor.id,position])]);
}
