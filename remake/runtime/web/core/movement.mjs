// DAT terrain is recovered. Exploration uses a kinematic foot box: stop the
// normal component at contact and consume the remaining tangent displacement.
export const MAP_FOOTPRINT=Object.freeze({halfWidth:4,halfHeight:3});
const SKIN=1e-5,EPS=1e-9;

function sweepBox(x,y,dx,dy,box,footprint){
  const left=box.left-footprint.halfWidth,right=box.right+footprint.halfWidth;
  const top=box.top-footprint.halfHeight,bottom=box.bottom+footprint.halfHeight;
  // Old saves and source entrances can start touching/inside a footprint.
  // Permit escape and tangent travel, never push the persistent position out.
  if(x>left+EPS&&x<right-EPS&&y>top+EPS&&y<bottom-EPS){
    const nx=x>=box.right-EPS?1:x<=box.left+EPS?-1:0;
    const ny=y>=box.bottom-EPS?1:y<=box.top+EPS?-1:0;
    if(nx||ny){
      const blockX=nx&&dx*nx<-EPS?nx:0,blockY=!nx&&dy*ny<-EPS?ny:0;
      return blockX||blockY?{t:0,nx:blockX,ny:blockY,hit:box.hit}:null;
    }
    const edges=[{depth:x-left,nx:-1,ny:0},{depth:right-x,nx:1,ny:0},
      {depth:y-top,nx:0,ny:-1},{depth:bottom-y,nx:0,ny:1}];
    const nearest=edges.sort((a,b)=>a.depth-b.depth)[0];
    return dx*nearest.nx+dy*nearest.ny<-EPS?{t:0,...nearest,hit:box.hit}:null;
  }
  if(!dx&&(x<=left+EPS||x>=right-EPS)||!dy&&(y<=top+EPS||y>=bottom-EPS))return null;
  const tx0=dx?(left-x)/dx:-Infinity,tx1=dx?(right-x)/dx:Infinity;
  const ty0=dy?(top-y)/dy:-Infinity,ty1=dy?(bottom-y)/dy:Infinity;
  const enterX=Math.min(tx0,tx1),enterY=Math.min(ty0,ty1);
  const enter=Math.max(enterX,enterY),leave=Math.min(Math.max(tx0,tx1),Math.max(ty0,ty1));
  if(enter<-EPS||enter>1+EPS||leave<=Math.max(0,enter)+EPS)return null;
  return {t:Math.max(0,enter),nx:enterX>=enterY-EPS?-Math.sign(dx):0,
    ny:enterY>=enterX-EPS?-Math.sign(dy):0,hit:box.hit};
}

// The displayed ground position is also the continuous actor collider. Native
// NPC route coordinates can lead this position by one or more source visits.
export function mapActorPosition(actor){return actor.motion?.x===undefined?actor:actor.motion;}

// Preserve an NPC's chosen route vector: stop at contact rather than sliding
// it onto a new path. Terrain and source occupancy remain the route planner's
// responsibility; this sweep also works for actors whose source route flies.
export function moveActorAgainst(x,y,dx,dy,obstacles,footprint=MAP_FOOTPRINT){
  let first=1,hit=null;
  for(const box of obstacles){const contact=sweepBox(x,y,dx,dy,box,footprint);
    if(contact&&contact.t<=first){first=contact.t;hit=contact;}}
  const length=Math.hypot(dx,dy),ratio=hit?Math.max(0,first-SKIN/(length||1)):1;
  return {x:x+dx*ratio,y:y+dy*ratio,blocked:Boolean(hit),hit};
}

