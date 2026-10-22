// Differential reactions use original x86 text, including 0x41C610 ranges and
// 0x5016B0 lookup draws. No second JavaScript reaction formula is an oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {createNativeRng} from '../web/core/combat_rules.mjs';
import {applyContactReaction,finalizeNativeDeath,validateForestReactionsData} from '../web/core/battle_reactions.mjs';
const clone=structuredClone,hash=b=>createHash('sha256').update(b).digest('hex');
const data=JSON.parse(await readFile(new URL('../web/data/forest_reactions.json',import.meta.url)));
const instructions=JSON.parse(await readFile(new URL('../evidence/forest_reactions_instructions_20261011.json',import.meta.url)));
const native=JSON.parse(await readFile(new URL('../evidence/forest_death_reactions_native_20261011.json',import.meta.url)));
const sample=JSON.parse(await readFile(new URL('../web/data/combat_sample.json',import.meta.url))),roles=Object.values(data.roles),checks=[];
const report={schema:'seventh-seal-forest-reactions-verification',version:1,passed:false,original_game_execution_observed:false,
  comparison:'Pure descriptors versus original 0x51C640/0x50B520/0x41EF00/0x50B770/0x5016B0/0x4FFE90/0x4FFD40 x86 instruction replay',checks,
  case_counts:{normal:0,guard:0,dodge:0,stream:0,death:0},
  oracle_hooks:['Current fixed records are copied from the supplied source snapshot by native record getter hooks.',
    'Each original skill table is placed at a synthetic address; native 0x5016B0 scans it with native cached-id counts zero, preserving lookup RNG even at count1.',
    'Display, path-cancel and debug-stack calls are bounded no-op hooks; original rendering/OS is not executed.',
    'Death finalization status reset follows retained 0x507E20 memset ranges; loot collection and victory dispatch remain explicit external hooks.'],
  limits:['Guard/dodge require grounded special gate0; original nonzero Z/F692 dispatch through 0x51CC00 is rejected explicitly.',
    'Death finalization clears existing status fields and returns a status-slot-clear directive; the status lifecycle module clears its serialized slots.',
    'HP/status contact submission, inventory/victory dispatch and preview timing are validated separately; descriptors do not execute contacts or animation.']};
