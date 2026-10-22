import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolveContentDefinition} from '../web/core/content_definition.mjs';
import {runtimeContent,runtimeContentDefinition} from '../web/core/content_registry.mjs';
import {admitPartyMember} from '../web/core/party_members.mjs';
import {createContentSample} from '../web/core/content_sample.mjs';
import {battleSkillEligibility} from '../web/core/battle_skill_access.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {createPartyActors} from '../web/core/party_attributes.mjs';
import {directSequence,compileNativeSequence} from '../web/core/skill_sequence.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {initialEncounterState,previewMovement} from '../web/core/encounters.mjs';
import {initializeNativeStatuses} from '../web/core/battle_status.mjs';
import {resolveAction,createNativeRng} from '../web/core/combat_rules.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {createRewardLedger,collectEnemyDefeat,planVictoryRewards,applyExperience} from '../web/core/battle_rewards.mjs';
import {readContentDefinition} from '../tools/resolve_content_definition.mjs';
const read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [seed,forest,story,attributes,commands,rewards,route,view,items]=await Promise.all(['opening_seed','forest_combat','chapter_story','party_combat','party_skills','party_rewards','route_seed','party_battle_view','items'].map(read));
const {sources:{maps}}=await readContentDefinition();
const sample=options=>createContentSample(seed,rewards,route.location,options);

test('Development checkpoint reaches the normal encounter transaction on one step without changing encounter frequency',async()=>{
  const data=await read('encounters'),world=sample(),before=structuredClone(world.encounters);
  const result=previewMovement(world.encounters,{party:world.party,leader_id:world.leader_id,map_id:'M70010',dx:16,dy:0},data);
  assert.equal(data.maps.M70010.frequency,1);assert.equal(result.steps,1);assert.equal(result.encounter.trigger_roll.raw,998);
  assert.equal(result.encounter.map_id,'M70010');assert.ok(result.encounter.members.length>0);
  assert.deepEqual(world.encounters,before);assert.equal(result.state.counters['001'],0);
});

test('Minimal content choices resolve identities, default skill IDs and source-owned story choices',()=>{
  assert.equal(runtimeContentDefinition.version,2);
  const before=structuredClone(runtimeContentDefinition);
  const result=resolveContentDefinition(before,{seed,forest,story,maps});
  assert.deepEqual(result,runtimeContent);assert.deepEqual(before,runtimeContentDefinition);
  assert.equal(result.roles['003'].source.sha256,seed.source.role_definitions['003'].sha256);
  assert.equal(result.roles['003'].native_slot,2);
  assert.equal(result.maps.M70010.flag_index,114);
  assert.deepEqual(result.battle_rosters['party-source-group'],['001','002','003','011','012','013']);
  assert.ok(result.roles['003'].battle_skills.some(row=>row.id==='003_25'&&row.index===25));
  assert.deepEqual(result.maps.M17026.rests[0].choices.map(row=>[row.text,row.record_id]),[['休息。',12],['不用。',0]]);
  const duplicate=structuredClone(before);duplicate.roles['003'].source={path:'foreign'};
  assert.throws(()=>resolveContentDefinition(duplicate,{seed,forest,story,maps}),/重复来源/);
});

test('Real Wadi admission preserves existing progress, equipment, formation holes and encounter RNG',()=>{
  const world=sample({heroLevel:seed.party[0].level,learnSkillIndices:[]});
  world.party=world.party.filter(role=>role.id!=='003');world.formation_slots=['001',null,'002',null];
  world.encounters=initialEncounterState(world.party,781);world.encounters.counters['001']=17;
  const before=structuredClone(world),result=admitPartyMember(world,'003');
  assert.equal(result.added,true);assert.equal(world.party[2].name,'娃蒂');assert.equal(world.party[2].level,25);
  assert.deepEqual(world.formation_slots,['001','003','002',null]);
  assert.deepEqual(world.party.slice(0,2),before.party);assert.deepEqual(world.inventory,before.inventory);
  assert.deepEqual(world.encounters,{...before.encounters,counters:{...before.encounters.counters,'003':0},remainders:{...before.encounters.remainders,'003':0}});
  const admitted=structuredClone(world);assert.deepEqual(admitPartyMember(world,'003'),{id:'003',added:false});assert.deepEqual(world,admitted);
  assert.equal(createPartyActors(world,attributes,{},items)[2].resource_id,'003');
});

test('Admitted but unlearned source attacks require both saved learning and the native character level',()=>{
  const skill=commands.skills['001_26'],before=structuredClone(commands);
  assert.equal(skill.learned_raw,0);assert.equal(battleSkillEligibility(seed,skill).required_level,12);
  const low=sample({heroLevel:11}),highUnlearned=sample({learnSkillIndices:[]}),high=sample();
  assert.equal(battleSkillEligibility(low,skill).learned,true);assert.equal(battleSkillEligibility(low,skill).available,false);
  assert.equal(createPartySample(low,attributes,commands).skills['001_26'],undefined);
  assert.equal(createPartySample(highUnlearned,attributes,commands).skills['001_26'],undefined);
  const live=createPartySample(high,attributes,commands);
  assert.equal(live.skills['001_26'].learned_effective,true);assert.ok(live.skills['001_23']);
  assert.equal(high.party[0].level,12);assert.equal(high.party[2].level,25);assert.deepEqual(commands,before);
  assert.equal(high.party[0].hp.maximum,seed.party[0].hp.maximum+rewards.tables.growth_rows[0][0]);
});

