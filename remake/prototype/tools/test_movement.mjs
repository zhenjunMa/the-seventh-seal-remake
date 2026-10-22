import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MovementMap, locomotion} from '../web/movement.mjs';

const fixture = rows => new MovementMap({schema:'seventh-seal-map-movement',version:1,
  width:rows[0].length,height:rows.length,cell_size:16,terrain_rows:rows,triggers:[]});
const checks=[];
function test(name,fn){fn();checks.push(name);}
test('truncated or nonbinary terrain rejected',()=>{
  assert.throws(()=>fixture(['00','0']));assert.throws(()=>fixture(['02']));
});
test('walking and running distance with diagonal normalization',()=>{
  const m=fixture(Array(100).fill('0'.repeat(100)));
  for(const speed of [150,270]){
    const p=m.move(100,100,speed/Math.SQRT2,speed/Math.SQRT2);
    assert.ok(Math.abs(Math.hypot(p.x-100,p.y-100)-speed)<1e-8);
  }
});
test('thin wall cannot be tunneled through in either direction',()=>{
  const m=fixture(['00100','00100','00100']);
  const a=m.move(8,24,2000,0),b=m.move(72,24,-2000,0);
  assert.ok(a.x<32&&a.x>31.99&&a.blocked);assert.ok(b.x>=48&&b.x<48.01&&b.blocked);
  assert.equal(m.at(a.x,a.y).blocked,false);assert.equal(m.at(b.x,b.y).blocked,false);
});
test('diagonal cannot cross touching blocked corners',()=>{
  const m=fixture(['010','100','000']);
  const p=m.move(8,8,32,32);assert.ok(p.blocked);assert.equal(p.hit.reason,'corner');
  assert.ok(p.x<16&&p.y<16);
});
test('open diagonal passes, wall stops both axes without slide',()=>{
  const m=fixture(['000','001','000']);
  assert.equal(m.move(8,8,16,16).blocked,false);
  const p=m.move(24,24,40,10);assert.ok(p.blocked&&p.x<32);
  assert.ok(Math.abs((p.y-24)/(p.x-24)-0.25)<1e-8);
});
test('all map edges reject outside positions including negative movement',()=>{
  const m=fixture(['00','00']);
  for(const [dx,dy] of [[-100,0],[100,0],[0,-100],[0,100]]){
    const p=m.move(16,16,dx,dy);assert.ok(p.blocked);assert.equal(p.hit.reason,'bounds');
    assert.ok(p.x>=0&&p.x<32&&p.y>=0&&p.y<32);
  }
});
test('held movement at wall stays idle and can immediately move away',()=>{
  const m=fixture(['01','01']);let p=m.move(8,24,27,0);
  for(let i=0;i<120;i++)p=m.move(p.x,p.y,27,0);
  assert.equal(p.moved,false);assert.equal(locomotion({dx:1,dy:0,running:true},p.moved).action,0);
  const back=m.move(p.x,p.y,-10,0);assert.ok(back.moved);
  assert.equal(locomotion({dx:-1,dy:0,running:true},back.moved).action,2);
});
test('runtime transition gates remain separate from terrain',()=>{
  const m=fixture(['000']);m.triggers.set(1,{x:1,y:0,id:1,path_gate:true});
  assert.equal(m.move(8,8,40,0).hit.reason,'transition');
  assert.equal(m.rows[0][1],'0');
});
test('all eight headings and release preserve movement state contract',()=>{
  const dirs=[[1,1],[1,0],[1,-1],[0,-1],[-1,-1],[-1,0],[-1,1],[0,1]];
  dirs.forEach(([dx,dy],i)=>{
    assert.equal(locomotion({dx,dy,running:false},true).direction,i);
    assert.equal(locomotion({dx,dy,running:false},true).action,1);
    assert.equal(locomotion({dx,dy,running:true},true).action,2);
    assert.equal(locomotion({dx,dy,running:true},false).action,0);
  });
  assert.equal(locomotion({dx:0,dy:0},false).direction,null);
});

const data=JSON.parse(fs.readFileSync(new URL('../web/assets/m01010_movement.json',import.meta.url)));
const nativeMap=new MovementMap(data);
let sweeps=0,samples=0;
test('every passable M01010 cell: eight directions at walk/run/long displacement',()=>{
  for(let y=0;y<nativeMap.height;y++)for(let x=0;x<nativeMap.width;x++){
    if(nativeMap.cell(x,y).blocked)continue;
    for(const length of [15,27,800])for(const [sx,sy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
      const start={x:x*16+8,y:y*16+8},n=Math.hypot(sx,sy);
      const p=nativeMap.move(start.x,start.y,sx/n*length,sy/n*length);
      assert.equal(nativeMap.at(p.x,p.y).blocked,false,`endpoint ${x},${y}`);
      const steps=Math.ceil(Math.hypot(p.x-start.x,p.y-start.y)*4)+1;
      // Independent dense sampling of the accepted segment, rather than only
      // asserting against the traverser's own reported hit or visited cells.
      for(let k=0;k<=steps;k++){
        const px=start.x+(p.x-start.x)*k/steps,py=start.y+(p.y-start.y)*k/steps;
        assert.equal(nativeMap.at(px,py).blocked,false,`segment ${x},${y}`);samples++;
      }
      sweeps++;
    }
  }
});
test('all user-facing validation points and saved start are passable',()=>{
  const manifest=JSON.parse(fs.readFileSync(new URL('../web/manifest.json',import.meta.url)));
  for(const p of [manifest.maps[0].start_preview,...manifest.maps[0].movement_probes])assert.equal(nativeMap.at(p.x,p.y).blocked,false,p.name);
});
const report={created_utc:new Date().toISOString(),passed:checks.length,checks,
  actual_map_sweeps:sweeps,independent_segment_samples:samples,
  scope:'Preview movement algorithm with exact exported DAT terrain; not original runtime parity'};
fs.writeFileSync(new URL('../evidence/collision_algorithm_verification.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
