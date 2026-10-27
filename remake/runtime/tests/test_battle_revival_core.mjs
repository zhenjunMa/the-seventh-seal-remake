// Core transaction fixtures retain source CHR resources and raw/effective HP.
// Animation boundaries are explicit callbacks; this is not a native play run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BattleController} from '../web/core/combat.mjs';
import {WorldStore} from '../web/core/world.mjs';
import {createForestSample} from '../web/forest_sample.mjs';
import {selectNativeRevivalAnimation} from '../web/core/battle_reactions.mjs';
import {REVIVAL_EVIDENCE} from '../web/core/battle_revival.mjs';
const read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name,import.meta.url)));
const [seed,base,forest,skills,scheduler,reactions,party]=await Promise.all(['route_seed.json','combat_sample.json','forest_combat.json','skills.json','battle_scheduler.json','enemy_reactions.json','party_skills.json'].map(read));
const copy=structuredClone,zero='00'.repeat(0xc6),address=n=>`0x${n.toString(16).padStart(8,'0')}`;
function fixture({playAction=async(_,{onImpact})=>onImpact(),onRevival=null,learned=true}={}){
  const world=new WorldStore(copy(seed),['M17010','M70010']),sample=createForestSample(world.snapshot(),base,forest,{map_id:'M70010',members:[{id:'012'}]},skills,scheduler),dead=copy(sample.actors[0]);
  Object.assign(dead,{id:'002',resource_id:'001',name:'source-backed corpse fixture',state_raw:7,alive:false});
  dead.raw_hp=(-dead.resource_bonuses.hp_current)|0;dead.raw_by_address[address(0x524a701)]=dead.raw_hp;dead.hp.current=0;
  sample.actors.splice(1,0,dead);sample.order=sample.actors.map(a=>a.id);
  const spell={...copy(party.roles['001'].skills[43]),id:'explicitly-learned-revival',actor_id:'001',battle_handler:'native-revival',learned_effective:true,evidence:[REVIVAL_EVIDENCE.status]};
  if(learned)sample.skills[spell.id]=spell;
  for(const actor of sample.actors){
    for(const n of [0x521f551,0x521f555,0x521f559,0x521f55d,0x521f571,0x521f575,0x521f579,0x521f57d])actor.status_by_address[address(n)]??=0;
    actor.native_status_slots=Array.from({length:100},()=>({raw_hex:zero}));
  }
  const draws=[],logs=[],responses=[];let now=0;
  const battle=new BattleController({world,id:()=> 'revival-core-fixture',now:()=>now,waitTick:async()=>{now+=20;},log:event=>logs.push(event),playAction,
    resolveAction:({skill})=>{assert.notEqual(skill.battle_handler,'native-revival','Revival cannot use damage resolution');return {hit:true,damage:0,mp_cost:skill.mp_cost};},
    applyDamage:(actor,result)=>{assert.equal(result.damage,0);return actor;},
    playSequence:async(event,callbacks)=>{
      assert.equal(event.skill_id,spell.id);
      const source=event.plan.records[8],step={source,source_skill_index:43,class_raw:spell.actions[8].class_raw,action_mask_raw:spell.actions[8].action_mask_raw,
        contact_key:event.action_id+':source-effect',effect_contact:true,effect_token:1};
      responses.push(callbacks.onContact(step));responses.push(callbacks.onContact(step));
      if(onRevival)await onRevival({battle,event,callbacks,step});
      callbacks.onPrimaryEnd();
    }});
  battle.start({...sample,reaction_data:reactions,lifecycle_enabled:true,rng:()=>{draws.push(0);return 0;}});
  for(const event of battle.presentationSnapshot().lifecycle_events)battle.ackLifecycle(event);
  battle.actor('enemy-0').charge.delay=1000000;
  battle.actor('001').charge.gauge=battle.state.scheduler.threshold;
  return {battle,spell,draws,logs,responses,world,async tick(){await battle.waitTick();battle.advanceClock();if(battle.actionTask)await battle.actionTask;}};
}

