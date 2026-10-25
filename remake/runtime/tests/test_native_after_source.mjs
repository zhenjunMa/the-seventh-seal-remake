// Original 51CC00 / 519FA0 / 519DD0 instructions arbitrate after-source
// transitions. Resource getters read the synthetic native skill table after
// each write, so later branches cannot accidentally reuse an old pose.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {createNativeRng} from '../web/core/combat_rules.mjs';
import {selectNativeAfterSourceReaction,selectNativeNormalReaction,finalizeNativeDeath,applyContactReaction} from '../web/core/battle_reactions.mjs';
const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url)));
const [data,sample,instructions,death,cc,home,idle]=await Promise.all([
  '../web/data/party_reactions.json','../web/data/combat_sample.json',
  '../evidence/forest_reactions_instructions_20261011.json','../evidence/forest_death_reactions_native_20261011.json',
  '../evidence/fire_valley_20261025/vertical_51cc00_assembly.json',
  '../evidence/fire_valley_20261025/vertical_519fa0_assembly.json',
  '../evidence/fire_valley_20261025/vertical_519dd0_assembly.json'].map(read));
const functions={...instructions.functions};
for(const row of [cc,home,idle])functions[row.parameters.procedure.toLowerCase()]=row.normalized_result.split(/\r?\n/);
const deathGate=death.records.find(row=>row.operation==='procedure_assembly'&&row.parameters.procedure.toLowerCase()==='0x5002b0');
functions['0x5002b0']=deathGate.normalized_result.split(/\r?\n/);
const selected=(role,id)=>structuredClone(role.skills.find(skill=>skill.original_id_raw===id));
function actor(role,id=1,patch={}){
 const a=structuredClone(sample.actors[0]);Object.assign(a,{id:'subject',resource_id:role.id,current_skill:selected(role,id),
  current_target_id:null,native_active:true,reaction_special_gate_raw:0,native_z_raw:0,status_flags_raw:0,
  state_raw:0,reaction_busy_raw:0,native_vertical_velocity_raw:0,native_vertical_counter_raw:17,
  native_vertical_target_raw:-50,native_vertical_acceleration_raw:0,
  native_x_raw:140,native_y_raw:300,native_home_x_raw:140,native_home_y_raw:300,
  charge:{gauge:0,delay:0,recovery:0,recovery_ticks:0}});
 a.status_by_address['0x0521f52a']=0;return Object.assign(a,patch);
}
const fields={native_z_raw:0x521a785,native_vertical_velocity_raw:0x524a63e,native_vertical_counter_raw:0x524a636,
 native_vertical_target_raw:0x524a63a,native_vertical_acceleration_raw:0x524a642,native_x_raw:0x521a77d,
 native_y_raw:0x521a781,native_home_x_raw:0x521a789,native_home_y_raw:0x521a78d};
class SourceEndOracle extends NativeAssemblyOracle{
 constructor(a,rng,{dispatch,threshold=20000}={}){
  super(functions,[a],rng);this.dispatch=dispatch;this.dispatchCalls=0;
  const role=data.roles[a.resource_id],base=0x23000000;
  this.write(0x524a6d1,role.skill_count);this.write(0x524a9dc,base);
  for(const skill of role.skills)Buffer.from(skill.fixed_raw_hex,'hex').forEach((value,i)=>this.write(base+skill.original_skill_index*0x421+i,value,1));
  this.write(0x524a656,a.current_skill.original_skill_index,1);this.write(0x524a657,3,1);
  this.write(0x521a778,Number(a.native_active),1);this.write(0x521f692,a.reaction_special_gate_raw);
  this.write(0x521f5f8,a.reaction_busy_raw,1);this.write(0x521f52a,a.status_flags_raw);
  this.write(0x521f68e,-1);this.write(0x521f6a2,a.charge.recovery_ticks);this.write(0x679c74,threshold);
  for(const[field,address]of Object.entries(fields))this.write(address,a[field],field==='native_vertical_acceleration_raw'?1:4);
 }
 external(target){
  const arg=n=>this.read(this.reg.ESP+n*4);
  if(target===0x501870){
   const base=this.read(0x524a9dc),index=this.read(0x524a656,1),destination=arg(0);
   for(let i=0;i<0x421;i++)this.write(destination+i,this.read(base+index*0x421+i,1),1);
   this.reg.EAX=destination;return;
  }
  if(target===0x507e20){for(let i=0;i<0xca;i++)this.write(0x521f52a+i,0,1);return;}
  // GAME.exe 401609 is E9 32 E8 02 00 -> 42FE40. Command dispatch is
  // external to this selector; retain its call boundary and returned writes.
  if(target===0x401609||target===0x42fe40){this.dispatchCalls++;if(this.dispatch)this.dispatch(this);return;}
  if([0x4ffa30,0x50cb60,0x511c30].includes(target))return;
  return super.external(target);
 }
}
function compare(a,seed=987,options={}){
 const before=structuredClone(a),rng=createNativeRng(seed),nativeRng=createNativeRng(seed),oracle=new SourceEndOracle(a,nativeRng,options);
 const output=selectNativeAfterSourceReaction({actor:a,data,rng,threshold:options.threshold??20000,
  onFinalizeDeath:({actor:current})=>{
   const descriptor=finalizeNativeDeath({actor:current,data,rng});
   return {actor:descriptor?{...current,...descriptor.after,native_after_raw:{...current.native_after_raw,...descriptor.after.native_after_raw}}:current,
    trace:descriptor?.trace??[],descriptor};
  },onDispatch:({actor:current})=>options.onDispatch?.(current)??{actor:current}});
 oracle.run(0x51cc00,[0]);
 const after={...a,...output.after,native_after_raw:{...a.native_after_raw,...output.after.native_after_raw}};
 assert.equal(after.current_skill.original_skill_index,oracle.read(0x524a656,1),'selected source index');
 assert.equal(Number(after.native_active),oracle.read(0x521a778,1),'native_active');
 assert.equal(after.state_raw,oracle.read(0x521a77b,1),'state');
 assert.equal(after.settled_raw,oracle.read(0x521f69d,1),'settled');
 for(const field of ['native_vertical_velocity_raw','native_vertical_target_raw','native_vertical_counter_raw'])assert.equal(after[field],oracle.read(fields[field]),field);
 assert.deepEqual(output.trace.filter(row=>row.kind==='rng').map(row=>row.raw),oracle.rng_calls);
 assert.equal(rng.state,nativeRng.state);assert.deepEqual(a,before);return {output,after,oracle};
}

