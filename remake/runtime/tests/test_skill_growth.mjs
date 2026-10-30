// Exact retained skill-growth instructions versus the runtime port. External
// notice drawing is observed as queue entries; no original process is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {upgradeNativeSkill,applySavedSkillProgress,recordNativeSkillPractice,nativeSkillPrerequisite,settleNativeSkillProgress,skillGrowthSource} from '../web/core/battle_skill_growth.mjs';
import {effectiveSkillSource,validateBattleSkillProgress} from '../web/core/battle_skill_access.mjs';
import {planVictoryRewards,createRewardLedger,collectEnemyDefeat,progressHeaderForRole} from '../web/core/battle_rewards.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {fieldSkillAvailability} from '../web/core/field_skills.mjs';
import {deriveRuntimeConfiguration,compileRuntimeConfiguration} from '../web/core/runtime_config.mjs';
import {chapterRoleFromDefinition} from '../web/core/chapter.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
const read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name+'.json',import.meta.url)));
const [commands,seed,rewards,attributes,items]=await Promise.all(['party_skills','opening_seed','party_rewards','party_combat','items'].map(read)),copy=structuredClone;
const bundle=JSON.parse(await readFile(new URL('../evidence/battle_result_20261020/native_evidence.json',import.meta.url))),functions={};
function gather(value){if(!value||typeof value!=='object')return;if(value.operation==='procedure_assembly'&&['0x50c000','0x50c4c0','0x501b70','0x50c560'].includes(String(value.parameters?.procedure).toLowerCase()))functions[value.parameters.procedure.toLowerCase()]=value.normalized_result.trim().split(/\r?\n/);for(const [key,child]of Object.entries(value))if(!['raw_result','normalized_result'].includes(key))gather(child);}
gather(bundle);assert.equal(Object.keys(functions).length,4);
const raw=skill=>Buffer.from(skill.fixed_raw_hex,'hex'),base=0x20000000;
class GrowthOracle extends NativeAssemblyOracle{
  constructor(skills,level=12){super(functions,[],()=>assert.fail('Skill growth must not draw'));this.notices=[];this.write(0x524a9dc,base);this.write(0x524a6d1,skills.length);this.write(0x524a6f5,level);skills.forEach((s,index)=>raw(s).forEach((v,i)=>this.write(base+index*0x421+i,v,1)));}
  external(target){if(target===0x50bb50){this.notices.push({actor:this.read(this.reg.ESP)&255,kind:this.read(this.reg.ESP+4),index:this.read(this.reg.ESP+8)});return;}return super.external(target);}
  skill(index){return Buffer.from(Array.from({length:0x41d},(_,i)=>this.read(base+index*0x421+i,1))).toString('hex');}
}
function worldTwo(){const world=copy(seed);world.party.push(chapterRoleFromDefinition(world.source.role_definitions['002']));return world;}

test('Every source skill rank-growth byte matches original 50C000, including signed bonuses, cap7 and unchanged threshold/actions',()=>{
  for(const role of Object.values(commands.roles))for(const source of role.skills){
    let skill=source;
    for(let step=0;step<8;step++){
      const oracle=new GrowthOracle([skill]);oracle.run(0x50c000,[base]);const actual=upgradeNativeSkill(skill);
      assert.equal(actual.fixed_raw_hex,oracle.skill(0),`${role.id}/${source.index}/step${step}`);assert.deepEqual(actual.actions,source.actions);assert.equal(raw(actual).readInt32LE(0x2f7),raw(source).readInt32LE(0x2f7));skill=actual;
    }
  }
});

test('Action-start practice matches 501B70 for each level and combination count; no hit or RNG dependency',()=>{
  for(let level=0;level<=8;level++)for(const count of [1,2,6,7,9]){
    const source=copy(commands.roles['001'].skills[22]),b=raw(source);b[0x2d]=level;source.fixed_raw_hex=b.toString('hex');
    const oracle=new GrowthOracle([source]);oracle.run(0x501b70,[0,count,0]);const practice={};recordNativeSkillPractice(practice,{id:'001'},{...source,original_skill_index:0},count);
    assert.equal(practice['001'][0],oracle.read(base+0x2ff),`level${level}/count${count}`);
  }
});

