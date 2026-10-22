import {commandReady,pumpUntil} from './helpers/battle_clock.mjs';
// Synthetic lifecycle checks. These numbers do not assert native Kai stats.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {selectReady} from '../web/core/battle_scheduler.mjs';
const read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name,import.meta.url)));
const seed=await read('route_seed.json'),source=await read('combat_sample.json'),scheduler=await read('battle_scheduler.json');
const clone=structuredClone;
function fixture({playerHp=[100,120],enemyFirst=false,damage=5,enemyCount=1,itemData=null}={}){
  const world=new WorldStore(clone(seed),['M17010','M70010']);let clock=0;const calls=[],logs=[];
  const a=clone(source.actors[0]),b=clone(a),e=clone(source.actors[1]);
  Object.assign(a,{hp:{current:playerHp[0],maximum:100},mp:{current:20,maximum:20},state_raw:playerHp[0]?0:4});
  Object.assign(b,{id:'002',name:'synthetic second member',resource_id:'001',hp:{current:playerHp[1],maximum:120},mp:{current:30,maximum:30},state_raw:playerHp[1]?0:4});
  e.hp={current:500,maximum:500};e.raw_by_address['0x0524a729']=enemyFirst?100:8;e.raw_by_address['0x0524a72d']=enemyFirst?100:8;
  const skills={one:{...clone(source.skills.yantu),id:'one',mp_cost:5},two:{...clone(source.skills.yantu),id:'two',actor_id:'002',mp_cost:7},snow_attack:clone(source.skills.snow_attack)};
  const enemies=[e,...Array.from({length:enemyCount-1},(_,i)=>({...clone(e),id:`enemy-${i+1}`,resource_id:'012'}))],actors=[a,b,...enemies];
  const enemySkills=Object.fromEntries(enemies.map((enemy,i)=>{const id=i?`snow_attack_${i}`:'snow_attack';if(i)skills[id]={...clone(skills.snow_attack),id,actor_id:enemy.id};return [enemy.id,id];}));
  const battle=new BattleController({world,id:()=> 'synthetic-party-battle',now:()=>clock,waitTick:async()=>{clock+=20;},
    itemData,
    log:e=>logs.push(e),
    resolveAction:i=>{calls.push(i);return {hit:true,damage:i.attacker.side==='enemy'?damage:1,mp_cost:i.skill.mp_cost};},
    applyDamage:(a,r)=>{const hp=Math.max(0,a.hp.current-r.damage);return {...a,hp:{...a.hp,current:hp},state_raw:hp===0?4:a.state_raw};},
    playAction:async(_,{onImpact})=>{onImpact();}});
  battle.start({actors,skills,order:actors.map(a=>a.id),enemy_skill_id:'snow_attack',enemy_skill_ids:enemySkills,scheduler_data:clone(scheduler),rng:()=>0,source:{authority:'synthetic party lifecycle fixture'}});
  return {world,battle,calls,logs};
}
test('Only the selected party member dispatches the queued command; both resources commit once',async()=>{
  const {world,battle,calls}=fixture(),before=world.snapshot();
  battle.actor('001').charge.gauge=999999;
  await commandReady(battle,'002');
  battle.selectPlayer('002');assert.equal(battle.canChoose('one'),false);assert.equal(battle.canChoose('two'),true);
  await battle.choose('two');
  assert.deepEqual(calls.filter(i=>i.attacker.side==='player').map(i=>i.attacker.id),['002']);
  assert.equal(battle.actor('001').mp.current,20);assert.equal(battle.actor('002').mp.current,23);
  assert.deepEqual(world.snapshot(),before);
  battle.selectPlayer('001');await battle.choose('one');
  const done=battle.finish();assert.deepEqual(done.resources_by_actor['001'],{hp:battle.actor('001').hp.current,mp:15});
  assert.deepEqual(done.resources_by_actor['002'],{hp:battle.actor('002').hp.current,mp:23});
  assert.equal(world.value.party[0].mp.current,15);assert.equal(world.value.party[1].mp.current,23);
  const saved=world.snapshot();assert.deepEqual(battle.finish(),done);assert.deepEqual(world.snapshot(),saved);
  assert.deepEqual(await decodeSave(await encodeSave(saved),['M17010','M70010']),saved);
});
test('A fallen selected member cancels its command and leaves the surviving member playable',async()=>{
  const {battle}=fixture({playerHp:[1,120],enemyFirst:true,damage:5});
  await commandReady(battle,'002');
  assert.equal(battle.actor('001').hp.current,0);assert.equal(battle.snapshot().phase,'command');
  assert.equal(battle.snapshot().player_id,'002');assert.equal(battle.actor('001').mp.current,20);
  assert.throws(()=>battle.selectPlayer('001'),/倒下/);assert.equal(battle.canChoose('two'),true);
});
test('A pre-existing fallen member is retained and cannot command; all-fallen roster rejects start',()=>{
  const {battle}=fixture({playerHp:[0,120]});assert.equal(battle.snapshot().player_id,'002');
  assert.throws(()=>fixture({playerHp:[0,0]}),/没有可行动/);
  assert.throws(()=>battle.selectPlayer('missing'));
});
test('Defeat requires both party members to fall and commits both resources',async()=>{
  const {battle,world}=fixture({playerHp:[1,1],enemyFirst:true,damage:5});
  await pumpUntil(battle,()=>battle.state.phase==='defeat');
  assert.equal(battle.snapshot().phase,'defeat');
  const done=battle.finish();assert.equal(done.outcome,'defeat');assert.equal(done.rewards_applied,false);
  assert.deepEqual(world.value.party.map(a=>a.hp.current),[0,0]);
});
test('The party scheduler never lends a selected actor command to another charged member',()=>{
  const {battle}=fixture(),s=battle.state.scheduler;
  s.pending={actor_id:'002',skill_id:'two',target_id:'012'};
  battle.actor('001').charge.gauge=s.threshold*2;
  battle.actor('002').charge.gauge=s.threshold;
  assert.equal(selectReady(battle.state.actors,s).actor_id,'002');
});
test('Native silence bit1 blocks type2 commands before charge, cost or world mutation, while type1 remains available',async()=>{
  const {battle,world,calls}=fixture();await commandReady(battle);const player=battle.actor('001'),skill=clone(battle.skills.one),raw=Buffer.from(skill.fixed_raw_hex,'hex');
  raw[0x32]=(raw[0x32]&0xf0)|2;skill.fixed_raw_hex=raw.toString('hex');skill.id='spell';battle.skills.spell=skill;
  player.status_flags_raw=2;const before=battle.snapshot(),saved=world.snapshot();
  assert.equal(battle.canChoose('spell'),false);assert.equal(battle.canChoose('one'),true);
  await assert.rejects(battle.choose('spell'),/沉默/);assert.deepEqual(battle.snapshot(),before);assert.deepEqual(world.snapshot(),saved);assert.equal(calls.length,0);
  player.status_flags_raw=0;assert.equal(battle.canChoose('spell'),true);
});