test('all actual player and enemy hit/launch/landing/get-up records keep original transitions and RNG',()=>{
 let cases=0;
 for(const id of ['001','002','003','004','005','006','011','012','013','032']){
  const role=data.roles[id];assert.ok(role);
  for(const current of [1,2,3,4,5,6,8,10,11,12])for(const seed of [0,1,77327,0x12345678]){
   if(!role.skills.some(skill=>skill.original_id_raw===current))continue;
   const {output}=compare(actor(role,current),seed);
   const expected=[2,3,8].includes(current)?4:current===5?8:current===4?6:0;
   assert.equal(output.skill.original_id_raw,expected,`${id}/${current}`);cases++;
  }
 }
 assert.equal(cases,356);
});

test('airborne falling repair precedes status gates and preserves native signed edge behavior',()=>{
 for(const z of [-100,1])for(const acceleration of [0,1,255])for(const velocity of [-10,0,1,10,-2147483648])for(const flags of [0,32,64,128]){
  const a=actor(data.roles['001'],5,{native_z_raw:z,native_vertical_acceleration_raw:acceleration,
   native_vertical_velocity_raw:velocity,status_flags_raw:flags});a.status_by_address['0x0521f52a']=flags;
  compare(a,77327);
 }
 const gated=compare(actor(data.roles['001'],5,{native_z_raw:-8,reaction_special_gate_raw:1}));
 assert.equal(gated.output.skill,null);assert.equal(gated.after.native_vertical_velocity_raw,10);
});

test('519FA0 uses authoritative current/home coordinates and only successful return10 skips idle',()=>{
 for(const displaced of [false,true])for(const active of [false,true])for(const busy of [0,1]){
  const {output}=compare(actor(data.roles['003'],6,{native_active:active,reaction_busy_raw:busy,native_x_raw:displaced?220:140}));
  assert.equal(output.skill.original_id_raw,displaced&&!active&&!busy?10:0);
 }
 const invalid=actor(data.roles['001'],6,{native_active:false});delete invalid.native_x_raw;
 assert.throws(()=>selectNativeAfterSourceReaction({actor:invalid,data,rng:()=>0}),/native x/);
});

test('state4 ground finalization mutates source before 51CC00 subsequent id4 lookup; air waits',()=>{
 for(const current of [1,4,5])for(const z of [0,-16])compare(actor(data.roles['001'],current,{native_z_raw:z,state_raw:4}),77327);
 const dead=actor(data.roles['001'],1,{state_raw:4});
 assert.throws(()=>selectNativeAfterSourceReaction({actor:dead,data,rng:()=>0}),/5002B0 death transaction hook/);
});

