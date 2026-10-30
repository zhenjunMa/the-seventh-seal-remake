// Lifecycle timing fixtures use actual source entry/death tables and native
// lookup RNG. Damage and animation completion are explicit synthetic adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BattleController} from '../web/core/combat.mjs';
import {initializeNativeEntry} from '../web/core/battle_reactions.mjs';
import {WorldStore} from '../web/core/world.mjs';
import {createForestSample} from '../web/forest_sample.mjs';
import {selectNativeTarget} from '../web/core/forest_ai.mjs';
const read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name,import.meta.url)));
const [seed,base,forest,scheduler,reactions]=await Promise.all(['route_seed.json','combat_sample.json','forest_combat.json','battle_scheduler.json','enemy_reactions.json'].map(read));
const copy=structuredClone;
function fixture({enabled=true,enemies=1,damage=99999,savedKo=false,playAction=async(_,{onImpact})=>onImpact()}={}){
  const world=new WorldStore(copy(seed),['M17010','M70010']),sample=createForestSample(world.snapshot(),base,forest,{map_id:'M70010',members:Array.from({length:enemies},()=>({id:'012'}))},null,scheduler),draws=[],logs=[];let now=0;
  if(savedKo){const actor={...copy(sample.actors[0]),id:'002',resource_id:'001',hp:{current:0,maximum:900},state_raw:0};sample.actors.splice(1,0,actor);sample.order=sample.actors.map(a=>a.id);}
  const battle=new BattleController({world,id:()=> 'lifecycle-fixture',now:()=>now,waitTick:async()=>{now+=20;},log:e=>logs.push(e),
    // This fixture uses the old one-impact adapter, not a native CHR runner.
    // Return the synthetic action's ownership only after its animation ends.
    playAction:async(event,hooks)=>{await playAction(event,hooks);battle.actor(event.actor_id).native_active=false;},
    resolveAction:({skill})=>({hit:true,damage,mp_cost:skill.mp_cost}),
    applyDamage:(actor,result)=>{const hp=Math.max(0,actor.hp.current-result.damage);return {...actor,hp:{...actor.hp,current:hp},state_raw:hp?actor.state_raw:4};}});
  battle.start({...sample,reaction_data:reactions,lifecycle_enabled:enabled,rng:()=>{draws.push(0);return 0;}});
  return {battle,world,draws,logs,async tick(){await battle.waitTick();battle.advanceClock();}};
}
const entries=b=>b.presentationSnapshot().lifecycle_events.filter(e=>e.kind==='entry');
function ackEntries(b){for(const event of entries(b))assert.equal(b.ackLifecycle(event),true);}
async function readyPlayer(f){
  f.battle.actor('001').charge.gauge=f.battle.state.scheduler.threshold;
  for(const a of f.battle.state.actors.filter(a=>a.side==='enemy'))a.charge.delay=1000000;
  await f.tick();
}

test('Native entry id11 lookup preserves source candidate order, one RNG draw and actor input',()=>{
  const f=fixture({enabled:false}),a=f.battle.actor('001'),before=copy(a),draws=[];
  const descriptor=initializeNativeEntry({actor:a,data:reactions,rng:()=>{draws.push(1);return 1;}});
  const choices=reactions.roles['001'].skills.filter(s=>s.original_id_raw===11);
  assert.equal(descriptor.source_skill_index,choices[1%choices.length].original_skill_index);assert.deepEqual(draws,[1]);assert.deepEqual(a,before);
  assert.equal(descriptor.after.state_raw,10);assert.equal(descriptor.after.immune_raw,1);assert.equal(descriptor.after.native_active,true);
});

test('command7 zero mode draws once at execution and renderer completion clears exact source gates',()=>{
  const f=fixture({enabled:false}),actor=f.battle.actor('001'),raw=Buffer.alloc(176);raw[0]=1;raw.writeUInt32LE(7,1);
  const before=f.draws.length;
  for(const [draw,expected]of [[0,1],[1,5],[2,7],[32767,5]]){
    let calls=0;f.battle.rng=()=>{calls++;return draw;};actor.immune_raw=1;
    assert.deepEqual(f.battle.beginNativeAppearance('001',raw.toString('hex')),{mode:expected,clock_raw:60});
    assert.equal(calls,1);assert.equal(actor.immune_raw,1);assert.equal(actor.native_after_raw['0x0521f666'],expected);
    assert.equal(actor.native_after_raw['0x0521f66e'],0);assert.equal(actor.native_after_raw['0x0521a7b1'],60);
    f.battle.completeNativeAppearance('001');assert.equal(actor.immune_raw,0);assert.equal(actor.native_after_raw['0x0521f666'],0);assert.equal(actor.native_after_raw['0x0521a7b1'],0);
  }
  f.battle.rng=()=>assert.fail('fixed appearance must not consume native RNG');
  for(const mode of [1,3,5,6,7]){raw[0x47]=mode;assert.equal(f.battle.beginNativeAppearance('001',raw.toString('hex')).mode,mode);}
  raw[0x47]=4;const actorBefore=copy(actor);assert.throws(()=>f.battle.beginNativeAppearance('001',raw.toString('hex')),/模式尚未接入/);assert.deepEqual(actor,actorBefore);assert.equal(f.draws.length,before);
});

