// Native numeric ranges are sampling instructions, not ordered UI bounds.
// Descending endpoints retain low without RNG in 41D990 / 41C610.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {configureSkills,sourceSkillParameters} from '../web/core/skill_config.mjs';
import {deriveRuntimeConfiguration,compileRuntimeConfiguration,compactRuntimeConfiguration} from '../web/core/runtime_config.mjs';
import {createNativeRng,resolveAction,nativeEffectContextForTarget} from '../web/core/combat_rules.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url))),copy=structuredClone;
const names={combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'party_rewards',party_skills:'party_skills',items:'items'};
const data=Object.fromEntries(await Promise.all(Object.entries(names).map(async([key,name])=>[key,await read(`../web/data/${name}.json`)])));
const [fixture,attributes,reactions,instructions,native]=await Promise.all([
 './fixtures/native_aid_skills.json','../web/data/party_combat.json','../web/data/party_reactions.json',
 '../evidence/turn_rules_assembly_20261011.json','../evidence/party_magic_native.json'].map(read));
const source=fixture.skills.find(skill=>skill.actor_id==='003'&&skill.original_skill_index===33);
assert.ok(source);
const entry=Object.values(data.party_skills.skills).find(skill=>skill.actor_id==='003'&&skill.original_skill_index===33);
assert.ok(entry,'source00333 must be a registered executable learning reward');
const configuration=(skill,mode='original')=>({schema:'seventh-seal-skill-config',version:1,mode,skills:{[skill.id]:{
 name:skill.name,source:copy(skill.source),original:sourceSkillParameters(skill),parameters:sourceSkillParameters(skill)}}});

test('actual 00333 original (200,0) compiles byte-for-byte through direct and unified original configuration',async()=>{
 const bytes=await readFile(new URL('../../../'+source.source.path,import.meta.url));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),source.source.sha256);
 assert.equal(bytes.subarray(source.source.fixed_record_offset,source.source.fixed_record_offset+1053).toString('hex'),source.fixed_raw_hex);
 assert.deepEqual(sourceSkillParameters(source).physical_multiplier_percent,{minimum:200,maximum_exclusive:0});
 const before=copy(source),cfg=configuration(source),profileBefore=copy(cfg),direct=configureSkills({[source.id]:source},cfg)[source.id];
 assert.equal(direct.fixed_raw_hex,source.fixed_raw_hex);assert.deepEqual(direct.actions,source.actions);
 assert.deepEqual(direct.configuration.differences,[]);assert.deepEqual(source,before);assert.deepEqual(cfg,profileBefore);
 const profile=deriveRuntimeConfiguration(data),compiled=compileRuntimeConfiguration(data,profile),skill=compiled.skill_registry[entry.id];
 assert.equal(skill.fixed_raw_hex,entry.fixed_raw_hex);assert.deepEqual(skill.actions,entry.actions);
 assert.deepEqual(skill.configuration.original.physical_multiplier_percent,{minimum:200,maximum_exclusive:0});
 assert.deepEqual(compiled.audit.differences,[]);
});

test('00333 debug zero and descending endpoints survive unified compilation and compact overrides without source mutation',()=>{
 const profile=deriveRuntimeConfiguration(data),before=copy(data);profile.manifest.mode='debug';
 Object.assign(profile.skills.entries[entry.id].parameters,{
  physical_multiplier_percent:{minimum:225,maximum_exclusive:0},
  defense_bonus:{minimum:50,maximum_exclusive:-10},term4_bonus:{minimum:70,maximum_exclusive:0}});
 const compiled=compileRuntimeConfiguration(data,profile),skill=compiled.skill_registry[entry.id],raw=Buffer.from(skill.fixed_raw_hex,'hex');
 for(const [low,high,a,b]of [[0xcb,0xcf,225,0],[0xd3,0xd7,50,-10],[0xe3,0xe7,70,0]]){
  assert.equal(raw.readInt32LE(low),a);assert.equal(raw.readInt32LE(high),b);
 }
 assert.deepEqual(skill.configuration.differences.map(row=>row.field),['physical_multiplier_percent','defense_bonus','term4_bonus']);
 assert.deepEqual(skill.actions,entry.actions);assert.deepEqual(skill.effect_context,entry.effect_context);
 const compact=compactRuntimeConfiguration(data,profile),roundTrip=compileRuntimeConfiguration(data,compact);
 assert.equal(roundTrip.skill_registry[entry.id].fixed_raw_hex,skill.fixed_raw_hex);assert.deepEqual(data,before);
 profile.manifest.mode='original';assert.throws(()=>compileRuntimeConfiguration(data,profile),/原版模式/);
});

