// Original x86 instructions are the application/aggregate/tick oracle.
// Resource allocation/copy/debug calls are explicit bounded hooks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {createNativeRng,elementalTerms} from '../web/core/combat_rules.mjs';
import {validateForestStatusData,initializeNativeStatuses,clearNativeStatuses,applyNativeSkillStatus,tickNativeStatuses} from '../web/core/battle_status.mjs';
const data=JSON.parse(await readFile(new URL('../web/data/forest_status.json',import.meta.url)));
const instruction=JSON.parse(await readFile(new URL('../evidence/forest_status_instructions_20261011.json',import.meta.url)));
const sample=JSON.parse(await readFile(new URL('../web/data/combat_sample.json',import.meta.url)));
const native=JSON.parse(await readFile(new URL('../evidence/forest_status_native_20261011.json',import.meta.url)));
const clone=structuredClone,sha=b=>createHash('sha256').update(b).digest('hex'),ZERO='00'.repeat(0xc6);
const report={schema:'seventh-seal-forest-status-verification',version:1,passed:false,checks:[],case_counts:{apply:0,tick:0},
  comparison:'Source bytes and bounded original 508BB0 / 508300 / 509E10 x86 instruction replay',
  oracle_hooks:['Native memset and memcpy transfer literal bytes; CRT RNG uses the supplied stream.',
    'Status43 resource descriptor points at its retained 80ms action field and ten-frame count.',
    '507C60 receives source flags0 in this forest slice and is a checked no-op; other flag values fail.',
    '42FE40 case5 player command/UI cancellation is checked as a descriptor; the original UI globals are not executed.',
    'Display, OS clocks and debug stack checks are not executed.'],
  limits:['Other game effect ids/modes, mode2 removal, controlling statuses and periodic HP effects are unsupported.',
    'Status43 numeric life cycle is retained; its original overlay sprite is not rendered here.'],original_game_execution_observed:false};