// Original 48EB70 admits a terrain0 diagonal destination without testing its
// two side cells. A rectangular footprint would disconnect those shipped
// passages. Bevel only the two terrain1 corners at such a contact; a separate
// centre sweep against the original tile still forbids entering terrain1.
// This is a continuous-collision adaptation, not native movement/rendering.
function diagonalTerrainBoxes(map,x,y,footprint){
  const open=(cx,cy)=>map.rows[cy]?.[cx]==='0'&&!map.cell(cx,cy).blocked;
  const wall=(cx,cy)=>map.rows[cy]?.[cx]==='1';
  const corners=[
    open(x,y-1)&&open(x-1,y)&&wall(x-1,y-1),
    open(x,y-1)&&open(x+1,y)&&wall(x+1,y-1),
    open(x,y+1)&&open(x+1,y)&&wall(x+1,y+1),
    open(x,y+1)&&open(x-1,y)&&wall(x-1,y+1)
  ];
  const size=map.cellSize,cut=Math.min(size/2-SKIN*2,footprint.halfWidth+footprint.halfHeight+SKIN*2);
  if(!corners.some(Boolean)||cut<=SKIN*2)return null;
  const xs=[x*size,x*size+cut,(x+1)*size-cut,(x+1)*size];
  const ys=[y*size,y*size+cut,(y+1)*size-cut,(y+1)*size],boxes=[];
  for(let iy=0;iy<3;iy++)for(let ix=0;ix<3;ix++){
    if(ix===0&&iy===0&&corners[0]||ix===2&&iy===0&&corners[1]
      ||ix===2&&iy===2&&corners[2]||ix===0&&iy===2&&corners[3])continue;
    boxes.push({left:xs[ix],right:xs[ix+1],top:ys[iy],bottom:ys[iy+1]});
  }
  return boxes;
}