test('Skill XP, cap/remainder and raw-ID prerequisite learning match the complete 50C560/50C4C0 instruction path',()=>{
  const source=commands.roles['001'];
  for(const level of [11,12,17])for(const gain of [0,1,10,800,9000]){
    const role={...copy(seed.party[0]),level,skill_progress:{version:2,learned_indices:[],records:[{index:22,level:1,experience:799},{index:37,level:1,experience:949}]}},skills=source.skills.map(s=>applySavedSkillProgress(s,role)),oracle=new GrowthOracle(skills,level);
    oracle.write(0x55edf28,10);oracle.write(base+22*0x421+0x2ff,gain);oracle.write(base+37*0x421+0x2ff,10);const native=oracle.run(0x50c560,[0]);
    const actual=settleNativeSkillProgress({role,source_role:source,practice:{22:gain,37:10},chain_bonus:10});assert.equal(actual.practice_total,native.eax);
    actual.skills.forEach((skill,index)=>assert.equal(skill.fixed_raw_hex,oracle.skill(index),`level${level}/gain${gain}/index${index}`));
    assert.deepEqual(actual.notifications.map(n=>({kind:n.type==='skill-learned'?0:1,index:n.skill_index})),oracle.notices.map(({kind,index})=>({kind,index})));
    assert.equal(nativeSkillPrerequisite(actual.skills,26,2),oracle.run(0x50c4c0,[0,26,2]).eax===1);
  }
});

test('Learning requires a skill-up pass and uses the old actor level; it does not automatically grant a newly level-qualified skill',()=>{
  const role={...copy(seed.party[0]),level:12},source=commands.roles['001'];
  const quiet=settleNativeSkillProgress({role,source_role:source,practice:{},chain_bonus:0});assert.deepEqual(quiet.notifications,[]);assert.equal(quiet.role.skill_progress,undefined);
  role.skill_progress={version:2,learned_indices:[],records:[{index:22,level:1,experience:799}]};
  const low=settleNativeSkillProgress({role:{...role,level:11},source_role:source,practice:{22:10}}),ready=settleNativeSkillProgress({role,source_role:source,practice:{22:10}});
  assert.equal(low.role.skill_progress.learned_indices.includes(26),false);assert.equal(ready.role.skill_progress.learned_indices.includes(26),true);
  assert.equal(ready.notifications.find(n=>n.type==='skill-learned').skill_name,source.skills[26].name);assert.equal(commands.roles['001'].skills[26].learned_raw,0);
});

test('Saved ranks apply after the unique numeric overlay, affect executable and field skills, remain idempotent, and do not expose unimplemented attacks',async()=>{
  const names={combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'party_rewards',party_skills:'party_skills',items:'items'},data=Object.fromEntries(await Promise.all(Object.entries(names).map(async([key,name])=>[key,await read(name)]))),config=deriveRuntimeConfiguration(data);config.manifest.mode='debug';
  config.skills.entries.yantu.parameters.physical_multiplier_percent={minimum:100,maximum_exclusive:100};config.skills.entries.yannuan.parameters.hp_term_bonus=400;
  const configured=compileRuntimeConfiguration(data,config),world=copy(seed);world.party[0].skill_progress={version:2,learned_indices:[26],records:[{index:22,level:2,experience:9},{index:41,level:2,experience:5}]};
  const before=copy(commands),sample=createPartySample(world,attributes,commands,configured),expected=upgradeNativeSkill(configured.skill_registry.yantu);
  assert.equal(sample.skills.yantu.fixed_raw_hex,applySavedSkillProgress(configured.skill_registry.yantu,world.party[0]).fixed_raw_hex);assert.equal(raw(sample.skills.yantu).readInt32LE(0xcb),raw(expected).readInt32LE(0xcb));
  assert.deepEqual(applySavedSkillProgress(sample.skills.yantu,world.party[0]),sample.skills.yantu);assert.equal(Object.values(sample.skills).some(s=>s.original_skill_index===26),false);
  const facade=effectiveSkillSource(commands,world);assert.equal(facade.roles['001'].skills[26].learned_raw,1);assert.equal(raw(facade.roles['001'].skills[22])[0x2d],2);assert.equal(raw(facade.roles['001'].skills[22]).readInt32LE(0x2fb),9);
  const configuredField={...commands,field_skills:{yannuan:configured.skill_registry.yannuan}};world.party[0].hp.current=100;
  const availability=fieldSkillAvailability(world,attributes,configuredField,items,{casterId:'001',skillId:'yannuan',targetId:'001'});assert.equal(availability.available,true);assert.equal(availability.hp_delta,raw(upgradeNativeSkill(configured.skill_registry.yannuan)).readInt32LE(0xab));
  assert.deepEqual(commands,before);
});

