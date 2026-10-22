import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {BattleController} from '../web/core/combat.mjs';

const root=new URL('../',import.meta.url),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const seedBytes=await readFile(new URL('web/data/world_seed.json',root)),seed=JSON.parse(seedBytes),results=[];
const clone=value=>structuredClone(value),deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(options={}) {
  const world=new WorldStore(clone(seed),['M01010','M01030']),logs=[],calls=[];
  const actors=[{id:'001',name:'synthetic player',side:'player',hp:{current:100,maximum:100},mp:{current:20,maximum:20}},
    {id:'012',name:'synthetic enemy',side:'enemy',hp:{current:100,maximum:100},mp:{current:8,maximum:8}}];
  const skills={yantu:{id:'yantu',actor_id:'001',mp_cost:5,source:'synthetic',evidence:['synthetic-lifecycle-only']},
    snow_attack:{id:'snow_attack',actor_id:'012',mp_cost:2,source:'synthetic',evidence:['synthetic-lifecycle-only']}};
  const config={actors,skills,order:['001','012'],enemy_skill_id:'snow_attack',rng:()=>0,source:{authority:'synthetic lifecycle fixture; no original numeric/order claims'}};
  const battle=new BattleController({world,id:()=> 'synthetic-battle',log:e=>logs.push(e),
    resolveAction:options.resolveAction??(input=>{calls.push(input);assert.equal(input.target.current_skill.actor_id,input.target.id);return {hit:true,damage:input.attacker.side==='player'?30:10,mp_cost:input.skill.mp_cost};}),
    applyDamage:options.applyDamage??((target,result)=>({...target,hp:{...target.hp,current:Math.max(0,target.hp.current-result.damage)}})),
    playAction:options.playAction??(async(result,{onImpact})=>{assert.equal(onImpact(),true);assert.equal(onImpact(),false);}),
    ...(options.resourcesForWorld?{resourcesForWorld:options.resourcesForWorld}:{})});
  return {world,battle,config,logs,calls};
}
function contract(name,fn){test(name,async()=>{try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});throw error;}});}

contract('Frame and HUD snapshots stay isolated and omit growing native history and configuration evidence',async()=>{
  const f=fixture();assert.equal(f.battle.presentationSnapshot(),null);f.battle.start(f.config);
  f.battle.state.source.runtime_configuration={mode:'debug',parameters:()=>{throw new Error('large source must not be traversed');}};
  Object.defineProperty(f.battle.actor('001'),'native_status_slots',{get(){throw new Error('raw status must not be traversed');}});
  f.battle.state.history.push({action_id:'contact',actor_id:'001',target_id:'012',skill_id:'yantu',round:1,impact:true,
    before:()=>{},after:()=>{},result:{hit:true,damage:30,raw_evidence:()=>{}},presentation:{source_frame:17}});
  const snapshot=f.battle.presentationSnapshot();assert.ok(JSON.stringify(snapshot).length<2000);
  assert.equal(snapshot.source.runtime_configuration.mode,'debug');assert.equal(snapshot.history[0].result.damage,30);
  assert.equal(snapshot.history[0].presentation.source_frame,17);
  snapshot.actors[0].hp.current=0;snapshot.history[0].result.damage=0;
  assert.equal(f.battle.actor('001').hp.current,100);assert.equal(f.battle.state.history[0].result.damage,30);
  let published;f.battle.notify=value=>{published=value;};f.battle.publish();
  assert.equal(published.actors[0].hp.current,100);assert.equal(published.history[0].result.damage,30);
});

