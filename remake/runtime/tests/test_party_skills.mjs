// Party attacks remain source-bound across command eligibility, pixels,
// contact callbacks and the existing dormant status branch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {directSequence,compileNativeSequence} from '../web/core/skill_sequence.mjs';
import {BattleView,validateBattleViewMetadata} from '../web/battle_view.mjs';
import {BattleResources,battleResources} from '../web/core/battle_resources.mjs';
import {validateForestReactionsData,applyContactReaction} from '../web/core/battle_reactions.mjs';
import {initializeNativeStatuses,applyNativeSkillStatus} from '../web/core/battle_status.mjs';
import {createNativeRng,resolveAction} from '../web/core/combat_rules.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {chapterRoleFromDefinition} from '../web/core/chapter.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
const web=new URL('../web/',import.meta.url),root=new URL('../../../',import.meta.url);
const read=async p=>JSON.parse(await readFile(new URL('data/'+p,web)));
const [party,meta,reactions,status,forest]=await Promise.all([
 'party_skills.json','party_battle_view.json','party_reactions.json','forest_status.json',
 'forest_combat.json'].map(read));
const banks=await Promise.all(Object.keys(party.roles).map(id=>read(`party_role_layers_${id}.json`)));
const bank001=banks.find(bank=>bank.role_id==='001'),bank002=banks.find(bank=>bank.role_id==='002');
const hash=b=>createHash('sha256').update(b).digest('hex');
test('new-game commands preserve CHR learned flags and never borrow a historical save definition',async()=>{
 assert.deepEqual(party.roles['002'].learned_indices,[19,20,21,22,23]);
 assert.deepEqual(party.roles['002'].default_hotkey_indices,[19,20,21]);
 assert.deepEqual(party.roles['001'].exposed_indices.filter(index=>[21,22,37,23,26].includes(index)),[21,22,37,23,26]);
 assert.deepEqual([...party.roles['001'].exposed_indices].sort((a,b)=>a-b),Object.values(party.skills).filter(skill=>skill.actor_id==='001').map(skill=>skill.original_skill_index).sort((a,b)=>a-b));
 assert.equal(party.roles['001'].definition_level,11);assert.equal(party.roles['002'].definition_level,10);
 for(const skill of Object.values(party.skills)){
  assert.equal(skill.source.path,`Fight_Role/${skill.actor_id}.CHR`);
  const source=await readFile(new URL(skill.source.path,root)),fixed=Buffer.from(skill.fixed_raw_hex,'hex');
  assert.equal(hash(source),skill.source.sha256);
  assert.deepEqual(source.subarray(skill.source.fixed_record_offset,skill.source.fixed_record_offset+1053),fixed);
  assert.equal(fixed[0x23],skill.learned_raw);assert.equal(fixed.readUInt32LE(0x32)&15,skill.type_raw);assert.equal(fixed.readUInt32LE(0x32),skill.type_flags_u32_0x32);assert.equal(fixed[0x25],skill.target_side_raw);
  assert.equal(skill.mp_cost,Math.max(0,-fixed.readInt32LE(0x14f)));assert.equal(fixed.readInt32LE(0x2e),skill.charge_i32_0x2e);
  for(const action of skill.actions)assert.equal(source.subarray(action.offset,action.offset+176).toString('hex'),action.raw_hex);
 }
 const native=JSON.parse(await readFile(new URL('remake/runtime/'+party.native_bundle.path,root)));
 assert.ok(native.records.find(r=>r.evidence_id===party.evidence.menu_defaults).normalized_result.includes('0x444647: MOV DL, byte ptr [ECX + EAX*0x1 + 0x23]'));
 assert.ok(party.roles['002'].skills.filter(s=>s.index>=24).every(s=>s.learned_raw===0));
});
test('all registered commands visit their exact logical contact and bind overlapping frame numbers by role',()=>{
 validateBattleViewMetadata(meta);
 for(const skill of Object.values(party.skills)){
  const compiled=compileNativeSequence(meta,skill.actor_id,directSequence(skill),banks);
  const contacts=compiled.steps.flatMap(step=>step.carrier_spawn?step.carrier_spawn.steps:[step]).filter(s=>s.event);assert.equal(contacts.length,skill.actions.filter(action=>action.contact_u32_raw_0x49!==0).length,skill.id);
  for(const contact of contacts){
   const original=Buffer.from(skill.actions[contact.chr_record_index].raw_hex,'hex');
   assert.equal(contact.logical_frame,original.readUInt32LE(0x49));
   assert.equal(contact.source_skill_index,skill.original_skill_index);
   assert.equal(contact.action_mask_raw,original[0x78]);
  }
  assert.ok(compiled.steps.filter(s=>s.command_raw===undefined).every(s=>s.pair&&s.pair.main.path.startsWith(`assets/party_layers/${skill.actor_id}/`)));
  if(skill.id==='yancui'){
   assert.equal(contacts[0].effect_contact,true);assert.equal(contacts[0].carrier_source_frame,6);
   assert.equal(contacts[0].chr_record_index,7);assert.equal(contacts[0].effect_token,1);
   assert.deepEqual(compiled.steps.filter(s=>s.carrier_asset_id==='_Blank68').map(s=>s.logical_frame),[0,1,2,3,4,5,6]);
   assert.deepEqual([...new Set(compiled.steps.map(s=>s.chr_record_index))],[0,1,2,3,4,5,6,7,8]);
  }else if(['yanci','yantu','kai_mieyan','kai_suizu','kai_luoyan','kai_liyan','kai_duanyan'].includes(skill.id)){
   assert.ok(compiled.segments.some(s=>s.movement_step_raw===10));
   assert.ok(compiled.segments.some(s=>s.movement_step_raw===-10));
  }
 }
 const suizu=party.skills.kai_suizu.actions.find(a=>a.contact_u32_raw_0x49);
 assert.equal(Buffer.from(suizu.raw_hex,'hex')[0x62],2);
 const shared=bank001.frames.find(f=>bank002.frames.some(k=>k.source_frame===f.source_frame));
 assert.ok(shared,'independent character banks overlap in physical indices');
 assert.notEqual(shared.main.sha256,bank002.frames.find(f=>f.source_frame===shared.source_frame).main.sha256);
});
test('Kai reaction lookup has every native required ID and an independently playable death/counter sequence',()=>{
 validateForestReactionsData(reactions);
 const role=reactions.roles['002'];assert.equal(role.skills.length,43);
 for(const id of [0,1,2,3,9,12,18,19])assert.equal(role.reaction_id_indices[id].length,1);
 for(const id of [1,2,3,9,12,18,19]){
  const skill=role.skills.find(s=>s.original_id_raw===id);
  const compiled=compileNativeSequence(meta,'002',{...directSequence(skill),allow_no_contacts:true},banks);
  assert.ok(compiled.steps.length);assert.ok(compiled.steps.every(s=>s.pair));
  assert.equal(compiled.steps.filter(s=>s.event).length,id===19?1:0);
 }
 const death=role.skills.find(s=>s.original_id_raw===12);
 assert.equal(compileNativeSequence(meta,'002',{...directSequence(death),allow_no_contacts:true},banks).segments[0].action_index,24);
});
test('party attack status blocks use the original id-zero path without hidden draws or modifiers',()=>{
 const actor=initializeNativeStatuses(structuredClone(forest.actors['012']),status);
 for(const skill of Object.values(party.skills)){
  const block=Buffer.from(skill.fixed_raw_hex,'hex').subarray(0x16b,0x231);
  if(block[1]){
   const retained=status.skills[`${skill.actor_id}:${skill.original_skill_index}`];
   assert.equal(retained.effect_raw_hex,block.toString('hex'));assert.equal(retained.effect_id_raw,block[1]);assert.equal(retained.mode_raw,block[0xb]);
   assert.ok(status.effects[block[1]].source.sha256);continue;
  }
  assert.equal(block.toString('hex'),'00'.repeat(0xc6));
  const result=applyNativeSkillStatus({actor,skill,data:status,rng:()=>{throw Error('dormant status consumed RNG');},now:0});
  assert.equal(result.native_return,1);assert.equal(result.reason,'effect-id-zero');
  assert.equal(result.applied,false);assert.deepEqual(result.actor,actor);assert.deepEqual(result.trace,[]);
 }
});
test('all five Kai attacks against every forest enemy match native settlement instructions and RNG order',async()=>{
 const [seed,attributes]=await Promise.all(['opening_seed.json','party_combat.json'].map(read));
 seed.party.push(chapterRoleFromDefinition(seed.source.role_definitions['002']));
 const sample=createPartySample(seed,attributes,party),template=sample.actors.find(a=>a.id==='002');
 const assembly=JSON.parse(await readFile(new URL('../evidence/turn_rules_assembly_20261011.json',import.meta.url)));
 let comparisons=0;
 for(const skill of Object.values(party.skills).filter(s=>s.actor_id==='002'&&['kai_mieyan','kai_suizu','kai_luoyan','kai_liyan','kai_duanyan'].includes(s.id)))for(const ident of ['011','012','013'])for(let n=0;n<16;n++){
  const attacker=structuredClone(template),target=structuredClone(forest.actors[ident]);
  const contact=Buffer.from(skill.actions.find(a=>a.contact_u32_raw_0x49).raw_hex,'hex');
  attacker.current_skill=structuredClone(skill);attacker.class_raw=contact[0x24];attacker.action_mask_raw=contact[0x78];
  const seedValue=(n*747796405)>>>0;
  const actual=resolveAction({attacker,target,skill,rng:createNativeRng(seedValue)});
  const oracle=new NativeAssemblyOracle(assembly.functions,[attacker,target],createNativeRng(seedValue));
  const native=oracle.run(0x41d990,[0,1,0x20000000,0]);
  assert.equal(actual.native_return,native.eax,`${skill.id}/${ident}/${n}`);
  assert.equal(actual.reaction,oracle.read(0x20000000));
  assert.equal(actual.after_settled_raw,oracle.read(0x521f69d+0x30274,1));
  assert.deepEqual(actual.trace.filter(r=>r.kind==='rng').map(r=>r.raw),native.rng_calls);
  comparisons++;
 }
 assert.equal(comparisons,240);
});
test('fire carrier matches native token1 damage with the actual 501930 same-index getter and fresh zero target slot',async()=>{
 const [seed,attributes]=await Promise.all(['opening_seed.json','party_combat.json'].map(read));
 seed.party.push(chapterRoleFromDefinition(seed.source.role_definitions['002']));
 const template=createPartySample(seed,attributes,party).actors.find(a=>a.id==='001'),skill=party.skills.yancui;
 const assembly=JSON.parse(await readFile(new URL('../evidence/turn_rules_assembly_20261011.json',import.meta.url)));
 const native=JSON.parse(await readFile(new URL('../evidence/party_magic_native.json',import.meta.url)));
 const getter=native.records.find(r=>r.operation==='procedure_assembly'&&r.parameters.procedure==='0x501930');
 const allocation=native.records.find(r=>r.operation==='procedure_assembly'&&r.parameters.procedure==='0x519a80');
 assert.ok(allocation.normalized_result.includes('0x519b2b: PUSH 0x339c8'));
 assert.ok(allocation.normalized_result.includes('0x519b30: PUSH 0x40'));
 assert.ok(allocation.normalized_result.includes('0x519b84: CMP dword ptr [EBP + -0x10], 0xc8'));
 assert.ok(getter.normalized_result.includes('0x501963: MOV EDX, dword ptr [ECX + 0x55e3fec]'));
 const functions={...assembly.functions,'0x501930':getter.normalized_result.trim().split('\n')};
 for(const ident of ['011','012','013'])for(let i=0;i<32;i++){
  const attacker=structuredClone(template),target=structuredClone(forest.actors[ident]),record=skill.actions[7];
  attacker.current_skill=skill;attacker.class_raw=record.class_raw;attacker.action_mask_raw=record.action_mask_raw;
  const seedValue=(i*747796405)>>>0,actual=resolveAction({attacker,target,skill,rng:createNativeRng(seedValue),context:skill.effect_context});
  const oracle=new NativeAssemblyOracle(functions,[attacker,target],createNativeRng(seedValue));
  oracle.write(0x55e3fec,37);
  for(const [n,actor]of [attacker,target].entries()){
   const table=0x23000000+n*0x100000;oracle.write(0x524a9dc+n*0x30274,table);
   // Fresh allocation and bounded loader retain zero fixed bytes in target
   // slot37. The appended action pointer is outside all numeric reads.
   const bytes=n===0?Buffer.from(skill.fixed_raw_hex,'hex'):Buffer.alloc(0x41d);
   for(let k=0;k<bytes.length;k++)oracle.write(table+37*0x421+k,bytes[k],1);
  }
  const expected=oracle.run(0x41d990,[0,1,0x20000000,1]);
  assert.equal(actual.native_return,expected.eax,`${ident}/${i}`);
  assert.equal(actual.reaction,oracle.read(0x20000000));assert.equal(actual.reaction,0);
  assert.equal(actual.after_settled_raw,oracle.read(0x521f69d+0x30274,1));
  assert.deepEqual(actual.trace.filter(r=>r.kind==='rng').map(r=>r.raw),expected.rng_calls);
  assert.ok(actual.hit&&actual.damage>0);assert.equal(actual.physical,0);assert.equal(actual.mp_cost,5);
 }
 assert.throws(()=>resolveAction({attacker:template,target:forest.actors['012'],skill,rng:()=>0,context:{effect_token:1}}),/outside the fresh/);
});
test('source reaction class2 on Kai broken-foot attack selects every forest enemy id2 pose',async()=>{
 const [seed,attributes]=await Promise.all(['opening_seed.json','party_combat.json'].map(read));
 seed.party.push(chapterRoleFromDefinition(seed.source.role_definitions['002']));
 const attacker=initializeNativeStatuses(createPartySample(seed,attributes,party).actors.find(a=>a.id==='002'),status);
 attacker.current_skill=party.skills.kai_suizu;
 Object.assign(attacker,{native_active:true,current_target_id:null,reaction_special_gate_raw:0,native_z_raw:0});
 const record=party.skills.kai_suizu.actions.find(a=>a.contact_u32_raw_0x49);
 for(const ident of ['011','012','013']){
  const target=initializeNativeStatuses(structuredClone(forest.actors[ident]),status);
  Object.assign(target,{native_active:true,current_target_id:null,reaction_special_gate_raw:0,native_z_raw:0});
  const result=applyContactReaction({attacker,target,result:{damage:1,reaction:0,native_return:1},record,data:reactions,rng:()=>0});
  assert.equal(result.skill.original_id_raw,2,ident);
  const compiled=compileNativeSequence(meta,ident,{...directSequence(result.skill),allow_no_contacts:true});
  assert.ok(compiled.steps.length);assert.equal(compiled.steps.filter(s=>s.event).length,0);
 }
});
function canvas(){const ctx={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},save(){},restore(){},drawImage(){},fillText(){},createLinearGradient:()=>({addColorStop(){}})};return {width:960,height:540,getContext:()=>ctx};}
test('actual BattleView loads every party atlas/layer and presents all admitted source commands',async()=>{
 const checked=new Set(),v=new BattleView({canvas:canvas(),metadataPath:'/data/party_battle_view.json',
  jsonLoader:async p=>read(p.slice('/data/'.length)),assetLoader:async a=>{
   const b=await readFile(new URL(a.path.slice(1),web));
   assert.equal(hash(b),a.sha256,a.path);assert.equal(b.readUInt32BE(16),a.width);assert.equal(b.readUInt32BE(20),a.height);
   checked.add(a.path);return {image:{width:a.width,height:a.height,path:a.path},sha256:a.sha256};
  }});
 await v.prepare();assert.ok(checked.size>600);
 const actors=[...Object.entries(party.roles).map(([id,role])=>({id,resource_id:id,side:'player',name:role.name,
   hp:{current:900,maximum:900},mp:{current:200,maximum:200}})),
  {...structuredClone(forest.actors['012']),id:'enemy-0',resource_id:'012'}];
 const skills={...structuredClone(party.skills),enemy:{...structuredClone(forest.skills['012_attack']),id:'enemy',actor_id:'enemy-0'}};
 for(const skill of Object.values(party.skills)){
  v.setRoster(actors.filter(actor=>actor.id===skill.actor_id||actor.side==='enemy'),skills);
  const contacts=[];let records=0;
  const pending=v.playSequence({actor_id:skill.actor_id,target_id:'enemy-0',skill_id:skill.id,plan:directSequence(skill)},
   {onRecord(){records++;},onContact:s=>{contacts.push(s);return {hit:true,damage:1,remainingHp:700};}});
  const compiled=compileNativeSequence(meta,skill.actor_id,directSequence(skill),banks),independent=compiled.independent_carriers;
  v.draw({actors},0);let frame=0;while(v.run||v.detachedRuns.length){assert.ok(++frame<(independent?1000:20));v.draw({actors},frame*(independent?80:10000));}
  const expectedContacts=skill.actions.filter(action=>action.contact_u32_raw_0x49!==0).length;
  const result=await pending;assert.equal(result.contact_count,compiled.steps.filter(step=>step.event).length);assert.equal(contacts.length,expectedContacts);
  assert.equal(records,skill.actions.filter(action=>action.type_raw===0||['effect-carrier','native-support'].includes(skill.battle_handler)).length);assert.ok(result.observations.draws>0);
 }
 v.destroy();
});
test('fire casting preserves source record order, draws target fire before contact, and commits the blank carrier once across slow RAF',async()=>{
 const draws=[],c=canvas();c.getContext().drawImage=(image,...coordinates)=>draws.push({path:image.path,coordinates});
 const v=new BattleView({canvas:c,metadataPath:'/data/party_battle_view.json',jsonLoader:p=>read(p.slice(6)),
  assetLoader:async a=>({image:{width:a.width,height:a.height,path:a.path},sha256:a.sha256})});
 await v.prepare();
 const actors=[{id:'001',resource_id:'001',side:'player',hp:{current:968,maximum:968},mp:{current:72,maximum:72}},
  {...structuredClone(forest.actors['012']),id:'enemy-0',resource_id:'012'}],skill=party.skills.yancui;
 v.setRoster(actors,{fire:skill,enemy:{...forest.skills['012_attack'],id:'enemy',actor_id:'enemy-0'}});
 const records=[],contacts=[];let ended=false;
 const pending=v.playSequence({actor_id:'001',target_id:'enemy-0',skill_id:'yancui',plan:directSequence(skill)},
  {onRecord:s=>records.push(s.chr_record_index),onPrimaryEnd:()=>{ended=true;},onContact:s=>{
   contacts.push(s);return {hit:true,damage:300,remainingHp:400,killer_frame_factor:2};}});
 v.draw({actors},0);v.draw({actors},850);
 assert.equal(contacts.length,0);assert.ok(draws.some(d=>d.path.includes('/m01Awz02/')),'source visual command appears before settlement');
 v.draw({actors},1235);assert.equal(contacts.length,1);assert.equal(contacts[0].carrier_source_frame,6);
 v.draw({actors},1900);assert.equal(ended,true);assert.ok(v.run,'independent source visual still plays after carrier completion');
 v.draw({actors},10000);const completed=await pending;
 assert.deepEqual(records,[0,1,2,3,4,5,6,7,8]);assert.equal(completed.contact_count,1);
 assert.ok(completed.observations.effect_ids.includes('m01Awz02'));assert.ok(completed.observations.effect_ids.includes('BFr01_Nm'));
 assert.throws(()=>compileNativeSequence(meta,'001',{...directSequence(skill),records:[{...directSequence(skill).records[0],raw_hex:'0102000000'+directSequence(skill).records[0].raw_hex.slice(10)}]},banks),/类型命令未支持/);
 v.destroy();
});

