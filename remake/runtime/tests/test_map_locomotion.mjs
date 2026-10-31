import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DistanceGait,mapMotionProfile,mapStepGeometry,nativeMapMovement} from '../web/core/map_locomotion.mjs';
import {MovementMap} from '../web/core/movement.mjs';

const {createMapController}=await import('../web/controllers/map.mjs');
const read=name=>JSON.parse(readFileSync(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));
const catalog=read('catalog');
const geometry={cell_size:16,native_coordinate_shift:3,native_to_pixel_scale:2,native_step_shift:1};
const actions=[{index:0,interval_raw:180,frames_per_direction:10},
  {index:1,interval_raw:250,frames_per_direction:10},{index:2,interval_raw:130,frames_per_direction:12}];

function fixture({wall=false,roleId='001'}={}) {
  const role=catalog.roles.find(role=>role.id===roleId),at={map_id:'M17020',x:wall?392:300,y:300,direction:1};
  const value={location:at,party:[{id:roleId,hp:{current:1}}],flags:[],object_states:{}};
  const world={value,get location(){return this.value.location;},setPosition(x,y,direction){
    assert.ok(Number.isInteger(direction)&&direction>=0&&direction<8,'WorldStore requires an eight-way heading');
    this.value.location={...this.location,x,y,direction};}};
  const rows=Array(100).fill(wall?'0'.repeat(25)+'1'+'0'.repeat(74):'0'.repeat(100));
  const movement={schema:'seventh-seal-map-movement',version:1,width:100,height:100,terrain_rows:rows,triggers:[],...geometry};
  const scene={data:{id:'M17020',movement,story_triggers:[]},bitmap:{width:1600,height:1600},
    movement:new MovementMap(movement),npcs:[],objects:[]};
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{dataset:{}});return nodes.get(id);};
  const state={world,scenes:{phase:'map',current:scene},resources:{revision:0,retainScopes(){}},
    actorResourcesByMap:new Map(),openingResources:{roles:{}},keys:new Set(),running:false,selectedRole:roleId,
    catalog:{roles:[role]},mapVitals:new Map(),view:{action:0,frame:0,follow:false,zoom:1},
    clock:0,chapterStory:{maps:{}},engine:{presentMap(){}},battleUnavailable:''};
  const controller=createMapController({state,actions:{},$,canvas:{},ctx:{}});let now=0;
  return {state,controller,step(ms){now+=ms;controller.updateExploration(now,ms);}};
}

test('every exported map carries its own native step geometry; walk/run use movement visit intervals',()=>{
  for(const map of catalog.maps){const data=read('maps/'+map.id.toLowerCase());
    assert.equal(data.movement.native_step_shift,1,map.id);
    assert.equal(mapStepGeometry(data.movement).stepSize,4);
  }
  const walk=mapMotionProfile(actions[1],geometry),run=mapMotionProfile(actions[2],geometry);
  assert.equal(walk.tickMs,31);assert.equal(run.tickMs,16);
  assert.ok(Math.abs(walk.speed-129.03225806451613)<1e-9);assert.equal(run.speed,250);
  assert.equal(walk.stride,8);assert.equal(run.stride,12);
  assert.equal(mapMotionProfile(actions[2],geometry,'',1000).tickMs,10);
  assert.equal(mapStepGeometry({...geometry,native_step_shift:0}).stepSize,2);
});

test('actual controller travel and gait agree across 30/60/120Hz and all three playable leaders',()=>{
  for(const roleId of ['001','002','003'])for(const running of [false,true]){
    const results=[];
    for(const hz of [30,60,120]){
      const f=fixture({roleId});f.state.keys.add('ArrowRight');f.state.running=running;
      for(let n=0;n<hz;n++)f.step(1000/hz);
      results.push({distance:f.state.world.location.x-300,frame:f.state.view.frame});
      assert.equal(f.state.view.action,running?2:1);assert.ok(Number.isInteger(f.state.view.frame));
    }
    for(const result of results){assert.ok(Math.abs(result.distance-results[0].distance)<1e-8);assert.equal(result.frame,results[0].frame);}
    assert.ok(Math.abs(results[0].distance-(running?250:1000*4/31))<1e-8);
  }
});

test('diagonal travel has no speed boost and animation measures accepted per-axis stride',()=>{
  const straight=fixture(),diagonal=fixture();straight.state.keys.add('ArrowRight');
  diagonal.state.keys.add('ArrowRight');diagonal.state.keys.add('ArrowDown');
  for(let n=0;n<60;n++){straight.step(1000/60);diagonal.step(1000/60);}
  const at=diagonal.state.world.location;
  assert.ok(Math.abs(Math.hypot(at.x-300,at.y-300)-(straight.state.world.location.x-300))<1e-8);
  assert.equal(at.direction,0);assert.equal(diagonal.state.view.frame,1);
});

