// Source-bound CF9/CF2 clocks, restored poses and collision projection. The
// retained x86 tick is interpreted independently; OS, rendering, TLK dispatch
// and event persistence are explicit external hooks, not original execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MapObjectRuntime} from '../web/core/map_objects.mjs';
import {MovementMap} from '../web/core/movement.mjs';
import {createNativeRng} from '../web/core/combat_rules.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {forestSwitches} from './helpers/fairy_forest_temple_world.mjs';

const web=new URL('../web/',import.meta.url),root=new URL('../../../',import.meta.url),copy=structuredClone;
const read=async path=>JSON.parse(await readFile(new URL(path,web),'utf8'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const effects=await read('data/map_effects.json');
const instructions=Object.fromEntries(await Promise.all([['0x410850','object_queue_assembly'],['0x4137c0','object_tick_4137c0_assembly']].map(async([address,name])=>{
  const record=JSON.parse(await readFile(new URL(`../evidence/fire_valley_20261025/${name}.json`,import.meta.url),'utf8'));
  assert.equal(record.subject.digest.sha256,'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18');
  return [address,record.normalized_result.split(/\r?\n/)];
})));

async function fixture(mapId,objectIndex,state=0){
  const map=await read(`data/maps/${mapId.toLowerCase()}.json`),dat=await readFile(new URL(`Map/${mapId.toLowerCase()}.dat`,root));
  assert.equal(digest(dat),map.source.sha256);
  const rows=effects.maps[mapId].objects,resources=rows.map(row=>{
    const resource=copy(effects.object_banks[row.bank]);
    for(const action of resource.actions){action.main_bitmap=action.main_sheet;action.intrinsic_bitmap=action.intrinsic_sheet;}
    return {...row,resource};
  });
  const width=dat.readUInt32LE(0x146),height=dat.readUInt32LE(0x14a),descriptorBytes=dat.readUInt32LE(0x18)===1?0x42:0x2b;
  const start=0x172+width*height*64+32*(0x2a+descriptorBytes+0x1b+0x110);
  const native=[];
  for(let index=0;index<dat.readUInt32LE(0x82);index++){
    const raw=dat.subarray(start+index*274,start+(index+1)*274);
    const dgp=await readFile(new URL(`${map.source.object_resource_base}/${String(raw.readUInt32LE(0x1e)).padStart(3,'0')}.dgp`,root));
    native.push({raw,dgp});
  }
  const row=resources.find(row=>row.index===objectIndex),source=native[objectIndex];
  assert.equal(row.source_record_raw_hex,source.raw.toString('hex'));assert.equal(row.resource.source.sha256,digest(source.dgp));
  for(const action of row.resource.actions)assert.equal(action.source_action_raw_hex,source.dgp.subarray(67+172*action.index,67+172*(action.index+1)).toString('hex'));
  const world={event_records:[],flags:[],revision:7},flag=map.map_flag_index;
  world.event_records[flag]=Array.from({length:native.length},()=>`00${'00'.repeat(13)}`);
  world.event_records[flag][objectIndex]=`${state.toString(16).padStart(2,'0')}${'00'.repeat(13)}`;
  const movement=new MovementMap(copy(map.movement)),rng=createNativeRng(7);
  const model=new MapObjectRuntime({objects:copy(map.objects),resources,mapId,mapFlagIndex:flag,movement,random:rng});
  return {map,dat,native,row,world,movement,rng,model,actor:model.actors.find(actor=>actor.object.index===objectIndex),objectIndex};
}

function oracleFor(fixture){
  const rng=createNativeRng(7),oracle=new NativeAssemblyOracle(instructions,[],rng),external=oracle.external.bind(oracle);
  oracle.external=target=>{
    if([0x401019,0x401113,0x40173a,0x4022b6,0x40155a,0x401884,0x401780,0x401956,0x401613].includes(target))return;
    if(target===0x401b9f){oracle.reg.EAX=0;return;}
    return external(target);
  };
  oracle.write(0x518c800,0,1);oracle.write(0x504b24a,fixture.native.length);oracle.write(0x2b7ba88,0x22000000);
  for(const [index,{raw,dgp}]of fixture.native.entries()){
    raw.forEach((value,offset)=>oracle.write(0x22000000+index*274+offset,value,1));oracle.write(0x22000000+index*274+0xd1,dgp[2]);
    const id=raw.readUInt32LE(0x1e)-1,address=0x23000000+id*4096;
    oracle.write(0x2b42492+id*235,dgp[2],1);oracle.write(0x2b424d3+id*235,address);
    dgp.subarray(67,67+dgp[2]*172).forEach((value,offset)=>oracle.write(address+offset,value,1));
  }
  oracle.run(0x410850,[]);return {oracle,rng,base:0x22000000+fixture.objectIndex*274};
}

test('all six source CF9 switches restore state3 at action2 frame0 and loop without changing saved events',async()=>{
  for(const {mapId,objectIndex}of forestSwitches){
    const f=await fixture(mapId,objectIndex,3),before=copy(f.world);f.model.update(0,{world:f.world});
    assert.equal(f.actor.actionIndex,2);assert.equal(f.actor.frame,0);assert.equal(f.actor.object.motion.frame,0);
    assert.equal(f.actor.resource.actions[2].first_frame,16);assert.equal(f.actor.object.layer,2);
    for(let tick=1;tick<=12;tick++){
      f.model.update(tick*160,{world:f.world});assert.equal(f.actor.frame,tick%10);
      assert.equal(f.actor.displayActionIndex,2);assert.equal(f.actor.object.motion.frame,tick%10);
    }
    assert.deepEqual(f.world,before);
  }
});

test('source CF9 forward action1 and CF2 forward action0 agree with the retained4137C0 clock until completion',async()=>{
  for(const [mapId,objectIndex]of [['M72040-0-7',20],['M72050',11],['M72061',0]]){
    const f=await fixture(mapId,objectIndex),expected=oracleFor(f),before=copy(f.world),{oracle,base}=expected;
    f.model.update(0,{world:f.world});
    const actionIndex=f.actor.behavior===9?1:0,action=f.actor.resource.actions[actionIndex];
    oracle.write(base+0xd0,2,1);oracle.write(base+0xeb,1,1);oracle.write(base+0xd5,actionIndex);
    oracle.write(base+0x22,0);oracle.write(base+0x3c,action.first_frame);
    let complete=false;const running=f.model.animate({objectIndex,state:2}).then(()=>{complete=true;});
    let now=0,visits=0;
    const visit=()=>{
      now+=100;f.model.update(now,{world:f.world});oracle.run(0x4137c0,[objectIndex,now]);
      assert.equal(f.actor.frame,oracle.read(base+0x22),`${mapId}/${now} logical`);
      assert.equal(f.actor.actionIndex,oracle.read(base+0xd5),`${mapId}/${now} action`);
      assert.equal(f.actor.resource.actions[f.actor.displayActionIndex].first_frame+f.actor.object.motion.frame,
        oracle.read(base+0x3c),`${mapId}/${now} physical`);
      assert.equal(f.actor.object.layer,oracle.read(base+0xce,1),`${mapId}/${now} layer`);
    };
    while(f.actor.pending&&visits++<100)visit();
    assert.equal(f.actor.pending,null);await running;assert.equal(complete,true);assert.equal(f.actor.commandState,3);
    // CF9's first completed tick retains the old action1 physical-frame base
    // once while it switches its cursor to action2. Readable state3 loads use
    // action2 frame0 immediately; these are distinct original source paths.
    for(let tail=0;tail<12;tail++)visit();
    assert.equal(oracle.read(base+0xd0,1),3);assert.deepEqual(f.world,before);
  }
});

test('both CF2 source objects write their physical terrain frames, restore the last frame and roll back cancelled terrain',async()=>{
  for(const [mapId,objectIndex,x,y]of [['M72050',11,53,33],['M72061',0,30,25]]){
    const f=await fixture(mapId,objectIndex),before=copy(f.world),action=f.actor.resource.actions[0];f.model.update(0,{world:f.world});
    assert.deepEqual([f.actor.object.cell_x,f.actor.object.cell_y],[x,y]);assert.equal(f.row.resource.terrain_frames.length,20);
    const initial=[...f.movement.rows],abort=new AbortController(),cancelled=f.model.animate({objectIndex,state:2,signal:abort.signal});
    for(const now of [100,200,300,400,500,600])f.model.update(now,{world:f.world});
    abort.abort(new Error('CF2 terrain cancelled'));await assert.rejects(cancelled,/CF2 terrain cancelled/);
    assert.deepEqual(f.movement.rows,initial);assert.equal(f.actor.pending,null);assert.equal(f.actor.frame,0);
    const running=f.model.animate({objectIndex,state:2});let now=600,frames=new Set([0]);
    for(let visit=0;visit<100&&f.actor.pending;visit++){
      now+=100;f.model.update(now,{world:f.world});const physical=action.first_frame+f.actor.object.motion.frame;frames.add(physical);
      for(const [dx,dy,raw]of f.row.resource.terrain_frames[physical])assert.equal(f.movement.rows[y+dy][x+dx],raw===2?'0':'1');
    }
    assert.equal(f.actor.pending,null);await running;assert.deepEqual([...frames],[...Array(20).keys()]);
    assert.equal(f.actor.object.motion.frame,19);
    for(let dy=0;dy<5;dy++)for(let dx=0;dx<5;dx++)assert.notEqual(f.movement.cell(x+dx,y+dy).reason,'terrain');
    assert.deepEqual(f.world,before);
    const restored=await fixture(mapId,objectIndex,3);restored.model.update(0,{world:restored.world});
    assert.equal(restored.actor.frame,19);assert.equal(restored.actor.object.motion.frame,19);
    assert.equal(restored.actor.object.layer,mapId==='M72061'?1:2);
    for(let dy=0;dy<5;dy++)for(let dx=0;dx<5;dx++)assert.notEqual(restored.movement.cell(x+dx,y+dy).reason,'terrain');
    assert.deepEqual(restored.movement.rows,f.movement.rows);
  }
});
