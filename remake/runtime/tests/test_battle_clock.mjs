// Frame-rate regressions use runtime data without the historical native oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BattleController} from '../web/core/battle/battle_controller.mjs';
import {WorldStore} from '../web/core/world/world.mjs';
import {createNativeRng,resolveAction,applyNativeDamage} from '../web/core/battle/combat_rules.mjs';
import {applyNativeSkillStatus} from '../web/core/battle/battle_status.mjs';
import {setIdleSkill} from '../web/core/battle/battle_scheduler.mjs';
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

test('20ms charging waits across short frames and discards late-frame excess',()=>{
  const {battle}=fixture();
  for(const [now,ticks]of [[19,0],[21,1],[39,1],[40,1],[99,2],[99,2],[100,2],[1020,3],[1039,3],[1040,4]]){
    const advanced=ticks>battle.state.scheduler.ticks;
    assert.equal(battle.advanceClock(now),advanced,`${now}ms advanced`);
    assert.equal(battle.state.scheduler.ticks,ticks,`${now}ms ticks`);
    assert.equal(battle.state.scheduler.elapsed_ms,now);
  }
});

test('enemy idle changes at one-quarter HP, loops without restarting and recovers after healing',()=>{
  const {battle}=fixture(),enemy=battle.actor('012'),low=scheduler.low_hp_skills['012'];
  enemy.raw_by_address['0x0524a705']=100;enemy.hp.maximum=100;enemy.charge.delay=1000000;
  enemy.hp.current=26;battle.advanceClock(20);assert.equal(enemy.current_skill.id,'012_idle');
  enemy.hp.current=25;battle.advanceClock(40);assert.equal(enemy.current_skill.id,low.id);
  assert.equal(enemy.idle_started_at,40);assert.equal(enemy.idle_pose.action_index,10);
  const duration=low.segments.reduce((n,s)=>n+s.frames.length*s.interval_raw,0);
  battle.advanceClock(40+duration);assert.equal(enemy.idle_started_at,40);assert.equal(enemy.idle_pose.action_index,10);
  enemy.hp.current=1;battle.advanceClock(60+duration);assert.equal(enemy.current_skill.id,low.id);
  enemy.hp.current=26;battle.advanceClock(80+duration);assert.equal(enemy.current_skill.id,'012_idle');
  assert.equal(enemy.idle_started_at,80+duration);
});

test('low-HP idle waits for active actions and does not replace a dead actor pose',()=>{
  const {battle}=fixture(),enemy=battle.actor('012');
  enemy.hp.current=1;enemy.native_active=true;enemy.current_skill=structuredClone(sample.skills.snow_attack);
  const actingId=enemy.current_skill.id;
  battle.advanceClock(20);assert.equal(enemy.current_skill.id,actingId);assert.equal(enemy.idle_pose,undefined);
  enemy.native_active=false;
  // This is the same idle handoff used when an attack or surviving reaction ends.
  setIdleSkill(enemy,battle.schedulerData,40);
  battle.advanceClock(40);assert.equal(enemy.current_skill.id,scheduler.low_hp_skills['012'].id);
  enemy.hp.current=0;enemy.state_raw=4;battle.advanceClock(60);
  assert.equal(enemy.idle_pose,undefined);assert.equal(battle.state.phase,'victory');
});

test('native millisecond frame timestamps preserve the original FPS-dependent charging cadence',()=>{
  for(const origin of [0,1234.5]){
    for(const [fps,ticks] of [[30,30],[50,50],[60,30],[75,37],[120,40],[144,48],[240,48]]){
      const {battle:reference}=fixture({origin});
      for(let tick=1;tick<=ticks;tick++)reference.advanceClock(origin+tick*20);
      const {battle}=fixture({origin});
      for(let frame=1;frame<=fps;frame++)battle.advanceClock(origin+Math.floor(frame*1000/fps));
      assert.equal(battle.state.scheduler.ticks,ticks,`${fps} FPS at origin ${origin}`);
      assert.equal(battle.state.scheduler.elapsed_ms,1000);
      assert.deepEqual(charges(battle),charges(reference));
    }
  }
});

