// Original004 allied contacts through retained50FA00/508BB0/507E20/41E950.
// Action admission and OS/presentation are explicit external boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {applyNativeSupport,nativeSupportSkillSupported,supportTargetEligibility,supportSkillAvailability} from '../web/core/battle_support.mjs';
import {applyNativeRevival,nativeRevivalSkillSupported} from '../web/core/battle_revival.mjs';
import {clearNativeStatuses,applyNativeSupportStatus,tickNativeStatuses,validateForestStatusData} from '../web/core/battle_status.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {createNativeRng} from '../web/core/combat_rules.mjs';
import {createForestSample} from '../web/forest_sample.mjs';
import {initializeScheduler} from '../web/core/battle_scheduler.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
const copy=structuredClone,ZERO='00'.repeat(0xc6),addr=n=>`0x${n.toString(16).padStart(8,'0')}`;
const json=async name=>JSON.parse(await readFile(new URL(`../${name}`,import.meta.url),'utf8'));
const [seed,base,forest,skills,scheduler,statusData,statusEvidence,recoveryEvidence,numeric,clearEvidence,lifecycleEvidence]=await Promise.all([
  'web/data/route_seed.json','web/data/combat_sample.json','web/data/forest_combat.json','web/data/skills.json','web/data/battle_scheduler.json',
  'web/data/forest_status.json','evidence/forest_status_native_20261011.json','evidence/battle_revive_recovery_native_20261015.json',
  'evidence/turn_rules_assembly_20261011.json','evidence/fire_valley_20261025/support_507e20.json','evidence/battle_lifecycle_native_20261015.json'].map(json));
function collect(value,records=[]){if(value&&typeof value==='object'){if(value.operation==='procedure_assembly')records.push(value);for(const child of Object.values(value))collect(child,records);}return records;}
const records=[...collect(statusEvidence),...collect(recoveryEvidence),...collect(lifecycleEvidence)],functions={...numeric.functions,
  '0x507e20':clearEvidence.normalized_result.assembly};
for(const address of ['0x50fa00','0x508bb0','0x508300','0x509e10','0x41bfb0','0x41e950','0x401aaa']){
  const record=records.find(row=>row.parameters?.procedure?.toLowerCase()===address);assert.ok(record,address);functions[address]=record.normalized_result.trim().split(/\r?\n/);
}
// The retained50FA00 assembly calls40147E, whereas the recovery bundle stores
// the41E950 body. Resolve its actual PE jump bytes, without inventing a thunk.
const executable=await readFile(new URL('../../../GAME.exe',import.meta.url)),pe=executable.readUInt32LE(0x3c),optional=pe+24,
  imageBase=executable.readUInt32LE(optional+28),sections=optional+executable.readUInt16LE(pe+20);