test('Two full party gauges can switch command ownership without spending charge; a partial gauge cannot',async()=>{
  const {battle,calls}=fixture();await commandReady(battle,'001');
  const s=battle.state.scheduler,a=battle.actor('001'),b=battle.actor('002');
  b.charge.gauge=s.threshold-1;
  assert.throws(()=>battle.selectPlayer('002'),/尚未充满/);
  b.charge.gauge=s.threshold;const gauges=[a.charge.gauge,b.charge.gauge];
  assert.deepEqual(battle.readyPlayerIds(),['001','002']);
  battle.selectPlayer('002');assert.equal(battle.canChoose('two'),true);assert.equal(battle.canChoose('one'),false);
  battle.selectPlayer('001');assert.deepEqual([a.charge.gauge,b.charge.gauge],gauges);assert.equal(calls.length,0);
  battle.selectPlayer('002');await battle.choose('two');assert.equal(battle.actor('001').charge.gauge,gauges[0]);
  assert.deepEqual(calls.map(c=>c.attacker.id),['002']);assert.equal(battle.canChoose('two'),false);
});

test('Ready enemies act without input, while an active action keeps charging and prevents another dispatch',async()=>{
  const {battle,calls}=fixture({enemyFirst:true});let release;
  battle.playAction=async(_,{onImpact})=>{await new Promise(r=>release=r);onImpact();};
  const enemy=battle.actor('012'),s=battle.state.scheduler;enemy.charge.gauge=s.threshold;battle.actor('002').charge.gauge=s.threshold;
  await battle.waitTick();battle.advanceClock();assert.equal(calls.length,1);assert.equal(battle.state.phase,'action');
  assert.ok(battle.presentationSnapshot().ready_player_ids.includes('002'));assert.equal(battle.presentationSnapshot().command_available,true);assert.equal(battle.presentationSnapshot().input_busy,false);assert.equal(battle.presentationSnapshot().action_busy,true);
  const before=battle.actor('001').charge.gauge;
  for(let n=0;n<5;n++){await battle.waitTick();battle.advanceClock();}
  assert.ok(battle.actor('001').charge.gauge>before);assert.equal(calls.length,1);assert.equal(battle.canCommand(),true);
  const task=battle.actionTask;release();await task;assert.equal(battle.running,false);
});