function makeActor(role,id,overrides={}){
  const a=clone(sample.actors[role.id==='001'?0:1]);a.id=id;a.resource_id=role.id;a.current_skill=clone(role.skills[0]);
  a.current_target_id=null;a.native_active=false;a.reaction_special_gate_raw=0;a.native_z_raw=0;a.status_flags_raw=0;a.reaction_busy_raw=1;
  if(role.id!=='001'){
    const b=Buffer.from(role.header_raw_hex,'hex');for(const addr of Object.keys(a.raw_by_address)){const off=Number(addr)-0x524a6d1;a.raw_by_address[addr]=b.readInt32LE(off);}
    a.side_raw=b[0x19];a.raw_hp=a.raw_by_address['0x0524a701'];a.hp.current=a.raw_hp;
  }
  a.class_raw=a.current_skill.actions[0].class_raw;a.action_mask_raw=a.current_skill.actions[0].action_mask_raw;
  return {...a,...overrides};
}
function record(overrides={}){const b=Buffer.alloc(0xb0);b[0x62]=1;b[0x77]=9;for(const[o,n]of Object.entries(overrides))b[Number(o)]=n;return {raw_hex:b.toString('hex')};}
function selected(role,ident){return clone(role.skills.find(s=>s.original_id_raw===ident));}
function scripted(values){let i=0;return()=>{assert.ok(i<values.length,'unexpected RNG draw');return values[i++];};}
class ReactionOracle extends NativeAssemblyOracle{
  constructor(actors,rng){super(instructions.functions,actors,rng);actors.forEach((a,i)=>{
    const offset=i*0x30274,role=data.roles[a.resource_id],base=0x20000000+i*0x100000;
    Buffer.from(role.header_raw_hex,'hex').forEach((v,j)=>this.write(0x524a6d1+offset+j,v,1));
    for(const [address,value]of Object.entries(a.raw_by_address))this.write(Number(address)+offset,value);
    this.write(0x524a6d1+offset,role.skill_count);this.write(0x524a9dc+offset,base);
    this.write(0x521f52a+offset,a.status_flags_raw);this.write(0x521a778+offset,Number(a.native_active),1);
    this.write(0x521f692+offset,a.reaction_special_gate_raw);this.write(0x521a785+offset,a.native_z_raw);
    this.write(0x521f5f8+offset,a.reaction_busy_raw,1);this.write(0x521f5f6+offset,1,1);this.write(0x521f5f7+offset,1,1);
    this.write(0x521f68e+offset,a.current_target_id===null?-1:actors.findIndex(x=>x.id===a.current_target_id));
    this.write(0x524a656+offset,a.current_skill.original_skill_index,1);this.write(0x524a657+offset,6,1);
    role.skills.forEach(s=>{const b=Buffer.from(s.fixed_raw_hex,'hex');b.forEach((v,j)=>this.write(base+s.original_skill_index*0x421+j,v,1));});
  });}
  external(target){
    if([0x511c30,0x401609,0x50cb60,0x4ffa30].includes(target))return;
    if(target===0x507e20){const offset=this.read(this.reg.ESP)*0x30274;for(let i=0;i<0xca;i++)this.write(0x521f52a+offset+i,0,1);return;}
    return super.external(target);
  }
}
function compareHandler(role,attacker,target,reaction,values,action=record(),category='guard'){
  const actors=[attacker,target],before=clone(actors),rng=typeof values==='function'?values:scripted(values),nativeRng=typeof values==='function'?createNativeRng(values.seed):scripted(values);
  const actual=applyContactReaction({attacker,target,result:{damage:reaction===0?1:0,reaction,native_return:0},record:action,data,rng});
  const oracle=new ReactionOracle(actors,nativeRng);let dispatch;
  if(reaction===0)oracle.run(0x51c640,[1,Buffer.from(action.raw_hex,'hex')[0x62]]);
  else if(reaction===1)oracle.run(0x50b520,[1,Buffer.from(action.raw_hex,'hex')[0x77]]);
  else{dispatch=Buffer.from(action.raw_hex,'hex')[0x48]===0?oracle.run(0x41ef00,[0,1,0]).eax:0;oracle.run(0x50b770,[1,0,9,dispatch]);}
  const offset=0x30274,idx=oracle.read(0x524a656+offset,1),targetIndex=oracle.read(0x521f68e+offset);
  assert.ok(actual);assert.equal(actual.source_skill_index??target.current_skill.original_skill_index,idx);
  assert.equal(actual.target_id,targetIndex<0?null:actors[targetIndex].id);
  assert.equal(actual.after.reaction_busy_raw??target.reaction_busy_raw,oracle.read(0x521f5f8+offset,1));
  assert.equal(actual.after.native_active??target.native_active,Boolean(oracle.read(0x521a778+offset,1)));
  assert.deepEqual(actual.trace.filter(e=>e.kind==='rng').map(e=>e.raw),oracle.rng_calls);
  if(typeof values==='function')assert.equal(rng.state,nativeRng.state);
  assert.deepEqual(actors,before);report.case_counts[category]++;return {actual,oracle,dispatch};
}
test('full original reaction source bytes, instruction identity and 113 skills are immutable',async()=>{
  validateForestReactionsData(data);assert.equal(roles.reduce((n,r)=>n+r.skill_count,0),113);
  for(const r of roles){const b=await readFile(new URL('../../../'+r.source.path,import.meta.url));assert.equal(hash(b),r.source.sha256);
    assert.equal(b.subarray(8,8+0x30b).toString('hex'),r.header_raw_hex);
    for(const s of r.skills){const f=b.subarray(s.source_record_offset,s.source_record_offset+0x41d);assert.equal(f.toString('hex'),s.fixed_raw_hex);assert.equal(hash(f),s.record_sha256);
      for(const a of s.actions){assert.equal(b.subarray(a.offset,a.offset+0xb0).toString('hex'),a.raw_hex);assert.equal(hash(Buffer.from(a.raw_hex,'hex')),a.raw_sha256);}}
  }
  for(const[address,lines]of Object.entries(instructions.functions)){const r=native.records.find(r=>r.evidence_id===instructions.evidence[address]);assert.equal(r.parameters.procedure.toLowerCase(),address);assert.deepEqual(lines,r.normalized_result.split(/\r?\n/));}
  for(const[path,sha]of Object.entries(data.source_hashes))assert.equal(hash(await readFile(new URL('../../../'+path,import.meta.url))),sha);
  checks.push('4 source headers / 113 full skill and action arrays / retained instructions match source hashes');
});
test('normal contacts draw lookup RNG, select original id1 and clear target without settled reset',()=>{
  for(const r of roles)for(const ident of [0,1,2,3,4,5,6,8,9,18,19]){
    const target=makeActor(r,'target',{current_skill:selected(r,ident),current_target_id:'attacker',settled_raw:1}),a=makeActor(data.roles['013'],'attacker');
    const {actual}=compareHandler(r,a,target,0,[32767],record(),'normal');assert.equal(actual.target_id,null);assert.equal(actual.trace.length,1);assert.equal(actual.after.settled_raw,undefined);
  }
  checks.push('44 normal handler instruction comparisons preserve lookup draw and source old-skill state');
});
test('guard split uses raw%10 edges then singleton lookup RNG and retains prior/null target',()=>{
  for(const r of roles)for(const oldTarget of [null,'attacker'])for(const raw of [0,6,7,9,16,17,32767]){
    const a=makeActor(data.roles['001'],'attacker'),t=makeActor(r,'target',{current_target_id:oldTarget});
    const {actual}=compareHandler(r,a,t,1,[raw,255]);assert.equal(actual.skill.original_id_raw,raw%10<7?9:19);assert.equal(actual.trace.length,2);assert.equal(actual.target_policy,'preserve');
  }
  checks.push('56 guard instruction comparisons preserve prior target and style/lookup draw order');
});
test('guard id19 and param0 clear busy without repeated RNG or new skill',()=>{
  for(const r of roles)for(const special of [0,1]){
    const a=makeActor(data.roles['001'],'attacker'),t=makeActor(r,'target',{current_skill:selected(r,19),reaction_special_gate_raw:special});
    const {actual}=compareHandler(r,a,t,1,[]);assert.equal(actual.kind,'none');assert.equal(actual.trace.length,0);
  }
  for(const r of roles)compareHandler(r,makeActor(data.roles['001'],'attacker'),makeActor(r,'target'),1,[],record({0x77:0}));
  checks.push('12 guard no-repeat / param0 instruction comparisons draw nothing');
});
test('dodge probability includes equality, equipment/status adjustment and original range RNG',()=>{
  for(const r of roles)for(const status of [-100,0,1,99,100])for(const roll of [0,1,99]){
    const a=makeActor(data.roles['013'],'attacker'),t=makeActor(r,'target');t.status_by_address['0x0521f5a9']=status;
    compareHandler(r,a,t,2,[15,15,15,roll,32767],record(),'dodge');
  }
  checks.push('60 dodge probability/equipment/status instruction comparisons preserve effective range RNG');
});
test('dodge current id2/3/4/5/8 suppress counter after probability draw',()=>{
  for(const r of roles)for(const ident of [2,3,4,5,8]){
    const a=makeActor(data.roles['013'],'attacker'),t=makeActor(r,'target',{current_skill:selected(r,ident)});t.status_by_address['0x0521f5a9']=1000;
    const {actual,dispatch}=compareHandler(r,a,t,2,[15,15,15,0,255],record(),'dodge');assert.equal(dispatch,0);assert.equal(actual.skill.original_id_raw,18);
  }
  checks.push('20 suppression-id instruction comparisons still consume probability before response lookup');
});
test('active id19 attacker forces new defender id18, while inactive id19 allows counter',()=>{
  for(const r of roles)for(const active of [false,true]){
    const ar=data.roles['013'],a=makeActor(ar,'attacker',{native_active:active,current_skill:selected(ar,19)}),t=makeActor(r,'target');t.status_by_address['0x0521f5a9']=1000;
    const {actual}=compareHandler(r,a,t,2,[15,15,15,0,255],record(),'dodge');assert.equal(actual.skill.original_id_raw,active?18:19);assert.equal(actual.target_id,'attacker');
  }
  checks.push('8 counter-chain instruction comparisons force new id18 only for active attacker id19');
});
test('source action48 suppresses effective/probability draws but still dispatches id18 lookup',()=>{
  for(const r of roles){const {actual}=compareHandler(r,makeActor(data.roles['013'],'attacker'),makeActor(r,'target'),2,[32767],record({0x48:1}),'dodge');assert.equal(actual.skill.original_id_raw,18);assert.equal(actual.trace.length,1);}
  checks.push('4 action48 instruction comparisons omit effective/probability RNG and retain response lookup');
});
test('continuous CRT streams preserve every effective/probability/lookup draw for all four roles',()=>{
  for(const r of roles)for(let seed=0;seed<25;seed++){
    const rng=createNativeRng(seed*77273);rng.seed=seed*77273;
    compareHandler(r,makeActor(data.roles['013'],'attacker'),makeActor(r,'target'),2,rng,record(),'stream');
  }
  checks.push('100 original CRT-stream comparisons preserve RNG state through complete dodge dispatch');
});
test('outer skipped/rejected/zero contacts and dead/immune normal gates consume no reaction RNG',()=>{
  const a=makeActor(data.roles['001'],'attacker'),t=makeActor(data.roles['013'],'target');let calls=0;const rng=()=>{calls++;return 0;};
  for(const result of [{damage:0,skipped:'native-contact-gate'},{damage:0,native_return:-1},{damage:0,reaction:0,native_return:0}])assert.equal(applyContactReaction({attacker:a,target:t,result,record:record(),data,rng}),null);
  for(const patch of [{immune_raw:1},{state_raw:5}])assert.equal(applyContactReaction({attacker:a,target:{...t,...patch},result:{damage:1,reaction:0,native_return:1},record:record(),data,rng}),null);
  assert.equal(calls,0);checks.push('Rejected/skipped/no-damage and unavailable normal targets do not add RNG');
});
test('unknown airborne/special dispatch and missing raw fields reject explicitly before RNG',()=>{
  const a=makeActor(data.roles['001'],'attacker'),t=makeActor(data.roles['013'],'target');let calls=0;const rng=()=>{calls++;return 0;};
  for(const patch of [{native_z_raw:1},{reaction_special_gate_raw:1},{reaction_special_gate_raw:undefined},{native_active:undefined},{current_target_id:undefined}])assert.throws(()=>applyContactReaction({attacker:a,target:{...t,...patch},result:{damage:0,reaction:1,native_return:0},record:record(),data,rng}));
  const invalid=clone(t);delete invalid.status_by_address['0x0521f5a9'];assert.throws(()=>applyContactReaction({attacker:a,target:invalid,result:{damage:0,reaction:2,native_return:0},record:record(),data,rng}));
  assert.equal(calls,0);checks.push('Unknown airborne/special dispatch and incomplete native snapshots fail before RNG');
});
test('native newly lethal setter draws nothing, then category4 normal reaction still draws lookup',()=>{
  for(const r of roles){const a=makeActor(data.roles['001'],'attacker'),t=makeActor(r,'target',{settled_raw:1,reaction_special_gate_raw:99});
    const oracle=new ReactionOracle([a,t],scripted([]));oracle.run(0x4ffd40,[1,0]);
    assert.equal(oracle.read(0x521a77b+0x30274,1),4);assert.equal(oracle.read(0x521f69d+0x30274,1),0);assert.equal(oracle.read(0x521f5f8+0x30274,1),0);assert.deepEqual(oracle.rng_calls,[]);
    const {actual}=compareHandler(r,a,{...t,state_raw:4,settled_raw:0,reaction_busy_raw:0,reaction_special_gate_raw:0},0,[255],record(),'normal');assert.equal(actual.skill.original_id_raw,1);
  }
  checks.push('4 new-death setter and category4 normal reaction instruction comparisons retain ordinary lookup draw');
});
test('death finalization chooses player id12, enemy id2 or modulo7 fade in original draw order',()=>{
  for(const r of roles)for(const ident of [0,1,2,3,4,9,18,19])for(const raw of [0,6,32767]){
    const other=makeActor(data.roles['001'],'other'),actor=makeActor(r,'dead',{state_raw:4,native_active:true,current_skill:selected(r,ident),current_target_id:'other',settled_raw:1,reaction_special_gate_raw:99,status_flags_raw:16});
    actor.status_by_address['0x0521f5a9']=42;const before=clone(actor);
    const actual=finalizeNativeDeath({actor,data,rng:scripted([raw])}),oracle=new ReactionOracle([other,actor],scripted([raw]));oracle.run(0x4ffe90,[1]);
    const offset=0x30274,idx=oracle.read(0x524a656+offset,1);assert.equal(actual.source_skill_index??actor.current_skill.original_skill_index,idx);
    assert.equal(actual.after.state_raw,oracle.read(0x521a77b+offset,1));assert.equal(actual.after.settled_raw,oracle.read(0x521f69d+offset,1));assert.equal(actual.after.status_flags_raw,oracle.read(0x521f52a+offset));
    assert.equal(actual.after.reaction_special_gate_raw,oracle.read(0x521f692+offset));assert.equal(actual.after.reaction_inhibit_raw,oracle.read(0x521f69e+offset));
    assert.equal(actual.after.native_active??actor.native_active,Boolean(oracle.read(0x521a778+offset,1)));
    assert.equal(actual.target_id,'other');assert.equal(oracle.read(0x521f68e+offset),0);assert.equal(actual.after.status_by_address['0x0521f5a9'],0);
    assert.deepEqual(actual.trace.map(e=>e.raw),oracle.rng_calls);assert.equal(actual.trace.length,1);
    if(r.id==='001'){assert.equal(actual.skill.original_id_raw,12);assert.equal(actual.fade_increment_raw,null);}
    else if([2,4].includes(ident)){assert.equal(actual.skill,null);assert.equal(actual.fade_increment_raw,raw%7+1);assert.equal(actual.after.death_fade_increment_raw,oracle.read(0x521f66a+offset));assert.equal(actual.after.death_fade_clock_raw,220);}
    else{assert.equal(actual.skill.original_id_raw,2);assert.equal(actual.fade_increment_raw,null);}
    assert.deepEqual(actor,before);report.case_counts.death++;
  }
  checks.push('96 death-finalization instruction comparisons retain id12/id2 singleton lookup and conditional enemy fade draws');
});
test('finalized deaths draw nothing, live/airborne death requests reject without mutating resources',()=>{
  const role=data.roles['013'],actor=makeActor(role,'dead',{state_raw:5});let calls=0;const rng=()=>{calls++;return 0;};
  assert.equal(finalizeNativeDeath({actor,data,rng}),null);
  for(const patch of [{state_raw:0},{state_raw:4,native_z_raw:1}])assert.throws(()=>finalizeNativeDeath({actor:{...actor,...patch},data,rng}));
  assert.equal(calls,0);checks.push('Finalized/live/airborne death dispatch guards add no RNG or resource mutation');
});
test.after(async()=>{
  report.passed=checks.length===14;report.fingerprints={};for(const path of ['../web/core/battle_reactions.mjs','../tools/export_forest_reactions.py','../web/data/forest_reactions.json','../evidence/forest_reactions_instructions_20261011.json','test_battle_reactions.mjs'])report.fingerprints[path]=hash(await readFile(new URL(path,import.meta.url)));
  report.source_hashes=data.source_hashes;
  await writeFile(new URL('../evidence/forest_reactions_verification_20261011.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  await writeFile(new URL('../evidence/forest_reactions_verification_20261011.txt',import.meta.url),`白木森林命中后反应验证\n结果：${report.passed?'通过':'失败'}\n原指令对照：${JSON.stringify(report.case_counts)}\n原版运行未观察；此处仅对照反应描述、源技能索引与RNG流。\n`);
});
