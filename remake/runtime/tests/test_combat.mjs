import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {BattleController} from '../web/core/combat.mjs';

const root=new URL('../',import.meta.url);
const seedBytes=await readFile(new URL('web/data/world_seed.json',root)),seed=JSON.parse(seedBytes);
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

test('Frame and HUD snapshots never read history and keep isolated incremental impact summaries',async()=>{
  const f=fixture({playAction:async(_,{onImpact})=>{assert.equal(onImpact({source_frame:17}),true);assert.equal(onImpact({source_frame:99}),false);}});
  assert.equal(f.battle.presentationSnapshot(),null);f.battle.start(f.config);
  assert.equal(f.battle.presentationSnapshot().impact_count,0);assert.equal(f.battle.presentationSnapshot().last_impact,null);
  await f.battle.choose('yantu');
  const full=f.battle.snapshot();assert.equal(full.history.length,2);assert.equal(full.history[0].result.damage,30);
  assert.equal(full.history[1].presentation.source_frame,17);
  f.battle.state.source.runtime_configuration={mode:'debug',parameters:()=>{throw new Error('large source must not be traversed');}};
  Object.defineProperty(f.battle.actor('001'),'native_status_slots',{get(){throw new Error('raw status must not be traversed');}});
  const history=f.battle.state.history;
  Object.defineProperty(f.battle.state,'history',{get(){throw new Error('frame/HUD must not read history');}});
  const snapshot=f.battle.presentationSnapshot();assert.ok(JSON.stringify(snapshot).length<2000);
  assert.equal(Object.hasOwn(snapshot,'history'),false);assert.equal(snapshot.source.runtime_configuration.mode,'debug');
  assert.equal(snapshot.impact_count,2);assert.deepEqual(snapshot.last_impact,{actor_id:'012',source_frame:17});
  snapshot.actors[0].hp.current=0;snapshot.last_impact.actor_id='mutated';
  assert.equal(f.battle.actor('001').hp.current,90);assert.equal(history[0].result.damage,30);
  let published;f.battle.notify=value=>{published=value;};f.battle.publish();
  assert.equal(published.actors[0].hp.current,90);assert.equal(published.impact_count,2);
  assert.deepEqual(published.last_impact,{actor_id:'012',source_frame:17});assert.equal(Object.hasOwn(published,'history'),false);
});

test('a late older action keeps the most recently appended impacted action in the display summary',async()=>{
  const contacts=[],f=fixture({playAction:async(_,{onImpact})=>{const gate=deferred();contacts.push({onImpact,gate});await gate.promise;}});
  f.battle.start(f.config);const player=f.battle.actor('001'),enemy=f.battle.actor('012');
  player.current_skill=f.battle.skills.yantu;enemy.current_skill=f.battle.skills.snow_attack;
  const older=f.battle.performAction(player,enemy,f.battle.skills.yantu);
  const newer=f.battle.performAction(enemy,player,f.battle.skills.snow_attack);
  assert.equal(contacts[1].onImpact({source_frame:22}),true);contacts[1].gate.resolve();await newer;
  assert.equal(f.battle.presentationSnapshot().impact_count,1);
  assert.deepEqual(f.battle.presentationSnapshot().last_impact,{actor_id:'012',source_frame:22});
  assert.equal(contacts[0].onImpact({source_frame:11}),true);assert.equal(contacts[0].onImpact({source_frame:99}),false);
  contacts[0].gate.resolve();await older;
  assert.equal(f.battle.presentationSnapshot().impact_count,2);
  assert.deepEqual(f.battle.presentationSnapshot().last_impact,{actor_id:'012',source_frame:22});
  assert.deepEqual(f.battle.snapshot().history.map(entry=>entry.presentation.source_frame),[11,22]);
});