test('An explicitly supplied revival command restores a KO ally at its source contact, without ordinary damage or duplicate lookup',async()=>{
  const f=fixture(),target=f.battle.actor('002'),caster=f.battle.actor('001');
  target.charge={gauge:-91,delay:31,recovery:18,recovery_ticks:9};
  const charge=copy(target.charge),statuses=copy(target.native_status_slots),flags=target.status_flags_raw,mp=caster.mp.current,draws=f.draws.length,saved=f.world.snapshot();
  assert.deepEqual(f.battle.targetIdsForSkill(f.spell.id),['002']);assert.equal(f.battle.canChoose(f.spell.id),true);
  await f.battle.choose(f.spell.id,'002');
  assert.equal(target.state_raw,0);assert.equal(target.alive,true);assert.equal(target.raw_hp,151);assert.equal(target.hp.current,151+target.resource_bonuses.hp_current);
  assert.deepEqual(target.charge,charge);assert.deepEqual(target.native_status_slots,statuses);assert.equal(target.status_flags_raw,flags);assert.equal(caster.mp.current,mp);
  // The contact still draws id14 exactly once. The newly connected source
  // completion separately draws id0 for the caster after the CHR ends.
  assert.deepEqual(f.battle.state.history[0].contacts[0].result.trace.filter(row=>row.kind==='rng').map(row=>row.label),['reaction-id-14']);
  const completion=f.logs.find(event=>event.type==='battle-source-completed'&&event.actor_id==='001');
  assert.deepEqual(completion.descriptor.trace.filter(row=>row.kind==='rng').map(row=>row.label),['reaction-id-0']);
  assert.equal(f.draws.length,draws+2);assert.deepEqual(f.responses[1],f.responses[0]);assert.equal(f.responses[0].revived,true);assert.equal(f.responses[0].hp_delta,target.hp.current);assert.deepEqual(f.world.snapshot(),saved);
  const event=f.battle.presentationSnapshot().lifecycle_events.find(e=>e.kind==='revive');assert.ok(event);assert.equal(event.actor_id,'002');assert.equal(event.source_id_raw,14);assert.equal(event.life_epoch,1);
  assert.equal(f.battle.canCommand('002'),false);assert.equal(f.battle.ackLifecycle(event),true);assert.equal(target.native_active,false);assert.equal(parseInt(target.current_skill.fixed_raw_hex.slice(0,2),16),0);
  assert.equal(f.draws.length,draws+3,'revived source14 completes through its own native id0 lookup');
  assert.equal(f.battle.ackLifecycle(event),false);assert.equal(f.draws.length,draws+3);
});

test('Revival replaces an uncompleted death event and rejects its late acknowledgement without resetting restored HP',async()=>{
  const f=fixture(),target=f.battle.actor('002');target.state_raw=4;target.native_z_raw=0;f.battle.finalizeDeath(target);
  const death=f.battle.presentationSnapshot().lifecycle_events.find(e=>e.kind==='death');assert.ok(death);assert.equal(death.source_id_raw,12);
  await f.battle.choose(f.spell.id,'002');const hp=target.hp.current,events=f.battle.presentationSnapshot().lifecycle_events;
  assert.equal(events.some(e=>e.token===death.token),false);assert.equal(events.find(e=>e.actor_id==='002').kind,'revive');assert.equal(f.battle.ackLifecycle(death),false);assert.equal(target.state_raw,0);assert.equal(target.hp.current,hp);
  assert.equal(f.battle.ackLifecycle(events.find(e=>e.kind==='revive')),true);assert.equal(target.state_raw,0);assert.equal(target.hp.current,hp);
});

