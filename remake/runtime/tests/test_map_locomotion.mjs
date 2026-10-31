import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DistanceGait,mapMotionProfile,mapStepGeometry,nativeMapMovement} from '../web/core/map_locomotion.mjs';
import {MovementMap,KeyboardMovement} from '../web/core/movement.mjs';
import {initialEncounterState} from '../web/core/encounters.mjs';

const {createMapController}=await import('../web/controllers/map.mjs');
const read=name=>JSON.parse(readFileSync(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));
const catalog=read('catalog');
const encounterData=read('encounters');
const geometry={cell_size:16,native_coordinate_shift:3,native_to_pixel_scale:2,native_step_shift:1};
const actions=[{index:0,interval_raw:180,frames_per_direction:10},
  {index:1,interval_raw:250,frames_per_direction:10},{index:2,interval_raw:130,frames_per_direction:12}];

function fixture({wall=false,sealed=false,encounters=false,roleId='001'}={}) {
  const mapId=encounters?'M70010':'M17020';
  const role=catalog.roles.find(role=>role.id===roleId),at={map_id:mapId,x:wall?392:300,y:300,direction:1};
  const value={location:at,party:[{id:roleId,hp:{current:1}}],flags:[],object_states:{}};
  const world={value,get location(){return this.value.location;},setPosition(x,y,direction){
    assert.ok(Number.isInteger(direction)&&direction>=0&&direction<8,'WorldStore requires an eight-way heading');
    this.value.location={...this.location,x,y,direction};},setEncounterState(value){this.value.encounters=value;}};
  const rows=Array(100).fill(sealed?'1'.repeat(100):wall?'0'.repeat(25)+'1'.repeat(75):'0'.repeat(100));
  if(sealed)rows[18]='1'.repeat(18)+'0'+'1'.repeat(81);
  const movement={schema:'seventh-seal-map-movement',version:1,width:100,height:100,terrain_rows:rows,triggers:[],...geometry};
  const scene={data:{id:mapId,movement,story_triggers:[]},bitmap:{width:1600,height:1600},
    movement:new MovementMap(movement),npcs:[],objects:[]};
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{dataset:{}});return nodes.get(id);};
  const state={world,scenes:{phase:'map',current:scene},resources:{revision:0,retainScopes(){}},
    actorResourcesByMap:new Map(),openingResources:{roles:{}},keys:new Set(),running:false,selectedRole:roleId,
    catalog:{roles:[role]},mapVitals:new Map(),view:{action:0,frame:0,follow:false,zoom:1},
    clock:0,chapterStory:{maps:{}},engine:{presentMap(){}},battleUnavailable:'',encounterData};
  value.encounters=initialEncounterState(value.party,294);
  const controller=createMapController({state,actions:{guarded:fn=>fn,startBattle(group,encounters){
    state.battle={group,encounters};state.scenes.phase='battle-loading';},runChapter(event){state.event=event;state.scenes.phase='event';}},$,canvas:{},ctx:{}});let now=0;
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

test('held wall microsteps preserve walk/run cadence, encounter distance and followed camera at every render Hz',()=>{
  for(const running of [false,true]){
    const results=[];
    for(const hz of [30,60,120]){
      const f=fixture({wall:true});f.state.running=running;f.state.keys.add('ArrowRight');
      for(let n=0;n<hz;n++)f.step(1000/hz);
      const positions=[],frames=new Set();
      for(let n=0;n<hz;n++){
        f.step(1000/hz);const at=f.state.world.location;positions.push(at.x);frames.add(f.state.view.frame);
        assert.ok(at.x>=392-1e-4&&at.x<=396+1e-4);assert.equal(at.y,300);
        assert.equal(at.direction,1,'backward wall microsteps must not flip the displayed pose');
        assert.equal(f.state.view.action,running?2:1);
        assert.ok(Math.abs(f.state.view.x-(at.x-16))<1e-8,'camera follows the actual microstep');
      }
      assert.ok(Math.max(...positions)-Math.min(...positions)>1);assert.ok(frames.size>3);
      const encounters=f.state.world.value.encounters,distance=(running?250:1000*4/31)*2;
      const accepted=encounters.counters['001']*4+encounters.remainders['001']/4;
      assert.ok(Math.abs(accepted-distance)<1e-4,'only contact skin may trim the accepted distance');
      results.push({...f.state.world.location,frame:f.state.view.frame});
      const at={...f.state.world.location};f.state.keys.clear();for(let n=0;n<hz;n++)f.step(1000/hz);
      assert.equal(f.state.view.action,0);assert.deepEqual(f.state.world.location,at);
      assert.equal(f.state.view.collisionFeedback.x,0);
      f.state.scenes.phase='event';f.step(16);assert.equal(f.state.view.collisionFeedback,null);
    }
    for(const at of results){assert.ok(Math.abs(at.x-results[0].x)<1e-4);assert.equal(at.direction,results[0].direction);assert.equal(at.frame,results[0].frame);}
  }
});