test('Wadi effect-carrier skill compiles with the same handler as Ingni, without role or source-index branching',()=>{
  for(const id of ['yancui','003_34']){
    const skill=commands.skills[id],compiled=compileNativeSequence(view,skill.actor_id,directSequence(skill));
    assert.equal(skill.battle_handler,'effect-carrier');assert.ok(compiled.steps.some(step=>step.effect_contact));
    assert.ok(compiled.steps.some(step=>step.command_raw===4));
    assert.ok(compiled.steps.every(step=>step.source_skill_index===skill.original_skill_index));
    const unregistered=directSequence(skill);unregistered.handler='direct';
    assert.throws(()=>compileNativeSequence(view,skill.actor_id,unregistered),/命令未支持/);
  }
});

test('Wadi item timing and the third growth row come from her own source records',async()=>{
  const presentation=await read('item_presentation'),role=presentation.roles.find(row=>row.id==='003');
  assert.equal(role.sequence.segments[0].action_index,22);assert.equal(role.sequence.segments[0].event.frame,19);
  assert.equal(presentation.roles.find(row=>row.id==='001').sequence.segments[0].event.frame,17);
  assert.equal(rewards.initial_roles['003'].growth_row,2);assert.equal(rewards.tables.growth_rows.length,6);
  assert.deepEqual(rewards.tables.growth_rows[2],[75,75,8,8,4,4,2,2,5,5]);
  const menu=await read('operation_menu');assert.equal(menu.actor_panels['003'].source_frame,2);
  assert.ok(menu.standing_actors['003'].frames.length>0);
});

test('Wadi spell damage matches native same-index effect dispatch across all forest targets and RNG draws',async()=>{
  const readProof=async name=>JSON.parse(await readFile(new URL(`../evidence/${name}.json`,import.meta.url),'utf8'));
  const [assembly,native,status]=await Promise.all([readProof('turn_rules_assembly_20261011'),readProof('party_magic_native'),read('forest_status')]);
  const getter=native.records.find(row=>row.operation==='procedure_assembly'&&row.parameters.procedure==='0x501930');
  const functions={...assembly.functions,'0x501930':getter.normalized_result.trim().split('\n')};
  const skill=commands.skills['003_34'],template=createPartySample(sample(),attributes,commands).actors.find(row=>row.id==='003');
  for(const id of ['011','012','013'])for(let n=0;n<8;n++){
    const attacker=initializeNativeStatuses(structuredClone(template),status),target=initializeNativeStatuses(structuredClone(forest.actors[id]),status);
    attacker.current_skill=skill;const contact=skill.actions.find(action=>action.contact_u32_raw_0x49);
    attacker.class_raw=contact.class_raw;attacker.action_mask_raw=contact.action_mask_raw;
    const seedValue=(n*747796405)>>>0,actual=resolveAction({attacker,target,skill,rng:createNativeRng(seedValue),context:skill.effect_context});
    const oracle=new NativeAssemblyOracle(functions,[attacker,target],createNativeRng(seedValue));
    oracle.write(0x55e3fec,skill.original_skill_index);
    for(const [slot,actor]of [attacker,target].entries()){
      const table=0x23000000+slot*0x100000;oracle.write(0x524a9dc+slot*0x30274,table);
      const bytes=slot===0?Buffer.from(skill.fixed_raw_hex,'hex'):Buffer.alloc(0x41d);
      for(let k=0;k<bytes.length;k++)oracle.write(table+skill.original_skill_index*0x421+k,bytes[k],1);
    }
    const expected=oracle.run(0x41d990,[0,1,0x20000000,1]);
    assert.equal(actual.native_return,expected.eax);assert.equal(actual.reaction,oracle.read(0x20000000));
    assert.deepEqual(actual.trace.filter(row=>row.kind==='rng').map(row=>row.raw),expected.rng_calls);
    assert.ok(actual.damage>0);
  }
});

test('Three living players receive the full victory pool and Wadi levels with her source growth row',()=>{
  const world=sample(),players=createPartyActors(world,attributes,{},items),enemy={id:'enemy-0',resource_id:'012',side:'enemy',side_raw:0,hp:{current:0},immune_raw:0,state_raw:5};
  const actors=[...players,enemy],ledger=createRewardLedger('real-third-member',actors);collectEnemyDefeat(ledger,enemy,{data:rewards});
  const plan=planVictoryRewards({world,actors,ledger,data:rewards,rng:()=>0});
  assert.deepEqual(plan.summary.experience.map(row=>[row.role_id,row.experience]),[['001',84],['002',84],['003',84]]);
  const wadi=world.party[2],bytes=Buffer.from(wadi.combat_progress.header_raw_hex,'hex'),amount=bytes.readInt32LE(0x2c)-bytes.readInt32LE(0x28);
  const result=applyExperience(wadi,amount,rewards,()=>0,[]);
  assert.equal(result.role.level,26);assert.equal(result.role.hp.maximum,wadi.hp.maximum+75);assert.equal(result.role.mp.maximum,wadi.mp.maximum+8);
});

test('Three real teammates and the new learned skill survive save reload; legacy worlds gain no teammate',async()=>{
  const world=new WorldStore(sample(),Object.keys(runtimeContent.maps));
  const saved=await decodeSave(await encodeSave(world.snapshot()),Object.keys(runtimeContent.maps));
  assert.deepEqual(saved,world.snapshot());
  const restored=createPartySample(saved,attributes,commands);assert.deepEqual(restored.actors.map(row=>row.id),['001','002','003']);
  assert.ok(restored.skills['001_26']);assert.ok(restored.skills['003_25']);assert.ok(restored.skills['003_34']);
  assert.deepEqual(createPartySample(seed,attributes,commands).actors.map(row=>row.id),['001']);
  assert.equal(seed.party[0].level,11);assert.equal(commands.skills['001_26'].learned_raw,0);
});