test('zero/equal/descending skill and actor bounds keep original 41D990/41C610 values and complete CRT stream',()=>{
 const getter=native.records.find(row=>row.operation==='procedure_assembly'&&row.parameters.procedure==='0x501930');
 const functions={...instructions.functions,'0x501930':getter.normalized_result.split(/\r?\n/)},contact=source.actions.find(record=>record.type_raw===1&&record.u32_at_0x01_raw===4);
 let comparisons=0;
 for(const [low,high]of [[200,0],[200,100],[200,200],[200,201],[0,0],[0,200]]){
  const cfg=configuration(source,'debug');Object.assign(cfg.skills[source.id].parameters,{
   physical_multiplier_percent:{minimum:low,maximum_exclusive:high},
   defense_bonus:{minimum:50,maximum_exclusive:0},term4_bonus:{minimum:70,maximum_exclusive:-10}});
  const selected={...configureSkills({[source.id]:source},cfg)[source.id],effect_context:{effect_token:1,effect_source_skill_index:33,effect_lookup:'same-index-source-table'}};
  for(const ident of ['011','012','013','032'])for(const seed of [0,1,77327,0x12345678]){
   const attacker={...copy(attributes.actors['003']),current_skill:copy(selected),state_raw:0,settled_raw:0,immune_raw:0,
    class_raw:contact.class_raw,action_mask_raw:contact.action_mask_raw,defense_half_raw:0,reaction_inhibit_raw:0,stance_raw:1},target=copy(data.forest.actors[ident]);
   // Actor attack/defense use the same low>=high fallback in 41C610.
   target.raw_by_address['0x0524a711']=90;target.raw_by_address['0x0524a715']=0;
   target.raw_by_address['0x0524a719']=40;target.raw_by_address['0x0524a71d']=20;
   const rng=createNativeRng(seed),nativeRng=createNativeRng(seed),context=nativeEffectContextForTarget(selected,target,reactions.roles),
    actual=resolveAction({attacker,target,skill:selected,rng,context}),oracle=new NativeAssemblyOracle(functions,[attacker,target],nativeRng);
   oracle.write(0x55e3fec,33);
   for(const [index,actor]of [attacker,target].entries()){
    const table=0x23000000+index*0x100000;oracle.write(0x524a9dc+index*0x30274,table);
    const fixed=index===0?Buffer.from(selected.fixed_raw_hex,'hex'):Buffer.alloc(1053);
    fixed.forEach((value,offset)=>oracle.write(table+33*0x421+offset,value,1));
   }
   const expected=oracle.run(0x41d990,[0,1,0x20000000,1]);
   assert.equal(actual.native_return,expected.eax,`${low}/${high}/${ident}/${seed}`);
   assert.deepEqual(actual.trace.filter(row=>row.kind==='rng').map(row=>row.raw),expected.rng_calls);
   assert.equal(rng.state,nativeRng.state);
   if(low>=high)assert.equal(actual.trace.filter(row=>row.kind==='rng'&&row.label==='physical-multiplier').length,0);
   assert.equal(actual.trace.filter(row=>row.kind==='rng'&&/skill-(defense|term4)-range|target\.(attack|defense)-range/.test(row.label)).length,0);
   comparisons++;
  }
 }
 assert.equal(comparisons,96);
});

test('unified actor attack/defense permit native constant fallback while speed, span overflow and integer bounds stay strict',()=>{
 const cfg=deriveRuntimeConfiguration(data);cfg.manifest.mode='debug';
 cfg.battle.entries.enemy_032.parameters.attack={minimum:200,maximum_exclusive:0};
 cfg.battle.entries.enemy_032.parameters.defense={minimum:80,maximum_exclusive:20};
 const compiled=compileRuntimeConfiguration(data,cfg),actor=compiled.forest.actors['032'];
 assert.equal(actor.raw_by_address['0x0524a711'],200);assert.equal(actor.raw_by_address['0x0524a715'],0);
 for(const change of [
  p=>{p.battle.entries.enemy_032.parameters.speed={minimum:80,maximum_exclusive:0};},
  p=>{p.battle.entries.enemy_032.parameters.speed={minimum:100,maximum_exclusive:80};},
  p=>{p.battle.entries.enemy_032.parameters.attack={minimum:1000001,maximum_exclusive:0};},
  p=>{p.skills.entries[entry.id].parameters.defense_bonus={minimum:-2147483648,maximum_exclusive:2147483647};},
  p=>{p.skills.entries[entry.id].parameters.physical_multiplier_percent={minimum:200.5,maximum_exclusive:0};},
  p=>{p.skills.entries[entry.id].parameters.physical_multiplier_percent={minimum:2147483648,maximum_exclusive:0};},
 ]){const invalid=copy(cfg);change(invalid);assert.throws(()=>compileRuntimeConfiguration(data,invalid),/配置/);}
});