test('diagonal wall contact preserves accepted tangent travel without stopping or changing running action',()=>{
  const results=[];
  for(const hz of [30,60,120]){
    const f=fixture({wall:true});f.state.keys=new Set(['ArrowRight','ArrowDown']);f.state.running=true;
    for(let n=0;n<hz;n++)f.step(1000/hz);
    const at=f.state.world.location;
    assert.ok(Math.abs(at.x-396)<1e-4);assert.ok(Math.abs(at.y-(300+250/Math.SQRT2))<1e-4);
    assert.equal(at.direction,7);assert.equal(f.state.view.action,2);
    results.push({x:at.x,y:at.y,frame:f.state.view.frame});
  }
  for(const r of results){assert.ok(Math.abs(r.y-results[0].y)<1e-4);assert.equal(r.frame,results[0].frame);}
});

test('visible NPCs remain solid during direction reselection, hidden actors do not block',()=>{
  for(const hidden of [false,true]){
    const f=fixture();f.state.scenes.current.npcs.push({id:'guard',x:320,y:300,hidden,event:{conditions:[]}});
    f.state.keys.add('ArrowRight');for(let i=0;i<20;i++){
      f.step(16);const at=f.state.world.location;
      if(!hidden)assert.ok(Math.abs(at.x-320)>=8-1e-4||Math.abs(at.y-300)>=6-1e-4,'NPC feet cannot overlap');
    }
    assert.ok(f.state.world.location.x>320,'reselection can continue past the NPC');
    assert.equal(f.state.world.location.y===300,hidden);
    if(!hidden){assert.equal(f.state.view.action,1);assert.equal(f.state.nearest.id,'guard');}
  }
});

test('the real forest entry stairs remain open uphill and downhill in walk/run at 30/60/120Hz',()=>{
  const data=read('maps/m70010');
  // The diagonal (26,36)->(27,35) is the narrow mouth of the entry stairs.
  assert.equal(data.movement.terrain_rows[36][26],'0');assert.equal(data.movement.terrain_rows[35][27],'0');
  for(const running of [false,true])for(const hz of [30,60,120]){
    const f=fixture(),scene=f.state.scenes.current;f.state.running=running;
    scene.data={...scene.data,movement:data.movement};scene.movement=new MovementMap(data.movement);
    f.state.world.value.location={...f.state.world.location,x:424,y:584};
    const speed=mapMotionProfile(f.state.catalog.roles[0].actions[running?2:1],data.movement).speed;
    for(const [keys,distance]of [[['ArrowRight','ArrowUp'],40],[['ArrowUp'],48],[['ArrowDown'],48],[['ArrowLeft','ArrowDown'],40]]){
      f.state.keys=new Set(keys);let remaining=distance/speed*1000;
      while(remaining>1e-8){const dt=Math.min(1000/hz,remaining);f.step(dt);remaining-=dt;
        assert.equal(scene.movement.at(f.state.world.location.x,f.state.world.location.y).blocked,false);}
      if(keys.length===1&&keys[0]==='ArrowUp')assert.ok(f.state.world.location.y<520,'reached the top of the stairs');
    }
    assert.ok(f.state.world.location.x<432&&f.state.world.location.y>579,'returned through the lower stair mouth');
  }
});

test('keyboard movement can follow source-open entry routes to all three forest exits',()=>{
  const data=read('maps/m70010'),resources=read('chapter_map_resources'),definition=read('runtime_content');
  const ready=new Set([...(resources.exits_by_map.M70010??[]).map(row=>row.id),...(definition.maps.M70010.triggers??[])]);
  const movement={...data.movement,triggers:data.movement.triggers.map(row=>({...row,path_gate:!ready.has(row.id)}))};
  const map=new MovementMap(movement),profile=mapMotionProfile(actions[1],movement);
  for(const trigger of [1,2,3]){
    const end=movement.triggers.find(row=>row.id===trigger),start=map.at(272,736),queue=[start];
    const previous=new Map([[`${start.x},${start.y}`,null]]);
    for(let i=0;i<queue.length;i++){
      const cell=queue[i];if(cell.x===end.x&&cell.y===end.y)break;
      for(const [dx,dy]of [[0,-1],[-1,0],[1,0],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]){
        const next=map.cell(cell.x+dx,cell.y+dy),key=`${next.x},${next.y}`;
        if(next.blocked||previous.has(key))continue;previous.set(key,cell);queue.push(next);
      }
    }
    const path=[];for(let cell=end;cell;cell=previous.get(`${cell.x},${cell.y}`))path.push(cell);path.reverse();
    for(const hz of [30,60,120]){
      let at={x:272,y:736};const keyboard=new KeyboardMovement();
      for(const cell of path){
        const goal={x:cell.x*16+8,y:cell.y*16+8};
        for(let frame=0;frame<hz&&Math.hypot(goal.x-at.x,goal.y-at.y)>=4;frame++){
          const vx=goal.x-at.x,vy=goal.y-at.y;
          at=keyboard.advance(map,at,{dx:Math.abs(vx)<2?0:Math.sign(vx),dy:Math.abs(vy)<2?0:Math.sign(vy),profile,elapsedMs:1000/hz});
          assert.equal(map.at(at.x,at.y).blocked,false);
        }
        assert.ok(Math.hypot(goal.x-at.x,goal.y-at.y)<4,`exit${trigger} ${hz}Hz cell${cell.x},${cell.y}: ${at.x},${at.y}`);
      }
    }
  }
});