async function slowEnemyFixture(){
  const f=fixture({enemyFirst:true});let release;
  f.battle.playAction=async(event,{onImpact})=>{if(event.actor_id==='012')await new Promise(r=>release=r);onImpact();};
  for(const actor of f.battle.state.actors)actor.charge.gauge=f.battle.state.scheduler.threshold;
  await f.battle.waitTick();f.battle.advanceClock();
  return {...f,enemyTask:f.battle.actionTask,release:()=>release()};
}

test('A slow enemy action leaves ready-party selection usable and confirmation queues without spending MP or starting another action',async()=>{
  const {battle,world,calls,enemyTask,release}=await slowEnemyFixture(),saved=world.snapshot();
  const gauges=battle.players().map(a=>a.charge.gauge);
  battle.selectPlayer('002');battle.setCommandStage('target');battle.selectPlayer('001');battle.selectPlayer('002');
  assert.deepEqual(battle.players().map(a=>a.charge.gauge),gauges);assert.equal(battle.canChoose('two'),true);
  const queued=await battle.choose('two');assert.equal(queued.scheduler.pending.actor_id,'002');assert.equal(queued.phase,'action');
  assert.equal(battle.actor('002').mp.current,30);assert.deepEqual(calls.map(c=>c.attacker.id),['012']);
  assert.equal(battle.state.scheduler.active_actor_id,'012');assert.equal(battle.canCommand('001'),false);
  assert.throws(()=>battle.selectPlayer('001'));await assert.rejects(battle.choose('two'));assert.throws(()=>battle.finish());
  release();await enemyTask;
  assert.equal(battle.running,false);assert.equal(battle.actor('002').mp.current,30);assert.equal(battle.state.scheduler.pending.actor_id,'002');assert.equal(calls.length,1);
  await battle.waitTick();battle.advanceClock();if(battle.actionTask)await battle.actionTask;
  assert.equal(battle.actor('002').mp.current,23);assert.deepEqual(calls.map(c=>c.attacker.id),['012','002']);assert.equal(battle.state.scheduler.pending,null);
  assert.deepEqual(world.snapshot(),saved);
});

