import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {configureSkills,sourceSkillParameters} from '../web/core/skill_config.mjs';
import {createBattleSample,resourcesForWorld,consumeBattleMp} from '../web/combat_sample.mjs';
import {createNativeRng,resolveAction,applyNativeDamage} from '../web/core/combat_rules.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
const root=new URL('../',import.meta.url),read=async p=>JSON.parse(await readFile(new URL(p,root)));
const [data,seed,config]=await Promise.all(['web/data/combat_sample.json','web/data/world_seed.json','web/data/skills.json'].map(read)),clone=v=>structuredClone(v),results=[];
function contract(name,fn){test(name,async()=>{await fn();results.push({name,passed:true});});}
function debugConfig(){const next=clone(config);next.mode='debug';return next;}
function battleFixture(cfg,{worldSeed=seed,playAction=async(_,{onImpact})=>onImpact()}={}){
  const world=new WorldStore(clone(worldSeed),['M01010','M01030']),logs=[],rng=createNativeRng(0x20261011);
  const battle=new BattleController({world,resolveAction,applyDamage:applyNativeDamage,consumeResources:consumeBattleMp,resourcesForWorld,playAction,log:e=>logs.push(e),id:()=> 'configured-battle'});
  battle.start({...createBattleSample(world.snapshot(),data,cfg),rng});return {battle,world,logs,rng};
}
contract('original config preserves raw source records and exact first-round settlement',async()=>{
  const raw=clone(data.skills),before=clone(config),compiled=configureSkills(data.skills,config);
  for(const [id,skill] of Object.entries(compiled)){
    assert.deepEqual(sourceSkillParameters(skill),config.skills[id].original);assert.equal(skill.fixed_raw_hex,data.skills[id].fixed_raw_hex);assert.deepEqual(skill.configuration.differences,[]);
  }
  assert.deepEqual(data.skills,raw);assert.deepEqual(config,before);
  const f=battleFixture(config),s=await f.battle.choose('yantu');assert.deepEqual(s.actors.map(a=>[a.hp.current,a.mp.current]),[[996,79],[863,24]]);
});
contract('debug parameters change the real formula inputs and identify changed values in results',()=>{
  const cfg=debugConfig();cfg.skills.yantu.parameters.physical_multiplier_percent={minimum:70,maximum_exclusive:70};cfg.skills.yantu.parameters.element_power=[0,0,0,0,0,0];
  const old=createBattleSample(seed,data,config),next=createBattleSample(seed,data,cfg);
  const run=sample=>resolveAction({attacker:sample.actors[0],target:sample.actors[1],skill:sample.skills.yantu,rng:createNativeRng(0x20261011)});
  const baseline=run(old),changed=run(next);assert.ok(changed.physical>baseline.physical);assert.equal(changed.elemental,0);assert.notEqual(changed.damage,baseline.damage);
  assert.equal(changed.configuration.mode,'debug');assert.deepEqual(changed.configuration.differences.map(d=>d.field),['physical_multiplier_percent','element_power']);
  assert.equal(data.skills.yantu.fixed_raw_hex,old.skills.yantu.fixed_raw_hex);
});
contract('nonzero debug MP cost commits raw and effective MP once and survives save reload',async()=>{
  const cfg=debugConfig();cfg.skills.yantu.parameters.mp_cost=5;const f=battleFixture(cfg);await f.battle.choose('yantu');
  const player=f.battle.actor('001');assert.equal(player.mp.current,74);assert.equal(player.raw_mp,67);assert.equal(player.raw_by_address['0x0524a709'],67);
  assert.equal(f.logs.filter(e=>e.type==='battle-action'&&e.actor_id==='001').length,1);
  assert.equal(f.battle.snapshot().history[0].result.configuration.differences[0].field,'mp_cost');
  f.battle.finish();assert.equal(f.world.value.party[0].mp.current,67);
  const restored=await decodeSave(await encodeSave(f.world.snapshot()),['M01010','M01030']);assert.equal(createBattleSample(restored,data,cfg).actors[0].mp.current,74);
});
contract('equipment MP depleted below raw zero persists DWORD bits without replenishment',()=>{
  const input=clone(seed);input.party[0].mp.current=0;const player=createBattleSample(input,data,config).actors[0];
  const spent=consumeBattleMp(player,5);assert.equal(spent.mp.current,2);assert.equal(spent.raw_mp,-5);assert.equal(resourcesForWorld(spent).mp,0xfffffffb);
  input.party[0].mp.current=resourcesForWorld(spent).mp;assert.equal(createBattleSample(input,data,config).actors[0].mp.current,2);
});
contract('unaffordable configured command rejects without RNG, HP, MP or world changes',async()=>{
  const cfg=debugConfig();cfg.skills.yantu.parameters.mp_cost=80;const f=battleFixture(cfg),before=f.battle.snapshot(),world=f.world.snapshot(),state=f.rng.state;
  assert.equal(f.battle.canChoose('yantu'),false);await assert.rejects(f.battle.choose('yantu'),/资源不足/);
  assert.deepEqual(f.battle.snapshot(),before);assert.deepEqual(f.world.snapshot(),world);assert.equal(f.rng.state,state);
});
contract('original mode source drift, unknown parameters, invalid ranges and malformed profiles reject',()=>{
  const mutations=[c=>c.mode='typo',c=>c.skills.yantu.parameters.mp_cost=1,c=>c.skills.yantu.original.mp_cost=1,
    c=>c.skills.yantu.source.sha256='0'.repeat(64),c=>c.skills.yantu.parameters.mpCost=5,
    c=>{c.mode='debug';c.skills.yantu.parameters.mp_cost=-1;},c=>{c.mode='debug';c.skills.yantu.parameters.element_power=[10];},
    c=>{c.mode='debug';c.skills.yantu.parameters.defense_bonus.minimum=1;},c=>{c.mode='debug';c.skills.yantu.parameters.mp_cost=2.5;}];
  for(const mutate of mutations){const cfg=clone(config);mutate(cfg);assert.throws(()=>configureSkills(data.skills,cfg),/技能配置/);}
});
contract('battle retains entry config snapshot after external edits and display failure',async()=>{
  const cfg=debugConfig();cfg.skills.yantu.parameters.mp_cost=5;
  const f=battleFixture(cfg,{playAction:async()=>{throw new Error('synthetic animation failed');}});cfg.skills.yantu.parameters.mp_cost=20;
  await assert.rejects(f.battle.choose('yantu'),/animation failed/);assert.equal(f.battle.actor('001').mp.current,74);assert.equal(f.battle.snapshot().history[0].result.mp_cost,5);
  f.battle.finish();assert.equal(f.world.value.party[0].mp.current,67);
});
contract('resource adapter failure is atomic before dispatch cost or history is committed',async()=>{
  const f=battleFixture(config),player=f.battle.actor('001');player.raw_mp=71;
  const before=f.battle.snapshot();await assert.rejects(f.battle.choose('yantu'),/MP显示/);assert.equal(player.mp.current,79);assert.equal(f.battle.snapshot().action_count,0);
  assert.equal(f.battle.snapshot().history.length,0);assert.deepEqual(f.battle.actor('012').hp,before.actors[1].hp);
});
after(async()=>{
  const paths=['web/core/skill_config.mjs','web/core/combat.mjs','web/combat_sample.mjs','web/core/combat_rules.mjs','web/data/skills.json','tests/test_skill_config.mjs'];
  const hashes=Object.fromEntries(await Promise.all(paths.map(async p=>[p,createHash('sha256').update(await readFile(new URL(p,root))).digest('hex')])));
  await writeFile(new URL('evidence/skill_config_verification_20261011.json',root),JSON.stringify({schema:'seventh-seal-skill-config-verification',version:1,
    tests:8,passed:results.length,failed:8-results.length,code_hashes:hashes,cases:results,
    authority:'Real exported numeric inputs with explicit debug config variants; animation errors and instant callbacks are synthetic',original_game_execution_observed:false},null,2)+'\n');
});