function actor(){const a=clone(sample.actors[0]);a.status_flags_raw=0;return initializeNativeStatuses(a,data);}
function draw(values){let at=0;const fn=()=>{assert.ok(at<values.length,'Unexpected RNG consumption');return values[at++];};Object.defineProperty(fn,'calls',{get:()=>at});return fn;}
function blockArgs(block){const b=Buffer.alloc(0xc8);Buffer.from(block,'hex').copy(b);return [0,...Array.from({length:50},(_,i)=>b.readInt32LE(i*4))];}
class StatusOracle extends NativeAssemblyOracle{
  constructor(a,rng,threshold=1000){super(instruction.instructions,[a],rng);a.native_status_slots.forEach((s,i)=>Buffer.from(s.raw_hex,'hex').forEach((v,j)=>this.write(0x521a7d2+i*0xc6+j,v,1)));
    this.write(0x521f52a,a.status_flags_raw);this.write(0x679c74,threshold);
    this.write(0x55eb0c3+42*0xeb,0x30000000);this.write(0x55eb0cb+42*0xeb,10);this.write(0x30000001,80);
  }
  regRead(name){if(name==='BL')return this.reg.EBX&255;return super.regRead(name);}
  regWrite(name,value){if(name==='BL'){this.reg.EBX=(this.reg.EBX&~255)|(value&255);return;}return super.regWrite(name,value);}
  external(target){const arg=i=>this.read(this.reg.ESP+i*4);
    if(target===0x570a40){for(let i=0;i<arg(2);i++)this.write(arg(0)+i,arg(1),1);this.reg.EAX=arg(0);return;}
    if(target===0x570d10){const values=Array.from({length:arg(2)},(_,i)=>this.read(arg(1)+i,1));values.forEach((v,i)=>this.write(arg(0)+i,v,1));this.reg.EAX=arg(0);return;}
    if(target===0x507c60){assert.equal(arg(1),0,'Unexported status flag merge');return;}
    if(target===0x401609){assert.equal(this.read(0x521a77b,1),4);return;}
    return super.external(target);
  }
  compare(a){
    assert.equal(this.read(0x521f52a)>>>0,a.status_flags_raw);
    for(const f of data.aggregation)assert.equal(this.read(Number(f.address),f.bits===8?1:4),a.status_by_address[f.address],f.address);
    for(let index=0;index<100;index++)assert.equal(Buffer.from(Array.from({length:0xc6},(_,i)=>this.read(0x521a7d2+index*0xc6+i,1))).toString('hex'),a.native_status_slots[index].raw_hex,`slot${index}`);
  }
}
function compareApply(a,key,values,now=0){
  const before=clone(a),actualRng=draw(values),nativeRng=draw(values),skill=data.skills[key];
  const result=applyNativeSkillStatus({actor:a,skill,data,rng:actualRng,now});
  const oracle=new StatusOracle(a,nativeRng);oracle.run(0x508bb0,blockArgs(skill.effect_raw_hex));
  assert.equal(result.native_return,oracle.reg.EAX);oracle.compare(result.actor);
  assert.deepEqual(result.trace.filter(e=>e.kind==='rng').map(e=>e.raw),oracle.rng_calls);assert.deepEqual(a,before);
  report.case_counts.apply++;return {result,oracle};
}
function compareTick(a,threshold,now){
  const before=clone(a),oracle=new StatusOracle(a,draw([]),threshold),result=tickNativeStatuses({actor:a,threshold,now,data});
  oracle.run(0x509e10,[now,0]);oracle.compare(result.actor);assert.deepEqual(a,before);assert.deepEqual(oracle.rng_calls,[]);
  report.case_counts.tick++;return result;
}
test('all eight original blocks and every retained instruction match immutable sources',async()=>{
  validateForestStatusData(data);assert.equal(Object.values(data.skills).filter(s=>s.effect_id_raw===43).length,1);
  assert.ok(Object.isFrozen(data)&&Object.isFrozen(data.skills)&&Object.isFrozen(data.skills['012:14'])&&Object.isFrozen(data.aggregation));
  const changed=clone(data);changed.skills['012:14'].effect_id_raw=0;assert.throws(()=>validateForestStatusData(changed),/mismatch/);
  for(const s of Object.values(data.skills)){const original=await readFile(new URL('../../../'+s.source.path,import.meta.url));assert.equal(sha(original),s.source.sha256);
    assert.equal(original.subarray(s.source.fixed_offset,s.source.fixed_offset+0x41d).toString('hex'),s.fixed_raw_hex);
    assert.equal(original.subarray(s.source.block_offset,s.source.block_offset+0xc6).toString('hex'),s.effect_raw_hex);
  }
  for(const[path,hash]of Object.entries(data.source_hashes))assert.equal(sha(await readFile(new URL('../../../'+path,import.meta.url))),hash);
  for(const[address,lines]of Object.entries(instruction.instructions)){const r=native.records.find(r=>r.evidence_id===instruction.evidence[address]);assert.equal(r.parameters.procedure.toLowerCase(),address);assert.deepEqual(lines,r.normalized_result.split(/\r?\n/));}
  assert.equal(instruction.evidence['0x509e10'],'ev_ea1b3b3a6c300baa92fa8f582405a40063f242f86f3575ec090085b7705c12f0');
  report.checks.push('8 original C6 blocks / original status43 action / retained x86 instructions and source hashes');
});
test('dormant id0 mode0/2 skill blocks return1 without RNG or payload application',()=>{
  for(const[key,s]of Object.entries(data.skills))if(s.effect_id_raw===0&&[0,2].includes(s.mode_raw)){const a=actor(),{result}=compareApply(a,key,[]);assert.deepEqual(result.actor,a);assert.equal(result.applied,false);assert.equal(result.reason,'effect-id-zero');}
  report.checks.push('Hunter dormant nonzero bytes and all other id0 blocks consume no RNG and do not change stats');
});
test('inclusive chance boundaries, post-roll target flags and category4 match native application',()=>{
  for(const roll of [0,79,80,81,99,32767]){const {result}=compareApply(actor(),'012:14',[roll],9000);assert.equal(result.applied,roll%100<=80);
    if(result.applied){assert.equal(result.actor.status_by_address['0x0521f5bd'],200);assert.equal(Buffer.from(result.actor.native_status_slots[0].raw_hex,'hex').readInt32LE(0x17),0);}}
  for(const flag of [0x20,0x40,0x80,0x200]){const a=actor();a.status_flags_raw=flag;a.status_by_address['0x0521f52a']=flag;assert.equal(compareApply(a,'012:14',[80]).result.reason,'target-status-flags');}
  const a=actor();a.state_raw=4;const applied=compareApply(a,'012:14',[80]).result;assert.equal(applied.applied,true);assert.equal(applied.cancel_command,true);
  report.checks.push('<=80 chance, roll before target status rejection, source lastTick0 copy and no category4 application gate');
});
test('duplicate id/mode returns0 before RNG and preserves duration and timestamp',()=>{
  let a=compareApply(actor(),'012:14',[0]).result.actor;a=compareTick(a,500,80).actor;
  const {result}=compareApply(a,'012:14',[],12345);assert.equal(result.reason,'duplicate-id-and-mode');assert.deepEqual(result.actor,a);
  report.checks.push('Repeated contact cannot refresh or stack status43 and does not draw application RNG');
});
test('80ms exact boundary, one tick after long stall and discarded threshold spill match native instructions',()=>{
  let a=compareApply(actor(),'012:14',[0]).result.actor;
  let result=compareTick(a,750,79);assert.equal(result.ticks,0);
  result=compareTick(a,750,80);assert.equal(result.ticks,1);a=result.actor;
  let b=Buffer.from(a.native_status_slots[0].raw_hex,'hex');assert.equal(b.readInt32LE(0x1b),500);assert.equal(b.readInt32LE(2),10);
  result=compareTick(a,750,10000);a=result.actor;b=Buffer.from(a.native_status_slots[0].raw_hex,'hex');
  assert.equal(result.ticks,1);assert.equal(b.readInt32LE(0x1b),0);assert.equal(b.readInt32LE(2),9);assert.equal(b.readInt32LE(0x17),10000);assert.equal(b.readInt32LE(0x13),2);
  assert.equal(compareTick(a,750,10079).ticks,0);assert.equal(compareTick(a,750,10080).ticks,1);
  report.checks.push('79/80ms boundary; long stall single tick; timestamp=now and gauge spill discarded');
});
test('ten threshold crossings expire the full record and recalculate aggregates',()=>{
  for(const threshold of [1,500,750,4000]){
    let a=compareApply(actor(),'012:14',[0]).result.actor,time=0,crossings=0;
    while(a.native_status_slots[0].raw_hex!==ZERO){time+=80;const before=Buffer.from(a.native_status_slots[0].raw_hex,'hex').readInt32LE(2);const result=compareTick(a,threshold,time);a=result.actor;
      const after=Buffer.from(a.native_status_slots[0].raw_hex,'hex').readInt32LE(2);if(after<before)crossings++;
      assert.equal(a.status_by_address['0x0521f5bd'],a.native_status_slots[0].raw_hex===ZERO?0:200);assert.ok(time<100000);
    }
    assert.equal(crossings,10);assert.equal(a.status_flags_raw,0);
  }
  report.checks.push('10 threshold crossings / complete slot clear / element aggregate removal at four thresholds');
});
test('status43 changes the next elemental calculation, clears for map writeback and never mutates source',()=>{
  const a=actor(),skill=clone(data.skills['012:14']),b=Buffer.from(skill.fixed_raw_hex,'hex');
  // Select native element slot1 to observe the actual combat module reading
  // the exported status aggregate address; this synthetic numeric probe does
  // not claim that snow skill14 itself attacks with element1.
  for(let i=0;i<6;i++)b.writeInt32LE(i===1?100:0,0x105+i*4);skill.fixed_raw_hex=b.toString('hex');
  const before=elementalTerms(a,a,skill),applied=compareApply(a,'012:14',[0]).result.actor,after=elementalTerms(a,applied,skill);
  assert.equal(after.resistance-before.resistance,200);
  const clean=clearNativeStatuses(applied,data);assert.equal(clean.status_by_address['0x0521f5bd'],0);assert.ok(clean.native_status_slots.every(s=>s.raw_hex===ZERO));assert.equal(clean.native_status_aggregate_raw_hex,ZERO);
  assert.equal(applied.status_by_address['0x0521f5bd'],200);assert.deepEqual(clearNativeStatuses(a,data),a);
  report.checks.push('Native combat reads element slot1 +200; 507E20 contract clears effects before map writeback');
});
test('native continuous RNG stream parity and unsupported mode2 fail explicitly',()=>{
  const rng=createNativeRng(20261011),oracleRng=createNativeRng(20261011);let a=actor();
  for(let i=0;i<30;i++){
    const result=applyNativeSkillStatus({actor:a,skill:data.skills['012:14'],data,rng,now:i*80});
    const oracle=new StatusOracle(a,oracleRng);oracle.run(0x508bb0,blockArgs(data.skills['012:14'].effect_raw_hex));oracle.compare(result.actor);
    assert.equal(result.native_return,oracle.reg.EAX);assert.deepEqual(result.trace.filter(e=>e.kind==='rng').map(e=>e.raw),oracle.rng_calls);assert.equal(rng.state,oracleRng.state);a=result.actor;
    if(i%5===4)a=clearNativeStatuses(a,data);
  }
  const raw=Buffer.from(data.status43.effect_raw_hex,'hex');raw[0xb]=2;a.native_status_slots[0]={raw_hex:raw.toString('hex')};
  assert.throws(()=>applyNativeSkillStatus({actor:a,skill:data.skills['012:14'],data,rng,now:0}),/mode2/);
  assert.throws(()=>tickNativeStatuses({actor:a,threshold:500,now:80,data}),/mode2/);
  report.checks.push('Continuous CRT RNG state parity; mode2 cannot silently omit native removal draws');
});
test.after(()=>assert.equal(report.checks.length,8));