test('Another ready actor may queue during a player animation, and completion preserves the next actor command',async()=>{
  const {battle,calls}=fixture();let release;
  battle.playAction=async(event,{onImpact})=>{if(event.actor_id==='001')await new Promise(r=>release=r);onImpact();};
  for(const actor of battle.players())actor.charge.gauge=battle.state.scheduler.threshold;
  await battle.waitTick();battle.advanceClock();const first=battle.choose('one');
  assert.equal(battle.state.scheduler.active_actor_id,'001');assert.equal(battle.state.scheduler.pending,null);
  assert.equal(battle.canCommand('001'),false);assert.equal(battle.canCommand('002'),true);assert.throws(()=>battle.selectPlayer('001'));
  battle.selectPlayer('002');await battle.choose('two');assert.equal(battle.actor('002').mp.current,30);assert.deepEqual(calls.map(c=>c.attacker.id),['001']);
  release();await first;assert.equal(battle.state.scheduler.pending.actor_id,'002');assert.throws(()=>battle.finish());
  await battle.waitTick();battle.advanceClock();if(battle.actionTask)await battle.actionTask;
  assert.deepEqual(calls.map(c=>c.attacker.id),['001','002']);assert.equal(battle.actor('002').mp.current,23);
});

async function queuedAttackOnDyingTarget(enemyCount){
  const f=fixture({enemyCount}),original=f.battle.resolveAction;let release;
  f.battle.resolveAction=input=>({...original(input),damage:input.attacker.id==='001'?1000:1});
  f.battle.playAction=async(event,{onImpact})=>{if(event.actor_id==='001')await new Promise(r=>release=r);onImpact();};
  for(const actor of f.battle.players())actor.charge.gauge=f.battle.state.scheduler.threshold;
  await f.battle.waitTick();f.battle.advanceClock();const first=f.battle.choose('one','012');
  f.battle.selectPlayer('002');await f.battle.choose('two','012');
  return {...f,first,release:()=>release()};
}

test('A queued attack whose target dies in the preceding animation uses the native random target selector',async()=>{
  const {battle,calls,logs,first,release}=await queuedAttackOnDyingTarget(3);
  assert.equal(battle.actor('002').mp.current,30);release();await first;assert.equal(battle.actor('012').state_raw,4);
  assert.equal(battle.state.scheduler.pending.target_id,'012');battle.rng=()=>1;
  await battle.waitTick();battle.advanceClock();if(battle.actionTask)await battle.actionTask;
  assert.notEqual(battle.state.phase,'interrupted');assert.equal(battle.actor('002').mp.current,23);
  assert.deepEqual(calls.map(c=>[c.attacker.id,c.target.id]),[['001','012'],['002','enemy-2']]);
  const retarget=logs.find(e=>e.type==='battle-command-retargeted');assert.equal(retarget.from_target_id,'012');assert.equal(retarget.target_id,'enemy-2');
  assert.deepEqual(retarget.selection.candidates.map(c=>c.id),['enemy-1','enemy-2']);assert.equal(retarget.selection.trace[0].raw,1);
});

test('If the preceding animation kills the final enemy, a queued teammate spends no MP, gauge, or action',async()=>{
  const {battle,calls,first,release}=await queuedAttackOnDyingTarget(1),b=battle.actor('002'),before=structuredClone({mp:b.mp,charge:b.charge});
  release();await first;assert.equal(battle.state.phase,'victory');assert.equal(battle.state.scheduler.pending,null);
  assert.deepEqual(b.mp,before.mp);assert.deepEqual(b.charge,before.charge);assert.deepEqual(calls.map(c=>c.attacker.id),['001']);assert.equal(battle.state.action_count,1);
  assert.equal(battle.advanceClock(999999),false);
});

test('An invalid queued enemy target with no native eligible replacement cancels without spending resources',async()=>{
  const {battle,calls,logs,first,release}=await queuedAttackOnDyingTarget(2),b=battle.actor('002');
  release();await first;battle.actor('enemy-1').immune_raw=1;const before=structuredClone({mp:b.mp,charge:b.charge});
  // One frame charges the surviving actors but does not dispatch the cancelled
  // command or apply preparation debt / a threshold subtraction to its owner.
  await battle.waitTick();battle.advanceClock();if(battle.actionTask)await battle.actionTask;
  assert.notEqual(battle.state.phase,'interrupted');assert.equal(battle.state.scheduler.pending,null);assert.deepEqual(b.mp,before.mp);
  assert.equal(b.charge.delay,before.charge.delay);assert.ok(b.charge.gauge>=before.charge.gauge);assert.equal(calls.length,1);
  const cancelled=logs.find(e=>e.type==='battle-command-cancelled');assert.equal(cancelled.reason,'no-native-target');assert.equal(cancelled.selection.candidates.length,0);
});

