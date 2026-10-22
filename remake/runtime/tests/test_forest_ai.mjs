// AI selection is compared with retained x86 instructions, not a second formula port.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createNativeRng} from '../web/core/combat_rules.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {validateForestAIData,selectNativeSkills,selectNativeTarget,planForestEnemyAction} from '../web/core/forest_ai.mjs';
const clone=structuredClone,hash=b=>createHash('sha256').update(b).digest('hex');
const data=JSON.parse(await readFile(new URL('../web/data/forest_ai.json',import.meta.url)));
const instructions=JSON.parse(await readFile(new URL('../evidence/forest_ai_instructions_20261011.json',import.meta.url)));
const native=JSON.parse(await readFile(new URL('../evidence/forest_ai_rules_native_20261011.json',import.meta.url)));
const roles=Object.values(data.roles),checks=[];
const report={schema:'seventh-seal-forest-ai-verification',version:1,passed:false,
  original_game_execution_observed:false,comparison:'Runtime pure selection versus retained x86 instruction interpreter',
  assembly_source:'forest_ai_instructions_20261011.json',checks,
  case_counts:{skill_instruction_comparisons:0,target_instruction_comparisons:0,stream_plan_comparisons:0},
  oracle_hooks:['0x501E90 captures argument skill index / source code bytes; action merge and gauge changes are not executed.',
    'Existing NativeAssemblyOracle accepts original JNC instruction as the equivalent JAE carry condition.',
    'CRT rand and debug stack checker use existing bounded interpreter hooks.'],
  limits:['Instruction-text replay is not CPU execution of GAME.exe or original fight observation.',
    'Only selection and target identity are compared here; combined animation/contacts have separate validation.']};
function actor(id='actor',overrides={}){return {id,resource_id:'013',side_raw:0,state_raw:0,immune_raw:0,reaction_busy_raw:0,status_flags_raw:0,
  raw_by_address:{},status_by_address:{},linked_by_address:{},role_link_raw:0,stance_raw:0,class_raw:0,
  settled_raw:0,defense_half_raw:0,reaction_inhibit_raw:0,hp:{current:960,maximum:960},raw_mp:0,...overrides};}
function scripted(values){let i=0;const rng=()=>{assert.ok(i<values.length,'unexpected RNG draw');return values[i++];};Object.defineProperty(rng,'calls',{get:()=>i});return rng;}
class AIOracle extends NativeAssemblyOracle {
  constructor(actors,role,rng){
    super(instructions.functions,actors,rng);this.role=role;
    this.write(0x55df74c,actors.length);
    actors.forEach((a,i)=>{const offset=i*0x30274;this.write(0x521f52a+offset,a.status_flags_raw??a.status_by_address['0x0521f52a']);this.write(0x521f5f8+offset,a.reaction_busy_raw,1);});
    if(role){const base=0x20000000;this.write(0x524a6d1,role.skill_count);this.write(0x524a9dc,base);
      for(const skill of role.skills){const bytes=Buffer.from(skill.fixed_raw_hex,'hex');for(let i=0;i<bytes.length;i++)this.write(base+skill.index*0x421+i,bytes[i],1);}
    }
  }
  external(target){
    if(target===0x501e90){
      const index=this.read(this.reg.ESP+8)&255,pointer=this.read(this.reg.ESP+4)>>>0,codes=[];
      for(let i=0;i<8&&this.read(pointer+i,1)!==0;i++)codes.push(this.read(pointer+i,1));
      const indices=codes.length?codes.flatMap(code=>this.role.skills.filter(s=>Buffer.from(s.fixed_raw_hex,'hex')[0x19]===code).map(s=>s.index)):[index];
      const side=this.read(0x20000000+index*0x421+0x25,1);
      this.selected={kind:codes.length?'combination':'single',skill_indices:indices,skill_codes:codes,target_side_raw:side};
      this.write(0x524a634,side,1);return;
    }
    return super.external(target);
  }
}
function compareSelection(role,input,values){
  const rng=scripted(values),actual=selectNativeSkills({actor:input,role,rng});
  const oracle=new AIOracle([input],role,scripted(values)),result=oracle.run(0x5029a0,[0]);
  assert.equal(actual.native_return,result.eax);assert.equal(actual.kind,oracle.selected?.kind??'none');
  assert.deepEqual(actual.skill_indices,oracle.selected?.skill_indices??[]);assert.deepEqual(actual.skill_codes,oracle.selected?.skill_codes??[]);
  if(oracle.selected)assert.equal(actual.target_side_raw,oracle.selected.target_side_raw);
  assert.deepEqual(actual.trace.filter(e=>e.kind==='rng').map(e=>e.raw),result.rng_calls);
  assert.equal(rng.calls,result.rng_calls.length);report.case_counts.skill_instruction_comparisons++;
  return actual;
}
function compareTarget(actors,actingIndex,targetSide,values){
  const rng=scripted(values),actual=selectNativeTarget({actors,actor_id:actors[actingIndex].id,target_side_raw:targetSide,rng});
  const oracle=new AIOracle(actors,null,scripted(values));oracle.write(0x524a634+actingIndex*0x30274,targetSide,1);
  const result=oracle.run(0x5014c0,[actingIndex]);
  assert.equal(actual.target_index,result.eax);assert.equal(actual.target_id,result.eax<0?null:actors[result.eax].id);
  assert.deepEqual(actual.trace.map(e=>e.raw),result.rng_calls);report.case_counts.target_instruction_comparisons++;
  return actual;
}
function editedRole(role,edits){const result=clone(role);for(const[index,fields]of Object.entries(edits)){const bytes=Buffer.from(result.skills[index].fixed_raw_hex,'hex');for(const[offset,value]of Object.entries(fields))bytes[Number(offset)]=value;result.skills[index].fixed_raw_hex=bytes.toString('hex');}return result;}