test('wall contact stops travel but preserves walking until release, with phase retained on departure',()=>{
  const f=fixture({wall:true});f.state.keys.add('ArrowRight');f.step(80);
  assert.ok(f.state.world.location.x<400);assert.equal(f.state.view.action,1);assert.equal(f.state.view.frame,0);
  f.step(80);assert.equal(f.state.view.action,1);
  const x=f.state.world.location.x,frames=new Set();for(let n=0;n<60;n++){f.step(1000/60);frames.add(f.state.view.frame);}
  assert.equal(f.state.world.location.x,x);assert.equal(f.state.view.action,1);assert.ok(frames.size>1);
  f.state.keys.clear();f.state.keys.add('ArrowLeft');f.step(16);
  assert.equal(f.state.view.action,1);assert.ok(f.state.world.location.x<x);
  f.state.keys.clear();f.step(16);assert.equal(f.state.view.action,0);
});

test('controller slides with actual heading and stable gait at 30/60/120Hz without wall oscillation',()=>{
  const results=[];
  for(const hz of [30,60,120]){
    const f=fixture({wall:true});f.state.keys=new Set(['ArrowRight','ArrowDown']);f.state.running=true;
    for(let n=0;n<hz;n++)f.step(1000/hz);
    const at=f.state.world.location;
    assert.ok(at.x>395.99&&at.x<396);assert.equal(at.direction,7);assert.equal(f.state.view.action,2);
    assert.ok(Math.abs(at.y-300-250/Math.SQRT2)<1e-4);
    results.push({x:at.x,y:at.y,frame:f.state.view.frame});
  }
  for(const r of results){assert.ok(Math.abs(r.x-results[0].x)<1e-4);assert.ok(Math.abs(r.y-results[0].y)<1e-4);assert.equal(r.frame,results[0].frame);}
});

test('visible NPC feet block the player; hidden actors do not',()=>{
  for(const hidden of [false,true]){
    const f=fixture();f.state.scenes.current.npcs.push({id:'guard',x:320,y:300,hidden,event:{conditions:[]}});
    f.state.keys.add('ArrowRight');for(let i=0;i<20;i++)f.step(16);
    assert.equal(f.state.world.location.x<312,!hidden);
    if(!hidden){assert.equal(f.state.view.action,1);assert.equal(f.state.nearest.id,'guard');}
  }
});

test('subpixel travel into a wall keeps a valid heading when the direction filter removes both components',()=>{
  const f=fixture({wall:true});f.state.world.value.location={...f.state.world.location,x:395.99997,direction:3};
  f.state.keys.add('ArrowRight');f.step(16);
  assert.ok(f.state.world.location.x>395.99997);assert.equal(f.state.world.location.direction,1);
  f.step(16);assert.equal(f.state.world.location.direction,1);assert.equal(f.state.view.action,1);
});

test('wall impact moves only the body, finishes after release and clears on a phase change',()=>{
  const f=fixture({wall:true});f.state.keys=new Set(['ArrowRight']);f.state.running=true;
  f.step(40);const at={...f.state.world.location};f.step(40);
  assert.deepEqual(f.state.world.location,at);assert.ok(f.state.view.collisionFeedback.x<0);
  assert.equal(f.state.view.action,2,'running retains its action while fully blocked');
  f.state.keys.clear();f.step(16);assert.deepEqual(f.state.world.location,at);
  assert.equal(f.state.view.action,0);assert.ok(f.state.view.collisionFeedback.x<0,'release does not snap the body back');
  for(let i=0;i<30;i++)f.step(16);
  assert.deepEqual(f.state.world.location,at);assert.ok(Math.abs(f.state.view.collisionFeedback.x)<1e-8);
  f.state.keys.clear();f.step(16);assert.ok(Math.abs(f.state.view.collisionFeedback.x)<1e-8);
  f.state.scenes.phase='event';f.step(16);assert.equal(f.state.view.collisionFeedback,null);
});

test('held wall contact retains walk/run cadence and moves the follow camera with presentation only',()=>{
  for(const running of [false,true])for(const hz of [30,60,120]){
    const f=fixture({wall:true});f.state.running=running;f.state.keys.add('ArrowRight');
    for(let n=0;n<hz;n++)f.step(1000/hz);
    const at={...f.state.world.location},camera=[],frames=new Set();
    let previous=f.state.view.frame,advances=0;
    for(let n=0;n<hz;n++){
      f.step(1000/hz);assert.deepEqual(f.state.world.location,at);
      assert.equal(f.state.view.action,running?2:1);frames.add(f.state.view.frame);
      if(f.state.view.frame!==previous)advances++;previous=f.state.view.frame;
      const step=f.state.view.collisionFeedback.step;
      assert.ok(step.x<=0&&step.x>=-4);assert.equal(step.y,0);
      assert.ok(Math.abs(f.state.view.x-(at.x-16+step.x))<1e-8);
      camera.push(f.state.view.x);
    }
    assert.ok(Math.max(...camera)-Math.min(...camera)>.5,'holding the wall keeps the camera recoil alive');
    assert.ok(frames.size>3,'blocked motion keeps animating at the selected cadence');
    assert.ok(advances>=(running?20:16),'wall contact does not slow the source animation cadence');
    f.state.keys.clear();for(let n=0;n<hz;n++)f.step(1000/hz);
    assert.equal(f.state.view.action,0);assert.deepEqual(f.state.world.location,at);
    assert.ok(Math.abs(f.state.view.x-(at.x-16))<1e-8,'release settles the camera');
    f.state.keys.add('ArrowRight');for(let n=0;n<10;n++)f.step(1000/hz);
    f.state.scenes.phase='event';f.step(1000/hz);
    assert.equal(f.state.view.collisionFeedback,null);assert.equal(f.state.view.x,at.x-16);
  }
});

