import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {DistanceGait,mapMotionProfile,mapStepGeometry} from '../web/core/map_locomotion.mjs';
import {MovementMap} from '../../prototype/web/movement.mjs';

registerHooks({resolve(specifier,context,next){
  if(specifier==='/prototype/movement.mjs')return {url:new URL('../../prototype/web/movement.mjs',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {createMapController}=await import('../web/controllers/map.mjs');
const read=name=>JSON.parse(readFileSync(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));
const catalog=read('catalog');
const geometry={cell_size:16,native_coordinate_shift:3,native_to_pixel_scale:2,native_step_shift:1};
const actions=[{index:0,interval_raw:180,frames_per_direction:10},
  {index:1,interval_raw:250,frames_per_direction:10},{index:2,interval_raw:130,frames_per_direction:12}];

function fixture({wall=false,roleId='001'}={}) {
  const role=catalog.roles.find(role=>role.id===roleId),at={map_id:'M17020',x:wall?396:300,y:300,direction:1};
  const value={location:at,party:[{id:roleId,hp:{current:1}}],flags:[],object_states:{}};
  const world={value,get location(){return this.value.location;},setPosition(x,y,direction){this.value.location={...this.location,x,y,direction};}};
  const rows=Array(100).fill(wall?'0'.repeat(25)+'1'+'0'.repeat(74):'0'.repeat(100));
  const movement={schema:'seventh-seal-map-movement',version:1,width:100,height:100,terrain_rows:rows,triggers:[],...geometry};
  const scene={data:{id:'M17020',movement,story_triggers:[]},bitmap:{width:1600,height:1600},
    movement:new MovementMap(movement),npcs:[],objects:[]};
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{dataset:{}});return nodes.get(id);};
  const state={world,scenes:{phase:'map',current:scene},resources:{revision:0,retainScopes(){}},
    actorResourcesByMap:new Map(),openingResources:{roles:{}},keys:new Set(),selectedRole:roleId,
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
      const f=fixture({roleId});f.state.keys.add('ArrowRight');if(running)f.state.keys.add('Shift');
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

test('partial wall contact counts accepted distance only and sustained blockage cannot keep walking',()=>{
  const f=fixture({wall:true});f.state.keys.add('ArrowRight');f.step(80);
  assert.ok(f.state.world.location.x<400);assert.equal(f.state.view.action,1);assert.equal(f.state.view.frame,0);
  f.step(80);assert.equal(f.state.view.action,0);
  const x=f.state.world.location.x;for(let n=0;n<60;n++)f.step(1000/60);
  assert.equal(f.state.world.location.x,x);assert.equal(f.state.view.action,0);
  f.state.keys.clear();f.state.keys.add('ArrowLeft');f.step(16);
  assert.equal(f.state.view.action,1);assert.equal(f.state.view.frame,0);assert.ok(f.state.world.location.x<x);
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