test('an old save beside a wall is not blocked early and keeps its displayed heading during recoil',()=>{
  const f=fixture({wall:true});f.state.world.value.location={...f.state.world.location,x:395.99997,direction:3};
  f.state.keys.add('ArrowRight');f.step(16);
  assert.ok(f.state.world.location.x>395.99997&&f.state.world.location.x<400);assert.equal(f.state.world.location.direction,1);
  f.step(16);assert.equal(f.state.world.location.direction,1);assert.equal(f.state.view.action,1);
});

test('wall microsteps can trigger a real encounter and stop at the successful step, independent of render Hz',()=>{
  for(const hz of [30,60,120]){
    const f=fixture({wall:true,encounters:true});f.state.world.value.encounters.counters['001']=40;
    f.state.world.value.location.x=396;
    f.state.keys.add('ArrowRight');f.state.running=true;
    for(let n=0;n<hz&&!f.state.battle;n++)f.step(1000/hz);
    assert.ok(f.state.battle);assert.equal(f.state.scenes.phase,'battle-loading');
    assert.equal(f.state.world.location.x,392);assert.equal(f.state.world.location.y,300);
    assert.equal(f.state.world.location.direction,1);
    assert.equal(f.state.battle.group.trigger_roll.value,998);assert.equal(f.state.battle.encounters.counters['001'],0);
    const at={...f.state.world.location};f.step(80);assert.deepEqual(f.state.world.location,at);
    assert.equal(f.state.view.collisionFeedback,null);
  }
});

test('a fully sealed position has no accepted step, animation travel or encounter draw',()=>{
  const f=fixture({sealed:true,encounters:true});f.state.world.value.encounters.counters['001']=40;
  const before=structuredClone(f.state.world.value);f.state.keys.add('ArrowRight');
  for(let i=0;i<60;i++)f.step(1000/60);
  assert.deepEqual(f.state.world.value,before);assert.equal(f.state.battle,undefined);assert.equal(f.state.view.action,0);
});

test('a story entry stops within the render frame and suppresses the otherwise successful chance draw',()=>{
  const f=fixture({encounters:true});f.state.world.value.encounters.counters['001']=40;
  f.state.scenes.current.data.story_triggers.push({id:'entry',field_26_raw:7,cells:[{x:19,y:18}]});
  f.state.keys.add('ArrowRight');f.step(80);
  assert.equal(f.state.world.location.x,304);assert.equal(f.state.scenes.phase,'event');
  assert.equal(f.state.world.value.encounters.rng_state,294);assert.equal(f.state.world.value.encounters.counters['001'],41);
  assert.equal(f.state.battle,undefined);assert.equal(f.state.event.triggerId,'entry');
});

test('NPC collision and interaction distance use its displayed feet during reselection',()=>{
  const f=fixture(),npc={id:'guard',x:340,y:300,motion:{x:320,y:300,direction:5},event:{conditions:[]}};
  f.state.scenes.current.npcs.push(npc);f.state.keys.add('ArrowRight');
  for(let i=0;i<20;i++)f.step(16);
  assert.ok(f.state.world.location.x>320&&f.state.world.location.y<294);
  assert.equal(f.state.nearest.x,320);assert.ok(Math.abs(f.state.nearest.distance-Math.hypot(320-f.state.world.location.x,300-f.state.world.location.y))<1e-8);
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
  f.state.world.value.party.push({id:'002',hp:{current:1}});f.state.selectedRole='002';
  f.state.world.value.encounters.counters['002']=0;f.state.world.value.encounters.remainders['002']=0;f.step(16);
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
