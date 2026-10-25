// Source032/004 status blocks and the original x86 application/tick instructions.
// Resource copy, command UI and periodic response/death presentation are
// explicit oracle boundaries; this does not execute GAME.exe.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {createNativeRng} from '../web/core/combat_rules.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {createForestSample} from '../web/forest_sample.mjs';
import {initializeScheduler} from '../web/core/battle_scheduler.mjs';
import {validateForestStatusData,validateNativeSkillStatus,initializeNativeStatuses,clearNativeStatuses,applyNativeSkillStatus,
  tickNativeStatuses,applyNativePeriodicResourceBlock} from '../web/core/battle_status.mjs';
const json=async name=>JSON.parse(await readFile(new URL(`../${name}`,import.meta.url),'utf8'));
const hash=raw=>createHash('sha256').update(raw).digest('hex'),copy=structuredClone,ZERO='00'.repeat(0xc6),addr=n=>`0x${n.toString(16).padStart(8,'0')}`;
const [baseData,instructions,seed,base,forest,skills,scheduler]=await Promise.all(['web/data/forest_status.json','evidence/forest_status_instructions_20261011.json',
  'web/data/route_seed.json','web/data/combat_sample.json','web/data/forest_combat.json','web/data/skills.json','web/data/battle_scheduler.json'].map(json));