test('irregular frames spend one charge/recovery step per due call and never replay a long frame',()=>{
  const make=()=>{
    const f=fixture();
    for(const actor of f.battle.state.actors){
      actor.raw_by_address['0x0524a72d']=actor.raw_by_address['0x0524a729']+7;
      Object.assign(actor.charge,{delay:800,recovery:100,recovery_ticks:25});
    }
    return f.battle;
  };
  const reference=make(),irregular=make();
  for(let now=20;now<=100;now+=20)reference.advanceClock(now);
  for(const now of [7,15,70,71,97,100,164,180,721,999,1000])irregular.advanceClock(now);
  assert.equal(irregular.state.scheduler.ticks,5);
  assert.deepEqual(charges(irregular),charges(reference));
  assert.equal(irregular.rng(),reference.rng());
});

test('a delayed frame processes an overdue status once using the actual frame time',()=>{
  const make=()=>{
    const {battle}=fixture({statusData:status});
    const actor=battle.actor('001'),applied=applyNativeSkillStatus({actor,skill:status.skills['012:14'],data:status,rng:()=>0,now:0});
    assert.equal(applied.applied,true);Object.assign(actor,applied.actor);return battle;
  };
  const delayed=make();
  delayed.advanceClock(1000);
  const block=Buffer.from(delayed.actor('001').native_status_slots[0].raw_hex,'hex');
  assert.equal(block.readInt32LE(0x17),1000);
  assert.equal(block.readInt32LE(0x1b),500);
  delayed.advanceClock(1079);
  assert.equal(Buffer.from(delayed.actor('001').native_status_slots[0].raw_hex,'hex').readInt32LE(0x1b),500);
  delayed.advanceClock(1080);
  assert.equal(Buffer.from(delayed.actor('001').native_status_slots[0].raw_hex,'hex').readInt32LE(0x1b),1000);
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
  frame(1);assert.equal(battle.state.scheduler.ticks,1);
  frame(1);assert.equal(battle.state.scheduler.ticks,2);
});

test('an interruption prevents subsequent frame steps',()=>{
  const {battle}=fixture();
  battle.notify=snapshot=>{if(snapshot.phase!=='interrupted'&&snapshot.scheduler.ticks===2)battle.interrupt(new Error('clock test interruption'));};
  battle.advanceClock(1000);assert.equal(battle.state.scheduler.ticks,1);
  battle.advanceClock(2000);
  assert.equal(battle.state.phase,'interrupted');
  assert.equal(battle.state.scheduler.ticks,2);
  assert.equal(battle.advanceClock(3000),false);
});

test('a due frame stops at victory and rejects a changed world before spending any ticks',()=>{
  const {battle}=fixture();battle.actor('012').hp.current=0;battle.actor('012').state_raw=4;
  battle.advanceClock(1000);
  assert.equal(battle.state.phase,'victory');assert.equal(battle.state.scheduler.ticks,1);
  assert.equal(battle.advanceClock(2000),false);
  const changed=fixture();changed.world.transact(world=>world.flags[0]^=1);
  assert.equal(changed.battle.advanceClock(1000),false);
  assert.equal(changed.battle.state.phase,'interrupted');assert.equal(changed.battle.state.scheduler.ticks,0);
});

test('late action frames charge once without dispatching the action twice',async()=>{
  let release,calls=0;
  const {battle}=fixture({testMode:false,playAction:async(_,{onImpact})=>{calls++;await new Promise(resolve=>release=resolve);onImpact();}});
  battle.actor('012').charge.gauge=battle.state.scheduler.threshold-1;
  battle.advanceClock(1000);
  assert.equal(calls,1);assert.equal(battle.running,true);
  assert.equal(battle.state.scheduler.ticks,1);
  battle.advanceClock(2000);assert.equal(battle.state.scheduler.ticks,2);assert.equal(calls,1);
  const task=battle.actionTask;release();await task;
  assert.equal(calls,1);assert.equal(battle.running,false);
});
