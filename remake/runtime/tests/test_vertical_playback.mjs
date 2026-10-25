import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BattleController} from '../web/core/combat.mjs';
import {BattleView} from '../web/battle_view.mjs';
import {BattleLifecyclePlayback} from '../web/battle_lifecycle_view.mjs';
import {directSequence} from '../web/core/skill_sequence.mjs';
const read=async p=>JSON.parse(await readFile(new URL(p,import.meta.url),'utf8')),copy=structuredClone;
const [sources,reactions,metadata,forest,scheduler]=await Promise.all([
 './fixtures/native_vertical_sequences.json','../web/data/party_reactions.json','../web/data/party_battle_view.json','../web/data/party_combat.json','../web/data/battle_scheduler.json'].map(read));
Object.assign(scheduler.idle_skills,(await read('../web/data/party_skills.json')).idle_skills);

test('actual source ID5 nonwait ascent and wait landing share one gameplay Z clock and continue through8/4/6/idle',async()=>{
 for(const id of ['001','002','003','004','005','006']){
  let draws=0,clock=0;const actor={...copy(forest.actors[id]),id,resource_id:id,current_skill:copy(reactions.roles[id].skills[5]),native_active:true,state_raw:0,immune_raw:0,settled_raw:0,reaction_inhibit_raw:0,reaction_special_gate_raw:0,reaction_busy_raw:0,status_flags_raw:0,
   native_z_raw:0,native_x_raw:140,native_y_raw:200,native_home_x_raw:140,native_home_y_raw:200,life_epoch:0,native_sequence_token:'test',
   charge:{gauge:0,delay:0,recovery:0,recovery_ticks:0},current_target_id:'enemy-0'};
  const core=Object.create(BattleController.prototype);
  Object.assign(core,{state:{id:'vertical-test',phase:'action',actors:[actor],lifecycle_events:[],scheduler:{threshold:10000}},schedulerData:scheduler,reactionData:reactions,lifecycleEnabled:true,lifecycleSequence:0,
   verticalClocks:new Map(),rng:()=>{draws++;return 0;},log(){},now:()=>clock,publish(){},refreshCommandState(){}});
  // These source sequences retain their entire original CHR/DGP records.
  const meta=copy(metadata),sourceRole=sources.sprite_roles.find(r=>r.id===id),role=meta.roles.find(r=>r.id===id);
  for(const action of sourceRole.actions)if(!role.actions.some(old=>old.index===action.index))role.actions.push(copy(action));
  const view=new BattleView({canvas:{getContext:()=>({})}});Object.assign(view,{ready:true,meta,layers:{role_id:id,frames:[]},nativeControl:core,nativeControlIsCurrent:()=>true,
    roster:[{id,resource_id:id,side:'player'},{id:'enemy-0',resource_id:'032',side:'enemy'}]});
  const plan=directSequence(actor.current_skill);plan.allow_no_contacts=true;
  let primaryEnd=null;const pending=view.playSequence({actor_id:id,target_id:'enemy-0',skill_id:actor.current_skill.id,plan},{onRecord(){},onContact(){throw Error('ID5 has no damage contact');},
   onPrimaryEnd:at=>{primaryEnd=at;core.completeNativeSource(actor,at);}});
  const z=[];for(clock=0;clock<=2000&&view.run;clock+=20){view._advance(clock);if(clock<=60)z.push(actor.native_z_raw);}
  await pending;assert.deepEqual(z.slice(0,4),id==='006'?[0,-50,-93,-100]:[0,-40,-75,-80],id);assert.equal(actor.native_z_raw,0,id);assert.ok(primaryEnd>=220);
  assert.equal(actor.current_skill.original_id_raw,8);assert.equal(actor.native_active,true);
  const life=new BattleLifecyclePlayback(sources,{nativeBridge:actorId=>view._nativeBridge(actorId)}),seen=[8];
  for(let n=0;n<2000&&core.state.lifecycle_events.length;n++,clock+=20){
   life.advance({id:'vertical-test',actors:[actor],lifecycle_events:core.state.lifecycle_events},view.roster,clock);
   for(const completed of life.drainCompleted()){core.ackLifecycle(completed);seen.push(actor.current_skill.original_id_raw??0);}
  }
  assert.deepEqual(seen,[8,4,6,0],id);assert.equal(actor.native_active,false,id);assert.equal(actor.native_z_raw,0,id);
  assert.equal(core.state.lifecycle_events.length,0,id);assert.equal(draws,4,'8,4,6,0 each retain the native singleton lookup draw');
 }
});

test('an ended source status gate retries on the next native clock and releasing one actor preserves another active owner',()=>{
 let draws=0;const actor={...copy(forest.actors['001']),id:'001',resource_id:'001',current_skill:copy(reactions.roles['001'].skills[5]),native_active:true,state_raw:0,immune_raw:0,
  settled_raw:1,reaction_inhibit_raw:0,reaction_special_gate_raw:1,reaction_busy_raw:0,status_flags_raw:0,native_z_raw:0,life_epoch:0,
  native_x_raw:140,native_y_raw:200,native_home_x_raw:140,native_home_y_raw:200,current_target_id:null,charge:{gauge:0,delay:0,recovery:0,recovery_ticks:0}};
 const core=Object.create(BattleController.prototype);
 Object.assign(core,{state:{id:'retry-test',phase:'action',actors:[actor],lifecycle_events:[],scheduler:{threshold:10000,ticks:0,elapsed_ms:0,active_actor_id:'other'}},
  schedulerData:scheduler,reactionData:reactions,lifecycleEnabled:true,lifecycleSequence:0,pendingSourceEnds:new Set(),verticalClocks:new Map(),chargeClock:0,
  rng:()=>{draws++;return 0;},checkWorld(){},now:()=>20,log(){},publish(){},refreshCommandState(){},scheduleReady(){return null;}});
 const blocked=core.completeNativeSource(actor,0);assert.equal(blocked.reason,'source-end-status-gate');assert.equal(draws,0);assert.equal(core.pendingSourceEnds.has('001'),true);assert.equal(actor.native_active,true);
 actor.reaction_special_gate_raw=0;core.advanceClock(20);assert.equal(actor.current_skill.original_id_raw,8);assert.equal(draws,1);assert.equal(core.pendingSourceEnds.size,0);
 for(const owner of ['other','001']){
  actor.current_skill=copy(reactions.roles['001'].skills[6]);actor.native_active=true;actor.settled_raw=1;
  core.state.scheduler.active_actor_id=owner;core.state.reward_ledger={chain:{target_id:'001',count:2}};
  const ended=core.completeNativeSource(actor,20);assert.equal(ended.kind,'idle');assert.equal(actor.settled_raw,0);assert.equal(actor.native_after_raw['0x0521f69d'],0);
  assert.equal(core.state.scheduler.active_actor_id,owner==='001'?null:'other');
 }
});