const source=await readFile(new URL('../../../Fight_Role/032.CHR',import.meta.url)),data=copy(baseData),content=copy(runtimeContent);
content.roles['032']={side:'enemy',source:{path:'Fight_Role/032.CHR',sha256:hash(source)}};data.effects??={};
const offsets=[10446,13083,16072,18709,21698];
for(const [n,offset]of offsets.entries()){
  const index=7+n,fixed=source.subarray(offset,offset+0x41d),block=fixed.subarray(0x16b,0x231),id=block[1];
  data.skills[`032:${index}`]={actor_id:'032',index,fixed_raw_hex:fixed.toString('hex'),effect_raw_hex:block.toString('hex'),effect_id_raw:id,mode_raw:block[0xb],
    source:{path:'Fight_Role/032.CHR',sha256:hash(source),fixed_offset:offset,block_offset:offset+0x16b}};
  const name=`Fight_Role/Status/${String(id).padStart(3,'0')}.dgp`,bytes=await readFile(new URL(`../../../${name}`,import.meta.url));
  assert.equal(bytes[0],9);assert.equal(bytes.readUInt32LE(2),1);
  const action=bytes.subarray(67,67+0xac);data.effects[id]={id_raw:id,interval_ms:action.readUInt32LE(1),frame_count:action[14],
    source:{path:name,sha256:hash(bytes),action_raw_hex:action.toString('hex')}};
}
const source004=await readFile(new URL('../../../Fight_Role/004.CHR',import.meta.url)),playerStatusIndices=[25,27,29,31];
content.roles['004']={...content.roles['004'],side:'player',native_slot:3,source:{path:'Fight_Role/004.CHR',sha256:hash(source004)}};
let offset004=8+0x30b;
for(let index=0;index<source004.readUInt32LE(8);index++){
  const fixed=source004.subarray(offset004,offset004+0x41d),actionCount=fixed.readUInt32LE(0x15);
  if(playerStatusIndices.includes(index)){
    const block=fixed.subarray(0x16b,0x231),id=block[1];
    data.skills[`004:${index}`]={actor_id:'004',index,fixed_raw_hex:fixed.toString('hex'),effect_raw_hex:block.toString('hex'),effect_id_raw:id,mode_raw:block[0xb],
      source:{path:'Fight_Role/004.CHR',sha256:hash(source004),fixed_offset:offset004,block_offset:offset004+0x16b}};
    const name=`Fight_Role/Status/${String(id).padStart(3,'0')}.dgp`,bytes=await readFile(new URL(`../../../${name}`,import.meta.url));
    assert.equal(bytes[0],9);assert.equal(bytes.readUInt32LE(2),1);
    const action=bytes.subarray(67,67+0xac);data.effects[id]={id_raw:id,interval_ms:action.readUInt32LE(1),frame_count:action[14],
      source:{path:name,sha256:hash(bytes),action_raw_hex:action.toString('hex')}};
  }
  offset004+=0x41d+actionCount*0xb0;
}
assert.equal(offset004,source004.length);
validateForestStatusData(data,content);
const recovery=await json('evidence/battle_revive_recovery_native_20261015.json'),functions=copy(instructions.instructions);
for(const record of recovery.records)functions[record.parameters.procedure]=record.normalized_result.trim().split(/\r?\n/);
function actor(){
  const sample=createForestSample(seed,base,forest,{map_id:'M70010',members:[{id:'012'}]},skills,scheduler);initializeScheduler(sample.actors,scheduler);
  return initializeNativeStatuses(sample.actors[0],data,content);
}
function args(block){const raw=Buffer.alloc(200);Buffer.from(block,'hex').copy(raw);return [0,...Array.from({length:50},(_,i)=>raw.readInt32LE(i*4))];}
class Oracle extends NativeAssemblyOracle{
  constructor(a,rng,threshold=1000,skillTest=0){
    super(functions,[a],rng);this.periodic=[];this.deaths=0;this.write(0x679c74,threshold);this.write(0x55ee004,skillTest);
    a.native_status_slots.forEach((row,index)=>Buffer.from(row.raw_hex,'hex').forEach((value,at)=>this.write(0x521a7d2+index*0xc6+at,value,1)));
    this.write(0x521f52a,a.status_flags_raw);
    for(const id of [...Object.keys(data.effects).map(Number),43]){
      const meta=id===43?data.status43:data.effects[id],pointer=0x30000000+id*0x10000;
      this.write(0x55eb0c3+(id-1)*0xeb,pointer);this.write(0x55eb0cb+(id-1)*0xeb,meta.frame_count);this.write(pointer+1,meta.interval_ms);
    }
  }
  regRead(name){return name==='BL'?this.reg.EBX&255:super.regRead(name);}
  regWrite(name,value){if(name==='BL')this.reg.EBX=(this.reg.EBX&~255)|(value&255);else super.regWrite(name,value);}
  external(target){const arg=i=>this.read(this.reg.ESP+i*4);
    if(target===0x570a40){for(let i=0;i<arg(2);i++)this.write(arg(0)+i,arg(1),1);this.reg.EAX=arg(0);return;}
    if(target===0x570d10){const raw=Array.from({length:arg(2)},(_,i)=>this.read(arg(1)+i,1));raw.forEach((value,i)=>this.write(arg(0)+i,value,1));this.reg.EAX=arg(0);return;}
    if(target===0x507c60){this.write(arg(0),(this.read(arg(0))|(arg(1)&0x3ff))>>>0);return;}
    if(target===0x401609){assert.equal(this.read(0x521a7c6,1),6);return;}
    if(target===0x51c640){this.periodic.push(arg(1));return;}
    if(target===0x4ffe90){
      this.deaths++;this.write(0x521a77b,5,1);this.write(0x521f52a,0);
      for(let at=0;at<0xc6;at++)this.write(0x521f52e+at,0,1);
      for(let at=0;at<100*0xc6;at++)this.write(0x521a7d2+at,0,1);return;
    }
    return super.external(target);
  }
  compare(a){
    assert.equal(this.read(0x521f52a)>>>0,a.status_flags_raw);
    for(const field of data.aggregation)assert.equal(this.read(Number(field.address),field.bits===8?1:4),a.status_by_address[field.address],field.address);
    for(let index=0;index<100;index++)assert.equal(Buffer.from(Array.from({length:0xc6},(_,at)=>this.read(0x521a7d2+index*0xc6+at,1))).toString('hex'),a.native_status_slots[index].raw_hex,`slot${index}`);
    for(const [field,n]of [['raw_hp',0x524a701],['raw_hp_maximum',0x524a705],['raw_mp',0x524a709],['raw_mp_maximum',0x524a70d]])assert.equal(this.read(n),a[field],field);
    assert.equal(this.read(0x521a77b,1),a.state_raw);
  }
}
function apply(a,key,seedValue){
  const before=copy(a),rng=createNativeRng(seedValue),oracleRng=createNativeRng(seedValue),oracle=new Oracle(a,oracleRng.next.bind(oracleRng));
  const result=applyNativeSkillStatus({actor:a,skill:data.skills[key],data,content,rng,now:0});
  oracle.run(0x508a90,[0]);oracle.run(0x508bb0,args(data.skills[key].effect_raw_hex));oracle.compare(result.actor);
  assert.equal(result.native_return,oracle.reg.EAX);assert.deepEqual(result.trace.filter(row=>row.kind==='rng').map(row=>row.raw),oracle.rng_calls);
  assert.equal(rng.state,oracleRng.state);assert.deepEqual(a,before);return result;
}

