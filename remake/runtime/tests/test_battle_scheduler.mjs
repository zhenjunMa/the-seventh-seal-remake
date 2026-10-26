import {battleActive,commandReady,chooseReady} from './helpers/battle_clock.mjs';
// Real exported actors/skills; retained x86 charge/selection instruction graph.
// Clock, record copies and positive-HP death check are explicit bounded hooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateScheduler,initializeScheduler,chargeActor,isActorReady,selectReady,dispatchCharge} from '../web/core/battle_scheduler.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {createNativeRng,resolveAction,applyNativeDamage} from '../web/core/combat_rules.mjs';
import {consumeBattleMp,resourcesForWorld} from '../web/combat_sample.mjs';
import {createForestSample} from '../web/forest_sample.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
const clone=structuredClone;
const read=async p=>JSON.parse(await readFile(new URL('../web/data/'+p,import.meta.url)));
const [seed,base,forest,config,data]=await Promise.all(['route_seed.json','combat_sample.json','forest_combat.json','skills.json','battle_scheduler.json'].map(read));
const asm=JSON.parse(await readFile(new URL('../evidence/forest_scheduler_instructions_20261011.json',import.meta.url)));
const mapIds=['M01010','M01030','M17010','M70010'];
function sample(ids=['012','013','013'],world=seed){return createForestSample(world,base,forest,{map_id:'M70010',members:ids.map(id=>({id}))},config,data);}
function prepared(ids){const s=sample(ids);const scheduler=initializeScheduler(s.actors,data);scheduler.pending={skill_id:'yanci',target_id:'enemy-0'};return {...s,scheduler};}
function skillFields(skill,fields){const b=Buffer.from(skill.fixed_raw_hex,'hex');for(const [p,v]of Object.entries(fields))b.writeInt32LE(v,Number(p));return {...clone(skill),fixed_raw_hex:b.toString('hex')};}
const signal={};
class SchedulerOracle extends NativeAssemblyOracle {
 external(target){
  if(target===0x5002b0){assert.ok(this.actors[this.read(this.reg.ESP)].hp.current>0);return;} // No state change in fresh, positive-HP slice.
  if(target===0x504b80){this.selected=this.read(this.reg.ESP+4)&255;throw signal;} // Its actor argument is a byte; EAX upper bytes remain stale.
  return super.external(target);
 }
}
function oracle(actors,scheduler,rng){const o=new SchedulerOracle(asm.functions,actors,rng);
 o.write(0x55df74c,actors.length);o.write(0x679c6c,0);o.write(0x679c74,scheduler.threshold);o.write(0x55df75c,scheduler.side_priority);
 actors.forEach((a,i)=>{const n=i*0x30274;o.write(0x521a770+n,1);o.write(0x521a778+n,Number(Boolean(a.native_active)),1);o.write(0x521a7b9+n,a.charge.gauge);o.write(0x521a7bd+n,a.charge.delay);o.write(0x521f69e+n,a.charge.recovery||a.reaction_inhibit_raw);o.write(0x521f6a2+n,a.charge.recovery_ticks);o.write(0x521f52a+n,a.status_flags_raw);o.write(0x521a7c5+n,a.side==='player'&&scheduler.pending?1:0,1);});return o;}