test('Lifecycle remains opt-in; enabled entries draw in roster order and cannot charge before individual completion',async()=>{
  const legacy=fixture({enabled:false});assert.equal(legacy.draws.length,0);assert.deepEqual(legacy.battle.presentationSnapshot().lifecycle_events,[]);
  const f=fixture({enemies:2}),initial=entries(f.battle);assert.deepEqual(initial.map(e=>e.actor_id),f.battle.state.actors.map(a=>a.id));assert.equal(f.draws.length,3);
  await f.tick();assert.ok(f.battle.state.actors.every(a=>a.charge.gauge===0));
  assert.equal(f.battle.ackLifecycle({...initial[0],life_epoch:99}),false);assert.equal(f.battle.ackLifecycle(initial[0]),true);
  const player=f.battle.actor('001');assert.equal(player.state_raw,0);assert.equal(player.immune_raw,0);
  await f.tick();assert.ok(player.charge.gauge>0);assert.ok(f.battle.state.actors.filter(a=>a.side==='enemy').every(a=>a.charge.gauge===0));
  f.battle.actor('enemy-0').charge.gauge=f.battle.state.scheduler.threshold;await f.tick();assert.equal(f.battle.state.history.length,0);
  assert.equal(f.battle.ackLifecycle(initial[0]),false);assert.equal(f.draws.length,3);assert.throws(()=>f.battle.finish());
  assert.ok(JSON.stringify(f.battle.presentationSnapshot().lifecycle_events).length<2000);assert.ok(!JSON.stringify(initial).includes('raw_hex'));
});

test('Death waits for its killer action, draws one descriptor and defers victory/finish until presentation acknowledgement',async()=>{
  let release;const f=fixture({playAction:async(_,{onImpact})=>{onImpact();await new Promise(r=>release=r);}});ackEntries(f.battle);await readyPlayer(f);
  const initialDraws=f.draws.length,action=f.battle.choose('yantu','enemy-0'),victim=f.battle.actor('enemy-0');
  assert.equal(victim.state_raw,4);assert.equal(victim.killer_actor_id,'001');await f.tick();assert.equal(victim.state_raw,4);assert.equal(f.draws.length,initialDraws);
  release();await action;const event=f.battle.presentationSnapshot().lifecycle_events.find(e=>e.kind==='death');
  assert.ok(event);assert.equal(victim.state_raw,5);assert.equal(f.draws.length,initialDraws+1);assert.equal(f.battle.state.pending_outcome,'victory');assert.equal(f.battle.state.outcome,null);
  assert.equal(f.battle.canCommand(),false);assert.throws(()=>f.battle.finish());assert.equal(event.hold_final_frame,false);
  await f.tick();assert.equal(f.draws.length,initialDraws+1);assert.equal(f.battle.ackLifecycle(event),true);assert.equal(f.battle.state.phase,'victory');assert.equal(f.battle.ackLifecycle(event),false);
  assert.equal(f.draws.length,initialDraws+1);assert.equal(f.battle.finish().outcome,'victory');
});

test('An enemy death presentation does not freeze surviving actors or consume its lookup twice',async()=>{
  const f=fixture({enemies:2});ackEntries(f.battle);await readyPlayer(f);await f.battle.choose('yantu','enemy-0');
  assert.ok(f.battle.hasLifecycle('death'));assert.equal(f.battle.state.outcome,null);const draws=f.draws.length;
  Object.assign(f.battle.actor('001').charge,{gauge:f.battle.state.scheduler.threshold,delay:0});await f.tick();assert.equal(f.battle.canCommand('001'),true);assert.equal(f.draws.length,draws);assert.throws(()=>f.battle.finish());
});

test('Player death id12 retains a category7 corpse after its source animation and cannot become an ordinary enemy target',async()=>{
  const f=fixture();ackEntries(f.battle);f.battle.actor('001').charge.delay=1000000;f.battle.actor('enemy-0').charge.gauge=f.battle.state.scheduler.threshold;
  await f.tick();if(f.battle.actionTask)await f.battle.actionTask;
  const event=f.battle.presentationSnapshot().lifecycle_events.find(e=>e.kind==='death'),actor=f.battle.actor('001');
  assert.equal(event.source_id_raw,12);assert.equal(event.hold_final_frame,true);assert.equal(actor.state_raw,5);assert.equal(f.battle.state.pending_outcome,'defeat');
  assert.equal(f.battle.ackLifecycle(event),true);assert.equal(actor.state_raw,7);assert.equal(actor.hp.current,0);assert.equal(f.battle.state.phase,'defeat');
  assert.ok(f.battle.state.actors.includes(actor));assert.deepEqual(f.battle.readyPlayerIds(),[]);
  const target=selectNativeTarget({actors:f.battle.state.actors,actor_id:'enemy-0',target_side_raw:0,rng:()=>assert.fail('A corpse must not enter the native target candidate list')});
  assert.equal(target.target_id,null);assert.deepEqual(target.candidates,[]);
});

test('A saved KO ally gets one original death presentation instead of entry and remains a category7 corpse in the new battle',async()=>{
  const f=fixture({savedKo:true}),actor=f.battle.actor('002'),events=f.battle.presentationSnapshot().lifecycle_events,death=events.find(e=>e.actor_id==='002');
  assert.equal(death.kind,'death');assert.equal(death.source_id_raw,12);assert.equal(death.hold_final_frame,true);assert.equal(actor.state_raw,5);assert.equal(actor.immune_raw,0);assert.equal(f.draws.length,3);
  assert.equal(events.some(e=>e.actor_id==='002'&&e.kind==='entry'),false);assert.equal(f.battle.canCommand('002'),false);
  assert.equal(f.battle.ackLifecycle(death),true);assert.equal(actor.state_raw,7);assert.equal(actor.hp.current,0);ackEntries(f.battle);
  const draws=f.draws.length;await f.tick();assert.equal(actor.charge.gauge,0);assert.equal(f.draws.length,draws);assert.equal(f.battle.state.outcome,null);
});