test('every admitted boss status is bound to its original CHR block and own native DGP timing',()=>{
  assert.deepEqual(offsets.map((_,n)=>[data.skills[`032:${7+n}`].effect_id_raw,data.skills[`032:${7+n}`].mode_raw]),[[2,2],[15,0],[30,0],[48,0],[6,0]]);
  assert.deepEqual([2,6,15,30,48].map(id=>[data.effects[id].interval_ms,data.effects[id].frame_count]),[[80,21],[80,4],[80,22],[80,16],[80,10]]);
  for(let n=7;n<12;n++)validateNativeSkillStatus(data.skills[`032:${n}`],data);
  const periodic=Buffer.from(data.skills['032:8'].effect_raw_hex,'hex');assert.equal(periodic[0x10],1);assert.equal(periodic.readInt32LE(0x23),-100);
});

test('mode0/2 application, removal-before-duplicate, aggregates and CRT state match native x86',()=>{
  for(const key of ['032:7','032:8','032:9','032:10','032:11'])for(const seedValue of [0,1,99,12345]){
    let a=actor();a=apply(a,key,seedValue).actor;a=apply(a,key,seedValue+1).actor;apply(a,'012:14',seedValue+2);
  }
  const permanent=apply(actor(),'032:7',0).actor;assert.equal(permanent.status_flags_raw,8);assert.equal(Buffer.from(permanent.native_status_slots[0].raw_hex,'hex').readInt32LE(2),-1);
  const confused=apply(actor(),'032:11',0).actor;assert.equal(confused.status_flags_raw,0x10);assert.equal(confused.status_by_address['0x0521f52a'],0x10);
});

test('all four admitted004 source statuses match native application, aggregates, timing and complete expiry',()=>{
  assert.deepEqual(playerStatusIndices.map(index=>[data.skills[`004:${index}`].effect_id_raw,data.skills[`004:${index}`].mode_raw]),[[32,0],[12,0],[28,0],[26,0]]);
  assert.deepEqual([32,12,28,26].map(id=>[data.effects[id].interval_ms,data.effects[id].frame_count]),Array(4).fill([80,16]));
  for(const index of playerStatusIndices){
    const skill=data.skills[`004:${index}`];validateNativeSkillStatus(skill,data);assert.equal(Buffer.from(skill.fixed_raw_hex,'hex')[0x23],1);
    for(const seedValue of [0,1,99,12345]){
      let a=apply(actor(),`004:${index}`,seedValue).actor;
      assert.equal(Buffer.from(a.native_status_slots[0].raw_hex,'hex')[1],skill.effect_id_raw);
      a=apply(a,`004:${index}`,seedValue+1).actor;
      const oracle=new Oracle(a,()=>{throw Error('Nonperiodic status tick cannot draw RNG');},500);
      for(let tick=1;tick<=10;tick++){
        const before=copy(a),result=tickNativeStatuses({actor:a,threshold:500,now:tick*80,data,content,rng:()=>{throw Error('Unexpected status RNG');}});
        oracle.run(0x509e10,[tick*80,0]);oracle.compare(result.actor);assert.deepEqual(a,before);assert.equal(result.ticks,1);a=result.actor;
      }
      assert.ok(a.native_status_slots.every(row=>row.raw_hex===ZERO));assert.equal(a.status_flags_raw,0);
    }
  }
});