test('exported header, all fixed/action bytes and native instructions match immutable sources',async()=>{
  validateForestAIData(data);for(const role of roles){const bytes=await readFile(new URL('../../../'+role.source.path,import.meta.url));
    assert.equal(hash(bytes),role.source.sha256);assert.equal(bytes.subarray(8,8+0x30b).toString('hex'),role.header_raw_hex);
    assert.equal(bytes.readUInt32LE(8),role.skill_count);
    for(const skill of role.skills){const fixed=bytes.subarray(skill.source_record_offset,skill.source_record_offset+0x41d);
      assert.equal(fixed.toString('hex'),skill.fixed_raw_hex);assert.equal(hash(fixed),skill.record_sha256);
      for(const action of skill.actions){assert.equal(bytes.subarray(action.offset,action.offset+0xb0).toString('hex'),action.raw_hex);assert.equal(hash(Buffer.from(action.raw_hex,'hex')),action.raw_sha256);}
    }
  }
  assert.deepEqual(roles.map(r=>r.learned_indices),[[14,15],[14,15],[15,16]]);
  assert.deepEqual(roles.map(r=>r.skills.filter(s=>s.learned_raw_0x23).map(s=>s.name)),[['鹰爪','飞鹰突击'],['球化攻击','盘化突击'],['烈爪突击','盾面突击']]);
  for(const[address,lines]of Object.entries(instructions.functions)){const record=native.records.find(r=>r.evidence_id===instructions.evidence[address]);assert.equal(record.parameters.procedure.toLowerCase(),address);assert.deepEqual(lines,record.normalized_result.split(/\r?\n/));}
  for(const[path,sha]of Object.entries(data.source_hashes))assert.equal(hash(await readFile(new URL('../../../'+path,import.meta.url))),sha);
  checks.push('3 headers, 64 complete skills, 6 learned commands and 2 instruction functions match originals');
});
test('normal weighted rolls retain half-open byte intervals and uncovered-roll fallback',()=>{
  for(const role of roles)for(const flags of [0,2])for(let roll=0;roll<100;roll++)for(const fallback of [0,1])compareSelection(role,actor('actor',{status_flags_raw:flags}),[20,roll,fallback]);
  const eagle=compareSelection(data.roles['011'],actor(),[20,20]);assert.deepEqual(eagle.skill_indices,[15]);
  assert.deepEqual(compareSelection(data.roles['011'],actor(),[20,70,0]).skill_indices,[14]);
  checks.push('1,202 source-weight/status cases include exact interval edges and extra fallback RNG');
});
test('combination gate and 3-5 duplicate command sequences consume original RNG order',()=>{
  for(const role of roles)for(const gate of [0,19])for(const length of [0,1,2])for(const member of [0,1]){
    const actual=compareSelection(role,actor(),[gate,length,...Array(length+3).fill(member)]);
    assert.equal(actual.kind,'combination');assert.equal(actual.skill_indices.length,length+3);assert.equal(new Set(actual.skill_indices).size,1);
  }
  assert.equal(compareSelection(data.roles['013'],actor(),[20,0]).kind,'single');
  checks.push('36 repeated combinations plus gate20 boundary match instructions');
});
test('status bit1 excludes type2 and failed combination falls through without length draw',()=>{
  for(const gate of [0,19,20,99])for(const roll of [0,19,20,99]){
    const actual=compareSelection(data.roles['011'],actor('actor',{status_flags_raw:2}),[gate,roll,255]);
    assert.equal(actual.kind,'single');assert.deepEqual(actual.skill_indices,[14]);
  }
  const ordinary=actor('actor',{hp:{current:0,maximum:960},raw_mp:-999});compareSelection(data.roles['013'],ordinary,[20,99,1]);
  checks.push('17 status/type and no invented HP/MP strategy comparisons');
});
test('nonzero-side automatic singles choose uniformly including one candidate',()=>{
  for(const role of roles)for(const side of [1,255])for(const flags of [0,2])for(const roll of [0,1,99,32767]){
    const actual=compareSelection(role,actor('actor',{side_raw:side,status_flags_raw:flags}),[20,roll]);
    assert.equal(actual.trace.filter(e=>e.kind==='rng').length,2);
  }
  checks.push('48 nonzero-side automatic uniform choices match instructions');
});
test('zero weights, oversized totals, type0 and no-candidate branches retain native decisions',()=>{
  const role=data.roles['013'],first=15,last=16;
  const zero=editedRole(role,{[first]:{0x27:0},[last]:{0x27:0}});
  for(const roll of [0,39,99])for(const fallback of [0,1])compareSelection(zero,actor(),[20,roll,fallback]);
  const oversized=editedRole(role,{[first]:{0x27:255},[last]:{0x27:255}});
  for(const roll of [0,20,99])assert.deepEqual(compareSelection(oversized,actor(),[20,roll]).skill_indices,[15]);
  const empty=editedRole(role,{[first]:{0x23:0},[last]:{0x23:0}});
  for(const gate of [0,20])assert.equal(compareSelection(empty,actor(),[gate]).kind,'none');
  const type0=editedRole(role,{[first]:{0x32:0}});
  assert.deepEqual(compareSelection(type0,actor(),[20,0]).skill_indices,[16]);
  assert.deepEqual(compareSelection(type0,actor(),[0,0,0,0,0]).skill_indices,[15,15,15]);
  checks.push('13 byte-weight, type0 and empty-source boundary comparisons');
});
test('targets match raw category/immunity/busy gates, source order, side and status bit4',()=>{
  const roster=[actor('caster'),actor('same'),actor('opponent-a',{side_raw:1}),actor('opponent-b',{side_raw:1,state_raw:3}),
    actor('category4',{side_raw:1,state_raw:4}),actor('immune',{side_raw:1,immune_raw:1}),actor('busy',{side_raw:1,reaction_busy_raw:1})];
  for(const flags of [0,16,18])for(const side of [0,1,255])for(const roll of [0,1,99,32767]){
    roster[0].status_flags_raw=flags;compareTarget(roster,0,side,[roll]);
  }
  roster[0].status_flags_raw=0;
  assert.deepEqual(compareTarget(roster,0,0,[0]).candidates.map(c=>c.id),['opponent-a','opponent-b']);
  assert.deepEqual(compareTarget(roster,0,1,[0]).candidates.map(c=>c.id),['caster','same']);
  checks.push('38 raw-target side/confusion/eligibility instruction comparisons');
});
test('empty target pool draws nothing, count1 still draws, HP is not substituted for category',()=>{
  const self=actor('self');assert.equal(compareTarget([self],0,0,[]).target_id,null);
  self.status_flags_raw=16;assert.equal(compareTarget([self],0,1,[]).target_id,null);
  self.status_flags_raw=0;
  const other=actor('other',{side_raw:1,hp:{current:0,maximum:960},reaction_inhibit_raw:999});
  const result=compareTarget([self,other],0,0,[32767]);assert.equal(result.target_id,'other');assert.equal(result.trace.length,1);
  checks.push('3 empty/singleton/no HP substitution target comparisons');
});
test('planned enemy action preserves the same original selection then target RNG stream',()=>{
  for(const role of roles)for(let seed=0;seed<50;seed++){
    const actors=[actor('enemy',{resource_id:role.id}),actor('player-a',{resource_id:'001',side_raw:1}),actor('player-b',{resource_id:'001',side_raw:1})],before=clone(actors);
    const rng=createNativeRng((seed*174637823)>>>0),actual=planForestEnemyAction({actors,actor_id:'enemy',data,rng});
    const nativeRng=createNativeRng((seed*174637823)>>>0),oracle=new AIOracle(actors,role,nativeRng),chosen=oracle.run(0x5029a0,[0]);
    assert.equal(chosen.eax,1);assert.deepEqual(actual.skill_indices,oracle.selected.skill_indices);assert.deepEqual(actual.skill_codes,oracle.selected.skill_codes);assert.equal(actual.kind,oracle.selected.kind);
    const targeted=oracle.run(0x5014c0,[0]);assert.equal(actual.target_index,targeted.eax);assert.equal(actual.target_id,actors[targeted.eax].id);
    assert.deepEqual(actual.trace.filter(e=>e.kind==='rng').map(e=>e.raw),oracle.rng_calls);assert.equal(rng.state,nativeRng.state);assert.deepEqual(actors,before);
    report.case_counts.stream_plan_comparisons++;
  }
  checks.push('150 integrated skill/target stream comparisons with untouched actor inputs');
});
test('source skill0 controls combo target side rather than first or last chosen command',()=>{
  const role=editedRole(data.roles['013'],{0:{0x25:1},15:{0x25:0},16:{0x25:0}});
  const actual=compareSelection(role,actor(),[0,0,0,1,0]);assert.equal(actual.target_side_raw,1);
  assert.equal(actual.parameter_skill_index,0);
  checks.push('combo parameter index0 target side confirmed by original call argument');
});
test('invalid source snapshots reject before RNG, recovery and busy flags stay distinct',()=>{
  const role=data.roles['013'];let calls=0;const rng=()=>{calls++;return 0;};
  assert.throws(()=>selectNativeSkills({actor:actor('bad',{status_flags_raw:undefined}),role,rng}));
  assert.throws(()=>selectNativeSkills({actor:actor('bad',{status_by_address:{'0x0521f52a':16}}),role,rng}));
  assert.throws(()=>selectNativeSkills({actor:actor(),role:{...role,skills:role.skills.slice(1)},rng}));
  assert.throws(()=>planForestEnemyAction({actors:[actor('enemy',{reaction_busy_raw:undefined,reaction_inhibit_raw:0})],actor_id:'enemy',data,rng}));
  assert.equal(calls,0);
  assert.throws(()=>selectNativeTarget({actors:[actor('caster'),actor('opponent',{side_raw:1})],actor_id:'caster',target_side_raw:0,rng:()=>32768}));
  const addressOnly=actor('ok',{status_flags_raw:undefined,status_by_address:{'0x0521f52a':2}});
  assert.deepEqual(selectNativeSkills({actor:addressOnly,role:data.roles['011'],rng:scripted([20,0])}).skill_indices,[14]);
  checks.push('invalid fields fail before RNG and native flag representations are explicit');
});
test.after(async()=>{
  report.passed=checks.length===11;
  report.fingerprints={};for(const path of ['../web/core/forest_ai.mjs','../tools/export_forest_ai.py','../web/data/forest_ai.json','../evidence/forest_ai_instructions_20261011.json','test_forest_ai.mjs'])report.fingerprints[path]=hash(await readFile(new URL(path,import.meta.url)));
  report.source_hashes=data.source_hashes;
  await writeFile(new URL('../evidence/forest_ai_verification_20261011.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  await writeFile(new URL('../evidence/forest_ai_verification_20261011.txt',import.meta.url),`白木森林敌方 AI 选择验证\n结果：${report.passed?'通过':'失败'}\n原指令选招对照：${report.case_counts.skill_instruction_comparisons}\n原指令目标对照：${report.case_counts.target_instruction_comparisons}\n完整随机流对照：${report.case_counts.stream_plan_comparisons}\n原版运行未观察；组合编译/数值/表现验证由独立报告覆盖。\n`);
});
