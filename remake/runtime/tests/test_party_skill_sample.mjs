import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPartySkillSample,PARTY_SKILL_SAMPLE_ROSTERS,partySampleSkillIndices} from '../web/core/party_skill_sample.mjs';
import {allPartyRoles} from '../web/core/party_roster.mjs';
import {admitPartyMember,deactivatePartyMember} from '../web/core/party_members.mjs';
import {encodeSave,decodeSave} from '../web/core/world.mjs';
import {battleSkillEligibility,effectiveSkillSource} from '../web/core/battle_skill_access.mjs';
import {previewMovement} from '../web/core/encounters.mjs';
import {learnEligiblePartySkills,settleNativeSkillProgress,skillGrowthSource} from '../web/core/battle_skill_growth.mjs';
import {createRewardLedger,planVictoryRewards,progressHeaderForRole,applyExperience} from '../web/core/battle_rewards.mjs';
import {loadRuntimeConfiguration,compileRuntimeConfiguration} from '../web/core/runtime_config.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {techniqueCandidates} from '../web/core/menu_techniques.mjs';
import {addCorrectedPartyPresentations} from '../web/core/party_skill_corrections.mjs';
import {mergeNativeActionAtlases,validateBattleViewMetadata} from '../web/battle_view.mjs';
import {compileNativeSequence,directSequence} from '../web/core/skill_sequence.mjs';
const read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [seed,rewards,commands,forest,encounters]=await Promise.all(['opening_seed','party_rewards','party_skills','maps/m70010','encounters'].map(read));
const {x,y,direction}=forest.route_entry,location={map_id:forest.id,x,y,direction};

test('Two four-person development worlds preserve all six grown records and source learning gates across save/load',async()=>{
  const before={seed:structuredClone(seed),rewards:structuredClone(rewards),commands:structuredClone(commands)};
  for(const activeRoleIds of Object.values(PARTY_SKILL_SAMPLE_ROSTERS)){
    const world=createPartySkillSample(seed,rewards,commands,location,{activeRoleIds});
    assert.deepEqual(world.party.map(role=>role.id),activeRoleIds);assert.equal(world.reserve_party.length,2);
    const owned=allPartyRoles(world);assert.equal(owned.length,6);
    const effective=effectiveSkillSource(commands,world);
    for(const role of owned){
      const initial=rewards.initial_roles[role.id],raw=Buffer.from(initial.header_raw_hex,'hex'),grown=Buffer.from(role.combat_progress.header_raw_hex,'hex');
      const levels=99-initial.level,row=rewards.tables.growth_rows[initial.growth_row];
      assert.equal(role.level,99);assert.equal(grown.readInt32LE(0x24),99);
      assert.equal(role.hp.maximum,raw.readInt32LE(0x34)+levels*row[0]);
      assert.equal(role.mp.maximum,raw.readInt32LE(0x3c)+levels*row[2]);
      assert.equal(grown.readInt32LE(0x5c),raw.readInt32LE(0x5c)+levels*row[8]);
      assert.equal(role.hp.current,role.hp.maximum);assert.equal(role.mp.current,role.mp.maximum);
      for(const index of partySampleSkillIndices(commands.roles[role.id])){
        assert.ok(role.skill_progress.learned_indices.includes(index));
        assert.equal(effective.roles[role.id].skills[index].learned_raw,1);
      }
    }
    assert.deepEqual(await decodeSave(await encodeSave(world)),world);
    const result=previewMovement(world.encounters,{party:world.party,leader_id:world.leader_id,map_id:forest.id,dx:16,dy:0},encounters);
    assert.equal(result.encounter.trigger_roll.raw,998);
  }
  const source=commands.roles['001'].skills[26],normal=battleSkillEligibility(seed,source);
  assert.equal(normal.required_level,12);assert.equal(normal.learned,false);assert.equal(normal.available,false);
  assert.deepEqual({seed,rewards,commands},before);
});

test('Returning a saved level-99 reserve member preserves learning and grown resources with the normal four-slot admission cap',()=>{
  const world=createPartySkillSample(seed,rewards,commands,location),reserve=structuredClone(world.reserve_party.find(entry=>entry.role.id==='005').role);
  assert.equal(admitPartyMember(world,'005').reason,'formation-full');
  deactivatePartyMember(world,'004');assert.equal(admitPartyMember(world,'005').reactivated,true);
  assert.deepEqual(world.party.find(role=>role.id==='005'),reserve);
  assert.ok(reserve.skill_progress.learned_indices.includes(29));assert.ok(reserve.skill_progress.learned_indices.includes(30));
  assert.equal(commands.roles['005'].skills[29].type_raw,0);assert.equal(commands.roles['005'].skills[30].type_raw,0);
});

