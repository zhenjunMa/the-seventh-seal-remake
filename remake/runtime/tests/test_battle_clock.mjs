// Frame-rate regressions use runtime data without the historical native oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BattleController} from '../web/core/combat.mjs';
import {WorldStore} from '../web/core/world.mjs';
import {createNativeRng,resolveAction,applyNativeDamage} from '../web/core/combat_rules.mjs';
import {applyNativeSkillStatus} from '../web/core/battle_status.mjs';
import {ActionClock} from '../web/phaser/components/action_clock.mjs';
import {PhaserRuntime} from '../web/phaser/runtime.mjs';

const read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name,import.meta.url),'utf8'));
const [seed,sample,scheduler,status]=await Promise.all(['route_seed.json','combat_sample.json','battle_scheduler.json','forest_status.json'].map(read));
function fixture({origin=0,statusData=null,testMode=true,playAction=async(_,{onImpact})=>onImpact(),clock=null}={}){
  const world=new WorldStore(structuredClone(seed),['M17010','M70010']);
  const battle=new BattleController({world,id:()=> 'battle-clock',now:()=>clock?.time??origin,resolveAction,applyDamage:applyNativeDamage,playAction});
  const actors=structuredClone(sample.actors);
  battle.start({actors,skills:sample.skills,order:actors.map(a=>a.id),enemy_skill_id:'snow_attack',scheduler_data:scheduler,
    status_data:statusData,test_mode:testMode,rng:createNativeRng(1234),source:{authority:'runtime data, controlled frame timestamps'}});
  return {battle,world};
}
const charges=battle=>battle.state.actors.map(a=>structuredClone(a.charge));

test('20ms charging retains fractional time across short, late and repeated frames',()=>{
  const {battle}=fixture();
  for(const [now,ticks]of [[19,0],[21,1],[39,1],[40,2],[99,4],[99,4],[100,5],[1020,51]]){
    const advanced=ticks>battle.state.scheduler.ticks;
    assert.equal(battle.advanceClock(now),advanced,`${now}ms advanced`);
    assert.equal(battle.state.scheduler.ticks,ticks,`${now}ms ticks`);
    assert.equal(battle.state.scheduler.elapsed_ms,ticks*20);
  }
});

test('30/50/60/75/120/144/240 FPS all produce 50 charging ticks per scene second',()=>{
  for(const origin of [0,1234.5]){
    const {battle:reference}=fixture({origin});
    for(let tick=1;tick<=50;tick++)reference.advanceClock(origin+tick*20);
    for(const fps of [30,50,60,75,120,144,240]){
      const {battle}=fixture({origin});
      for(let frame=1;frame<=fps;frame++)battle.advanceClock(origin+frame*1000/fps);
      assert.equal(battle.state.scheduler.ticks,50,`${fps} FPS at origin ${origin}`);
      assert.equal(battle.state.scheduler.elapsed_ms,1000);
      assert.deepEqual(charges(battle),charges(reference));
    }
  }
});

test('irregular frames preserve charge debt, recovery and RNG draws across a long frame',()=>{
  const make=()=>{
    const f=fixture();
    for(const actor of f.battle.state.actors){
      actor.raw_by_address['0x0524a72d']=actor.raw_by_address['0x0524a729']+7;
      Object.assign(actor.charge,{delay:800,recovery:100,recovery_ticks:25});
    }
    return f.battle;
  };
  const reference=make(),irregular=make();
  for(let now=20;now<=1000;now+=20)reference.advanceClock(now);
  for(const now of [7,15,70,71,97,100,164,180,721,999,1000])irregular.advanceClock(now);
  assert.equal(irregular.state.scheduler.ticks,50);
  assert.deepEqual(charges(irregular),charges(reference));
  assert.equal(irregular.rng(),reference.rng());
});

test('status effects receive every fixed step when a frame crosses several 80ms intervals',()=>{
  const make=()=>{
    const {battle}=fixture({statusData:status});
    const actor=battle.actor('001'),applied=applyNativeSkillStatus({actor,skill:status.skills['012:14'],data:status,rng:()=>0,now:0});
    assert.equal(applied.applied,true);Object.assign(actor,applied.actor);return battle;
  };
  const reference=make(),delayed=make();
  for(let now=20;now<=1000;now+=20)reference.advanceClock(now);
  delayed.advanceClock(1000);
  for(let i=0;i<100;i++)assert.equal(delayed.actor('001').native_status_slots[i].raw_hex,reference.actor('001').native_status_slots[i].raw_hex,`status slot ${i}`);
  const block=Buffer.from(delayed.actor('001').native_status_slots[0].raw_hex,'hex');
  assert.equal(block.readInt32LE(0x17),960);
  assert.equal(block.readInt32LE(0x1b),6000);
});

test('scene pause and resume exclude suspended time while retaining the partial battle tick',()=>{
  const clock=new ActionClock();clock.time=1234.5;
  const {battle}=fixture({clock}),scene={clock,skipDelta:false};
  const runtime={started:true,paused:false,adapters:{battle:now=>battle.advanceClock(now)},fail:error=>{throw error;}};
  const frame=delta=>PhaserRuntime.prototype.updateScene.call(runtime,'battle',scene,delta);
  frame(21);assert.equal(battle.state.scheduler.ticks,1);
  runtime.paused=true;clock.paused=true;frame(30000);
  assert.equal(battle.state.scheduler.ticks,1);
  runtime.paused=false;clock.paused=false;scene.skipDelta=true;frame(30000);
  assert.equal(battle.state.scheduler.ticks,1);
  frame(18);assert.equal(battle.state.scheduler.ticks,1);
  frame(1);assert.equal(battle.state.scheduler.ticks,2);
});

test('catchup stops immediately when the battle is interrupted',()=>{
  const {battle}=fixture();
  battle.notify=snapshot=>{if(snapshot.phase!=='interrupted'&&snapshot.scheduler.ticks===2)battle.interrupt(new Error('clock test interruption'));};
  battle.advanceClock(1000);
  assert.equal(battle.state.phase,'interrupted');
  assert.equal(battle.state.scheduler.ticks,2);
  assert.equal(battle.advanceClock(2000),false);
});

test('catchup stops at victory and rejects a changed world before spending any ticks',()=>{
  const {battle}=fixture();battle.actor('012').hp.current=0;battle.actor('012').state_raw=4;
  battle.advanceClock(1000);
  assert.equal(battle.state.phase,'victory');assert.equal(battle.state.scheduler.ticks,1);
  assert.equal(battle.advanceClock(2000),false);
  const changed=fixture();changed.world.transact(world=>world.flags[0]^=1);
  assert.equal(changed.battle.advanceClock(1000),false);
  assert.equal(changed.battle.state.phase,'interrupted');assert.equal(changed.battle.state.scheduler.ticks,0);
});

test('catchup continues charging during an action without dispatching it twice',async()=>{
  let release,calls=0;
  const {battle}=fixture({testMode:false,playAction:async(_,{onImpact})=>{calls++;await new Promise(resolve=>release=resolve);onImpact();}});
  battle.actor('012').charge.gauge=battle.state.scheduler.threshold-1;
  battle.advanceClock(1000);
  assert.equal(calls,1);assert.equal(battle.running,true);
  assert.equal(battle.state.scheduler.ticks,50);
  const task=battle.actionTask;release();await task;
  assert.equal(calls,1);assert.equal(battle.running,false);
});