function fixture(ids=['012','013','013'],extra={}){
 const world=new WorldStore(clone(seed),mapIds),s=sample(ids,world.snapshot()),logs=[];let time=0,battle;
 battle=new BattleController({world,id:()=> 'scheduler',now:()=>time,waitTick:async()=>{time+=20;},log:e=>logs.push(e),
  resolveAction,applyDamage:applyNativeDamage,consumeResources:consumeBattleMp,resourcesForWorld,
  playAction:async(r,{onImpact})=>{onImpact();onImpact();for(let i=0;i<125;i++){time+=20;battle.advanceClock();}},...extra});
 battle.start({...s,rng:createNativeRng(0x20261011)});return {world,battle,logs,advance:n=>time+=n};
}
test('scheduler source idles and source hashes match original bytes; threshold uses raw speed',async()=>{
 validateScheduler(data);for(const [id,skill]of Object.entries(data.idle_skills)){
  const b=await readFile(new URL('../../../'+skill.source.path,import.meta.url));assert.equal(createHash('sha256').update(b).digest('hex'),skill.source.sha256,id);
  assert.equal(b.subarray(skill.source.offset,skill.source.offset+1053).toString('hex'),skill.fixed_raw_hex,id);
 }
 const {actors,scheduler}=prepared();assert.deepEqual(actors.map(a=>a.raw_by_address['0x0524a729']),[51,50,55,55]);assert.equal(scheduler.threshold,10400);
 actors[0].linked_by_address['0x04f990a4']=999;assert.equal(initializeScheduler(actors,data).threshold,10400);
 const bad=clone(data);bad.tick_interval_ms=16;assert.throws(()=>validateScheduler(bad));
});
test('charge arithmetic matches native x86 for exact debt/recovery boundaries and negative gauge',()=>{
 for(let i=0;i<80;i++){
  const {actors,scheduler}=prepared(['012']),a=actors[0];a.charge={gauge:i%2?-10400:100,delay:[0,1,50,51,52,100,800,10400][i%8],recovery:[0,1,25,26,50][i%5],recovery_ticks:i%7};
  const o=oracle(clone(actors),scheduler,createNativeRng(i)),rng=createNativeRng(i);chargeActor(a,rng);o.run(0x502f30,[0]);
  assert.deepEqual(a.charge,{gauge:o.read(0x521a7b9),delay:o.read(0x521a7bd),recovery:o.read(0x521f69e),recovery_ticks:o.read(0x521f6a2)},`case${i}`);assert.deepEqual(o.rng_calls,[]);
 }
});
test('ranged speed consumes one draw, exclusive upper bound; zero bound uses80 and equipment is excluded',()=>{
 for(const type of [0,4,7])for(const min of [0,51])for(const n of [0,6,32767]){
  const {actors,scheduler}=prepared(['012']),a=actors[0];a.raw_by_address['0x0524a729']=min;a.raw_by_address['0x0524a72d']=58;
  a.current_skill=skillFields(a.current_skill,{0xe3:min,0xe7:58});const b=Buffer.from(a.current_skill.fixed_raw_hex,'hex');b[0]=type;a.current_skill.fixed_raw_hex=b.toString('hex');a.status_by_address['0x0521f56d']=3;
  const o=oracle(clone(actors),scheduler,()=>n),used=[];chargeActor(a,()=>{used.push(n);return n;});o.run(0x502f30,[0]);
  assert.equal(a.charge.gauge,o.read(0x521a7b9));assert.deepEqual(used,o.rng_calls);assert.equal(a.charge.gauge,min?min+n%7+3:83);
 }
});
test('ready selection and side alternation match original candidate-position access even with gaps',()=>{
 for(let i=0;i<96;i++){
  const {actors,scheduler}=prepared();scheduler.side_priority=i%2;if(i%3===0)scheduler.pending=null;
  actors.forEach((a,j)=>{a.charge.gauge=10400+((i+j)%4)*51;if((i+j)%7===0)a.charge.gauge=10399;if((i+j)%11===0)a.charge.delay=1;if((i+j)%13===0){a.state_raw=4;a.hp.current=0;}if((i+j)%17===0)a.status_flags_raw=0x20;if((i+j)%19===0)a.native_active=true;});
  const o=oracle(clone(actors),clone(scheduler),()=>{throw Error('Selection must not draw');}),ported=selectReady(actors,scheduler);
  try{o.run(0x5036d0,[]);}catch(e){if(e!==signal)throw e;}
  assert.equal(ported.actor_id,o.selected===undefined?null:actors[o.selected].id,`selection ${i}`);assert.equal(scheduler.side_priority,o.read(0x55df75c),`priority ${i}`);
 }
});
test('dispatch resets gauge before threshold subtraction and adds raw preparation debt',()=>{
 const {actors,scheduler,skills}=prepared();const a=actors[0];a.charge.gauge=11000;
 const d=dispatchCharge(a,skills.yanci,scheduler);assert.equal(d.before.gauge,11000);assert.equal(a.charge.gauge,-10400);assert.equal(a.charge.delay,800);
 dispatchCharge(a,skillFields(skills.yanci,{0x2e:0}),scheduler);assert.equal(a.charge.delay,1600);assert.equal(a.charge.gauge,-10400);
});