test('Victory plans keep original event ordering, report XP threshold timing and persist skill ranks/learning once through save reload',async()=>{
  const world=worldTwo(),role=world.party[0],header=Buffer.from(progressHeaderForRole(role,rewards));
  // A valid native-derived level12 header, then a one-XP report boundary.
  const setupEnemy={id:'e',resource_id:'012',side:'enemy',hp:{current:0}},setupActors=[{id:'001',side:'player',hp:{current:1},state_raw:0,immune_raw:0},setupEnemy],setup=createRewardLedger('setup-growth',setupActors);collectEnemyDefeat(setup,setupEnemy,{data:rewards});setup.experience=1260;
  setup.experience=header.readInt32LE(0x2c)-header.readInt32LE(0x28);
  world.party=planVictoryRewards({world,actors:setupActors,ledger:setup,data:rewards,rng:()=>99}).world_patch.party;const grown=world.party[0],b=Buffer.from(grown.combat_progress.header_raw_hex,'hex');assert.equal(grown.level,12);b.writeInt32LE(b.readInt32LE(0x2c)-1,0x28);grown.combat_progress.header_raw_hex=b.toString('hex');
  grown.skill_progress={version:2,learned_indices:[],records:[{index:22,level:1,experience:799},{index:37,level:1,experience:949}]};
  const enemy={id:'enemy-0',resource_id:'012',side:'enemy',hp:{current:0}},actors=[{id:'001',side:'player',hp:{current:1},state_raw:0,immune_raw:0},enemy],ledger=createRewardLedger('skill-growth-plan',actors);collectEnemyDefeat(ledger,enemy,{data:rewards});
  const plan=planVictoryRewards({world,actors,ledger,data:rewards,rng:()=>99,skill_data:skillGrowthSource(commands),skill_practice:{'001':{22:10,37:50}}});
  assert.deepEqual(plan.summary.notifications.map(n=>n.type),['skill-level-up','skill-level-up','skill-learned','skill-learned','role-level-up']);
  assert.deepEqual(plan.summary.notifications.filter(n=>n.type==='skill-learned').map(n=>n.skill_index),[26,48]);
  assert.equal(plan.summary.practice_total,60);assert.equal(plan.summary.experience[0].levels[0].gained_at,1);assert.equal(plan.summary.notifications.at(-1).experience_gained_at,1);
  const saved={...world,...plan.world_patch,reward_records:[plan.reward_record]},store=new WorldStore(saved,['M72061','M70010']),loaded=await decodeSave(await encodeSave(store.snapshot()),store.mapIds);
  assert.deepEqual(loaded.party[0].skill_progress,plan.world_patch.party[0].skill_progress);assert.equal(loaded.party[0].skill_progress.learned_indices.includes(26),true);
  const repeat=planVictoryRewards({world:loaded,actors,ledger,data:rewards,rng:()=>assert.fail('Repeated rewards must not draw'),skill_data:skillGrowthSource(commands),skill_practice:{'001':{22:999}}});assert.equal(repeat.applied,false);assert.deepEqual(repeat.summary,plan.summary);
  for(const malformed of [{version:2,learned_indices:[],records:[{index:22,level:8,experience:0}]},{version:2,learned_indices:[],records:[{index:22,level:2,experience:0},{index:22,level:3,experience:0}]}])assert.throws(()=>validateBattleSkillProgress(malformed),/技巧成长/);
});