test('NPC collision and interaction distance follow its displayed feet rather than a leading source coordinate',()=>{
  const f=fixture(),npc={id:'guard',x:340,y:300,motion:{x:320,y:300,direction:5},event:{conditions:[]}};
  f.state.scenes.current.npcs.push(npc);f.state.keys.add('ArrowRight');
  for(let i=0;i<20;i++)f.step(16);
  assert.ok(f.state.world.location.x<312&&f.state.world.location.x>311.99);
  assert.equal(f.state.nearest.x,320);assert.ok(Math.abs(f.state.nearest.distance-8)<1e-4);
  assert.equal(npc.x,340);
});

test('release stops immediately; pause/role/scene resets never replay accumulated travel',()=>{
  const f=fixture();f.state.keys.add('ArrowRight');for(let n=0;n<20;n++)f.step(16);
  assert.ok(f.state.view.frame>0);f.state.keys.clear();const at={...f.state.world.location};f.step(16);
  assert.deepEqual(f.state.world.location,at);assert.equal(f.state.view.action,0);assert.equal(f.state.view.frame,0);
  f.state.scenes.phase='event';f.step(30000);assert.deepEqual(f.state.world.location,at);
  f.state.scenes.phase='map';f.state.view.action=0;f.state.view.frame=0;f.state.keys.add('ArrowRight');f.step(16);
  assert.equal(f.state.view.frame,0);assert.ok(f.state.world.location.x-at.x<3);
  for(let n=0;n<20;n++)f.step(16);assert.ok(f.state.view.frame>0);
  f.state.catalog.roles.push(catalog.roles.find(role=>role.id==='002'));
  f.state.world.value.party.push({id:'002',hp:{current:1}});f.state.selectedRole='002';f.step(16);
  assert.equal(f.state.view.frame,0);
  for(let n=0;n<20;n++)f.step(16);assert.ok(f.state.view.frame>0);
  f.state.scenes.current={...f.state.scenes.current};f.step(16);assert.equal(f.state.view.frame,0);
});

test('turns and walk/run switches preserve phase, while a new idle-to-move starts on the first pose',()=>{
  const gait=new DistanceGait();assert.equal(gait.advance(actions[1],{dx:48,stride:12}),4);
  assert.equal(gait.advance(actions[1],{dy:-6,stride:12}),4);
  assert.equal(gait.advance(actions[2],{dx:0,stride:12}),5);
  assert.equal(gait.advance(actions[1],{dx:0,stride:12}),4);
  assert.equal(gait.advance(actions[0],{elapsedMs:0}),0);
  assert.equal(gait.advance(actions[1],{dx:1,stride:12}),0);
});

test('chapter-style actions use logical source sequences and idle time never advances movement',()=>{
  const gait=new DistanceGait(),sequence={index:1,uses_sequence:true,sequence_raw:[0,2,1],sequence_length_raw:3,frame_count:3};
  assert.equal(gait.advance(sequence,{dx:12,stride:12}),2);
  assert.equal(gait.advance(sequence,{elapsedMs:60000,stride:12}),2);
  assert.equal(gait.advance(sequence,{dx:12,stride:12}),1);
  assert.equal(gait.advance({index:0,frame_count:10,interval_raw:180},{elapsedMs:360}),2);
});

test('legacy map assets recover exact camera and actor steps from their verified DAT header',()=>{
 const header=Buffer.alloc(0x172);header[0x144]=2;header[0x145]=3;
 const movement={source:'Map/m17010.dat',source_sha256:'a'.repeat(64)};
 const table={map_source:{path:'Map/m17010.dat',sha256:movement.source_sha256},header_raw_hex:header.toString('hex')};
 assert.deepEqual(nativeMapMovement(movement,table),{...movement,native_step_shift:2,native_camera_step_shift:3});
 assert.equal(movement.native_camera_step_shift,undefined,'loading does not rewrite source asset data');
 assert.throws(()=>nativeMapMovement({...movement,native_camera_step_shift:1},table),/步长与来源/);
 assert.throws(()=>nativeMapMovement({...movement,source_sha256:'b'.repeat(64)},table),/移动头与来源/);
 assert.throws(()=>nativeMapMovement(movement,{...table,header_raw_hex:table.header_raw_hex.slice(2)}),/移动头与来源/);
});