function rawOffset(address){
  const rva=address-imageBase;
  for(let index=0;index<executable.readUInt16LE(pe+6);index++){
    const at=sections+index*40,virtual=executable.readUInt32LE(at+12),size=Math.max(executable.readUInt32LE(at+8),executable.readUInt32LE(at+16));
    if(rva>=virtual&&rva<virtual+size)return executable.readUInt32LE(at+20)+rva-virtual;
  }
  throw Error(`Missing native address${address.toString(16)}`);
}
const recoveryThunk=rawOffset(0x40147e);assert.equal(executable[recoveryThunk],0xe9);
assert.equal(0x40147e+5+executable.readInt32LE(recoveryThunk+1),0x41e950);
functions['0x40147e']=['0x40147e: JMP 0x0041e950'];
const original=await readFile(new URL('../../../Fight_Role/004.CHR',import.meta.url)),sourceHash=createHash('sha256').update(original).digest('hex'),source={};
let offset=8+0x30b;
for(let index=0;index<original.readUInt32LE(8);index++){
  const fixed=original.subarray(offset,offset+0x41d),view=new DataView(fixed.buffer,fixed.byteOffset,fixed.length);
  if([33,38,40].includes(index))source[index]={id:`004_${index}`,actor_id:'004',original_skill_index:index,index,fixed_raw_hex:fixed.toString('hex'),
    learned_raw:fixed[0x23],mp_cost:Math.max(0,-view.getInt32(0x14f,true)),source:{path:'Fight_Role/004.CHR',sha256:sourceHash,fixed_record_offset:offset},
    actions:Array.from({length:fixed.readUInt32LE(0x15)},(_,actionIndex)=>{const at=offset+0x41d+actionIndex*0xb0,raw=original.subarray(at,at+0xb0);return {
      index:actionIndex,source_offset:at,raw_hex:raw.toString('hex'),type_raw:raw[0],command_raw:raw.readUInt32LE(1),contact_raw:raw.readUInt32LE(0x49)};})};
  offset+=0x41d+fixed.readUInt32LE(0x15)*0xb0;
}
assert.equal(offset,original.length);
const source032=await readFile(new URL('../../../Fight_Role/032.CHR',import.meta.url)),mode2=source032.subarray(10446+0x16b,10446+0x231).toString('hex');
// The support fixtures come directly from every companion's immutable CHR,
// independently of the generated runtime skill selection.
const alliedSource={},expandedStatusData=copy(statusData);expandedStatusData.support_skills={};expandedStatusData.effects??={};
for(const role of ['001','002','003','004','005','006']){
  const raw=await readFile(new URL(`../../../Fight_Role/${role}.CHR`,import.meta.url));let at=8+0x30b;
  for(let index=0;index<raw.readUInt32LE(8);index++){
    const fixed=raw.subarray(at,at+0x41d),effect=fixed.subarray(0x231,0x2f7);
    if(fixed[0x25]===1){
      const key=`${role}:${index}`,skill={id:`${role}_${index}`,actor_id:role,original_skill_index:index,index,
        fixed_raw_hex:fixed.toString('hex'),effect_raw_hex:effect.toString('hex'),effect_id_raw:effect[1],mode_raw:effect[0xb]};
      alliedSource[key]=skill;expandedStatusData.support_skills[key]=skill;
      if(effect[1]&&effect[0xb]===0){
        const path=`Fight_Role/Status/${String(effect[1]).padStart(3,'0')}.dgp`,dgp=await readFile(new URL('../../../'+path,import.meta.url));
        assert.ok([8,9].includes(dgp[0]));assert.equal(dgp[2],1);
        expandedStatusData.effects[String(effect[1])]={id_raw:effect[1],interval_ms:dgp.readInt32LE(0x43+1),frame_count:dgp[0x43+14],
          source:{path,sha256:createHash('sha256').update(dgp).digest('hex')}};
      }
    }
    at+=0x41d+fixed.readUInt32LE(0x15)*0xb0;
  }
  assert.equal(at,raw.length);
}
validateForestStatusData(expandedStatusData);
function fixture(skill,data=statusData){
  const sample=createForestSample(seed,base,forest,{map_id:'M70010',members:[{id:'012'}]},skills,scheduler);initializeScheduler(sample.actors,scheduler);
  const caster=clearNativeStatuses(sample.actors[0],data),target=copy(caster);caster.current_skill=copy(skill);target.id='support-target';target.state_raw=0;
  target.raw_hp=20;target.raw_by_address[addr(0x524a701)]=20;target.hp.current=20+target.resource_bonuses.hp_current;
  return {caster,target};
}
function writeSlots(oracle,target,index=1){
  const shift=index*0x30274;target.native_status_slots.forEach((row,slot)=>Buffer.from(row.raw_hex,'hex').forEach((value,at)=>oracle.write(0x521a7d2+shift+slot*0xc6+at,value,1)));
  oracle.write(0x521f52a+shift,target.status_flags_raw);
}
class SupportOracle extends NativeAssemblyOracle{
  regRead(name){if(name==='BL')return this.reg.EBX&255;return super.regRead(name);}
  regWrite(name,value){if(name==='BL'){this.reg.EBX=(this.reg.EBX&~255)|(value&255);return;}return super.regWrite(name,value);}
  external(target){const arg=i=>this.read(this.reg.ESP+i*4);
    if(target===0x40121c){this.reg.EAX=0;return;} // 41B3C0 action/dispatch guard: this contact has already been admitted.
    if(target===0x570a40){for(let at=0;at<arg(2);at++)this.write(arg(0)+at,arg(1),1);this.reg.EAX=arg(0);return;}
    if(target===0x570d10){const values=Array.from({length:arg(2)},(_,at)=>this.read(arg(1)+at,1));values.forEach((value,at)=>this.write(arg(0)+at,value,1));this.reg.EAX=arg(0);return;}
    if(target===0x507c60){this.write(arg(0),(this.read(arg(0))|(arg(1)&0x3ff))>>>0);return;}
    if(target===0x50e3a0){this.animation_type=arg(1);return;}
    if(target===0x401609){this.command_cancellations=(this.command_cancellations??0)+1;return;} // 42FE40 UI/queued-command dispatch is surfaced separately.
    return super.external(target);
  }
}
function native(caster,target,seedValue){
  const rng=createNativeRng(seedValue),oracle=new SupportOracle(functions,[caster,target],rng);writeSlots(oracle,caster,0);writeSlots(oracle,target);
  oracle.write(0x521f68e,1);oracle.write(0x55df74c,2);oracle.run(0x50fa00,[0]);return {oracle,rng};
}
function compare(actual,oracle,index=1){
  const shift=index*0x30274;
  for(const [field,address]of [['raw_hp',0x524a701],['raw_hp_maximum',0x524a705],['raw_mp',0x524a709],['raw_mp_maximum',0x524a70d]])assert.equal(actual[field],oracle.read(address+shift),field);
  assert.equal(actual.state_raw,oracle.read(0x521a77b+shift,1));assert.equal(actual.status_flags_raw,oracle.read(0x521f52a+shift)>>>0);
  for(const field of statusData.aggregation)assert.equal(actual.status_by_address[field.address],oracle.read(Number(field.address)+shift,field.bits===8?1:4),field.address);
  for(let slot=0;slot<100;slot++)assert.equal(actual.native_status_slots[slot].raw_hex,Buffer.from(Array.from({length:0xc6},(_,at)=>oracle.read(0x521a7d2+shift+slot*0xc6+at,1))).toString('hex'),`slot${slot}`);
}
test('actual004 learned33/38 use the allied recovery branch and preserve every source byte',()=>{
  for(const index of [33,38]){const skill=source[index],raw=Buffer.from(skill.fixed_raw_hex,'hex');assert.equal(skill.learned_raw,1);assert.equal(raw[0x24],0);assert.equal(raw[0x25],1);
    assert.equal(raw[0x232],0);assert.equal(raw[0x23c],index===33?0:5);assert.equal(skill.mp_cost,index===33?6:12);assert.equal(nativeSupportSkillSupported(skill),true);
    assert.equal(original.subarray(skill.source.fixed_record_offset,skill.source.fixed_record_offset+0x41d).toString('hex'),skill.fixed_raw_hex);}
  assert.equal(Buffer.from(source[33].fixed_raw_hex,'hex').readInt32LE(0xab),1200);assert.equal(Buffer.from(source[33].fixed_raw_hex,'hex').readInt32LE(0xaf),1200);
  assert.equal(nativeSupportSkillSupported(source[40]),false);assert.equal(nativeRevivalSkillSupported(source[40]),true);
});
test('actual033/038 action records retain the original command6/4/11 sequence and sole contact18',()=>{
  for(const index of [33,38]){
    const skill=source[index];assert.equal(skill.actions.length,20);
    assert.deepEqual(skill.actions.filter(row=>row.type_raw===1&&row.command_raw!==0).map(row=>[row.index,row.command_raw]),[[0,6],[16,6],[17,4],[18,4],[19,11]]);
    assert.deepEqual(skill.actions.filter(row=>row.contact_raw).map(row=>[row.index,row.contact_raw]),[[18,1]]);
    for(const row of skill.actions)assert.equal(original.subarray(row.source_offset,row.source_offset+0xb0).toString('hex'),row.raw_hex);
  }
});
test('support availability checks actual learning, level, silence, MP and living allied targets without requiring injury or statuses',()=>{
  for(const index of [33,38]){
    const skill=source[index],{caster,target}=fixture(skill),check=()=>supportSkillAvailability({caster,target,skill,learned:true});
    assert.equal(check().available,true);assert.equal(supportSkillAvailability({caster,target,skill,learned:false}).available,false);
    caster.mp.current=skill.mp_cost-1;assert.match(check().reason,/MP/);caster.mp.current=skill.mp_cost;
    caster.status_flags_raw=2;assert.match(check().reason,/沉默/);caster.status_flags_raw=0;
    const levelRaw=Buffer.from(skill.fixed_raw_hex,'hex');levelRaw.writeInt32LE(caster.level+1,0x143);
    assert.match(supportSkillAvailability({caster,target,skill:{...skill,fixed_raw_hex:levelRaw.toString('hex')},learned:true}).reason,/等级/);
    target.side_raw=0;assert.equal(check().available,false);target.side_raw=caster.side_raw;
    for(const state of [4,5,6,7,11]){target.state_raw=state;assert.equal(supportTargetEligibility(target,skill).available,false);}target.state_raw=0;
    target.immune_raw=1;assert.equal(check().available,false);target.immune_raw=0;target.escaped=true;assert.equal(check().available,false);target.escaped=false;
    target.hp.current=target.hp.maximum;assert.equal(check().available,true,'source permits full-HP/empty-status casts');
  }
});
test('source33 recovery and source38 clear-all match full native50FA00 contact, including preservation of mode2 on healing',()=>{
  for(const index of [33,38])for(let n=0;n<18;n++){
    const skill=source[index],{caster,target}=fixture(skill),rng=createNativeRng(n*214013);
    target.raw_hp=20+n*91;target.raw_by_address[addr(0x524a701)]=target.raw_hp;target.hp.current=target.raw_hp+target.resource_bonuses.hp_current;
    target.native_status_slots[17]={raw_hex:mode2};target.status_flags_raw=8;target.status_by_address[addr(0x521f52a)]=8;
    for(const [address,value]of [[0x521f551,n%2?0:5],[0x521f555,n%3?0:20],[0x521f571,n%4?0:150],[0x521f575,n%5?0:125],
      [0x521f559,n%3?0:1],[0x521f55d,n%4?0:2],[0x521f579,n%6?0:2],[0x521f57d,n%5?0:125]])target.status_by_address[addr(address)]=value;
    const before=copy(target),actual=applyNativeSupport({target,skill,rng,statusData}),expected=native(caster,target,n*214013);
    compare(actual.actor,expected.oracle);assert.deepEqual(actual.trace.filter(row=>row.kind==='rng').map(row=>row.raw),expected.oracle.rng_calls);assert.equal(rng.state,expected.rng.state);
    assert.equal(actual.cleared_statuses,index===38?1:0);assert.deepEqual(target,before);
    if(index===33)assert.deepEqual(actual.actor.native_status_slots,before.native_status_slots);
    else assert.ok(actual.actor.native_status_slots.every(row=>row.raw_hex===ZERO));
  }
});
test('configured support HP/MP ranges use native exclusive upper bounds and draw HP before MP',()=>{
  for(const n of [0,1,99,12345]){
    const raw=Buffer.from(source[33].fixed_raw_hex,'hex');raw.writeInt32LE(120,0xab);raw.writeInt32LE(180,0xaf);raw.writeInt32LE(3,0xbb);raw.writeInt32LE(17,0xbf);
    const skill={...source[33],fixed_raw_hex:raw.toString('hex')},{caster,target}=fixture(skill),rng=createNativeRng(n);
    const actual=applyNativeSupport({target,skill,rng,statusData}),expected=native(caster,target,n);compare(actual.actor,expected.oracle);
    assert.deepEqual(actual.trace.filter(row=>row.kind==='rng').map(row=>[row.label,row.raw,row.modulus]),[
      ['support-hp-range',expected.oracle.rng_calls[0],60],['support-mp-range',expected.oracle.rng_calls[1],14]]);assert.equal(rng.state,expected.rng.state);
  }
});
test('id0 mode0/5 ignores secondary HP/MP/max payload exactly as508BB0, without dispatching41BFB0',()=>{
  for(const index of [33,38]){
    const raw=Buffer.from(source[index].fixed_raw_hex,'hex');
    for(const [at,value]of [[0x23,-10000],[0x27,9000],[0x2b,5000],[0x2f,-5000],[0x43,-75]])raw.writeInt32LE(value,0x231+at);
    raw[0x231+0x10]=1;raw[0x231+0x11]=35;
    // These are deliberately adversarial bytes, not an alteration of the
    // immutable source33/38 fixtures. Native id0 makes them dormant.
    const skill={...source[index],fixed_raw_hex:raw.toString('hex')};assert.equal(nativeSupportSkillSupported(skill),true);
    const {caster,target}=fixture(skill),rng=createNativeRng(12345),actual=applyNativeSupport({target,skill,rng,statusData}),expected=native(caster,target,12345);
    compare(actual.actor,expected.oracle);assert.deepEqual(expected.oracle.rng_calls,[]);assert.equal(rng.state,expected.rng.state);
  }
  const active=Buffer.from(source[33].fixed_raw_hex,'hex');active[0x232]=43;
  assert.equal(nativeSupportSkillSupported({...source[33],fixed_raw_hex:active.toString('hex')}),true,'nonzero IDs use the shared status handler');
  const mode=Buffer.from(source[33].fixed_raw_hex,'hex');mode[0x23c]=4;
  assert.equal(nativeSupportSkillSupported({...source[33],fixed_raw_hex:mode.toString('hex')}),false,'escape/reaction mode4 cannot become recovery');
});
test('generic group support applies in native actor order to each eligible ally and keeps original single-target source flags immutable',()=>{
  for(const index of [33,38]){
    const raw=Buffer.from(source[index].fixed_raw_hex,'hex');raw[0x24]=1;
    const skill={...source[index],fixed_raw_hex:raw.toString('hex')},{caster,target}=fixture(skill),rng=createNativeRng(7);
    caster.native_status_slots[0]={raw_hex:mode2};target.native_status_slots[17]={raw_hex:mode2};
    const expected=native(caster,target,7),results=[caster,target].map(actor=>applyNativeSupport({target:actor,skill,rng,statusData}));
    results.forEach((result,n)=>compare(result.actor,expected.oracle,n));assert.equal(rng.state,expected.rng.state);
    assert.equal(Buffer.from(source[index].fixed_raw_hex,'hex')[0x24],0,'actual source remains single-target');
  }
});
test('ineligible contacts preserve resources and statuses, without a recovery or status-removal RNG draw',()=>{
  for(const index of [33,38])for(const state of [4,5,6,7,11]){
    const skill=source[index],{caster,target}=fixture(skill);target.state_raw=state;const before=copy(target),actual=applyNativeSupport({target,skill,statusData,rng:()=>{throw Error('Ineligible contact must not draw');}});
    const expected=native(caster,target,0);compare(actual.actor,expected.oracle);assert.deepEqual(actual.actor,before);assert.equal(actual.applied,false);assert.deepEqual(expected.oracle.rng_calls,[]);
  }
});
test('actual00440 revival reuses the original mode3 branch and recovery instruction sequence',()=>{
  const skill=source[40];assert.equal(skill.learned_raw,1);
  for(let n=0;n<16;n++){
    const {caster,target}=fixture(skill);target.state_raw=[0,3,4,5,6,7,8,11][n%8];target.immune_raw=n%5===0?1:0;
    target.raw_hp=-target.resource_bonuses.hp_current;target.raw_by_address[addr(0x524a701)]=target.raw_hp;target.hp.current=0;
    const before=copy(target),rng=createNativeRng(n),actual=applyNativeRevival({target,skill,rng}),expected=native(caster,target,n);
    compare(actual.actor,expected.oracle);assert.deepEqual(actual.trace.filter(row=>row.kind==='rng').map(row=>row.raw),expected.oracle.rng_calls);assert.equal(rng.state,expected.rng.state);assert.deepEqual(target,before);
  }
});
test('every companion allied support source matches original50FA00 for application, recovery, duplicates and RNG order',()=>{
  assert.equal(Object.keys(alliedSource).length,27);
  for(const[key,skill]of Object.entries(alliedSource)){
    const revival=skill.mode_raw===3;assert.equal(revival?nativeRevivalSkillSupported(skill):nativeSupportSkillSupported(skill),true,key);
    for(const seedValue of [0,12345,214013]){
      let {caster,target}=fixture(skill,expandedStatusData);
      if(revival){target.state_raw=4;target.raw_hp=-target.resource_bonuses.hp_current;target.raw_by_address[addr(0x524a701)]=target.raw_hp;target.hp.current=0;}
      const group=Buffer.from(skill.fixed_raw_hex,'hex')[0x24]===1,actors=group?[caster,target]:[target],rng=createNativeRng(seedValue),before=copy(actors),
        results=actors.map(target=>revival?applyNativeRevival({target,skill,rng}):applyNativeSupport({target,skill,rng,statusData:expandedStatusData})),expected=native(caster,target,seedValue);
      results.forEach((actual,index)=>compare(actual.actor,expected.oracle,group?index:1));assert.deepEqual(results.flatMap(actual=>actual.trace.filter(row=>row.kind==='rng').map(row=>row.raw)),expected.oracle.rng_calls,key);assert.equal(rng.state,expected.rng.state,key);assert.deepEqual(actors,before);
      if(!revival&&skill.mode_raw===0&&skill.effect_id_raw){
        const updated=results.map(row=>row.actor),duplicateRng=createNativeRng(seedValue),duplicates=updated.map(target=>applyNativeSupport({target,skill,rng:duplicateRng,statusData:expandedStatusData})),duplicateExpected=native(group?updated[0]:caster,updated.at(-1),seedValue);
        duplicates.forEach((duplicate,index)=>{compare(duplicate.actor,duplicateExpected.oracle,group?index:1);assert.equal(duplicate.status_native_return,0,key);assert.equal(duplicate.status_reason,'duplicate-id-and-mode');});
        assert.deepEqual(duplicateExpected.oracle.rng_calls,[]);assert.equal(duplicateRng.state,duplicateExpected.rng.state);
      }
    }
  }
});
test('actual00141 cures only the first matching status and still recovers HP when no status can be removed',()=>{
  const skill=alliedSource['001:41'],payload=Buffer.from(skill.effect_raw_hex,'hex');payload[0xb]=0;
  for(const mode of ['absent','single','two','duplicate-removal-mode']){
    const {caster,target}=fixture(skill,expandedStatusData);
    if(mode!=='absent')target.native_status_slots[2]={raw_hex:payload.toString('hex')};
    if(mode==='two')target.native_status_slots[7]={raw_hex:payload.toString('hex')};
    if(mode==='duplicate-removal-mode')target.native_status_slots[7]={raw_hex:skill.effect_raw_hex};
    target.native_status_slots[11]={raw_hex:mode2};
    const rng=createNativeRng(35),actual=applyNativeSupport({target,skill,rng,statusData:expandedStatusData}),expected=native(caster,target,35);
    compare(actual.actor,expected.oracle);assert.deepEqual(expected.oracle.rng_calls,[]);assert.equal(rng.state,expected.rng.state);
    assert.equal(actual.cleared_statuses,['single','two'].includes(mode)?1:0);assert.equal(actual.hp_delta,300);assert.equal(actual.actor.native_status_slots[11].raw_hex,mode2,'allied cures do not trigger508A90 contact-removal');
    if(mode==='two')assert.equal(actual.actor.native_status_slots[7].raw_hex,payload.toString('hex'));
  }
});
test('actual00444/45 retain dormant ID0 numerical bytes without inventing an elemental buff',()=>{
  for(const key of ['004:44','004:45']){
    const skill=alliedSource[key],{caster,target}=fixture(skill,expandedStatusData),before=copy(target),rng=createNativeRng(12345);
    assert.equal(skill.effect_id_raw,0);assert.ok(Buffer.from(skill.effect_raw_hex,'hex').subarray(0x8b,0xa3).some(Boolean));
    const actual=applyNativeSupport({target,skill,rng,statusData:expandedStatusData}),expected=native(caster,target,12345);
    compare(actual.actor,expected.oracle);assert.deepEqual(actual.actor.native_status_slots,before.native_status_slots);assert.deepEqual(actual.actor.status_by_address,before.status_by_address);
    assert.equal(actual.hp_delta,0);assert.equal(actual.mp_delta,0);assert.equal(actual.status_reason,'effect-id-zero');assert.deepEqual(expected.oracle.rng_calls,[]);assert.equal(rng.state,expected.rng.state);
  }
});
test('actual00436/37 periodic HP recovery, source duration and final slot expiry match509E10 instruction replay',()=>{
  for(const key of ['004:36','004:37']){
    const skill=alliedSource[key],{target}=fixture(skill,expandedStatusData),applied=applyNativeSupport({target,skill,rng:createNativeRng(0),statusData:expandedStatusData});let actor=applied.actor;
    for(let tick=1;tick<=20;tick++){
      const oracle=new SupportOracle(functions,[actor],()=>{throw Error('Healing tick must not draw RNG');});writeSlots(oracle,actor,0);oracle.write(0x679c74,500);
      for(const metadata of Object.values(expandedStatusData.effects)){
        const id=metadata.id_raw,action=0x30000000+id*0x100;oracle.write(0x55eb0c3+(id-1)*0xeb,action);oracle.write(0x55eb0cb+(id-1)*0xeb,metadata.frame_count);oracle.write(action+1,metadata.interval_ms);
      }
      const actual=tickNativeStatuses({actor,data:expandedStatusData,threshold:500,now:tick*80});oracle.run(0x509e10,[tick*80,0]);compare(actual.actor,oracle,0);
      assert.equal(actual.ticks,1);assert.equal(actual.death_requested,false);assert.deepEqual(oracle.rng_calls,[]);actor=actual.actor;
      assert.equal(Buffer.from(actor.native_status_slots[0].raw_hex,'hex').readInt32LE(2),tick===20?0:20-tick);
    }
    assert.ok(actor.native_status_slots.every(slot=>slot.raw_hex===ZERO));
  }
});