export class MovementMap {
  constructor(data) {
    if (data?.schema !== 'seventh-seal-map-movement' || data.version !== 1 ||
        !Number.isInteger(data.width) || !Number.isInteger(data.height) ||
        data.width <= 0 || data.height <= 0 || data.cell_size !== 16 ||
        data.terrain_rows?.length !== data.height ||
        data.terrain_rows.some(row => typeof row !== 'string' || row.length !== data.width || /[^01]/.test(row))) {
      throw new Error('地图通行数据无效');
    }
    this.width = data.width; this.height = data.height; this.cellSize = data.cell_size;
    this.rows = data.terrain_rows; this.triggers = new Map();
    this.entryCells=new Set();
    for(const cell of data.native_entry_cells??[]){
      if(!Number.isInteger(cell.x)||!Number.isInteger(cell.y)||cell.x<0||cell.y<0
        ||cell.x>=this.width||cell.y>=this.height||this.rows[cell.y][cell.x]!=='1')throw new Error('地图原入口格无效');
      this.entryCells.add(`${cell.x},${cell.y}`);
    }
    for (const trigger of data.triggers ?? []) {
      if (!Number.isInteger(trigger.x) || !Number.isInteger(trigger.y) ||
          trigger.x < 0 || trigger.y < 0 || trigger.x >= this.width || trigger.y >= this.height ||
          !Number.isInteger(trigger.id) || trigger.id < 1 || trigger.id > 32 ||
          typeof trigger.path_gate !== 'boolean') throw new Error('地图触发格无效');
      const index = trigger.y * this.width + trigger.x;
      if (this.triggers.has(index)) throw new Error('地图触发格重复');
      this.triggers.set(index, trigger);
    }
  }
  cell(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return {blocked: true, reason: 'bounds', x, y};
    const trigger = this.triggers.get(y * this.width + x);
    if (this.rows[y][x] === '1') return {blocked: true, reason: 'terrain', x, y, trigger};
    if (trigger?.path_gate) return {blocked: true, reason: 'transition', x, y, trigger};
    return {blocked: false, x, y, trigger};
  }
  at(x, y) { return this.cell(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize)); }
  validEntry(x,y){const hit=this.at(x,y);return !hit.blocked||hit.reason==='terrain'&&this.entryCells.has(`${hit.x},${hit.y}`);}
  moveAndSlide(x,y,dx,dy,{footprint=MAP_FOOTPRINT,obstacles=[]}={}){
    if(![x,y,dx,dy,footprint.halfWidth,footprint.halfHeight].every(Number.isFinite)
      ||footprint.halfWidth<0||footprint.halfHeight<0)throw new Error('移动坐标或脚底范围无效');
    if(!this.validEntry(x,y))return {x,y,moved:false,blocked:true,hit:this.at(x,y),contacts:[]};
    const start={x,y},contacts=[],segments=[];
    let rx=dx,ry=dy;
    // A source marker may deliberately land inside terrain. Ignore only that
    // starting tile until the centre leaves it; all surrounding walls remain.
    const entry=this.at(x,y),escape=entry.blocked&&entry.reason==='terrain'?entry:null;
    // Source grid anchors may overlap the edge of a whole continuous wall.
    // Remember only faces actually overlapped at the start; permit travel
    // along that face across tile seams until the feet leave it naturally.
    const escapeFaces=[],size=this.cellSize,hw=footprint.halfWidth,hh=footprint.halfHeight;
    for(let cy=Math.max(0,Math.floor((y-hh)/size));cy<=Math.min(this.height-1,Math.floor((y+hh)/size));cy++)
      for(let cx=Math.max(0,Math.floor((x-hw)/size));cx<=Math.min(this.width-1,Math.floor((x+hw)/size));cx++){
        if(this.cell(cx,cy).reason!=='terrain')continue;
        const left=cx*size,right=left+size,top=cy*size,bottom=top+size;
        if(x+hw<=left+EPS||x-hw>=right-EPS||y+hh<=top+EPS||y-hh>=bottom-EPS)continue;
        if(x>=right-EPS)escapeFaces.push({edge:right,sign:1,axis:'x'});
        else if(x<=left+EPS)escapeFaces.push({edge:left,sign:-1,axis:'x'});
        else if(y>=bottom-EPS)escapeFaces.push({edge:bottom,sign:1,axis:'y'});
        else if(y<=top+EPS)escapeFaces.push({edge:top,sign:-1,axis:'y'});
      }
    for(let iteration=0;iteration<4&&(Math.abs(rx)>EPS||Math.abs(ry)>EPS);iteration++){
      let first=1,hits=[];
      const consider=hit=>{if(!hit||hit.t>first+EPS)return;
        if(hit.t<first-EPS){first=hit.t;hits=[];}hits.push(hit);};
      const size=this.cellSize,hw=footprint.halfWidth,hh=footprint.halfHeight;
      const x0=Math.max(0,Math.floor((Math.min(x,x+rx)-hw)/size));
      const x1=Math.min(this.width-1,Math.floor((Math.max(x,x+rx)+hw)/size));
      const y0=Math.max(0,Math.floor((Math.min(y,y+ry)-hh)/size));
      const y1=Math.min(this.height-1,Math.floor((Math.max(y,y+ry)+hh)/size));
      for(let cy=y0;cy<=y1;cy++)for(let cx=x0;cx<=x1;cx++){
        const hit=this.cell(cx,cy);
        if(!hit.blocked||escape&&cx===escape.x&&cy===escape.y)continue;
        if(hit.reason==='terrain'&&escapeFaces.some(face=>face.axis==='x'
          ?face.edge===(face.sign>0?cx+1:cx)*size&&rx*face.sign>=0
          :face.edge===(face.sign>0?cy+1:cy)*size&&ry*face.sign>=0))continue;
        // Gates use the logical centre so a covered exit can actually be
        // reached; terrain alone has physical thickness around the feet.
        const box={left:cx*size,right:(cx+1)*size,top:cy*size,bottom:(cy+1)*size,hit};
        const diagonal=hit.reason==='terrain'?diagonalTerrainBoxes(this,cx,cy,footprint):null;
        if(diagonal){
          for(const part of diagonal)consider(sweepBox(x,y,rx,ry,{...part,hit},footprint));
          // The bevel grants body clearance only. Logical terrain and unknown
          // transition gates continue to constrain the player's centre.
          consider(sweepBox(x,y,rx,ry,box,{halfWidth:0,halfHeight:0}));
        }else consider(sweepBox(x,y,rx,ry,box,hit.reason==='transition'?{halfWidth:0,halfHeight:0}:footprint));
      }
      for(const obstacle of obstacles)consider(sweepBox(x,y,rx,ry,obstacle,footprint));
      const bound=(value,delta,low,high,axis)=>{
        if(delta<0&&value+delta<low)consider({t:Math.max(0,(low-value)/delta),nx:axis==='x'?1:0,ny:axis==='y'?1:0,hit:{blocked:true,reason:'bounds'}});
        if(delta>0&&value+delta>high)consider({t:Math.max(0,(high-value)/delta),nx:axis==='x'?-1:0,ny:axis==='y'?-1:0,hit:{blocked:true,reason:'bounds'}});
      };
      bound(x,rx,Math.min(start.x,hw),Math.max(start.x,this.width*size-hw-SKIN),'x');
      bound(y,ry,Math.min(start.y,hh),Math.max(start.y,this.height*size-hh-SKIN),'y');
      // Leave skin only on the blocked axes; shortening the whole vector
      // loses tangent distance once per frame and makes sliding frame-dependent.
      const blockX=hits.some(hit=>hit.nx),blockY=hits.some(hit=>hit.ny);
      const sx=rx*first-(blockX?Math.sign(rx)*Math.min(Math.abs(rx*first),SKIN):0);
      const sy=ry*first-(blockY?Math.sign(ry)*Math.min(Math.abs(ry*first),SKIN):0);
      // Keep the approach ray through source-open diagonal corners intact.
      // Axis-only skin is a short correction near contact, not a change to
      // the whole approach direction. Final position/tangent travel stay exact.
      const approach=Math.max(0,first-Math.max(blockX&&rx?Math.min(Math.abs(rx*first),SKIN)/Math.abs(rx):0,
        blockY&&ry?Math.min(Math.abs(ry*first),SKIN)/Math.abs(ry):0));
      const ax=rx*approach,ay=ry*approach;
      if(ax||ay)segments.push({x,y,dx:ax,dy:ay});
      if(sx!==ax||sy!==ay)segments.push({x:x+ax,y:y+ay,dx:sx-ax,dy:sy-ay});
      x+=sx;y+=sy;
      if(!hits.length)break;
      contacts.push(...hits);
      rx*=1-first;ry*=1-first;
      if(blockX)rx=0;
      if(blockY)ry=0;
    }
    return {x,y,moved:Math.hypot(x-start.x,y-start.y)>SKIN,blocked:contacts.length>0,
      hit:contacts[0]?.hit,contacts,segments};
  }
  // Visible actors use the same foot extent as the player. Callers filter
  // story visibility; image dimensions and decorative map objects are ignored.
  actorObstacles(actors){return actors.map(actor=>{const at=mapActorPosition(actor);
    return {left:at.x-MAP_FOOTPRINT.halfWidth,right:at.x+MAP_FOOTPRINT.halfWidth,
      top:at.y-MAP_FOOTPRINT.halfHeight,bottom:at.y+MAP_FOOTPRINT.halfHeight,
      hit:{blocked:true,reason:'actor',id:actor.id}};});}
  // Traverse every grid boundary on the segment. Endpoint-only checks tunnel
  // through thin walls during running or a slow frame.
  move(x, y, dx, dy) {
    if (![x, y, dx, dy].every(Number.isFinite)) throw new Error('移动坐标无效');
    if (!this.validEntry(x,y)) return {x, y, moved: false, blocked: true, hit: this.at(x, y)};
    const distance = Math.hypot(dx, dy);
    if (!distance) return {x, y, moved: false, blocked: false};
    const size = this.cellSize, sx = Math.sign(dx), sy = Math.sign(dy);
    let cx = Math.floor(x / size), cy = Math.floor(y / size);
    let tx = sx ? ((sx > 0 ? (cx + 1) * size : cx * size) - x) / dx : Infinity;
    let ty = sy ? ((sy > 0 ? (cy + 1) * size : cy * size) - y) / dy : Infinity;
    const stepX = sx ? size / Math.abs(dx) : Infinity, stepY = sy ? size / Math.abs(dy) : Infinity;
    while (Math.min(tx, ty) <= 1) {
      const t = Math.min(tx, ty), crossX = tx <= ty + 1e-12, crossY = ty <= tx + 1e-12;
      const nx = cx + (crossX ? sx : 0), ny = cy + (crossY ? sy : 0);
      let hit = this.cell(nx, ny);
      // Conservative preview corner policy. Native path expansion checks the
      // diagonal destination; exact original corner behavior awaits playback.
      if (crossX && crossY && !hit.blocked) {
        const sideX = this.cell(nx, cy), sideY = this.cell(cx, ny);
        if (sideX.blocked || sideY.blocked) hit = {...(sideX.blocked ? sideX : sideY), reason: 'corner'};
      }
      if (hit.blocked) {
        const accepted = Math.max(0, t - 1e-5 / distance);
        return {x: x + dx * accepted, y: y + dy * accepted,
          moved: accepted * distance > 1e-4, blocked: true, hit};
      }
      cx = nx; cy = ny;
      if (crossX) tx += stepX;
      if (crossY) ty += stepY;
    }
    return {x: x + dx, y: y + dy, moved: true, blocked: false};
  }
}

export function locomotion(input, moved) {
  const {dx, dy} = input;
  const direction = dy < 0 ? (dx > 0 ? 2 : dx < 0 ? 4 : 3)
    : dy > 0 ? (dx > 0 ? 0 : dx < 0 ? 6 : 7) : dx > 0 ? 1 : 5;
  return {action: moved ? (input.running ? 2 : 1) : 0, direction: dx || dy ? direction : null};
}
