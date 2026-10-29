import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MapNpcRuntime,decodeNpcBehavior,npcPath} from '../web/core/map_npcs.mjs';
import {MovementMap} from '../web/core/movement.mjs';
import {createNativeRng} from '../web/core/combat_rules.mjs';
import {captureMapNpcState,restoreMapNpcState} from '../web/core/map_npc_state.mjs';

const read=name=>JSON.parse(readFileSync(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));
const story=read('chapter_story'),resources=read('chapter_map_resources'),village=read('maps/m17020');
function fixture({actual=false,random=createNativeRng(21)}={}){
  const source=actual?village:{...village,movement:{...village.movement,width:70,height:70,terrain_rows:Array(70).fill('0'.repeat(70)),triggers:[]}};
  const npcs=structuredClone(actual?resources.npcs_by_map.M17020:[resources.npcs_by_map.M17020[0]]);
  if(!actual){npcs[0].x=640;npcs[0].y=640;}
  const scene={data:source,movement:new MovementMap(source.movement),npcs};
  const runtime=new MapNpcRuntime({scene,table:story.maps.M17020,roles:resources.roles,random});
  return {scene,runtime,npc:npcs[0]};
}
function run(runtime,ms,{from=0,step=10,...options}={}){
  for(let time=from;time<=from+ms;time+=step)runtime.update(time,options);
}

test('source records classify thirteen roaming fire sprites and eight fixed villagers without name overrides',()=>{
  const records=story.maps.M17020.npc_records.map(decodeNpcBehavior);
  assert.equal(records.filter(r=>!r.fixed).length,13);assert.equal(records.filter(r=>r.fixed).length,8);
  assert.deepEqual(records[0].bindings.slice(0,3),[0,1,2]);assert.equal(records[0].speedBias,1);
  assert.equal(records[0].routeCount,0);assert.equal(decodeNpcBehavior({raw_hex:'00'}),null);
});

test('native target selection uses home +/- nineteen cells and the &10 pause mask',()=>{
  const {runtime,npc}=fixture({random:(()=>{const values=[3,8,0,15,19,19];return ()=>values.shift()??0;})()});
  runtime.update(0);runtime.update(80);
  assert.equal(runtime.snapshot()[0].wait,18);assert.equal(npc.x,640);assert.equal(npc.y,640);
  // 18 idle visits finish the source pause; the latch prevents pausing again.
  run(runtime,18*180,{from:260,step:180});
  const goal=runtime.snapshot()[0].goal;
  assert.equal(goal.x,640-19*16);assert.equal(goal.y,640+19*16);
});

test('path expansion accepts native diagonal destinations and backtrace priority while rejecting gates and walls',()=>{
  const grid={width:3,height:3,rows:['010','100','000'],triggers:new Map()};
  assert.deepEqual(npcPath(grid,{x:0,y:0},{x:1,y:1}),[{x:1,y:1}]);
  const path=npcPath({...grid,rows:['000','111','000']},{x:0,y:0},{x:2,y:2});
  assert.ok(path.every(cell=>cell.y!==1));
  const gate={width:3,height:1,rows:['000'],triggers:new Map([[1,{path_gate:true}]])};
  assert.deepEqual(npcPath(gate,{x:0,y:0},{x:2,y:0}),[]);
  assert.deepEqual(npcPath(gate,{x:0,y:0},{x:2,y:0},{flying:true}),[{x:1,y:0},{x:2,y:0}]);
});

test('real village sprites walk with source actions/facing and walkable destinations; guards keep position',()=>{
  const {scene,runtime}=fixture({actual:true}),before=runtime.snapshot(),positions=new Map(before.map(a=>[a.id,a]));
  const motions=new Set(),directions=new Map();
  for(let time=0;time<30000;time+=20){
    runtime.update(time);
    for(const npc of scene.npcs){
      if(npc.motion.action===1)motions.add(npc.id);
      if(!directions.has(npc.id))directions.set(npc.id,new Set());directions.get(npc.id).add(npc.direction);
      const original=positions.get(npc.id);
      if(original.fixed){assert.equal(npc.x,original.x);assert.equal(npc.y,original.y);}
      else {const step=runtime.actors.get(npc.id).step;
        if(step)assert.equal(scene.movement.cell(step.cell.x,step.cell.y).blocked,false);
        else if(npc.x!==original.x||npc.y!==original.y)assert.equal(scene.movement.at(npc.x,npc.y).blocked,false);
      }
    }
  }
  assert.ok(motions.size>=10);assert.ok([...directions.values()].some(values=>values.size>=3));
  assert.ok(runtime.snapshot().some(a=>!a.fixed&&(a.x!==positions.get(a.id).x||a.y!==positions.get(a.id).y)));
  assert.deepEqual(resources.npcs_by_map.M17020.map(n=>[n.x,n.y]),before.map(n=>[n.x,n.y]));
});

test('interaction holds only the chosen live NPC and release resumes; pauses and slow frames do not fast-forward',()=>{
  const {runtime,npc}=fixture();run(runtime,1000);const release=runtime.hold(npc.id),position=[npc.x,npc.y];
  run(runtime,3000,{from:1010});assert.deepEqual([npc.x,npc.y],position);
  release();run(runtime,3000,{from:4020});assert.notDeepEqual([npc.x,npc.y],position);
  const before=runtime.snapshot();runtime.update(100000,{paused:true});runtime.update(100010,{paused:true});
  assert.deepEqual(runtime.snapshot(),before);runtime.update(200000);assert.deepEqual(runtime.snapshot(),before);
});

