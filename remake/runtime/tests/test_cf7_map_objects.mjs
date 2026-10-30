// Real M01065 queue, retained native instructions and the normal prepareMap path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MapObjectRuntime} from '../web/core/map_objects.mjs';
import {createNativeRng} from '../web/core/combat_rules.mjs';
import {StoryRepository} from '../web/core/story_repository.mjs';
import {runtimeContent,runtimeContentDefinition} from '../web/core/content_registry.mjs';
import {createMapController} from '../web/controllers/map.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';

const root=new URL('../../../',import.meta.url),web=new URL('../web/',import.meta.url),copy=structuredClone;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async path=>JSON.parse(await readFile(new URL(path.replace(/^\//,''),web),'utf8'));
const original=path=>readFile(new URL(path,root));
const [effects,map,seed,index,catalog,opening]=await Promise.all(['map_effects','maps/m01065','opening_seed','story/index','catalog','opening_map_resources'].map(path=>read(`data/${path}.json`)));
const dat=await original('Map/m01065.dat');assert.equal(digest(dat),'2ca9d09e6c3b42814d0e6112ea17384e3796bbbe3660aa25c61503b407cb9aa5');
const width=dat.readUInt32LE(0x146),height=dat.readUInt32LE(0x14a),descriptorBytes=dat.readUInt32LE(0x18)===1?0x42:0x2b;
const objectStart=0x172+width*height*64+32*(0x2a+descriptorBytes+0x1b+0x110),native=[];
for(let i=0;i<dat.readUInt32LE(0x82);i++){
  const raw=dat.subarray(objectStart+i*274,objectStart+(i+1)*274),dgp=await original(`mapm/m01065/${String(raw.readUInt32LE(0x1e)).padStart(3,'0')}.dgp`);
  native.push({raw,dgp});
}
const resources=effects.maps.M01065.objects.map(row=>{
  const source=native[row.index];assert.equal(row.source_record_raw_hex,source.raw.toString('hex'));
  const resource=copy(effects.object_banks[row.bank]);assert.equal(resource.source.sha256,digest(source.dgp));
  resource.actions.forEach(action=>{action.main_bitmap=action.main_sheet;action.intrinsic_bitmap=action.intrinsic_sheet;});
  return {...row,resource};
});
const [init,tick]=await Promise.all(['object_queue_assembly','object_tick_4137c0_assembly'].map(async name=>JSON.parse(await readFile(new URL(`../evidence/fire_valley_20261025/${name}.json`,import.meta.url),'utf8'))));
assert.equal(init.subject.digest.sha256,digest(await original('GAME.exe')));assert.equal(tick.subject.digest.sha256,init.subject.digest.sha256);
const instructions={'0x410850':init.normalized_result.split(/\r?\n/),'0x4137c0':tick.normalized_result.split(/\r?\n/)};
const make=(rngSeed=1,state=0)=>{
  const rng=createNativeRng(rngSeed),objects=copy(map.objects),world={event_records:[],flags:[],object_states:{},encounter_state:{rng_state:314159},revision:7};
  if(state){world.event_records[384]=[];world.event_records[384][1]=`${state.toString(16).padStart(2,'0')}00000000000000000000000000`;}
  const model=new MapObjectRuntime({objects,resources:copy(resources),mapId:'M01065',mapFlagIndex:384,random:rng});
  return {model,objects,world,rng};
};
function oracleFor(rngSeed,state=0){
  const rng=createNativeRng(rngSeed),oracle=new NativeAssemblyOracle(instructions,[],rng),baseExternal=oracle.external.bind(oracle);
  oracle.external=target=>{
    if([0x401019,0x401113,0x40173a,0x4022b6,0x40155a].includes(target))return;
    //40C3B0 persists through the owning story draft;40ED70 rebuilds map
    //collision. Source051/054 links are zero, so411A50/468B30 have no
    //spawn/reward payload here. Numeric action/frame clocks remain native.
    if([0x401884,0x401780,0x401956,0x401613].includes(target))return;
    // Passive state4 is compared with the original proximity trigger false.
    // No player selection/open/close interaction is admitted by this test.
    if(target===0x401b9f){oracle.reg.EAX=0;return;}
    return baseExternal(target);
  };
  oracle.write(0x518c800,0,1);oracle.write(0x504b24a,native.length);oracle.write(0x2b7ba88,0x22000000);
  for(const [i,{raw,dgp}]of native.entries()){
    raw.forEach((value,k)=>oracle.write(0x22000000+i*274+k,value,1));oracle.write(0x22000000+i*274+0xd1,dgp[2]);
    const id=raw.readUInt32LE(0x1e)-1,address=0x23000000+id*4096;
    oracle.write(0x2b42492+id*235,dgp[2],1);oracle.write(0x2b424d3+id*235,address);
    dgp.subarray(67,67+dgp[2]*172).forEach((value,k)=>oracle.write(address+k,value,1));
  }
  oracle.run(0x410850,[]);
  const base=0x22000000+274;oracle.write(base+0xd0,state,1);
  if(state===3){
    // Retained 40CFE0 ev_491fb7... chooses action1 and logical0 for CF7.
    oracle.write(base+0xd5,1);oracle.write(base+0x22,0);oracle.write(base+0x3c,6);oracle.write(base+0xce,2,1);
  }
  return {oracle,rng};
}

test('M01065 whole eight-object queue preserves native init and passive state0/3/4 clocks',()=>{
  assert.deepEqual(resources.map(row=>row.behavior_raw_cf),[1,7,1,1,1,1,1,1]);
  let compared=0;
  for(const state of [0,3,4])for(const rngSeed of [0,1,42,0xffffffff]){
    const actual=make(rngSeed,state),expected=oracleFor(rngSeed,state),before=copy(actual.world);let now=0;
    actual.model.update(0,{world:actual.world});
    for(const actor of actual.model.actors){
      const base=0x22000000+actor.object.index*274;
      assert.equal(actor.ffRaw,expected.oracle.read(base+0xff,1));assert.equal(actor.interval,expected.oracle.read(base+0xd9)>>>0);
    }
    assert.equal(expected.oracle.rng_calls.length,15);assert.equal(actual.rng.state,expected.rng.state);
    for(let visit=0;visit<36;visit++){
      now+=[37,89,123,249,1][visit%5];actual.model.update(now,{world:actual.world});
      for(const actor of actual.model.actors){
        const base=0x22000000+actor.object.index*274;expected.oracle.run(0x4137c0,[actor.object.index,now]);
        const displayed=actor.behavior===7?actor.displayActionIndex:0,action=actor.resource.actions[displayed];
        assert.equal(action.first_frame+actor.object.motion.frame,expected.oracle.read(base+0x3c),`state${state}/${actor.object.index}/${now}`);
        assert.equal(actor.frame,expected.oracle.read(base+0x22));
        if(actor.behavior===7)assert.equal(actor.actionIndex,expected.oracle.read(base+0xd5));
        compared++;
      }
      assert.equal(actual.rng.state,expected.rng.state);assert.equal(expected.oracle.rng_calls.length,15);
    }
    assert.deepEqual(actual.world,before);
  }
  assert.equal(compared,3456);
});

test('CF7 keeps state0 display, delayed action switch, hidden update, pause and completed-load action1',()=>{
  const actual=make(7),actor=actual.model.actors.find(row=>row.behavior===7);actual.model.update(0,{world:actual.world});
  actual.model.update(130,{world:actual.world});assert.equal(actor.object.motion.frame,0);assert.equal(actor.actionIndex,0);
  actual.world.event_records[384]=[];actual.world.event_records[384][1]='0400000000000000000000000000';
  actual.model.update(260,{world:actual.world});assert.equal(actor.actionIndex,1);assert.equal(actor.displayActionIndex,0);assert.equal(actor.object.motion.frame,0);
  actor.object.hidden=true;actual.model.update(390,{world:actual.world});assert.equal(actor.displayActionIndex,1);assert.equal(actor.object.motion.frame,1);
  actual.model.update(520,{world:actual.world,paused:true});assert.equal(actor.object.motion.frame,1);
  actual.model.update(10000,{world:actual.world});assert.equal(actor.object.motion.frame,1);
  const restored=make(7,3),last=restored.model.actors.find(row=>row.behavior===7);restored.model.update(0,{world:restored.world,paused:true});
  assert.equal(last.actionIndex,1);assert.equal(last.displayActionIndex,1);assert.equal(last.object.motion.frame,0);assert.equal(last.object.layer,2);assert.equal(last.interval,130);
  restored.model.update(130,{world:restored.world});assert.equal(last.object.motion.frame,1);
  for(const state of [1,2,5]){
    const active=make(7,state);assert.throws(()=>active.model.update(0,{world:active.world}),/主动交互状态尚未恢复/);
  }
});

test('CF7 ANM commands follow original forward/reverse ticks and settle only at the native barrier',async()=>{
  for(const rngSeed of [0,7,42]){
    const actual=make(rngSeed),expected=oracleFor(rngSeed),actor=actual.model.actors.find(row=>row.behavior===7),base=0x22000000+274;
    actual.model.update(0,{world:actual.world});
    let now=0;
    // 40C5C0(mode1,0) starts action0 without waiting for its clock.
    expected.oracle.write(base+0xd0,2,1);expected.oracle.write(base+0xeb,1,1);
    expected.oracle.write(base+0xd5,0);expected.oracle.write(base+0x22,0);expected.oracle.write(base+0x3c,0);
    let completed=false;const forward=actual.model.animate({objectIndex:1,state:2}).then(()=>{completed=true;});
    assert.equal(completed,false);assert.equal(actor.object.motion.frame,0);
    const visit=()=>{
      now+=150;actual.model.update(now,{world:actual.world});expected.oracle.run(0x4137c0,[1,now]);
      assert.equal(actor.frame,expected.oracle.read(base+0x22));assert.equal(actor.actionIndex,expected.oracle.read(base+0xd5));
      assert.equal(actor.resource.actions[actor.displayActionIndex].first_frame+actor.object.motion.frame,expected.oracle.read(base+0x3c));
      assert.equal(actor.interval,expected.oracle.read(base+0xd9)>>>0);assert.equal(actual.rng.state,expected.rng.state);
    };
    for(let i=0;i<6;i++)visit();await forward;assert.equal(completed,true);assert.equal(actor.commandState,3);
    visit();
    // 40C5C0(mode6,0) restores the final action0 cursor, then reverses it.
    expected.oracle.write(base+0xd0,5,1);expected.oracle.write(base+0xeb,1,1);
    expected.oracle.write(base+0xd5,0);expected.oracle.write(base+0x22,5);
    completed=false;const reverse=actual.model.animate({objectIndex:1,state:5}).then(()=>{completed=true;});
    const shown=actor.object.motion.frame;actual.model.update(now+50,{world:actual.world,paused:true});
    assert.equal(actor.object.motion.frame,shown);assert.equal(completed,false);
    // Pause is the existing scene-clock adaptation; reset both DD clocks.
    expected.oracle.write(base+0xdd,now+50);now+=50;
    for(let i=0;i<6;i++)visit();await reverse;assert.equal(completed,true);assert.equal(actor.commandState,0);
    assert.equal(expected.oracle.read(base+0xd0,1),0);
  }
  const actual=make(7),actor=actual.model.actors.find(row=>row.behavior===7),abort=new AbortController();
  actual.model.update(0,{world:actual.world});const before=structuredClone(actual.world),running=actual.model.animate({objectIndex:1,state:2,signal:abort.signal});
  actual.model.update(130,{world:actual.world});abort.abort(new Error('CF7 animation cancelled'));
  await assert.rejects(running,/CF7 animation cancelled/);assert.equal(actor.pending,null);assert.deepEqual(actual.world,before);
});

test('formal prepareMap M01065 loads all CF1 and CF7 main/light banks and updates without mutating the input save',async()=>{
  const world=copy(seed);world.opening.status='complete';world.location={map_id:'M01065',x:320,y:320,direction:2};
  const state={catalog,openingResources:copy(opening),mapEffects:copy(effects),world:{value:world,location:world.location},actorResourcesByMap:new Map(),
    view:{zoom:1,frame:0},scenes:{current:null,phase:'map'},resources:{revision:0,retainScopes(){},async attach(action,sheet,_scope,key='bitmap'){return action[key]=await image(sheet);}}};
  const images=new Map();
  async function image(path){
    if(!images.has(path))images.set(path,readFile(new URL(path.replace(/^\//,''),web)).then(bytes=>({width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)})));
    return images.get(path);
  }
  state.storyRepository=await StoryRepository.create({read,index,content:runtimeContent,definition:runtimeContentDefinition,currentMap:()=>state.scenes.current?.data.id});
  state.chapterStory=state.storyRepository.story;state.chapterResources=state.storyRepository.resources;state.events=state.storyRepository.events;
  state.openingResources.roles={...state.openingResources.roles,...state.chapterResources.roles};
  const before=copy(world),controller=createMapController({state,actions:{json:read,image},$:()=>({}),canvas:{},ctx:{}});
  const scene=await controller.prepareMap('M01065');assert.equal(scene.objectRuntime.actors.length,8);
  assert.equal(scene.objectRuntime.actors.filter(row=>row.behavior===7).length,1);
  for(const now of [0,40,130,260,390,520])scene.objectRuntime.update(now,{world});
  for(const actor of scene.objectRuntime.actors)assert.ok(Number.isInteger(actor.object.motion.frame)&&actor.object.motion.main&&actor.object.motion.intrinsic);
  assert.deepEqual(world,before);assert.equal(state.storyRepository.pins.size,0);
});

test('CF7 source identity, action drift and unimplemented sound payloads remain explicit failures',()=>{
  for(const change of [row=>{row.behavior_raw_cf=6;},row=>{row.source_record_raw_hex='00';},
    row=>{row.resource.actions[1].logical_frames[1]=0;},row=>{row.resource.actions.pop();},
    row=>{const raw=Buffer.from(row.source_record_raw_hex,'hex');raw.writeUInt32LE(1,0xf6);row.source_record_raw_hex=raw.toString('hex');}]){
    const changed=copy(resources),row=changed.find(row=>row.behavior_raw_cf===7);change(row);
    assert.throws(()=>new MapObjectRuntime({objects:copy(map.objects),resources:changed,mapId:'M01065',mapFlagIndex:384,random:createNativeRng(7)}),/地图|CF7/);
  }
});