test('remake learning accepts empty prerequisites, still requires every configured prerequisite, and catches the character level earned in this victory',async()=>{
  const source=commands.roles['002'],role={id:'002',name:source.name,level:19};
  assert.ok(!learnEligiblePartySkills({role,source_role:source}).role.skill_progress?.learned_indices.includes(42));
  role.level=20;
  assert.ok(learnEligiblePartySkills({role,source_role:source}).role.skill_progress.learned_indices.includes(42),'碎冰拳仅按人物20级学习');
  role.skill_progress={version:2,learned_indices:[],records:[19,20,21].map(index=>({index,level:2,experience:0}))};
  assert.ok(!learnEligiblePartySkills({role,source_role:source}).role.skill_progress.learned_indices.includes(24),'炙勾拳第四项前置仍不足');
  role.skill_progress.records.push({index:22,level:2,experience:0});
  assert.ok(learnEligiblePartySkills({role,source_role:source}).role.skill_progress.learned_indices.includes(24));

  const world=structuredClone(seed);world.party[0].skill_progress={version:2,learned_indices:[],records:[{index:22,level:2,experience:0}]};
  const header=Buffer.from(progressHeaderForRole(world.party[0],rewards)),enemy={id:'enemy-0',resource_id:'012',side:'enemy',hp:{current:0}},
    actors=[{id:'001',side:'player',hp:{current:1},state_raw:0,immune_raw:0},enemy],ledger=createRewardLedger('remake-level-learning',actors);
  ledger.defeated_ids=[enemy.id];ledger.experience=header.readInt32LE(0x2c)-header.readInt32LE(0x28);
  const plan=planVictoryRewards({world,actors,ledger,data:rewards,rng:()=>0,skill_data:skillGrowthSource(commands)});
  assert.equal(plan.world_patch.party[0].level,12);
  assert.ok(plan.world_patch.party[0].skill_progress.learned_indices.includes(26),'人物升级也能触发燕落学习，无需技巧再次升级');
  const notices=plan.summary.notifications;
  assert.ok(notices.findIndex(row=>row.type==='role-level-up')<notices.findIndex(row=>row.type==='skill-learned'&&row.skill_index===26));
  assert.ok(!notices.some(row=>row.type==='skill-level-up'));
  const saved={...world,...plan.world_patch,reward_records:[plan.reward_record]},loaded=await decodeSave(await encodeSave(saved));
  assert.deepEqual(loaded.party[0].skill_progress,saved.party[0].skill_progress);
  assert.equal(planVictoryRewards({world:loaded,actors,ledger,data:rewards,rng:()=>assert.fail('重复结算不能抽随机'),skill_data:skillGrowthSource(commands)}).applied,false);

  const capped={id:'001',name:'英格妮',level:99,skill_progress:{version:2,learned_indices:[],records:commands.roles['001'].skills.filter(skill=>skill.learned_raw).map(skill=>({index:skill.index,level:7,experience:0}))}};
  const caught=settleNativeSkillProgress({role:capped,source_role:commands.roles['001'],remake:true});
  assert.ok(caught.role.skill_progress.learned_indices.includes(48),'满级旧档无需再升级也能补学');
  assert.ok(!caught.notifications.some(row=>row.type==='skill-level-up'));
  assert.ok(!caught.role.skill_progress.learned_indices.includes(35)&&!caught.role.skill_progress.learned_indices.includes(36),'援攻仍由剧情授予');
  assert.deepEqual(settleNativeSkillProgress({role:caught.role,source_role:commands.roles['001'],remake:true}).notifications,[]);
});