test('A queued revival loses an immune or already restored target before dispatch without spending caster resources',async()=>{
  let release;const f=fixture({playAction:async(_,{onImpact})=>{await new Promise(r=>release=r);onImpact();}}),caster=f.battle.actor('001'),enemy=f.battle.actor('enemy-0'),target=f.battle.actor('002');
  enemy.charge.delay=0;enemy.charge.gauge=f.battle.state.scheduler.threshold;await f.battle.waitTick();f.battle.advanceClock();const task=f.battle.actionTask;
  assert.equal(f.battle.running,true);await f.battle.choose(f.spell.id,'002');const charge=copy(caster.charge),mp=caster.mp.current;
  target.immune_raw=1;release();await task;enemy.charge.delay=1000000;const draws=f.draws.length;await f.tick();
  assert.equal(f.battle.state.scheduler.pending,null);assert.equal(caster.mp.current,mp);assert.equal(caster.charge.delay,charge.delay);assert.ok(caster.charge.gauge>=charge.gauge);assert.equal(f.draws.length,draws);
  assert.equal(target.hp.current,0);assert.equal(f.responses.length,0);assert.ok(f.logs.some(e=>e.type==='battle-command-cancelled'&&e.reason==='revival-target-unavailable'));
});

test('Revival admission excludes living, enemy, immune and escaped actors and never adds an unlearned source skill',async()=>{
  const f=fixture(),target=f.battle.actor('002');assert.deepEqual(f.battle.targetIdsForSkill(f.spell.id),['002']);assert.deepEqual(f.battle.targetIdsForSkill('yantu'),['enemy-0']);
  target.immune_raw=1;assert.deepEqual(f.battle.targetIdsForSkill(f.spell.id),[]);assert.equal(f.battle.canChoose(f.spell.id),false);await assert.rejects(f.battle.choose(f.spell.id,'002'));
  target.immune_raw=0;target.state_raw=11;assert.deepEqual(f.battle.targetIdsForSkill(f.spell.id),[]);
  const unlearned=fixture({learned:false});assert.equal(unlearned.battle.skills[unlearned.spell.id],undefined);assert.deepEqual(unlearned.battle.targetIdsForSkill(unlearned.spell.id),[]);await assert.rejects(unlearned.battle.choose(unlearned.spell.id,'002'));
});

test('Type14 selection reuses an already active source14 and otherwise draws exactly once',()=>{
  const f=fixture(),actor=f.battle.actor('002');actor.state_raw=0;actor.current_skill=copy(reactions.roles['001'].skills.find(s=>s.original_id_raw===14));
  const result=selectNativeRevivalAnimation({actor,data:reactions,rng:()=>assert.fail('Current source14 bypasses lookup')});assert.equal(result.source_skill_index,actor.current_skill.original_skill_index);assert.deepEqual(result.trace,[]);
});

test('Core revival preserves type14 lookup before configured recovery RNG and rejects later distinct contacts without another draw',async()=>{
  let later;const f=fixture({onRevival:({callbacks,step})=>{later=callbacks.onContact({...step,contact_key:step.contact_key+':later'});}}),skill=f.battle.skills[f.spell.id],raw=Buffer.from(skill.fixed_raw_hex,'hex');
  raw.writeInt32LE(160,0xaf);skill.fixed_raw_hex=raw.toString('hex');const values=[7,5,11],consumed=[];
  f.battle.rng=()=>{assert.ok(values.length,'Unexpected core revival RNG');const value=values.shift();consumed.push(value);return value;};
  await f.battle.choose(f.spell.id,'002');assert.deepEqual(consumed,[7,5,11]);assert.equal(f.battle.actor('002').raw_hp,156);assert.equal(later.skipped,'revival-target-unavailable');
  assert.deepEqual(f.battle.state.history[0].contacts[0].result.trace.filter(row=>row.kind==='rng').map(row=>row.raw),[7,5]);
  assert.deepEqual(f.logs.find(event=>event.type==='battle-source-completed'&&event.actor_id==='001').descriptor.trace.filter(row=>row.kind==='rng').map(row=>[row.label,row.raw]),[['reaction-id-0',11]]);
  assert.deepEqual(values,[]);
  assert.equal(f.battle.state.history[0].contacts.length,2);assert.equal(f.battle.presentationSnapshot().impact_count,1);
  assert.equal(f.battle.presentationSnapshot().last_impact.actor_id,'001');
});