contract('two automatic actions settle once and advance a round; world changes only on return',async()=>{
  const f=fixture(),before=f.world.snapshot();f.battle.start(f.config);const state=await f.battle.choose('yantu');
  assert.equal(state.phase,'command');assert.equal(state.round,2);assert.equal(state.action_count,2);
  assert.deepEqual(state.actors.map(a=>[a.hp.current,a.mp.current]),[[90,15],[70,6]]);
  assert.deepEqual(f.world.snapshot(),before);assert.equal(f.logs.filter(e=>e.type==='battle-impact').length,2);
  const done=f.battle.finish();assert.equal(done.rewards_applied,false);assert.equal(done.outcome,'aborted');
  assert.deepEqual(f.world.value.party[0].hp,{current:90,maximum:before.party[0].hp.maximum});
  assert.deepEqual(f.world.snapshot().location,before.location);assert.deepEqual(f.world.value.flags,before.flags);
  assert.deepEqual(f.world.value.inventory,before.inventory);assert.deepEqual(f.world.value.party[1],before.party[1]);
  assert.equal(f.world.value.leader_id,before.leader_id);
  const once=f.world.snapshot();assert.deepEqual(f.battle.finish(),done);assert.deepEqual(f.world.snapshot(),once);
});
contract('pending animation blocks reentry and return; impact cannot replay',async()=>{
  const entered=deferred(),release=deferred();let impact;
  const f=fixture({playAction:async(result,{onImpact})=>{if(result.actor_id==='001'){impact=onImpact;entered.resolve();await release.promise;}onImpact();}});
  f.battle.start(f.config);const pending=f.battle.choose('yantu');await entered.promise;
  assert.equal(f.battle.canChoose('yantu'),false);await assert.rejects(f.battle.choose('yantu'),/行动完成/);assert.throws(()=>f.battle.finish(),/执行/);
  assert.equal(f.battle.actor('001').mp.current,15);assert.equal(impact(),true);assert.equal(impact(),false);
  release.resolve();await pending;assert.equal(f.battle.actor('012').hp.current,70);
});
contract('lethal player damage waits for animation completion and skips enemy',async()=>{
  const entered=deferred(),release=deferred();const f=fixture({resolveAction:i=>({hit:true,damage:100,mp_cost:i.skill.mp_cost}),
    playAction:async(_,{onImpact})=>{onImpact();entered.resolve();await release.promise;}});
  f.battle.start(f.config);const pending=f.battle.choose('yantu');await entered.promise;
  assert.equal(f.battle.snapshot().phase,'action');assert.equal(f.battle.actor('012').hp.current,0);assert.throws(()=>f.battle.finish());
  release.resolve();const state=await pending;assert.equal(state.phase,'victory');assert.equal(state.action_count,1);assert.equal(state.actors[1].mp.current,8);
  assert.equal(f.battle.finish().outcome,'victory');
});
contract('enemy-first lethal action produces defeat without consuming unplayed player command',async()=>{
  const f=fixture({resolveAction:i=>({hit:true,damage:101,mp_cost:i.skill.mp_cost})});f.config.order=['012','001'];f.battle.start(f.config);
  const state=await f.battle.choose('yantu');assert.equal(state.phase,'defeat');assert.equal(state.action_count,1);assert.equal(state.actors[0].mp.current,20);
  f.battle.finish();assert.equal(f.world.value.party[0].hp.current,0);
});
contract('unaffordable and unknown commands have no effects or random calls',async()=>{
  const f=fixture();f.config.actors[0].mp.current=4;f.battle.start(f.config);const before=f.battle.snapshot();
  assert.equal(f.battle.canChoose('yantu'),false);await assert.rejects(f.battle.choose('yantu'),/资源不足/);await assert.rejects(f.battle.choose('unknown'),/未接入/);
  assert.deepEqual(f.battle.snapshot(),before);assert.equal(f.calls.length,0);
});
contract('missing impact interrupts and retains dispatch cost but no damage',async()=>{
  const f=fixture({playAction:async()=>{}});f.battle.start(f.config);await assert.rejects(f.battle.choose('yantu'),/没有执行/);
  assert.equal(f.battle.snapshot().phase,'interrupted');assert.equal(f.battle.actor('001').mp.current,15);assert.equal(f.battle.actor('012').hp.current,100);
  assert.equal(f.battle.finish().outcome,'interrupted');assert.equal(f.world.value.party[0].mp.current,15);
});
contract('animation error after impact retains exactly the committed HP and MP',async()=>{
  const f=fixture({playAction:async(_,{onImpact})=>{onImpact();throw new Error('synthetic display failed');}});f.battle.start(f.config);
  await assert.rejects(f.battle.choose('yantu'),/display failed/);assert.equal(f.battle.actor('012').hp.current,70);assert.equal(f.battle.actor('001').mp.current,15);
  assert.equal(f.logs.filter(e=>e.type==='battle-impact').length,1);f.battle.finish();
});
contract('resolver failure interrupts before consuming command',async()=>{
  const f=fixture({resolveAction:()=>{throw new Error('synthetic unsupported rule');}});f.battle.start(f.config);
  await assert.rejects(f.battle.choose('yantu'),/unsupported/);assert.equal(f.battle.actor('001').mp.current,20);assert.equal(f.battle.snapshot().action_count,0);
});
contract('external world revision during animation cannot be overwritten by HP or finish',async()=>{
  const entered=deferred(),release=deferred();const f=fixture({playAction:async(_,{onImpact})=>{entered.resolve();await release.promise;onImpact();}});
  f.battle.start(f.config);const pending=f.battle.choose('yantu');await entered.promise;f.world.transact(next=>next.flags[1999]=42);const external=f.world.snapshot();
  release.resolve();await assert.rejects(pending,/状态已变化/);assert.throws(()=>f.battle.finish(),/状态已变化/);assert.deepEqual(f.world.snapshot(),external);
});
contract('resource-free exit preserves complete world and does not add rewards',async()=>{
  const f=fixture();f.config.actors[0].hp.current=seed.party[0].hp.current;f.config.actors[0].mp.current=seed.party[0].mp.current;
  const before=f.world.snapshot();f.battle.start(f.config);assert.equal(f.battle.finish().actions,0);assert.deepEqual(f.world.snapshot(),before);
});
contract('malformed configuration rejects before a battle is published',async()=>{
  for(const mutate of [c=>c.actors[0].hp.current=0,c=>c.order=['001','001'],c=>c.skills.yantu.evidence=[],c=>c.actors[1].mp.current=-1]){
    const f=fixture();mutate(f.config);assert.throws(()=>f.battle.start(f.config));assert.equal(f.battle.snapshot(),null);assert.equal(f.logs.length,0);
  }
});
contract('non-target resource mutation is rejected rather than committed',async()=>{
  const f=fixture({applyDamage:(target,result)=>({...target,mp:{...target.mp,current:0},hp:{...target.hp,current:target.hp.current-result.damage}})});
  f.battle.start(f.config);await assert.rejects(f.battle.choose('yantu'),/非目标资源/);assert.equal(f.battle.actor('012').hp.current,100);assert.equal(f.battle.actor('012').mp.current,8);
});
contract('native signed raw death bits survive unsigned world save and restore',async()=>{
  const f=fixture({resourcesForWorld:()=>({hp:0xffffff9c,mp:15})});f.battle.start(f.config);f.battle.finish();
  const restored=await decodeSave(await encodeSave(f.world.snapshot()),['M01010','M01030']);assert.equal(restored.party[0].hp.current,0xffffff9c);assert.equal(restored.party[0].hp.current|0,-100);
});
contract('a closed controller can start a fresh independent battle',async()=>{
  const f=fixture();f.battle.start(f.config);await f.battle.choose('yantu');f.battle.finish();f.battle.start(f.config);
  assert.equal(f.battle.snapshot().history.length,0);assert.equal(f.battle.snapshot().round,1);assert.equal(f.battle.canChoose('yantu'),true);
});
after(async()=>{
  const paths=['web/core/combat.mjs','tests/test_combat.mjs'],code_hashes=Object.fromEntries(await Promise.all(paths.map(async p=>[p,hash(await readFile(new URL(p,root)))])));
  await mkdir(new URL('evidence/',root),{recursive:true});
  await writeFile(new URL('evidence/turn_lifecycle_verification_20261011.json',root),JSON.stringify({schema:'seventh-seal-turn-lifecycle-verification',version:1,
    authority:'synthetic lifecycle tests with real world seed; no original arithmetic, action order, AI or animation claim',tests:results.length,passed:results.filter(r=>r.passed).length,
    failed:results.filter(r=>!r.passed).length,seed_sha256:hash(seedBytes),code_hashes,cases:results},null,2)+'\n');
});
