import {battleActive,commandReady,chooseReady} from './helpers/battle_clock.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BattleView} from '../web/battle_view.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {assembleForestSample} from '../web/forest_sample.mjs';
import {partyResourcesForWorld,consumePartyMp,createPartyActors} from '../web/core/party_attributes.mjs';
import {chapterRoleFromDefinition} from '../web/core/chapter.mjs';
import {resolveAction,applyNativeDamage,createNativeRng} from '../web/core/combat_rules.mjs';
import {loadRuntimeConfiguration,compileRuntimeConfiguration} from '../web/core/runtime_config.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
const read=async p=>JSON.parse(await readFile(new URL('../'+p,import.meta.url)));
const json=p=>read('web/'+p),clone=structuredClone;
const attributes=await json('data/party_combat.json'),commands=await json('data/party_skills.json');
const data={combat:await json('data/combat_sample.json'),forest:await json('data/forest_combat.json'),scheduler:await json('data/battle_scheduler.json'),ai:await json('data/forest_ai.json'),rewards:await json('data/party_rewards.json'),party_skills:commands,items:await json('data/items.json')};
const reaction=await json('data/party_reactions.json'),statuses=await json('data/forest_status.json'),assembly=await read('evidence/turn_rules_assembly_20261011.json');
const config=await loadRuntimeConfiguration(json);
async function worldFixture(){const seed=await json('data/opening_seed.json');seed.party.push(chapterRoleFromDefinition(seed.source.role_definitions['002']));seed.opening.status='complete';return new WorldStore(seed,['M72061','M70010']);}
test('Direct new-game attacks use their contact masks against every forest role and match original instructions and RNG',async()=>{
  const world=await worldFixture(),party=createPartySample(world.snapshot(),attributes,commands),actors=party.actors;
  for(const skill of Object.values(party.skills))for(const enemy of Object.values(data.forest.actors))for(const seed of [0,1,12345,0x20261011]){
    if(skill.effect_context)continue; // Actual token1 branch has a separate native getter oracle.
    const attacker=clone(actors.find(a=>a.id===skill.actor_id)),target=clone(enemy);
    const contact=skill.actions.find(a=>a.contact_u32_raw_0x49);
    attacker.current_skill=clone(skill);attacker.class_raw=contact.class_raw;attacker.action_mask_raw=contact.action_mask_raw;
    const actual=resolveAction({attacker,target,skill,rng:createNativeRng(seed)}),oracle=new NativeAssemblyOracle(assembly.functions,[attacker,target],createNativeRng(seed));
    const native=oracle.run(0x41d990,[0,1,0x20000000,0]);
    assert.equal(actual.native_return,native.eax,`${skill.id} against ${enemy.id}`);assert.equal(actual.reaction,oracle.read(0x20000000));
    assert.deepEqual(actual.trace.filter(r=>r.kind==='rng').map(r=>r.raw),native.rng_calls);
  }
});
test('New-game commands use the unified registry and reject a different actor source',async()=>{
  const world=await worldFixture(),bundle=clone(config);bundle.manifest.mode='debug';bundle.skills.entries.yantu.parameters.mp_cost=6;
  const configured=compileRuntimeConfiguration(data,bundle),sample=createPartySample(world.snapshot(),attributes,commands,configured);
  assert.equal(sample.skills.yantu.mp_cost,6);assert.equal(sample.skills.kai_mieyan.mp_cost,0);assert.equal(sample.skills.kai_suizu.mp_cost,0);
  const wrong=clone(commands);wrong.skills.kai_mieyan.actor_id='001';
  assert.throws(()=>createPartySample(world.snapshot(),attributes,wrong),/来源|技能|指纹|角色/);
});
test('Source party, complete contact reactions, two-person rewards and re-entry form one transaction',async()=>{
  const world=await worldFixture(),configured=compileRuntimeConfiguration(data,config);
  const sample=assembleForestSample(createPartySample(world.snapshot(),attributes,commands,configured),configured.forest,{map_id:'M70010',members:['012','013','013'].map(id=>({id}))},
    {...configured.scheduler,idle_skills:{...configured.scheduler.idle_skills,...commands.idle_skills}},configured.ai,configured.rewards,reaction,statuses);
  const ctx={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},save(){},restore(){},drawImage(){},fillText(){},createLinearGradient:()=>({addColorStop(){}})};
  const view=new BattleView({canvas:{width:960,height:540,getContext:()=>ctx},metadataPath:'/data/party_battle_view.json',jsonLoader:path=>json(path.slice(1)),assetLoader:async asset=>{
    const b=await readFile(new URL(asset.path.startsWith('/prototype/')?'../../prototype/web/'+asset.path.slice(11):'../web/'+asset.path.slice(1),import.meta.url));
    assert.equal(createHash('sha256').update(b).digest('hex'),asset.sha256);assert.equal(b.readUInt32BE(16),asset.width);assert.equal(b.readUInt32BE(20),asset.height);
    return {image:{width:asset.width,height:asset.height,path:asset.path},sha256:asset.sha256};
  }});await view.prepare();view.setRoster(sample.actors,sample.skills);
  let clock=0;const events=[];
  const battle=new BattleController({world,resolveAction,applyDamage:applyNativeDamage,resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,
    id:()=> 'source-party-integration',now:()=>clock,waitTick:async()=>{clock+=20;},log:event=>events.push(event),playAction:async()=>{throw new Error('Complete source contact path expected');},
    playSequence:async(result,hooks)=>{
      const pending=view.playSequence(result,hooks);view.draw({actors:battle.state.actors},clock);let frames=0;
      while(view.run){assert.ok(++frames<20000,'Bounded source playback');clock+=20;battle.advanceClock();view.draw({actors:battle.state.actors},clock);}
      return pending;
    }});
  battle.start({...sample,rng:createNativeRng(0x20261011)});
  const before=world.snapshot();let actions=0,usedKai=false,usedSpell=false;
  while(battleActive(battle)&&actions++<30){
    const living=battle.players().filter(a=>a.hp.current>0),snow=battle.actor('enemy-0').hp.current>0;
    const selected=living.find(a=>a.id===(snow?'001':actions%2?'002':'001'))??living[0];
    if(!await commandReady(battle,selected.id))break;battle.selectPlayer(selected.id);const skill=selected.id==='002'?'kai_suizu':snow?'yancui':'yantu';usedKai||=selected.id==='002';usedSpell||=skill==='yancui';await chooseReady(battle,skill);
  }
  assert.ok(usedKai);assert.ok(usedSpell);assert.ok(events.some(e=>e.type==='battle-impact'&&e.effect_token===1&&e.damage>0));assert.equal(battle.snapshot().phase,'victory',JSON.stringify({actors:battle.snapshot().actors.map(a=>({id:a.id,hp:a.hp,state:a.state_raw,immune:a.immune_raw,busy:a.reaction_busy_raw,flags:a.status_flags_raw,skill:a.current_skill?.fixed_raw_hex.slice(0,2)})),events:events.filter(e=>e.type==='battle-impact').slice(-4).map(e=>({actor:e.actor_id,skill:e.skill_id,hit:e.hit,damage:e.damage,skipped:e.skipped}))}));assert.deepEqual(world.snapshot(),before);
  assert.equal(battle.snapshot().rewards.experience.length,2);
  const done=battle.finish();assert.equal(done.rewards_applied,true);assert.ok(Object.hasOwn(done.resources_by_actor,'002'));
  const once=world.snapshot();assert.deepEqual(battle.finish(),done);assert.deepEqual(world.snapshot(),once);
  const reloaded=await decodeSave(await encodeSave(once),['M72061','M70010']);assert.deepEqual(reloaded,once);
  const resumed=createPartyActors(reloaded,attributes);assert.equal(resumed.length,2);assert.equal(reloaded.reward_records.length,1);
});
