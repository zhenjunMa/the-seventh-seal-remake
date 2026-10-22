import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {applyNativeRevival,applyNativeRevivalRecoveryBlock,revivalSkillAvailability,isNativeRevivalSkill,nativeRevivalSkillSupported,revivalTargetEligibility} from '../web/core/battle_revival.mjs';
import {createNativeRng} from '../web/core/combat_rules.mjs';
import {createForestSample} from '../web/forest_sample.mjs';
import {initializeScheduler} from '../web/core/battle_scheduler.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
const read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name,import.meta.url)));
const [seed,base,forest,skills,schedulerData,party]=await Promise.all(['route_seed.json','combat_sample.json','forest_combat.json','skills.json','battle_scheduler.json','party_skills.json'].map(read));
const recoveryBundle=JSON.parse(await readFile(new URL('../evidence/battle_revive_recovery_native_20261015.json',import.meta.url)));
const statusBundle=JSON.parse(await readFile(new URL('../evidence/forest_status_native_20261011.json',import.meta.url)));
const numeric=JSON.parse(await readFile(new URL('../evidence/turn_rules_assembly_20261011.json',import.meta.url)));
const lifecycleBundle=JSON.parse(await readFile(new URL('../evidence/battle_lifecycle_native_20261015.json',import.meta.url)));
function collect(value,records=[]){if(value&&typeof value==='object'){if(value.operation==='procedure_assembly')records.push(value);for(const child of Object.values(value))collect(child,records);}return records;}
const records=[...collect(recoveryBundle),...collect(statusBundle),...collect(lifecycleBundle)];
const functions={...numeric.functions};for(const address of ['0x508bb0','0x41bfb0','0x41e950']){const record=records.find(row=>row.parameters?.procedure.toLowerCase()===address);assert.ok(record,address);functions[address]=record.normalized_result.trim().split(/\r?\n/);}
const source=party.roles['001'].skills[43],clone=structuredClone,zero='00'.repeat(0xc6),addr=n=>`0x${n.toString(16).padStart(8,'0')}`;
function fixture(){
  const sample=createForestSample(seed,base,forest,{map_id:'M70010',members:[{id:'012'}]},skills,schedulerData);initializeScheduler(sample.actors,schedulerData);
  const caster=sample.actors[0],target=clone(caster);caster.current_skill=clone(source);target.id='dead-party-member';target.state_raw=5;
  target.raw_hp=(-target.resource_bonuses.hp_current)|0;target.raw_by_address[addr(0x524a701)]=target.raw_hp;target.hp.current=0;
  for(const actor of [caster,target]){for(const n of [0x521f551,0x521f555,0x521f559,0x521f55d,0x521f571,0x521f575,0x521f579,0x521f57d])actor.status_by_address[addr(n)]??=0;actor.native_status_slots=Array.from({length:100},()=>({raw_hex:zero}));}
  return {caster,target};
}
function blockArgs(index,hex){const buffer=Buffer.alloc(200);Buffer.from(hex,'hex').copy(buffer);return [index,...Array.from({length:50},(_,i)=>buffer.readInt32LE(i*4))];}
class RevivalOracle extends NativeAssemblyOracle {
  external(target){
    if(target===0x508a90)return;
    if(target===0x50e3a0){this.animation={actor:this.read(this.reg.ESP),type:this.read(this.reg.ESP+4)};throw this.stop;}
    return super.external(target);
  }
}
function nativeRevival(caster,target,skill,rng=()=>{throw Error('Original source43 has no recovery RNG');}){
  const oracle=new RevivalOracle(functions,[caster,target],rng);oracle.stop={};
  const effect=skill.fixed_raw_hex.slice(0x231*2,0x2f7*2);
  oracle.write(0x521f52a+0x30274,target.status_flags_raw);
  target.native_status_slots.forEach((slot,index)=>{const bytes=Buffer.from(slot.raw_hex,'hex');for(let i=0;i<bytes.length;i++)oracle.write(0x521a7d2+0x30274+index*0xc6+i,bytes[i],1);});
  let statusReturn=1;try{statusReturn=oracle.run(0x508bb0,blockArgs(1,effect)).eax;}catch(error){if(error!==oracle.stop)throw error;}
  if(oracle.animation){oracle.run(0x41bfb0,blockArgs(1,effect));oracle.run(0x41e950,[0,1,0]);}
  return {oracle,statusReturn};
}
test('revival source43 bytes match original CHR; raw positive MP40 means no native battle cost',async()=>{
  const original=await readFile(new URL('../../../'+source.source.path,import.meta.url));
  assert.equal(createHash('sha256').update(original).digest('hex'),source.source.sha256);
  assert.equal(original.subarray(source.source.fixed_record_offset,source.source.fixed_record_offset+0x41d).toString('hex'),source.fixed_raw_hex);
  assert.equal(source.original_skill_index,43);assert.equal(source.learned_raw,0);assert.equal(source.mp_delta_raw,40);assert.equal(source.mp_cost,0);assert.ok(isNativeRevivalSkill(source));
  assert.equal(nativeRevivalSkillSupported(source),true);
  assert.equal(source.actions[8].contact_u32_raw_0x49,1);assert.ok(Buffer.from(source.actions[8].raw_hex,'hex').includes(Buffer.from('_iRelife.dgp')));
});
test('learning and target admission require explicit progression; neither helpers nor source bytes grant the spell',()=>{
  const {caster,target}=fixture(),before=clone(source);
  assert.equal(revivalSkillAvailability({caster,target,skill:source,learned:source.learned_raw===1}).available,false);
  assert.equal(revivalTargetEligibility(target,source).available,true);
  assert.equal(revivalSkillAvailability({caster,target,skill:source,learned:true}).available,true);
  caster.status_flags_raw=2;assert.equal(revivalSkillAvailability({caster,target,skill:source,learned:true}).available,false);
  caster.status_flags_raw=0;target.state_raw=11;target.escaped=true;assert.equal(revivalSkillAvailability({caster,target,skill:source,learned:true}).available,false);assert.deepEqual(source,before);
});
test('source43 mode3 resurrection and resource recovery match exact native instruction sequence',()=>{
  for(let i=0;i<56;i++){
    const {caster,target}=fixture();target.state_raw=[0,3,4,5,6,7,8,11][i%8];target.immune_raw=i%9===0?1:0;
    target.resource_bonuses.hp_current=i%3?96:0;target.linked_by_address[addr(0x4f99088)]=target.resource_bonuses.hp_current;
    target.raw_hp=(-target.resource_bonuses.hp_current)|0;target.raw_by_address[addr(0x524a701)]=target.raw_hp;target.hp.current=0;
    target.charge={gauge:-91,delay:31,recovery:18,recovery_ticks:9};const before=clone(target),actual=applyNativeRevival({target,skill:source});
    const {oracle,statusReturn}=nativeRevival(caster,target,source),offset=0x30274;
    assert.equal(actual.native_return,statusReturn);assert.equal(actual.actor.state_raw,oracle.read(0x521a77b+offset,1));
    for(const[field,address]of [['raw_hp',0x524a701],['raw_hp_maximum',0x524a705],['raw_mp',0x524a709],['raw_mp_maximum',0x524a70d]])assert.equal(actual.actor[field],oracle.read(address+offset),`${field} case${i}`);
    assert.deepEqual(actual.actor.charge,before.charge);assert.deepEqual(actual.actor.native_status_slots,before.native_status_slots);assert.equal(actual.actor.status_flags_raw,before.status_flags_raw);assert.deepEqual(target,before);
    if(actual.applied){assert.equal(actual.animation_type_raw,14);assert.equal(actual.actor.raw_hp,151);}
  }
});
test('existing mode3 effect id prevents duplicate resurrection before target state changes',()=>{
  const {caster,target}=fixture(),effect=source.fixed_raw_hex.slice(0x231*2,0x2f7*2);target.native_status_slots[17]={raw_hex:effect};
  const actual=applyNativeRevival({target,skill:source}),{oracle,statusReturn}=nativeRevival(caster,target,source);
  assert.equal(actual.applied,false);assert.equal(actual.native_return,0);assert.equal(statusReturn,0);assert.equal(oracle.read(0x521a77b+0x30274,1),5);assert.equal(actual.actor.state_raw,5);
});
test('positive mode3 recovery-block branches preserve native unusual percentage/clamp arithmetic',()=>{
  for(let i=0;i<64;i++){
    const {target}=fixture();target.state_raw=0;target.raw_hp=100+i*17;target.raw_by_address[addr(0x524a701)]=target.raw_hp;target.hp.current=target.raw_hp+target.resource_bonuses.hp_current;
    for(const[n,value]of [[0x521f551,i%3?0:7],[0x521f555,i%4?0:19],[0x521f571,i%5?0:125],[0x521f575,i%7?0:80]])target.status_by_address[addr(n)]=value;
    const b=Buffer.alloc(0xc6);b[0xb]=3;for(const[n,v]of [[0x23,i%2?50:0],[0x27,i%3],[0x2b,i%4],[0x2f,i%5],[0x43,i%2?0:50]])b.writeInt32LE(v,n);
    const actual=applyNativeRevivalRecoveryBlock({actor:target,effect_raw_hex:b.toString('hex')}),oracle=new NativeAssemblyOracle(functions,[target],()=>0);oracle.run(0x41bfb0,blockArgs(0,b.toString('hex')));
    for(const[field,n]of [['raw_hp',0x524a701],['raw_hp_maximum',0x524a705],['raw_mp',0x524a709],['raw_mp_maximum',0x524a70d]])assert.equal(actual.actor[field],oracle.read(n),`${field} block${i}`);
  }
});
test('configured recovery range and status clamps preserve original 41E950 instruction and RNG results',()=>{
  for(let i=0;i<24;i++){
    const {caster,target}=fixture(),b=Buffer.from(source.fixed_raw_hex,'hex');b.writeInt32LE(120,0xab);b.writeInt32LE(180,0xaf);
    const skill={...clone(source),fixed_raw_hex:b.toString('hex')};caster.current_skill=skill;
    for(const[n,v]of [[0x521f551,i%2?0:5],[0x521f555,i%3?0:20],[0x521f571,i%4?0:150],[0x521f575,i%5?0:125],[0x521f559,i%3?0:1],[0x521f55d,i%4?0:2],[0x521f57d,i%5?0:125]])target.status_by_address[addr(n)]=v;
    const seed=i*214013,actual=applyNativeRevival({target,skill,rng:createNativeRng(seed)}),{oracle}=nativeRevival(caster,target,skill,createNativeRng(seed));
    assert.equal(actual.actor.raw_hp,oracle.read(0x524a701+0x30274));assert.equal(actual.actor.raw_mp,oracle.read(0x524a709+0x30274));assert.deepEqual(actual.trace.filter(row=>row.kind==='rng').map(row=>row.raw),oracle.rng_calls);
  }
});
test('type14 selector runs after state restoration and before recovery-range RNG',()=>{
  const {target}=fixture(),b=Buffer.from(source.fixed_raw_hex,'hex');b.writeInt32LE(160,0xaf);const skill={...source,fixed_raw_hex:b.toString('hex')},draws=[7,5],consumed=[];
  const rng=()=>{const value=draws.shift();consumed.push(value);return value;};
  const actual=applyNativeRevival({target,skill,rng,selectAnimation:(actor,{animation_type_raw,rng})=>{assert.equal(actor.state_raw,0);assert.equal(actor.raw_hp,1);assert.equal(animation_type_raw,14);return {type:14,lookup:rng()};}});
  assert.deepEqual(consumed,[7,5]);assert.equal(actual.actor.raw_hp,156);assert.deepEqual(actual.animation,{type:14,lookup:7});
});
