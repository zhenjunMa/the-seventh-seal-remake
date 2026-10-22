import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateBattleSkillProgress,isBattleSkillLearned,supportedBattleRecoverySkills} from '../web/core/battle_skill_access.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {WorldStore,validateWorld,encodeSave,decodeSave} from '../web/core/world.mjs';
import {compileRuntimeConfiguration,loadRuntimeConfiguration} from '../web/core/runtime_config.mjs';
const read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name+'.json',import.meta.url)));
const names={combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'party_rewards',party_skills:'party_skills',items:'items'};
const data=Object.fromEntries(await Promise.all(Object.entries(names).map(async([key,name])=>[key,await read(name)])));
const [seed,attributes]=await Promise.all(['opening_seed','party_combat'].map(read)),config=await loadRuntimeConfiguration(p=>read(p.slice(5,-5))),copy=structuredClone;
const commands=data.party_skills,source=commands.roles['001'].skills[43],maps=['M72061','M70010'];
const learnedHex=()=>{const raw=Buffer.from(source.fixed_raw_hex,'hex');raw[0x23]=1;return raw.toString('hex');};
function learnedWorld(indices=[43]){const world=copy(seed);world.party.find(role=>role.id==='001').skill_progress={version:1,learned_indices:[...indices]};return world;}

test('Original source43 learned0 is retained and the default new-game party receives no revival command',()=>{
  const before=copy(commands),world=copy(seed),saved=copy(world),recovery=supportedBattleRecoverySkills(commands),sample=createPartySample(world,attributes,commands);
  assert.equal(source.learned_raw,0);assert.equal(Buffer.from(source.fixed_raw_hex,'hex')[0x23],0);assert.equal(source.mp_delta_raw,40);assert.equal(source.mp_cost,0);
  assert.equal(commands.skills['001_43'],undefined);assert.equal(recovery['001_43'].battle_handler,'native-revival');assert.equal(recovery['001_43'].original_skill_index,43);
  assert.equal(isBattleSkillLearned(world,recovery['001_43']),false);assert.equal(sample.skills['001_43'],undefined);assert.equal(sample.source.player_command_order['001'].includes('001_43'),false);
  assert.deepEqual(commands,before);assert.deepEqual(world,saved);
});

test('Only explicit role progress or an original learned byte admits the source-owned command without mutating CHR records',()=>{
  const world=learnedWorld(),before=copy(world),command=supportedBattleRecoverySkills(commands)['001_43'],sample=createPartySample(world,attributes,commands);
  assert.equal(isBattleSkillLearned(world,command),true);assert.equal(sample.skills['001_43'].learned_effective,true);assert.equal(sample.skills['001_43'].learned_raw,1);
  assert.equal(sample.skills['001_43'].fixed_raw_hex,learnedHex());assert.equal(sample.skills['001_43'].source.path,'Fight_Role/001.CHR');assert.deepEqual(sample.skills['001_43'].actions,source.actions);
  assert.ok(sample.source.player_command_order['001'].includes('001_43'));assert.deepEqual(world,before);
  assert.equal(createPartySample(learnedWorld([]),attributes,commands).skills['001_43'],undefined);assert.equal(createPartySample(learnedWorld([42]),attributes,commands).skills['001_43'],undefined);
  assert.equal(isBattleSkillLearned(seed,{...command,learned_raw:1}),true);assert.equal(isBattleSkillLearned(world,{...command,actor_id:'missing'}),false);assert.equal(source.learned_raw,0);
});

test('Skill progress validation rejects duplicate, malformed and out-of-range indices at helper and world boundaries',()=>{
  const input={version:1,learned_indices:[0,43,199]},validated=validateBattleSkillProgress(input);validated.learned_indices.push(1);assert.deepEqual(input.learned_indices,[0,43,199]);
  const invalid=[null,[],{}, {version:2,learned_indices:[43]},{version:1,learned_indices:[43],extra:true},{version:1},
    ...[[43,43],[-1],[200],[43.5],['43'],[null],[NaN]].map(learned_indices=>({version:1,learned_indices}))];
  for(const value of invalid){assert.throws(()=>validateBattleSkillProgress(value),/已学技巧/);const world=copy(seed);world.party[0].skill_progress=value;assert.throws(()=>validateWorld(world,maps),/已学技巧/);}
  assert.doesNotThrow(()=>validateWorld(learnedWorld([0,43,199]),maps));
  const store=new WorldStore(copy(seed),maps),before=store.snapshot();assert.throws(()=>store.transact(world=>world.party[0].skill_progress={version:1,learned_indices:[43,43]}),/已学技巧/);assert.deepEqual(store.snapshot(),before);
});

test('Explicit learned indices survive the save envelope and reload while legacy saves remain without source43',async()=>{
  const world=new WorldStore(learnedWorld(),maps),before=world.snapshot(),loaded=await decodeSave(await encodeSave(before),maps);
  assert.deepEqual(loaded,before);assert.deepEqual(loaded.party[0].skill_progress,{version:1,learned_indices:[43]});assert.ok(createPartySample(loaded,attributes,commands).skills['001_43']);
  const legacy=await decodeSave(await encodeSave(seed),maps);assert.equal(legacy.party[0].skill_progress,undefined);assert.equal(createPartySample(legacy,attributes,commands).skills['001_43'],undefined);
  assert.equal(source.learned_raw,0);assert.equal(Buffer.from(source.fixed_raw_hex,'hex')[0x23],0);
});

test('The 001_43 command uses the unified source-bound skill overlay for MP, recovery and preparation debt',()=>{
  const cfg=copy(config),before=copy(data),world=learnedWorld(),row=cfg.skills.entries['001_43'];
  assert.ok(row);assert.deepEqual(row.owner,{role_id:'001',skill_index:43,side:'player'});assert.deepEqual(row.source,source.source);assert.equal(row.original.mp_cost,0);assert.equal(row.original.hp_term_bonus,150);
  const original=compileRuntimeConfiguration(data,cfg),plain=createPartySample(world,attributes,commands,original).skills['001_43'];assert.equal(plain.fixed_raw_hex,learnedHex());assert.deepEqual(plain.actions,source.actions);
  cfg.manifest.mode='debug';Object.assign(row.parameters,{mp_cost:3,hp_term_bonus:225,hp_max_term_bonus:225,preparation_delay_raw:1234});
  const compiled=compileRuntimeConfiguration(data,cfg),sample=createPartySample(world,attributes,commands,compiled),skill=sample.skills['001_43'],raw=Buffer.from(skill.fixed_raw_hex,'hex');
  assert.equal(skill.battle_handler,'native-revival');assert.equal(skill.mp_cost,3);assert.equal(raw.readInt32LE(0x14f),-3);assert.equal(raw.readInt32LE(0xab),225);assert.equal(raw.readInt32LE(0xaf),225);assert.equal(raw.readInt32LE(0x2e),1234);
  assert.deepEqual(skill.actions,source.actions);assert.deepEqual(skill.configuration.owner,row.owner);assert.equal(skill.configuration.mode,'debug');assert.deepEqual(data,before);
  const unregistered=copy(compiled);delete unregistered.skill_registry['001_43'];assert.throws(()=>createPartySample(world,attributes,commands,unregistered),/未登记/);
});