test('a source response remains ineligible while other actors can act beside a detached carrier',()=>{
 const {actors,scheduler}=prepared(['012']),player=actors[0],enemy=actors[1];
 for(const actor of actors)actor.charge={gauge:scheduler.threshold,delay:0,recovery:0,recovery_ticks:0};
 player.native_active=true;
 assert.equal(isActorReady(player,scheduler),false);
 assert.equal(isActorReady(enemy,scheduler),true);
 assert.equal(selectReady(actors,scheduler).actor_id,enemy.id);
 player.native_active=false;
 assert.equal(isActorReady(player,scheduler),true);
});
test('20ms clock runs before input and in every command layer with elapsed-time catchup',async()=>{
 const g=fixture(['012']);
 assert.equal(g.battle.state.phase,'charging');assert.equal(g.battle.canChoose('yantu'),false);
 const before=g.battle.snapshot();await assert.rejects(g.battle.choose('yantu'));assert.deepEqual(g.battle.snapshot(),before);
 assert.equal(g.battle.advanceClock(19),false);assert.equal(g.battle.advanceClock(20),true);assert.equal(g.battle.advanceClock(20),false);assert.equal(g.battle.advanceClock(1020),true);assert.equal(g.battle.snapshot().scheduler.ticks,51);
 let now=1020;
 for(const stage of ['wheel','skills','items','target']){g.battle.setCommandStage(stage);const ticks=g.battle.state.scheduler.ticks;assert.equal(g.battle.advanceClock(now+=20),true);assert.equal(g.battle.state.scheduler.ticks,ticks+1);}
 assert.equal(g.battle.state.history.length,0);assert.ok(g.battle.actor('001').charge.gauge>0);
});
test('hunters can precede player; charging and post-impact clocks retain gauge across commands',async()=>{
 const {battle,logs,world}=fixture();const before=world.snapshot();await chooseReady(battle,'yanci','enemy-1');
 const scheduled=logs.filter(e=>e.type==='battle-scheduled');assert.deepEqual(scheduled.slice(0,2).map(e=>e.actor_id),['enemy-1','enemy-2']);assert.ok(scheduled.findIndex(e=>e.actor_id==='001')>=2);
 assert.equal(battle.snapshot().phase,'charging');assert.equal(battle.snapshot().history.length,scheduled.length);assert.equal(logs.filter(e=>e.type==='battle-impact').length,scheduled.length);
 assert.equal(battle.snapshot().scheduler.ticks,scheduled.at(-1).ticks+125);assert.deepEqual(world.snapshot(),before);
 const gauges=battle.snapshot().actors.map(a=>a.charge.gauge);assert.ok(gauges.some(n=>n!==0));await chooseReady(battle,'yantu','enemy-0');assert.ok(battle.snapshot().scheduler.ticks>scheduled.at(-1).ticks+125);
});
test('all1-4 source enemies dispatch; dead slots skip; victories commit once and save preserves RNG/resources',async()=>{
 for(let count=1;count<=4;count++){
  const {battle,world}=fixture(Array(count).fill('012'),{resolveAction:({attacker,skill})=>({hit:true,damage:attacker.side==='player'?99999:1,mp_cost:skill.mp_cost,after_settled_raw:1})});
  for(let i=0;i<count;i++)await chooseReady(battle,'yanci',`enemy-${i}`);
  assert.equal(battle.snapshot().phase,'victory');const location=clone(world.location),result=battle.finish(),snapshot=world.snapshot();assert.deepEqual(battle.finish(),result);assert.deepEqual(world.snapshot(),snapshot);assert.deepEqual(world.location,location);
  const loaded=await decodeSave(await encodeSave(snapshot),mapIds);assert.deepEqual(loaded,snapshot);
  const history=battle.snapshot().history;for(let i=0;i<count;i++){const death=history.findIndex(h=>h.target_id===`enemy-${i}`&&h.after?.target.hp.current===0);assert.ok(death>=0);assert.ok(!history.slice(death+1).some(h=>h.actor_id===`enemy-${i}`));}
 }
});
test('queued command is atomic on invalid input and blocked against duplicate commands or exit',async()=>{
 let release;const {battle,world}=fixture(['012'],{playAction:async(_,{onImpact})=>{await new Promise(r=>release=r);onImpact();}});
 battle.actor('enemy-0').charge.delay=1000000;await commandReady(battle);const before=battle.snapshot();
 await assert.rejects(battle.choose('missing'));await assert.rejects(battle.choose('yanci','missing'));assert.deepEqual(battle.snapshot(),before);
 const task=battle.choose('yanci');assert.equal(battle.snapshot().phase,'action');await assert.rejects(battle.choose('yantu'));assert.throws(()=>battle.finish());
 world.transact(w=>w.flags[0]^=1);release();await assert.rejects(task,/世界状态/);assert.equal(battle.snapshot().phase,'interrupted');assert.equal(battle.snapshot().history[0].impact,false);assert.throws(()=>battle.finish(),/世界状态/);
});
test('native numeric flying target gate and death interrupt remain effective with charging',async()=>{
 const {battle}=fixture(['011']);await chooseReady(battle,'yantu');assert.ok(battle.snapshot().history.some(h=>h.actor_id==='001'&&h.result.reason==='action-class-rejected'));
 for(let i=0;i<12&&battleActive(battle);i++)await chooseReady(battle,'yanci');assert.equal(battle.snapshot().phase,'victory');
 const f=fixture(['013'],{resolveAction:({skill})=>({hit:true,damage:99999,mp_cost:skill.mp_cost,after_settled_raw:1})});await chooseReady(f.battle,'yanci');assert.equal(f.battle.snapshot().phase,'defeat');assert.ok(f.battle.snapshot().history.every(h=>h.actor_id!=='001'));assert.equal(f.battle.finish().resources.hp,0xffffffa0);
});