test('A queued medicine target that falls or leaves during another action cancels without consuming the item',async()=>{
  const itemData=await read('items.json');
  for(const reason of ['fallen','escaped']){
    const {battle,world,logs}=fixture({enemyFirst:true,damage:reason==='fallen'?1000:0,itemData});let release;
    for(const a of battle.players()){Object.assign(a,{raw_hp:a.hp.current,raw_mp:a.mp.current,raw_hp_maximum:a.hp.maximum,raw_mp_maximum:a.mp.maximum,resource_bonuses:{hp_current:0,mp_current:0}});a.charge.gauge=battle.state.scheduler.threshold;}
    battle.playAction=async(_,{onImpact})=>{await new Promise(r=>release=r);onImpact();};
    battle.playItem=async()=>assert.fail('Cancelled medicine must not be presented');battle.actor('012').charge.gauge=battle.state.scheduler.threshold;
    await battle.waitTick();battle.advanceClock();const enemyTask=battle.actionTask;
    const tea=battle.items().find(i=>i.id===12),before=structuredClone({inventory:battle.state.inventory,mp:battle.actor('002').mp,charge:battle.actor('002').charge}),saved=world.snapshot();
    battle.selectPlayer('002');await battle.chooseItem(tea.instance_id,'001');assert.ok(battle.state.scheduler.pending);
    if(reason==='escaped')battle.actor('001').state_raw=11;
    release();await enemyTask;
    assert.equal(battle.state.scheduler.pending,null);assert.notEqual(battle.state.phase,'interrupted');assert.deepEqual(battle.state.inventory,before.inventory);
    assert.deepEqual(battle.actor('002').mp,before.mp);assert.deepEqual(battle.actor('002').charge,before.charge);assert.deepEqual(world.snapshot(),saved);
    assert.equal(battle.state.history.filter(h=>h.item_id).length,0);assert.equal(logs.find(e=>e.type==='battle-command-cancelled').reason,'item-target-unavailable');
  }
});

test('Defend and escape confirmed during an enemy animation apply only at the next dispatch boundary',async()=>{
  for(const kind of ['defend','escape']){
    const {battle,calls,enemyTask,release}=await slowEnemyFixture();battle.rng=()=>99;battle.selectPlayer('002');
    const a=battle.actor('002'),before=structuredClone(a),actions=battle.state.action_count;
    await (kind==='defend'?battle.chooseDefend():battle.chooseEscape());
    assert.equal(battle.state.scheduler.pending.command_kind,kind);assert.deepEqual(a,before);assert.equal(battle.state.action_count,actions);
    release();await enemyTask;assert.equal(a.state_raw,before.state_raw);assert.equal(a.defense_half_raw,before.defense_half_raw);assert.equal(calls.length,1);
    await battle.waitTick();battle.advanceClock();if(battle.actionTask)await battle.actionTask;
    assert.equal(battle.state.history.at(-1).command_kind,kind);assert.equal(a.mp.current,before.mp.current);
    if(kind==='defend')assert.equal(a.defense_half_raw,1);else assert.equal(a.state_raw,11);
    assert.equal(calls.length,1);assert.equal(battle.state.scheduler.pending,null);
  }
});

test('Frame-driven enemy presentation errors publish one interrupted state without awaiting a command',async()=>{
  const {battle}=fixture({enemyFirst:true});const phases=[];battle.notify=s=>phases.push(s.phase);
  battle.playAction=async()=>{throw new Error('automatic playback failure');};
  battle.actor('012').charge.gauge=battle.state.scheduler.threshold;
  await battle.waitTick();assert.equal(battle.advanceClock(),true);await battle.actionTask.catch(()=>{});
  assert.equal(battle.state.phase,'interrupted');assert.equal(battle.state.error,'automatic playback failure');assert.equal(battle.running,false);
  assert.equal(phases.filter(p=>p==='interrupted').length,1);assert.equal(battle.advanceClock(99999),false);
});