test('two automatic actions settle once and advance a round; world changes only on return',async()=>{
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
test('pending animation blocks reentry and return; impact cannot replay',async()=>{
  const entered=deferred(),release=deferred();let impact;
  const f=fixture({playAction:async(result,{onImpact})=>{if(result.actor_id==='001'){impact=onImpact;entered.resolve();await release.promise;}onImpact();}});
  f.battle.start(f.config);const pending=f.battle.choose('yantu');await entered.promise;
  assert.equal(f.battle.canChoose('yantu'),false);await assert.rejects(f.battle.choose('yantu'),/行动完成/);assert.throws(()=>f.battle.finish(),/执行/);
  assert.equal(f.battle.actor('001').mp.current,15);assert.equal(impact(),true);assert.equal(impact(),false);
  release.resolve();await pending;assert.equal(f.battle.actor('012').hp.current,70);
});
test('lethal player damage waits for animation completion and skips enemy',async()=>{
  const entered=deferred(),release=deferred();const f=fixture({resolveAction:i=>({hit:true,damage:100,mp_cost:i.skill.mp_cost}),
    playAction:async(_,{onImpact})=>{onImpact();entered.resolve();await release.promise;}});
  f.battle.start(f.config);const pending=f.battle.choose('yantu');await entered.promise;
  assert.equal(f.battle.snapshot().phase,'action');assert.equal(f.battle.actor('012').hp.current,0);assert.throws(()=>f.battle.finish());
  release.resolve();const state=await pending;assert.equal(state.phase,'victory');assert.equal(state.action_count,1);assert.equal(state.actors[1].mp.current,8);
  assert.equal(f.battle.finish().outcome,'victory');
});
test('enemy-first lethal action produces defeat without consuming unplayed player command',async()=>{
  const f=fixture({resolveAction:i=>({hit:true,damage:101,mp_cost:i.skill.mp_cost})});f.config.order=['012','001'];f.battle.start(f.config);
  const state=await f.battle.choose('yantu');assert.equal(state.phase,'defeat');assert.equal(state.action_count,1);assert.equal(state.actors[0].mp.current,20);
  f.battle.finish();assert.equal(f.world.value.party[0].hp.current,0);
});
test('unaffordable and unknown commands have no effects or random calls',async()=>{
  const f=fixture();f.config.actors[0].mp.current=4;f.battle.start(f.config);const before=f.battle.snapshot();
  assert.equal(f.battle.canChoose('yantu'),false);await assert.rejects(f.battle.choose('yantu'),/资源不足/);await assert.rejects(f.battle.choose('unknown'),/未接入/);
  assert.deepEqual(f.battle.snapshot(),before);assert.equal(f.calls.length,0);
});
test('missing impact interrupts and retains dispatch cost but no damage',async()=>{
  const f=fixture({playAction:async()=>{}});f.battle.start(f.config);await assert.rejects(f.battle.choose('yantu'),/没有执行/);
  assert.equal(f.battle.snapshot().phase,'interrupted');assert.equal(f.battle.actor('001').mp.current,15);assert.equal(f.battle.actor('012').hp.current,100);
  assert.equal(f.battle.finish().outcome,'interrupted');assert.equal(f.world.value.party[0].mp.current,15);
});
test('animation error after impact retains exactly the committed HP and MP',async()=>{
  const f=fixture({playAction:async(_,{onImpact})=>{onImpact();throw new Error('synthetic display failed');}});f.battle.start(f.config);
  await assert.rejects(f.battle.choose('yantu'),/display failed/);assert.equal(f.battle.actor('012').hp.current,70);assert.equal(f.battle.actor('001').mp.current,15);
  assert.equal(f.logs.filter(e=>e.type==='battle-impact').length,1);f.battle.finish();
});
test('resolver failure interrupts before consuming command',async()=>{
  const f=fixture({resolveAction:()=>{throw new Error('synthetic unsupported rule');}});f.battle.start(f.config);
  await assert.rejects(f.battle.choose('yantu'),/unsupported/);assert.equal(f.battle.actor('001').mp.current,20);assert.equal(f.battle.snapshot().action_count,0);
});
test('external world revision during animation cannot be overwritten by HP or finish',async()=>{
  const entered=deferred(),release=deferred();const f=fixture({playAction:async(_,{onImpact})=>{entered.resolve();await release.promise;onImpact();}});
  f.battle.start(f.config);const pending=f.battle.choose('yantu');await entered.promise;f.world.transact(next=>next.flags[1999]=42);const external=f.world.snapshot();
  release.resolve();await assert.rejects(pending,/状态已变化/);assert.throws(()=>f.battle.finish(),/状态已变化/);assert.deepEqual(f.world.snapshot(),external);
});
test('resource-free exit preserves complete world and does not add rewards',async()=>{
  const f=fixture();f.config.actors[0].hp.current=seed.party[0].hp.current;f.config.actors[0].mp.current=seed.party[0].mp.current;
  const before=f.world.snapshot();f.battle.start(f.config);assert.equal(f.battle.finish().actions,0);assert.deepEqual(f.world.snapshot(),before);
});
test('malformed configuration rejects before a battle is published',async()=>{
  for(const mutate of [c=>c.actors[0].hp.current=0,c=>c.order=['001','001'],c=>c.skills.yantu.evidence=[],c=>c.actors[1].mp.current=-1]){
    const f=fixture();mutate(f.config);assert.throws(()=>f.battle.start(f.config));assert.equal(f.battle.snapshot(),null);assert.equal(f.logs.length,0);
  }
});
test('non-target resource mutation is rejected rather than committed',async()=>{
  const f=fixture({applyDamage:(target,result)=>({...target,mp:{...target.mp,current:0},hp:{...target.hp,current:target.hp.current-result.damage}})});
  f.battle.start(f.config);await assert.rejects(f.battle.choose('yantu'),/非目标资源/);assert.equal(f.battle.actor('012').hp.current,100);assert.equal(f.battle.actor('012').mp.current,8);
});
test('native signed raw death bits survive unsigned world save and restore',async()=>{
  const f=fixture({resourcesForWorld:()=>({hp:0xffffff9c,mp:15})});f.battle.start(f.config);f.battle.finish();
  const restored=await decodeSave(await encodeSave(f.world.snapshot()),['M01010','M01030']);assert.equal(restored.party[0].hp.current,0xffffff9c);assert.equal(restored.party[0].hp.current|0,-100);
});
test('a closed controller can start a fresh independent battle',async()=>{
  const f=fixture();f.battle.start(f.config);await f.battle.choose('yantu');f.battle.finish();f.battle.start(f.config);
  assert.equal(f.battle.snapshot().history.length,0);assert.equal(f.battle.snapshot().round,1);assert.equal(f.battle.canChoose('yantu'),true);
  assert.equal(f.battle.presentationSnapshot().impact_count,0);assert.equal(f.battle.presentationSnapshot().last_impact,null);
});