test('four shipped skill-level overrides gate actual victory learning and prevent early use of an already learned skill',async()=>{
  const names={combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'party_rewards',party_skills:'party_skills',items:'items',source_skills:'library/skills',source_magic:'library/magic'};
  const data=Object.fromEntries(await Promise.all(Object.entries(names).map(async([key,name])=>[key,await read(name)]))),
    bundle=await loadRuntimeConfiguration(p=>read(p.slice(5,-5))),configured=compileRuntimeConfiguration(data,bundle),attributes=await read('party_combat');
  for(const [id,index,level]of [['001',48,50],['003',51,53],['005',33,35],['006',35,52]]){
    const key=`${id}_${index}`,world=structuredClone(seed);
    if(id!=='001')assert.equal(admitPartyMember(world,id).added,true);
    const position=world.party.findIndex(role=>role.id===id);
    while(world.party[position].level<level-1){
      const header=Buffer.from(progressHeaderForRole(world.party[position],rewards));
      world.party[position]=applyExperience(world.party[position],Math.max(1,header.readInt32LE(0x2c)-header.readInt32LE(0x28)),rewards,()=>0,[]).role;
    }
    assert.equal(bundle.skills.entries[key].parameters.required_role_level,level);
    assert.equal(Buffer.from(commands.roles[id].skills[index].fixed_raw_hex,'hex').readInt32LE(0x143),0);
    world.party[position].skill_progress={version:2,learned_indices:[index],records:[]};
    const premature=createPartySample(world,attributes,commands,configured);
    assert.equal(premature.skills[key],undefined,'旧档提前学到的技能也受新等级门槛约束');
    assert.equal(Buffer.from(premature.skill_data.roles[id].skills[index].fixed_raw_hex,'hex').readInt32LE(0x143),level);
    delete world.party[position].skill_progress;
    const header=Buffer.from(progressHeaderForRole(world.party[position],rewards)),actors=[{id,side:'player',hp:{current:1},state_raw:0,immune_raw:0},{id:'enemy',resource_id:'012',side:'enemy',hp:{current:0}}],ledger=createRewardLedger(`configured-level-${id}`,actors);
    ledger.defeated_ids=['enemy'];ledger.experience=header.readInt32LE(0x2c)-header.readInt32LE(0x28);
    const plan=planVictoryRewards({world,actors,ledger,data:rewards,rng:()=>0,skill_data:skillGrowthSource(premature.skill_data)}),next={...world,...plan.world_patch};
    assert.equal(next.party[position].level,level);
    assert.ok(next.party[position].skill_progress.learned_indices.includes(index));
    assert.ok(createPartySample(next,attributes,commands,configured).skills[key]);
    const notices=plan.summary.notifications.filter(row=>row.actor_id===id);
    assert.ok(notices.findIndex(row=>row.type==='role-level-up')<notices.findIndex(row=>row.type==='skill-learned'&&row.skill_index===index));
    assert.ok(!notices.some(row=>row.type==='skill-learned'&&/援攻/.test(row.skill_name)));
  }
  for(const value of [-1,100,1.5]){
    const invalid=structuredClone(bundle);invalid.skills.entries['001_48'].parameters.required_role_level=value;
    assert.throws(()=>compileRuntimeConfiguration(data,invalid),/required_role_level/);
  }
});

test('朱特两条援攻在菜单、战斗命令和原动作接触中生效，来源记录保持type0',async()=>{
  const world=createPartySkillSample(seed,rewards,commands,location,{activeRoleIds:PARTY_SKILL_SAMPLE_ROSTERS.B}),
    attributes=await read('party_combat'),sample=createPartySample(world,attributes,commands),effective=effectiveSkillSource(commands,world),
    meta=await read('party_battle_view'),lifecycle=await read('battle_lifecycle');
  for(const row of lifecycle.roles){const role=meta.roles.find(role=>role.id===row.id);if(role)mergeNativeActionAtlases(role,row,meta.source_hashes);}
  assert.equal(addCorrectedPartyPresentations(meta,sample.skills),2);validateBattleViewMetadata(meta);
  const candidates=techniqueCandidates(world,effective,'005',3,{capacity:7});
  for(const index of [29,30]){
    const skill=sample.skills[`005_${index}`],source=commands.roles['005'].skills[index];
    assert.ok(skill);assert.equal(skill.type_raw,3);assert.equal(Buffer.from(skill.fixed_raw_hex,'hex')[0x32]&15,3);
    assert.equal(source.type_raw,0);assert.equal(Buffer.from(source.fixed_raw_hex,'hex')[0x32]&15,0);
    assert.deepEqual(skill.actions,source.actions);assert.ok(candidates.some(row=>row.index===index));
    const compiled=compileNativeSequence(meta,'005',directSequence(skill));
    assert.equal(compiled.steps.flatMap(step=>step.carrier_spawn?.steps??[step]).filter(step=>step.event).length,index===29?2:3);
  }
  assert.equal(addCorrectedPartyPresentations(meta,sample.skills),0,'重复准备不重复登记动作');
});