test('Defend commits one full-gauge command and expires on the next ready scan without spending MP or inventing contact',async()=>{
  const {battle,world,calls}=fixture(),saved=world.snapshot();await assert.rejects(battle.chooseDefend());
  await commandReady(battle,'001');const a=battle.actor('001'),s=battle.state.scheduler;
  a.charge.gauge=s.threshold+17;const mp=a.mp.current;
  await battle.chooseDefend();assert.equal(a.charge.gauge,17);assert.equal(a.charge.delay,0);assert.equal(a.defense_half_raw,1);
  assert.equal(a.mp.current,mp);assert.equal(battle.state.action_count,1);assert.equal(battle.state.history[0].command_kind,'defend');assert.equal(battle.state.history[0].impact,false);
  assert.equal(calls.length,0);assert.deepEqual(world.snapshot(),saved);
  a.charge.gauge=s.threshold-1;await battle.waitTick();battle.advanceClock();if(battle.actionTask)await battle.actionTask;
  assert.equal(a.defense_half_raw,0);assert.equal(battle.canCommand('001'),true);assert.equal(battle.state.action_count,1);
});

test('Successful escape removes only the selected actor; remaining targets fight until the party leaves and commits once',async()=>{
  const {battle,world,calls}=fixture(),saved=world.snapshot();await commandReady(battle,'001');battle.rng=()=>99;
  await battle.chooseEscape();assert.equal(battle.actor('001').state_raw,11);assert.equal(battle.actor('001').charge.gauge,0);
  assert.notEqual(battle.state.phase,'escaped');assert.equal(battle.state.player_id,'002');assert.equal(battle.canCommand('001'),false);
  assert.deepEqual(battle.readyPlayerIds(),['002']);assert.deepEqual(world.snapshot(),saved);
  battle.actor('012').charge.gauge=battle.state.scheduler.threshold;
  await battle.waitTick();battle.advanceClock();if(battle.actionTask)await battle.actionTask;
  assert.equal(calls.at(-1).target.id,'002');assert.equal(battle.actor('001').charge.gauge,0);
  battle.selectPlayer('002');await battle.chooseEscape();assert.equal(battle.state.phase,'escaped');assert.equal(battle.state.outcome,'escaped');
  assert.ok(battle.presentationSnapshot().actors.filter(a=>a.side==='player').every(a=>a.escaped));
  assert.equal(battle.state.history.filter(h=>h.command_kind==='escape').length,2);assert.equal(battle.advanceClock(999999),false);
  const result=battle.finish(),once=world.snapshot();assert.equal(result.outcome,'escaped');assert.equal(result.rewards_applied,false);
  assert.equal(world.value.reward_records?.length??0,0);assert.deepEqual(battle.finish(),result);assert.deepEqual(world.snapshot(),once);
});

test('Failed escape spends the selected gauge without changing HP, MP, targets, or another ready player',async()=>{
  const {battle,world}=fixture();await commandReady(battle,'001');battle.rng=()=>0;
  const a=battle.actor('001'),b=battle.actor('002'),before=structuredClone({hp:a.hp,mp:a.mp,b:b.charge}),saved=world.snapshot();
  await battle.chooseEscape();assert.equal(a.state_raw,0);assert.equal(a.charge.gauge,0);assert.equal(a.charge.delay,0);
  assert.deepEqual(a.hp,before.hp);assert.deepEqual(a.mp,before.mp);assert.deepEqual(b.charge,before.b);assert.deepEqual(world.snapshot(),saved);
  const entry=battle.presentationSnapshot().history.at(-1);assert.equal(entry.command_kind,'escape');assert.equal(entry.result.success,false);assert.equal(entry.impact,false);
  assert.equal(battle.state.player_id,'002');assert.equal(battle.canCommand('002'),true);
});
