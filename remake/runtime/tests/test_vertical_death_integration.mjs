// Integrate real source ID5 records, native damage/status/reaction rules and
// controller death gates. Contact delivery and reward-planner observation are
// explicit harness boundaries; no production source value is changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BattleController} from '../web/core/combat.mjs';
import {BattleView,mergeNativeActionAtlases} from '../web/battle_view.mjs';
import {BattleLifecyclePlayback} from '../web/battle_lifecycle_view.mjs';
import {initializeScheduler} from '../web/core/battle_scheduler.mjs';
import {initializeNativeStatuses,applyNativeSkillStatus} from '../web/core/battle_status.mjs';
import {applyContactReaction} from '../web/core/battle_reactions.mjs';
import {applyNativeDamage,resolveAction,createNativeRng} from '../web/core/combat_rules.mjs';
import {directSequence,compileNativeSequence} from '../web/core/skill_sequence.mjs';

const copy=structuredClone,read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name+'.json',import.meta.url)));
const [party,forest,skills,reactions,schedulerSource,status,metadata,lifecycle]=await Promise.all([
  'party_combat','forest_combat','party_skills','party_reactions','battle_scheduler','forest_status','party_battle_view','battle_lifecycle'].map(read));
const context={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},save(){},restore(){},drawImage(){},fillText(){},createLinearGradient:()=>({addColorStop(){}})};
function fixture({player='001',enemy='032',victim=player,seed=173}={}){
  let clock=0,rewardPlans=0,current=true;const logs=[],draws=[],nativeRng=createNativeRng(seed),scheduler=copy(schedulerSource);
  Object.assign(scheduler.idle_skills,skills.idle_skills);
  const actors=[{...copy(party.actors[player]),id:player,resource_id:player},{...copy(forest.actors[enemy]),id:enemy,resource_id:enemy}];
  const scheduling=initializeScheduler(actors,scheduler,0,0);
  for(const actor of actors){
    Object.assign(actor,initializeNativeStatuses(actor,status));
    Object.assign(actor,{life_epoch:0,native_x_raw:140,native_y_raw:200,native_home_x_raw:140,native_home_y_raw:200});
  }
  const target=actors.find(actor=>actor.id===victim),other=actors.find(actor=>actor.id!==victim),core=Object.create(BattleController.prototype);
  Object.assign(core,{state:{id:'vertical-death',phase:'action',round:1,action_count:0,actors,player_id:player,enemy_id:enemy,source:{},history:[],outcome:null,lifecycle_events:[],scheduler:scheduling},
    schedulerData:scheduler,reactionData:reactions,statusData:status,lifecycleEnabled:true,lifecycleSequence:0,verticalClocks:new Map(),pendingSourceEnds:new Set(),pendingCarriers:new Set(),
    chargeClock:0,running:false,testMode:false,lockedOutcome:null,rewardData:{},rewardPlan:null,
    rng:()=>{const value=nativeRng();draws.push(value);return value;},now:()=>clock,checkWorld(){},publish(){},scheduleReady(){return null;},
    resolveAction,applyDamage:applyNativeDamage,consumeResources:(actor,cost)=>({...actor,mp:{...actor.mp,current:actor.mp.current-cost}}),
    log:event=>logs.push({...copy(event),at:clock,z:target.native_z_raw}),
    prepareRewards(){if(!this.rewardPlan){rewardPlans++;this.rewardPlan={};}return this.rewardPlan;}});
  const meta=copy(metadata);for(const row of lifecycle.roles){const role=meta.roles.find(role=>role.id===row.id);if(role)mergeNativeActionAtlases(role,row,meta.source_hashes);}
  const view=new BattleView({canvas:{width:960,height:540,getContext:()=>context}});
  Object.assign(view,{ready:true,meta,layers:{role_id:player,frames:[]},nativeControl:core,nativeControlIsCurrent:()=>current,lifecyclePairs:new Map(),lifecycleBounds:new Map(),
    roster:actors.map(actor=>({id:actor.id,resource_id:actor.resource_id,side:actor.side}))});
  view.lifecycle=new BattleLifecyclePlayback(lifecycle,{nativeBridge:id=>view._nativeBridge(id)});
  const heldDeaths=[];
  const frame=(at,{holdDeath=false}={})=>{
    clock=at;core.advanceClock(at);view.draw(core.presentationSnapshot(),at);
    for(const completed of view.drainLifecycleCompleted()){
      const event=core.state.lifecycle_events.find(event=>event.token===completed.token);
      if(holdDeath&&event?.kind==='death')heldDeaths.push(completed);else core.ackLifecycle(completed);
    }
    assert.notEqual(core.state.phase,'interrupted',core.state.error);
  };
  const response=descriptor=>{
    core.state.lifecycle_events=core.state.lifecycle_events.filter(event=>event.actor_id!==target.id);
    core.queueLifecycle(target,{...descriptor,kind:'response'});
  };
  const launch=()=>{
    const selected=reactions.roles[victim].skills.find(skill=>skill.original_id_raw===5);
    assert.ok(selected);Object.assign(target,{current_skill:copy(selected),native_active:true,current_target_id:other.id});
    response({skill:selected,source_skill_index:selected.original_skill_index});frame(clock);
  };
  return {core,view,target,other,logs,draws,frame,launch,response,heldDeaths,get clock(){return clock;},get rewardPlans(){return rewardPlans;},
    invalidate(){current=false;},get rngState(){return nativeRng.state;}};
}
function hp(actor,value){
  actor.raw_hp=value;actor.raw_by_address['0x0524a701']=value;actor.hp.current=value+(actor.resource_bonuses?.hp_current??0);actor.effective_hp_raw=actor.hp.current;
}
function deathEvents(f){return f.logs.filter(event=>event.type==='battle-death-finalized');}
function finishDeathPresentation(f,outcome){
  for(let n=0;n<2000&&!f.heldDeaths.length;n++)f.frame(f.clock+20,{holdDeath:true});
  assert.equal(f.heldDeaths.length,1);assert.equal(deathEvents(f).length,1);assert.equal(deathEvents(f)[0].z,0);
  assert.equal(f.core.lockedOutcome,null);assert.equal(f.core.state.outcome,null);assert.equal(f.rewardPlans,0);
  const before=copy({hp:f.target.hp,raw_hp:f.target.raw_hp,mp:f.target.mp}),draws=f.draws.length;
  assert.equal(f.core.ackLifecycle(f.heldDeaths[0]),true);assert.equal(f.core.state.phase,outcome);
  const after=f.draws.length;assert.equal(after,draws);assert.equal(f.core.ackLifecycle(f.heldDeaths[0]),false);
  f.core.refreshCommandState();assert.deepEqual({hp:f.target.hp,raw_hp:f.target.raw_hp,mp:f.target.mp},before);assert.equal(f.draws.length,after);
  assert.equal(f.rewardPlans,outcome==='victory'?1:0);assert.equal(deathEvents(f).length,1);
  assert.equal(f.core.nextNativeVerticalAt(),Infinity);
}