test('99 percent recovery redispatch stays before 519DD0 and keeps exact unsigned product',()=>{
 let hooks=0;
 const result=compare(actor(data.roles['001'],1,{charge:{gauge:0,delay:0,recovery:0,recovery_ticks:100}}),1,
  {onDispatch:current=>{hooks++;assert.equal(current.reaction_inhibit_raw,20000);return {actor:current};}});
 assert.equal(hooks,1);assert.equal(result.oracle.dispatchCalls,1);
 assert.equal(result.after.reaction_inhibit_raw,result.oracle.read(0x521f69e));
 assert.equal(result.after.charge.recovery_ticks,0);
 assert.throws(()=>selectNativeAfterSourceReaction({actor:actor(data.roles['001'],1,{charge:{recovery_ticks:100}}),data,rng:()=>0,threshold:20000}),/42FE40 command transaction hook/);
 for(const ticks of [0,99,100,101,0xffffffff])for(const threshold of [20000,0x7fffffff]){
  const result=compare(actor(data.roles['001'],1,{charge:{gauge:0,delay:0,recovery:0,recovery_ticks:ticks}}),1,{threshold});
  assert.equal(result.after.reaction_inhibit_raw,result.oracle.read(0x521f69e));
 }
 const mutated=compare(actor(data.roles['001'],1,{charge:{gauge:0,delay:0,recovery:0,recovery_ticks:100}}),1,{
  dispatch:oracle=>{oracle.write(0x521a77b,4,1);oracle.write(0x524a656,5,1);},
  onDispatch:current=>({actor:{...current,state_raw:4,current_skill:selected(data.roles['001'],5)}})});
 assert.equal(mutated.after.state_raw,4);assert.equal(mutated.after.current_skill.original_id_raw,5);assert.equal(mutated.after.native_active,false);
});

test('51C640 airborne ordinary contacts reverse falling velocity while native id5 retains its motion',()=>{
 const role=data.roles['001'];
 for(const ident of [1,5])for(const acceleration of [0,1])for(const velocity of [-10,0,10]){
  const a=actor(role,5,{native_z_raw:-40,native_vertical_velocity_raw:velocity,native_vertical_acceleration_raw:acceleration}),
   rng=createNativeRng(77327),nativeRng=createNativeRng(77327),oracle=new SourceEndOracle(a,nativeRng);
  const result=selectNativeNormalReaction({actor:a,ident,data,rng});oracle.run(0x51c640,[0,ident]);
  const after={...a,...result.after};assert.equal(after.native_vertical_velocity_raw,oracle.read(0x524a63e));
  assert.deepEqual(result.trace.filter(row=>row.kind==='rng').map(row=>row.raw),oracle.rng_calls);
 }
});

test('guard/dodge airborne paths use 51CC00 after native busy reset and dodge probability draws',()=>{
 for(const reaction of [1,2])for(const current of [1,5,8])for(const special of [0,1]){
  const a=actor(data.roles['001'],current,{native_z_raw:-40,reaction_special_gate_raw:special}),other=actor(data.roles['001'],1);
  other.id='other';const raw=Buffer.alloc(176);raw[0x77]=9;raw[0x62]=1;raw[0x48]=1;
  const rng=createNativeRng(77327),nativeRng=createNativeRng(77327),oracle=new SourceEndOracle(a,nativeRng);
  const result=applyContactReaction({attacker:other,target:a,result:{damage:0,reaction,native_return:0},record:{raw_hex:raw.toString('hex')},data,rng});
  if(reaction===1)oracle.run(0x50b520,[0,9]);else oracle.run(0x50b770,[0,0,9,0]);
  const after={...a,...result.after};assert.equal(after.current_skill.original_skill_index,oracle.read(0x524a656,1));
  assert.equal(after.native_vertical_velocity_raw,oracle.read(0x524a63e));
  assert.deepEqual(result.trace.filter(row=>row.kind==='rng').map(row=>row.raw),oracle.rng_calls);
 }
});

test('50B770 immunity gate preserves existing target and busy flags before any airborne dispatch',()=>{
 const a=actor(data.roles['001'],5,{immune_raw:1,native_z_raw:-40,reaction_busy_raw:1}),other=actor(data.roles['001'],1);
 other.id='other';const raw=Buffer.alloc(176);raw[0x48]=1;
 const rng=createNativeRng(1),nativeRng=createNativeRng(1),oracle=new SourceEndOracle(a,nativeRng);
 const result=applyContactReaction({attacker:other,target:a,result:{damage:0,reaction:2,native_return:0},record:{raw_hex:raw.toString('hex')},data,rng});
 oracle.run(0x50b770,[0,0,9,0]);const after={...a,...result.after};
 assert.equal(result.target_id,null);assert.equal(oracle.read(0x521f68e),-1);
 assert.equal(after.reaction_busy_raw,oracle.read(0x521f5f8,1));
 assert.equal(after.native_vertical_velocity_raw,oracle.read(0x524a63e));
 assert.deepEqual(result.trace,[]);
});