test('source mode2 contact removal consumes RNG before the inclusive zero/10/11/99 boundary',()=>{
  const applied=apply(actor(),'032:7',0).actor,dormant=Object.values(data.skills).find(skill=>skill.effect_id_raw===0);
  assert.equal(dormant.effect_id_raw,0);
  for(const roll of [0,10,11,99]){
    let draws=0,nativeDraws=0;
    const actual=applyNativeSkillStatus({actor:applied,skill:dormant,data,content,now:0,rng:()=>{draws++;return roll;}});
    const oracle=new Oracle(applied,()=>{nativeDraws++;return roll;});oracle.run(0x508a90,[0]);oracle.run(0x508bb0,args(dormant.effect_raw_hex));oracle.compare(actual.actor);
    assert.equal(draws,1);assert.equal(nativeDraws,1);assert.equal(actual.actor.native_status_slots[0].raw_hex===ZERO,roll<=10);
  }
});

test('periodic 41BFB0 raw HP, threshold spill, negative duration and response callback match native ticks',()=>{
  for(const hp of [1000,100,70])for(const skillTest of [0,1]){
    let a=apply(actor(),'032:8',0).actor;a.raw_hp=hp;a.raw_by_address[addr(0x524a701)]=hp;a.hp.current=hp+a.resource_bonuses.hp_current;
    const before=copy(a),calls=[],oracle=new Oracle(a,()=>{throw Error('Numeric periodic boundary must not invent RNG');},500,skillTest);
    const result=tickNativeStatuses({actor:a,threshold:500,now:80,data,content,global_055ee004:skillTest,rng:()=>{throw Error('Unexpected numeric RNG');},
      onPeriodicEffect:({actor,effect,damageResult,reaction_requested})=>{
        if(damageResult.death_requested){const clean=clearNativeStatuses(actor,data,content);clean.state_raw=5;return {actor:clean};}
        if(reaction_requested)calls.push(effect.reaction_argument_raw);return {actor};
      }});
    oracle.run(0x509e10,[80,0]);oracle.compare(result.actor);assert.deepEqual(calls,oracle.periodic);assert.deepEqual(a,before);
    assert.equal(result.ticks,1);assert.equal(result.death_requested,oracle.deaths>0);
    if(result.death_requested){const raw=Buffer.from(result.actor.native_status_slots[0].raw_hex,'hex');assert.equal(raw[1],0);assert.equal(raw.readInt32LE(2),-1);}
    else assert.equal(Buffer.from(result.actor.native_status_slots[0].raw_hex,'hex').readInt32LE(2),-2);
  }
});

test('periodic percentage damage and signed MP/max changes follow 41BFB0 arithmetic without equipment death substitution',()=>{
  for(const percent of [0,-10,-100])for(const hp of [30,800]){
    const a=actor(),block=Buffer.from(data.skills['032:8'].effect_raw_hex,'hex');
    block.writeInt32LE(percent?0:-100,0x23);block.writeInt32LE(percent,0x43);block.writeInt32LE(-10,0x2b);block.writeInt32LE(-7,0x2f);
    a.raw_hp=hp;a.raw_by_address[addr(0x524a701)]=hp;a.hp.current=hp+a.resource_bonuses.hp_current;
    const actual=applyNativePeriodicResourceBlock({actor:a,effect_raw_hex:block.toString('hex')}),oracle=new Oracle(a,()=>{throw Error('No periodic resource RNG');});
    oracle.run(0x41bfb0,args(block.toString('hex')));
    assert.equal(actual.actor.raw_hp,oracle.read(0x524a701));assert.equal(actual.actor.raw_mp,oracle.read(0x524a709));assert.equal(actual.actor.raw_mp_maximum,oracle.read(0x524a70d));
    assert.equal(actual.native_return,oracle.reg.EAX);
  }
});
