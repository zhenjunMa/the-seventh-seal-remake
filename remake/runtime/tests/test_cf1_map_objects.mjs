// Source bytes + retained 410850/4137C0 instructions, never a translated fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MapObjectRuntime} from '../web/core/map_objects.mjs';
import {createNativeRng} from '../web/core/combat_rules.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
const root=new URL('../../../',import.meta.url),runtime=new URL('../',import.meta.url);
const json=async path=>JSON.parse(await readFile(new URL(path,runtime),'utf8'));
const audit=await json('evidence/fire_valley_20261025/object_closure_audit.json');
const [init,tick]=await Promise.all(['object_queue_assembly','object_tick_4137c0_assembly'].map(name=>json(`evidence/fire_valley_20261025/${name}.json`)));
const functions={'0x410850':init.normalized_result.split(/\r?\n/),'0x4137c0':tick.normalized_result.split(/\r?\n/)};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const executable=await readFile(new URL('GAME.exe',root));
assert.equal(hash(executable),init.subject.digest.sha256);assert.equal(hash(executable),tick.subject.digest.sha256);
const cache=new Map();
async function sourceMap(mapId){
  if(cache.has(mapId))return cache.get(mapId);
  const map=audit.maps.find(map=>map.id===mapId),bytes=await readFile(new URL(map.source.path,root));
  assert.equal(hash(bytes),map.source.sha256);
  const native=[];const resources=[];
  for(const row of audit.objects.filter(row=>row.map_id===mapId)){
    const raw=bytes.subarray(row.source_record_offset,row.source_record_offset+274),dgp=await readFile(new URL(row.resource,root));
    assert.equal(hash(raw),row.raw_sha256);native.push({raw,dgp});
    if(row.cf!==1||!row.action_count)continue;
    const observed=audit.animated_resources[row.resource];assert.equal(hash(dgp),observed.sha256);
    const a=dgp.subarray(67,239),count=a.readUInt32LE(14);
    resources.push({index:row.index,behavior_raw_cf:1,map_id:mapId,source_record_offset:row.source_record_offset,
      source_record_raw_hex:raw.toString('hex'),fixed_clock_raw_b4:raw[0xb4],initial_frame_raw:raw.readUInt32LE(0x3c),
      resource:{source:{path:row.resource,sha256:hash(dgp)},frame_width:observed.width,frame_height:observed.height,
        actions:[{index:0,frame_count:count,directions:1,interval_raw:a.readUInt32LE(1),first_frame:a.readUInt32LE(0x72),
          source_action_raw_hex:a.toString('hex'),logical_frames:Array.from({length:count},(_,i)=>i),
          main_bitmap:{source:row.resource,channel:'main'},intrinsic_bitmap:{source:row.resource,channel:'intrinsic'}}]}});
  }
  const result={mapId,mapFlagIndex:bytes.readUInt32LE(0x92),native,resources};cache.set(mapId,result);return result;
}
const mapIds=[...new Set(audit.summary.missing_visible_cf1_animation_placements.map(row=>row.map_id)), 'M17010','M17020','M17024'];
const maps=await Promise.all([...new Set(mapIds)].map(sourceMap));
async function handoffSourceMap(mapId,expectedSha){
  const bytes=await readFile(new URL(`Map/${mapId.toLowerCase()}.dat`,root));assert.equal(hash(bytes),expectedSha);
  const width=bytes.readUInt32LE(0x146),height=bytes.readUInt32LE(0x14a),descriptorBytes=bytes.readUInt32LE(0x18)===1?0x42:0x2b;
  const start=0x172+width*height*64+32*(0x2a+descriptorBytes+0x1b+0x110),count=bytes.readUInt32LE(0x82);
  const base=bytes.subarray(0x14e,0x16e).toString('ascii').split('\0')[0].replaceAll('\\','/').replace(/^\.\//,'').replace(/\/+$/,'').toLowerCase();
  assert.equal(base,`mapm/${mapId.toLowerCase()}`);
  const native=[],resources=[];
  for(let index=0;index<count;index++){
    const offset=start+index*274,raw=bytes.subarray(offset,offset+274),path=`${base}/${String(raw.readUInt32LE(0x1e)).padStart(3,'0')}.dgp`;
    const dgp=await readFile(new URL(path,root));native.push({raw,dgp});
    if(raw[0xcf]!==1||!dgp[2])continue;
    assert.equal(dgp[0],9);assert.equal(dgp[2],1);
    const a=dgp.subarray(67,239),physical=a.readUInt32LE(14),logical=a[13]===0?a.readUInt32LE(0x12):physical;
    const geometry=67+dgp[2]*172;
    resources.push({index,behavior_raw_cf:1,map_id:mapId,source_record_offset:offset,
      source_record_raw_hex:raw.toString('hex'),fixed_clock_raw_b4:raw[0xb4],initial_frame_raw:raw.readUInt32LE(0x3c),
      resource:{source:{path,sha256:hash(dgp)},frame_width:dgp.readUInt16LE(geometry),frame_height:dgp.readUInt16LE(geometry+2),
        actions:[{index:0,frame_count:physical,directions:1,interval_raw:a.readUInt32LE(1),first_frame:a.readUInt32LE(0x72),
          source_action_raw_hex:a.toString('hex'),logical_frames:a[13]===0?[...a.subarray(0x16,0x16+logical)]:Array.from({length:logical},(_,i)=>i),
          main_bitmap:{source:path,channel:'main'},intrinsic_bitmap:{source:path,channel:'intrinsic'}}]}});
  }
  return {mapId,mapFlagIndex:bytes.readUInt32LE(0x92),native,resources};
}
const handoffs=await Promise.all([
  handoffSourceMap('M01060','5ff8f2a3c43649fff1efc4eccd878f4a662d905f6ba3404948e47ec9240a3826'),
  handoffSourceMap('M01065','2ca9d09e6c3b42814d0e6112ea17384e3796bbbe3660aa25c61503b407cb9aa5'),
]);
const make=(map,seed=1,resources=map.resources)=>{
  const rng=createNativeRng(seed),world={revision:6,event_records:[],object_states:{},flags:[],encounter_state:{rng_state:123}},objects=resources.map(row=>({index:row.index}));
  const model=new MapObjectRuntime({objects,resources:structuredClone(resources),mapFlagIndex:map.mapFlagIndex,mapId:map.mapId,random:rng});
  return {model,world,objects,rng};
};
function oracleFor(map,seed){
  const rng=createNativeRng(seed),oracle=new NativeAssemblyOracle(functions,[],rng),baseExternal=oracle.external.bind(oracle);
  // Queue reset, zero saved-state projection, and occupancy rebuild are outside
  // the numeric clock. These actual fixtures have no links/saved records.
  oracle.external=target=>[0x401019,0x401113,0x40173a].includes(target)?undefined:baseExternal(target);
  oracle.write(0x518c800,0,1);oracle.write(0x504b24a,map.native.length);oracle.write(0x2b7ba88,0x22000000);
  for(const [index,{raw,dgp}]of map.native.entries()){
    raw.forEach((value,i)=>oracle.write(0x22000000+index*274+i,value,1));
    oracle.write(0x22000000+index*274+0xd1,dgp[2]);
    const id=raw.readUInt32LE(0x1e)-1,address=0x23000000+id*4096;
    oracle.write(0x2b42492+id*235,dgp[2],1);oracle.write(0x2b424d3+id*235,address);
    dgp.subarray(67,67+dgp[2]*172).forEach((value,i)=>oracle.write(address+i,value,1));
  }
  oracle.run(0x410850,[]);return {oracle,rng};
}

test('all32 real CF1 placements preserve 410850 FF draw then interval draw, source order and initial frame0',()=>{
  assert.equal(maps.reduce((sum,map)=>sum+map.resources.length,0),32);
  for(const map of maps)for(const seed of [0,1,7,42,0x12345678,0xffffffff]){
    const {model,rng}=make(map,seed,[...map.resources].reverse()),{oracle,rng:nativeRng}=oracleFor(map,seed);
    for(const actor of model.actors){const base=0x22000000+actor.object.index*274;
      assert.equal(actor.ffRaw,oracle.read(base+0xff,1));assert.equal(actor.interval,oracle.read(base+0xd9)>>>0);
      assert.equal(actor.frame,0);assert.equal(actor.object.motion.frame,oracle.read(base+0x3c));
    }
    assert.equal(rng.state,nativeRng.state);assert.equal(oracle.rng_calls.length,map.resources.length*2);
  }
});

test('4137C0 real single-action frames match every native visit including overshoot and wrapping without extra RNG',()=>{
  let compared=0;
  for(const map of maps)for(const seed of [0,77327]){
    const {model,world,rng}=make(map,seed),{oracle,rng:nativeRng}=oracleFor(map,seed);let now=0;
    model.update(now,{world});
    for(let visit=0;visit<35;visit++){
      now+=[37,89,123,249,1][visit%5];model.update(now,{world});
      for(const actor of model.actors){oracle.run(0x4137c0,[actor.object.index,now]);
        assert.equal(actor.object.motion.frame,oracle.read(0x22000000+actor.object.index*274+0x3c),`${map.mapId}/${actor.object.index}/${now}`);compared++;
      }
      assert.equal(rng.state,nativeRng.state);
    }
  }
  assert.equal(compared,2240);
});

test('M01060 CF1 sources retain logical FF modulus and every 4137C0 explicit-table visit with unchanged RNG',()=>{
  assert.deepEqual(handoffs.map(map=>map.resources.length),[26,7]);
  const explicit=handoffs[0].resources.filter(row=>Buffer.from(row.resource.actions[0].source_action_raw_hex,'hex')[13]===0);
  assert.equal(explicit.length,10);
  for(const row of explicit){
    assert.equal(row.resource.actions[0].frame_count,5);
    assert.deepEqual(row.resource.actions[0].logical_frames,[0,1,2,3,4,3,2,1,0]);
  }
  let compared=0;
  // M01060's actual animation queue is entirely CF1. M01065 additionally
  // initializes a CF7 object; its wider global CRT schedule is outside
  // this CF1 scene-local adaptation and is not silently stubbed from this run.
  for(const map of handoffs.filter(map=>map.mapId==='M01060'))for(const seed of [0,1,7,42,0x12345678,0xffffffff]){
    const actual=make(map,seed,[...map.resources].reverse()),native=oracleFor(map,seed);let now=0;
    actual.model.update(now,{world:actual.world});
    for(const actor of actual.model.actors){
      const base=0x22000000+actor.object.index*274;
      assert.equal(actor.ffRaw,native.oracle.read(base+0xff,1));
      assert.equal(actor.interval,native.oracle.read(base+0xd9)>>>0);
      assert.equal(actor.object.motion.frame,0);
    }
    assert.equal(actual.rng.state,native.rng.state);
    assert.equal(native.oracle.rng_calls.length,map.resources.length*2);
    for(let visit=0;visit<45;visit++){
      now+=[37,89,123,249,1][visit%5];actual.model.update(now,{world:actual.world});
      for(const actor of actual.model.actors){
        const base=0x22000000+actor.object.index*274;
        native.oracle.run(0x4137c0,[actor.object.index,now]);
        assert.equal(actor.frame,native.oracle.read(base+0x22),`${map.mapId}/${actor.object.index}/${now}/logical`);
        assert.equal(actor.object.motion.frame,native.oracle.read(base+0x3c),`${map.mapId}/${actor.object.index}/${now}/physical`);compared++;
      }
      assert.equal(actual.rng.state,native.rng.state,'single-action wraps do not draw more CRT values');
      assert.equal(native.oracle.rng_calls.length,map.resources.length*2);
    }
  }
  assert.equal(compared,7020);
});

test('real nine-step CF1 sequence preserves its return leg, hidden updates, pause, and source save reconstruction',()=>{
  const map=handoffs[0],single=structuredClone(map.resources.filter(row=>row.index===13)),actual=make(map,77327,single),actor=actual.model.actors[0];
  const before=structuredClone(actual.world),rng=actual.rng.state,sequence=[0];let now=0;
  actual.model.update(0,{world:actual.world});
  for(let step=0;step<18;step++){
    now+=actor.interval;actual.model.update(now,{world:actual.world});sequence.push(actor.object.motion.frame);
  }
  assert.deepEqual(sequence,[0,1,2,3,4,3,2,1,0,0,1,2,3,4,3,2,1,0,0]);
  actor.object.hidden=true;now+=actor.interval;actual.model.update(now,{world:actual.world});assert.equal(actor.object.motion.frame,1);
  const logical=actor.frame;now+=actor.interval;actual.model.update(now,{world:actual.world,paused:true});assert.equal(actor.frame,logical);
  actual.model.update(now+10000,{world:actual.world});assert.equal(actor.frame,logical);
  assert.equal(actual.rng.state,rng);assert.deepEqual(actual.world,before);
  const restored=make(map,91,single),restoredActor=restored.model.actors[0];restored.world=structuredClone(before);
  restored.model.update(0,{world:restored.world});assert.equal(restoredActor.frame,0);assert.equal(restoredActor.object.motion.frame,0);
  // Retained 40CFE0 ev_491fb7... restores +22 to logical_count-1, maps
  // action+16 to its physical frame, and maps +0D's high nibble to layer2.
  const completed=make(map,91,single),last=completed.model.actors[0];completed.world.event_records[map.mapFlagIndex]=[];
  completed.world.event_records[map.mapFlagIndex][last.object.index]='0300000000000000000000000000';
  const saved=structuredClone(completed.world);completed.model.update(0,{world:completed.world});
  assert.equal(last.frame,8);assert.equal(last.object.motion.frame,0);assert.equal(last.object.layer,2);
  completed.model.update(last.interval,{world:completed.world});assert.equal(last.frame,0);assert.equal(last.object.motion.frame,0);
  completed.model.update(last.interval*2,{world:completed.world});assert.equal(last.object.motion.frame,1);
  assert.deepEqual(completed.world,saved);
});

test('explicit sequence validation rejects raw-table bounds, physical references and generated metadata drift',()=>{
  const map=handoffs[0],source=map.resources.find(row=>row.index===13);
  for(const mutate of [
    (a,v)=>v.setUint32(0x12,0,true),(a,v)=>v.setUint32(0x12,0x5d,true),(a)=>{a[0x16]=5;},
    (a,v,row)=>{row.resource.actions[0].logical_frames[5]=4;},
  ]){
    const row=structuredClone(source),bytes=Uint8Array.from(Buffer.from(row.resource.actions[0].source_action_raw_hex,'hex'));
    mutate(bytes,new DataView(bytes.buffer),row);row.resource.actions[0].source_action_raw_hex=Buffer.from(bytes).toString('hex');
    assert.throws(()=>make(map,1,[row]),/CF1/);
  }
  // Initialization writes displayed +3C=0 independently of action+16[0].
  // A bounded alternate source table therefore starts at0 until its first
  // clock visit; the logical visit still advances to table entry1.
  const alternate=structuredClone(source),raw=Buffer.from(alternate.resource.actions[0].source_action_raw_hex,'hex');
  raw[0x16]=2;alternate.resource.actions[0].source_action_raw_hex=raw.toString('hex');alternate.resource.actions[0].logical_frames[0]=2;
  const actual=make(map,1,[alternate]),actor=actual.model.actors[0];assert.equal(actor.object.motion.frame,0);
  actual.model.update(0,{world:actual.world});assert.equal(actor.object.motion.frame,0);
  actual.model.update(actor.interval,{world:actual.world});assert.equal(actor.object.motion.frame,1);
});

test('pause and background suspension discard time; render-hidden objects still update; scenes remain independent',()=>{
  const map=maps.find(map=>map.mapId==='M17023'),a=make(map),b=make(map),before=structuredClone(a.world),actor=a.model.actors[0];
  a.model.update(0,{world:a.world});b.model.update(0,{world:b.world});
  a.model.update(actor.interval,{world:a.world});assert.equal(actor.frame,1);assert.equal(b.model.actors[0].frame,0);
  a.model.update(actor.interval+50,{world:a.world,paused:true});a.model.update(10000,{world:a.world});assert.equal(actor.frame,1);
  a.world.object_states[`${map.mapId}:${actor.object.index}`]={visible:false};actor.object.hidden=true;
  a.model.update(10000+actor.interval,{world:a.world});assert.equal(actor.frame,2);
  assert.equal(b.model.actors[0].frame,0);delete a.world.object_states[`${map.mapId}:${actor.object.index}`];assert.deepEqual(a.world,before);
  assert.equal(a.rng.state,b.rng.state,'ticks never consume RNG for one action');
});

test('load reconstruction redraws interval/FF and starts at0 or the native completed-state last frame, then keeps looping',()=>{
  const map=maps.find(map=>map.mapId==='M17030-1'),a=make(map,91),saved=structuredClone(a.world);let now=0;
  a.model.update(now,{world:a.world});now+=a.model.actors[0].interval;a.model.update(now,{world:a.world});
  const b=make(map,92);b.world=structuredClone(saved);b.model.update(0,{world:b.world});assert.equal(b.model.actors[0].frame,0);
  const c=make(map,92),first=c.model.actors[0];c.world.event_records[map.mapFlagIndex]=[];
  c.world.event_records[map.mapFlagIndex][first.object.index]='0300000000000000000000000000';
  const before=structuredClone(c.world);c.model.update(0,{world:c.world});assert.equal(first.frame,11);
  c.model.update(first.interval,{world:c.world});assert.equal(first.frame,0);assert.deepEqual(c.world,before);
  assert.notEqual(a.rng.state,b.rng.state,'separate load draws a new visual clock, independent of save RNG');
});

test('source binding rejects unsupported multi-action/mode/sequence/sound/interval and metadata drift',()=>{
  const map=maps.find(map=>map.mapId==='M17023');
  const alter=(row,offset,value)=>{const raw=Buffer.from(row.resource.actions[0].source_action_raw_hex,'hex');raw[offset]=value;row.resource.actions[0].source_action_raw_hex=raw.toString('hex');};
  for(const change of [r=>delete r.source_record_raw_hex,r=>{r.fixed_clock_raw_b4=1;},r=>{r.resource.actions.push(structuredClone(r.resource.actions[0]));},
    r=>{const raw=Buffer.from(r.source_record_raw_hex,'hex');raw.writeUInt32LE(1,0xf6);r.source_record_raw_hex=raw.toString('hex');},
    r=>alter(r,13,0),r=>alter(r,0,1),r=>alter(r,1,1),r=>alter(r,0x56,65),r=>alter(r,0x84,1),r=>alter(r,0x72,1),
    r=>{r.resource.actions[0].logical_frames[0]=2;},r=>{r.map_id='M17030';}]){
    const resources=structuredClone(map.resources);change(resources[0]);assert.throws(()=>make(map,1,resources),/地图|CF1/);
  }
  assert.throws(()=>new MapObjectRuntime({objects:[{index:0}],resources:[{...map.resources[0],index:0}],mapFlagIndex:0,random:()=>0.5}),/CRT/);
});

test('fixed source B4 clock consumes only the FF initialization draw, as the native branch does',()=>{
  const original=maps.find(map=>map.mapId==='M17023'),map=structuredClone(original);
  const objectIndex=map.resources[0].index;
  map.native[objectIndex].raw=Buffer.from(map.native[objectIndex].raw);map.native[objectIndex].raw[0xb4]=1;
  map.native=map.native.map(row=>({raw:Buffer.from(row.raw),dgp:Buffer.from(row.dgp)}));
  const raw=Buffer.from(map.resources[0].source_record_raw_hex,'hex');raw[0xb4]=1;
  map.resources[0].source_record_raw_hex=raw.toString('hex');map.resources[0].fixed_clock_raw_b4=1;
  const actual=make(map,173),native=oracleFor(map,173);
  assert.equal(actual.model.actors[0].interval,90);assert.equal(actual.rng.state,native.rng.state);
  assert.equal(actual.model.actors[0].ffRaw,native.oracle.read(0x22000000+objectIndex*274+0xff,1));
  assert.equal(native.oracle.rng_calls.length,map.resources.length*2-1);
});