test('scene inheritance and ANM handoff preserve live positions without sharing mutable path state or modifying sources',()=>{
  const first=fixture();run(first.runtime,1000);const before=first.runtime.snapshot(),next=fixture();
  next.runtime.inherit(first.runtime);assert.deepEqual(next.runtime.snapshot(),before);
  next.runtime.actors.get(next.npc.id).path.push({x:1,y:1});
  assert.notDeepEqual(next.runtime.actors.get(next.npc.id).path,first.runtime.actors.get(first.npc.id).path);
  next.runtime.adoptActors(new Map([[10,{x:800,y:820,direction:5,visible:true,action:0,frame:2}]]));
  assert.equal(next.npc.x,800);assert.equal(next.npc.y,820);assert.equal(next.npc.direction,5);
  assert.equal(next.npc.motion.frame,2);assert.deepEqual(first.runtime.snapshot(),before);
  next.runtime.adoptActors(new Map([[10,{x:810,y:824,direction:3,visible:true,action:1,frame:6}]]));
  assert.equal(next.npc.motion.frame,6);assert.deepEqual([next.npc.motion.x,next.npc.motion.y],[810,824]);
});

test('saved NPC pose initializes the same action, physical frame and facing in an ordinary map runtime',()=>{
  const first=fixture();first.runtime.adoptActors(new Map([[10,{x:810,y:824,direction:3,visible:true,action:1,frame:6}]]));
  const saved={};captureMapNpcState(saved,'M17020',first.scene.npcs);
  const next=fixture();restoreMapNpcState(next.scene.npcs,saved,'M17020');
  const runtime=new MapNpcRuntime({scene:next.scene,table:story.maps.M17020,roles:resources.roles});
  assert.deepEqual([next.npc.x,next.npc.y,next.npc.direction,next.npc.hidden,next.npc.motion.action,next.npc.motion.frame],[810,824,3,false,1,6]);
  assert.deepEqual(runtime.snapshot().map(row=>[row.action,row.frame]),[[1,6]]);
});

test('NPC movement does not access persistent world resources, RNG, or revision and previews stay isolated',()=>{
  const live=fixture(),preview=fixture(),world={revision:6,encounters:{rng_state:123},location:{map_id:'M17020',x:1092,y:986}};
  const before=structuredClone(world),previewBefore=preview.runtime.snapshot();run(live.runtime,8000,{player:world.location});
  assert.deepEqual(world,before);assert.deepEqual(preview.runtime.snapshot(),previewBefore);
});

test('native countdown advances every two visits across cell boundaries',()=>{
  const {runtime,npc}=fixture(),a=runtime.actors.get(npc.id);
  runtime.visible=()=>true;a.path=Array.from({length:3},(_,i)=>({x:41+i,y:40}));a.wait=0;
  const frames=[];
  for(let visit=0;visit<12;visit++){runtime.tick(a,null);frames.push(a.logicalFrame);}
  assert.deepEqual(frames,[1,1,2,2,3,3,4,4,5,5,6,6]);
});

test('ordinary NPC visual travel is bounded by source speed, shares distance gait, and freezes on hold/pause',()=>{
  for(const hz of [30,60,120]){
    const {runtime,npc}=fixture(),a=runtime.actors.get(npc.id);
    a.path=Array.from({length:8},(_,i)=>({x:41+i,y:40}));a.wait=0;a.interval=43;
    runtime.update(0);let previous=640;
    for(let n=1;n<=hz;n++){
      runtime.update(n*1000/hz);
      assert.ok(npc.motion.x<=npc.x+1e-8);assert.ok(npc.motion.x>=previous);
      assert.ok(npc.motion.x-previous<=4/43*1000/hz+1e-8);
      const traveled=npc.motion.x-640;
      assert.equal(npc.motion.frame,Math.floor(traveled/8+1e-8)%10);
      previous=npc.motion.x;
    }
    assert.ok(npc.motion.x>728&&npc.motion.x<734);
    const release=runtime.hold(npc.id),held={...npc.motion};
    runtime.update(1100);assert.equal(npc.motion.x,held.x);assert.equal(npc.motion.y,held.y);assert.equal(npc.motion.action,0);
    runtime.update(5000,{paused:true});assert.equal(npc.motion.x,held.x);
    release();runtime.update(5016);assert.ok(Math.abs(npc.motion.x-held.x)<=4/43*16+1e-8);
  }
});

test('continuous NPC feet stop at a nearby player without route backlog and resume when the player moves away',()=>{
  for(const hz of [30,60,120]){
    const {runtime,npc,scene}=fixture(),a=runtime.actors.get(npc.id),player={x:651,y:640};
    a.path=Array.from({length:8},(_,i)=>({x:41+i,y:40}));a.wait=0;a.interval=43;
    runtime.update(0,{player});
    for(let n=1;n<=hz;n++){
      runtime.update(n*1000/hz,{player});
      assert.ok(npc.motion.x<=643+1e-8,'NPC body cannot enter the player foot box');
      const collider=scene.movement.actorObstacles([npc])[0];assert.equal(collider.left,npc.motion.x-4);
    }
    assert.ok(a.contactBlocked);const stopped=npc.motion.x,logical=npc.x;
    for(let n=hz+1;n<=hz*3;n++)runtime.update(n*1000/hz,{player});
    assert.equal(npc.motion.x,stopped);assert.equal(npc.x,logical,'waiting cannot accumulate hidden source travel');
    player.y+=32;runtime.update((hz*3+1)*1000/hz,{player});
    assert.ok(npc.motion.x>stopped);assert.ok(npc.motion.x-stopped<=4/43*1000/hz+1e-8);
    assert.equal(a.contactBlocked,false);assert.equal(a.goal.x,640,'contact does not choose a new random goal');
  }
});