test('actual staff final contact KOs an airborne ID5 enemy once, waits for grounded death and only then unlocks victory rewards',async()=>{
  const f=fixture({player:'004',enemy:'011',victim:'011'});hp(f.target,1);f.launch();f.frame(20);f.frame(40);
  assert.ok(f.target.native_z_raw<0);const selected=skills.skills['004_18'],plan=directSequence(selected),compiled=compileNativeSequence(f.view.meta,'004',plan);
  const contact=compiled.steps.find(step=>step.event);assert.ok(contact);assert.equal(Buffer.from(contact.source.raw_hex,'hex')[0x62],5);
  let release;
  f.core.playSequence=async(_event,hooks)=>{
    const response=hooks.onContact({...copy(contact),contact_key:'source-final-contact',presentation_time_ms:f.clock});
    assert.equal(response.remainingHp,0);assert.ok(response.damage>0);assert.equal(response.reaction_descriptor.skill.original_id_raw,5);
    const after=copy(f.target),state=f.rngState,count=f.draws.length;
    assert.deepEqual(hooks.onContact({...copy(contact),contact_key:'source-final-contact',presentation_time_ms:f.clock}),response);
    assert.deepEqual(f.target,after);assert.equal(f.rngState,state);assert.equal(f.draws.length,count);
    f.response(response.reaction_descriptor);await new Promise(resolve=>release=resolve);hooks.onPrimaryEnd(f.clock);return {completed:true};
  };
  f.core.running=true;const action=f.core.performSequence(f.other,f.target,selected,plan);
  assert.equal(f.target.hp.current,0);assert.equal(f.target.state_raw,4);assert.equal(f.core.canFinalizeDeath(f.target),false);
  assert.equal(deathEvents(f).length,0);assert.equal(f.rewardPlans,0);
  release();await action;f.core.running=false;f.core.refreshCommandState();
  assert.equal(f.core.state.pending_outcome,'victory');assert.equal(f.core.state.outcome,null);assert.equal(f.rewardPlans,0);
  finishDeathPresentation(f,'victory');
});