test('a periodic response retires future source contacts before a slow RAF catches up',async()=>{
 const v=new BattleView({canvas:canvas(),metadataPath:'/data/party_battle_view.json',jsonLoader:p=>read(p.slice(6)),
  assetLoader:async asset=>({image:{width:asset.width,height:asset.height},sha256:asset.sha256})});
 await v.prepare();
 const actors=[{id:'001',resource_id:'001',side:'player',hp:{current:968,maximum:968},mp:{current:72,maximum:72}},
  {...structuredClone(forest.actors['012']),id:'enemy-0',resource_id:'012'}];
 v.setRoster(actors,{yancui:party.skills.yancui,enemy:{...forest.skills['012_attack'],id:'enemy',actor_id:'enemy-0'}});
 let contacts=0,ended=false;
 const pending=v.playSequence({actor_id:'001',target_id:'enemy-0',skill_id:'yancui',plan:directSequence(party.skills.yancui)},
  {onRecord(){},onContact(){contacts++;return {hit:true,damage:1};},onPrimaryEnd(){ended=true;}});
 v.draw({actors,lifecycle_events:[]},0);
 v.draw({actors,lifecycle_events:[{token:'periodic-1',actor_id:'001',life_epoch:0,kind:'response',source_skill_index:1}]},10000);
 const result=await pending;assert.equal(result.interrupted,true);assert.equal(contacts,0);assert.equal(result.contact_count,0);assert.equal(ended,false);
 v.destroy();
});
test('default battle images use shared verified atlas pages and reject corrupt packed bytes before readiness',async()=>{
 let fetched=0,decoded=0,damaged=false;
 const createPool=()=>new BattleResources({read:async path=>{
  let bytes=await readFile(new URL(String(path).slice(1),web));
  if(path.endsWith('.png')){fetched++;if(damaged){bytes=Buffer.from(bytes);bytes[bytes.length-8]^=1;}}
  return new Response(bytes);
 },decode:async blob=>{const bytes=Buffer.from(await blob.arrayBuffer());decoded++;return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),close(){}};}});
 // Formal party encounters, scripted battles and skill tests all include the
 // native lifecycle bank; it may select a larger source-identical action atlas.
 const pool=createPool(),makeView=()=>new BattleView({canvas:canvas(),metadataPath:'/data/party_battle_view.json',lifecycleMetadataPath:'/data/battle_lifecycle.json',jsonLoader:p=>read(p.slice(6))});
 const first=makeView(),second=makeView();assert.equal(first.resourcePool,battleResources);
 first.resourcePool=second.resourcePool=pool;
 try{
  await first.prepare();assert.ok(first.images.size>600);
  const requiredPages=new Set([...first.images.keys()].flatMap(path=>pool.data.images[path].regions.map(region=>region[4])));
  assert.equal(fetched,requiredPages.size,'each source-required packed page is fetched once');assert.ok(fetched<first.images.size/10,'atlases materially reduce original image requests');assert.equal(decoded,fetched);
  const requests=fetched;await second.prepare();assert.equal(fetched,requests,'second view reuses decoded pages');
  assert.ok([...first.images.values()].every(image=>image.packed&&image.pool===pool));
  damaged=true;const broken=makeView(),brokenPool=createPool();broken.resourcePool=brokenPool;
  try{await assert.rejects(broken.prepare(),/指纹不符/);assert.equal(broken.ready,false);}
  finally{broken.destroy();brokenPool.dispose();}
 }finally{first.destroy();second.destroy();pool.dispose();}
 assert.equal(pool.pages.size,0);
});
