// Verify that real exit strips cannot be crossed without the final location
// remaining on their trigger, including the maximum keyboard frame distance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {MovementMap} from '../../prototype/web/movement.mjs';

const runtime=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load=id=>JSON.parse(fs.readFileSync(path.join(runtime,'web/data/maps',id.toLowerCase()+'.json'),'utf8'));
const key=(x,y)=>`${x},${y}`;
const directions=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
const distances=[150*.016,270*.016,150*.08,270*.08,800];

// Independent slab intersection against each cell's strict interior.
function intersectsInterior(x,y,endX,endY,cell){
  let lo=0,hi=1;
  for(const [origin,delta,minimum,maximum] of [[x,endX-x,cell.x*16,cell.x*16+16],[y,endY-y,cell.y*16,cell.y*16+16]]){
    if(Math.abs(delta)<1e-12){if(origin<=minimum||origin>=maximum)return false;continue;}
    const a=(minimum-origin)/delta,b=(maximum-origin)/delta;
    lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));
    if(hi-lo<1e-8)return false;
  }
  const mid=(lo+hi)/2,px=x+(endX-x)*mid,py=y+(endY-y)*mid;
  return px>cell.x*16&&px<(cell.x+1)*16&&py>cell.y*16&&py<(cell.y+1)*16;
}

const checks=[];
for(const id of ['M01010','M01030']){
  const record=load(id),original=JSON.stringify(record.movement);
  const data=structuredClone(record.movement);
  const cells=record.exits.flatMap(exit=>exit.cells),ready=new Set(cells.map(c=>key(c.x,c.y)));
  for(const trigger of data.triggers)if(ready.has(key(trigger.x,trigger.y)))trigger.path_gate=false;
  const map=new MovementMap(data);
  let sweeps=0,approaches=0,starts=0;
  for(let cy=0;cy<map.height;cy++)for(let cx=0;cx<map.width;cx++){
    if(map.cell(cx,cy).blocked||ready.has(key(cx,cy)))continue;
    starts++;
    const x=cx*16+8,y=cy*16+8;
    for(const [dx,dy] of directions)for(const distance of distances){
      const length=Math.hypot(dx,dy),result=map.move(x,y,dx/length*distance,dy/length*distance);
      assert.equal(map.at(result.x,result.y).blocked,false,`${id} movement entered blocked terrain`);
      const crossed=cells.some(cell=>intersectsInterior(x,y,result.x,result.y,cell));
      if(crossed){
        approaches++;
        assert(ready.has(key(Math.floor(result.x/16),Math.floor(result.y/16))),`${id} exited trigger strip without firing`);
      }
      sweeps++;
    }
  }
  assert(approaches>0);
  assert.equal(JSON.stringify(record.movement),original,'Original native path gates were mutated');
  for(const exit of record.exits){
    const target=load(exit.target_map),destination=new MovementMap(target.movement);
    assert.equal(destination.at(exit.entry.x,exit.entry.y).blocked,false,'Native target entry must load directly');
    assert(Number.isInteger(exit.entry.direction)&&exit.entry.direction>=0&&exit.entry.direction<8);
    // Strip backs against true blocked terrain so an arbitrarily large
    // movement segment remains within the exit once it gets there.
    for(const cell of exit.cells)assert.equal(map.cell(cell.x,cell.y).blocked,false);
  }
  checks.push({id,open_non_exit_start_cells:starts,direction_distance_sweeps:sweeps,exit_strip_crossings:approaches,
    speed_frame_policy:{walking_pixels_per_second:150,running_pixels_per_second:270,max_delta_seconds:.08},
    maximum_frame_pixels:21.6,stress_distance_pixels:800});
}
const report={schema:'seventh-seal-runtime-transition-movement-checks',version:1,success:true,checks,
  scope:'Real exported terrain, verified exit gates enabled on a clone, all open-cell centers × eight directions × five distances; not original game runtime timing'};
fs.writeFileSync(path.join(runtime,'evidence/map_transition_movement_20261011.json'),JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify(report,null,2));