test('actual wolf-flame periodic HP exhaustion during ID5 flight waits for ground, clears once and does not repeat a pulse on the same clock',()=>{
  for(const player of ['002','001']){
  const f=fixture({player});hp(f.target,100);
  const applied=applyNativeSkillStatus({actor:f.target,skill:status.skills['032:8'],data:status,rng:f.core.rng,now:0});assert.equal(applied.applied,true);
  Object.assign(f.target,applied.actor);
  // An already charged native status slot is a saved clock boundary, not an
  // altered effect: gauge/timestamp are the original mutable tick fields.
  const slot=f.target.native_status_slots.find(slot=>Buffer.from(slot.raw_hex,'hex')[1]===15),raw=Buffer.from(slot.raw_hex,'hex');
  raw.writeInt32LE(f.core.state.scheduler.threshold,0x1b);slot.raw_hex=raw.toString('hex');
  f.launch();for(const at of [20,40,60,80])f.frame(at,{holdDeath:true});
  assert.equal(f.target.hp.current,f.target.resource_bonuses.hp_current);assert.equal(f.target.raw_hp,0);assert.equal(f.target.state_raw,4);assert.ok(f.target.native_z_raw<0);
  assert.deepEqual(f.core.activePlayers().map(actor=>actor.id),[],'equipment HP bonus does not reverse native state4');
  assert.equal(deathEvents(f).length,0);assert.equal(f.core.state.pending_outcome,'defeat');assert.equal(f.rewardPlans,0);
  const actor=copy(f.target),rng=f.rngState,draws=f.draws.length;f.frame(80,{holdDeath:true});
  assert.deepEqual(f.target,actor);assert.equal(f.rngState,rng);assert.equal(f.draws.length,draws);
  finishDeathPresentation(f,'defeat');
  assert.ok(f.target.native_status_slots.every(slot=>Buffer.from(slot.raw_hex,'hex')[1]===0));
  assert.equal(f.target.hp.current,f.target.resource_bonuses.hp_current);assert.equal(f.target.state_raw,7);assert.deepEqual(f.core.activePlayers(),[]);
  }
});

test('repeated real airborne hit responses replace one actor clock, and cancelling then reusing a view isolates its old active clock',()=>{
  const old=fixture({player:'004',enemy:'011',victim:'011'});old.launch();old.frame(20);
  const record=skills.skills['004_18'].actions.find(action=>Buffer.from(action.raw_hex,'hex').readUInt32LE(0x49));
  const heights=[];
  for(let n=0;n<3;n++){
    const before=copy(old.target.hp),response=applyContactReaction({attacker:old.other,target:old.target,result:{damage:1,reaction:0,native_return:0},record,data:reactions,rng:old.core.rng});
    assert.equal(response.skill.original_id_raw,5);Object.assign(old.target,response.after);old.response(response);old.frame(old.clock);old.frame(old.clock+20);
    heights.push(old.target.native_z_raw);assert.equal(old.core.verticalClocks.size,1);assert.deepEqual(old.target.hp,before);
  }
  assert.ok(heights[2]<heights[1]&&heights[1]<heights[0]);
  const staleBridge=old.view._nativeBridge(old.target.id),snapshot=copy(old.target),clock=copy(old.core.verticalClocks.get(old.target.id)),draws=old.draws.length;
  old.view.stop();old.invalidate();
  const fresh=fixture({player:'004',enemy:'011',victim:'011'});
  old.view.nativeControl=fresh.core;old.view.nativeControlIsCurrent=()=>true;
  old.view._advance(10000);assert.throws(()=>staleBridge.advance(10000),{name:'AbortError'});
  assert.deepEqual(old.target,snapshot);assert.deepEqual(old.core.verticalClocks.get(old.target.id),clock);assert.equal(old.draws.length,draws);
  assert.equal(fresh.core.verticalClocks.size,0);assert.equal(fresh.target.native_z_raw,0);assert.equal(fresh.core.nextNativeVerticalAt(),Infinity);
  // Reuse that very view, including its lifecycle object, for a new native ID5.
  fresh.view.lifecycle.nativeBridge=id=>old.view._nativeBridge(id);
  old.view.lifecycle=fresh.view.lifecycle;fresh.launch();
  old.view.draw(fresh.core.presentationSnapshot(),0);old.view._advance(20);
  assert.equal(fresh.target.native_z_raw,-8,'011 uses its own source ascent, not the player height80 curve');assert.equal(fresh.core.verticalClocks.size,1);
  assert.deepEqual(old.target,snapshot);
});
