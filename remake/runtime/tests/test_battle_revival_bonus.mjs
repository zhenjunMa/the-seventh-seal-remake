// Actual learned00440 and source001 linked HP. Contact delivery is a harness
// boundary; command admission/dispatch, recovery, type14 and actor-Z are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BattleController} from '../web/core/combat.mjs';
import {BattleView} from '../web/battle_view.mjs';
import {initializeScheduler} from '../web/core/battle_scheduler.mjs';
import {initializeNativeStatuses} from '../web/core/battle_status.mjs';
import {revivalTargetEligibility} from '../web/core/battle_revival.mjs';
import {consumePartyMp} from '../web/core/party_attributes.mjs';
import {createNativeRng} from '../web/core/combat_rules.mjs';
import {directSequence,compileNativeSequence} from '../web/core/skill_sequence.mjs';

const copy=structuredClone,web=new URL('../web/',import.meta.url),read=async path=>JSON.parse(await readFile(new URL(path.replace(/^\//,''),web)));
const [party,forest,skills,reactions,schedulerSource,status,lifecycle]=await Promise.all([
  'party_combat','forest_combat','party_skills','party_reactions','battle_scheduler','forest_status','battle_lifecycle'].map(name=>read('data/'+name+'.json')));
const original=await readFile(new URL('../../../Fight_Role/004.CHR',import.meta.url)),source=lifecycle.roles.find(role=>role.id==='004').skills.find(skill=>skill.chr_skill_index===40).source_skill;
assert.equal(createHash('sha256').update(original).digest('hex'),source.source.sha256);
assert.equal(original.subarray(source.source.fixed_record_offset,source.source.fixed_record_offset+1053).toString('hex'),source.fixed_raw_hex);
assert.equal(Buffer.from(source.fixed_raw_hex,'hex')[0x23],1,'this source revival is already learned');
const context={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},save(){},restore(){},drawImage(){},fillText(){},createLinearGradient:()=>({addColorStop(){}})};

async function fixture(airborne){
  let clock=0;const logs=[],draws=[],rng=createNativeRng(173),scheduler=copy(schedulerSource);
  Object.assign(scheduler.idle_skills,skills.idle_skills);
  const actors=[copy(party.actors['001']),copy(party.actors['004']),{...copy(forest.actors['032']),id:'032',resource_id:'032'}],scheduling=initializeScheduler(actors,scheduler,0,0);
  for(const actor of actors){Object.assign(actor,initializeNativeStatuses(actor,status));Object.assign(actor,{life_epoch:0,native_x_raw:140,native_y_raw:200,native_home_x_raw:140,native_home_y_raw:200});}
  const target=actors[0],caster=actors[1],selected={...copy(source),id:'004_40'};
  const core=Object.create(BattleController.prototype);
  Object.assign(core,{state:{id:'bonus-revival',phase:'command',round:1,action_count:0,actors,player_id:'004',enemy_id:'032',source:{},history:[],outcome:null,lifecycle_events:[],scheduler:scheduling},
    schedulerData:scheduler,reactionData:reactions,statusData:status,skills:{yantu:skills.skills.yantu,'004_40':selected,'032_attack':forest.skills['032_attack']},
    lifecycleEnabled:true,lifecycleSequence:0,verticalClocks:new Map(),pendingSourceEnds:new Set(),pendingCarriers:new Set(),chargeClock:0,running:false,testMode:false,lockedOutcome:null,
    rng:()=>{const value=rng();draws.push(value);return value;},now:()=>clock,checkWorld(){},publish(){},consumeResources:consumePartyMp,log:event=>logs.push(copy(event)),
    resolveAction(){throw Error('Revival cannot resolve ordinary damage');},applyDamage(){throw Error('Revival cannot submit ordinary damage');}});
  const view=new BattleView({canvas:{width:960,height:540,getContext:()=>context},metadataPath:'/data/party_battle_view.json',lifecycleMetadataPath:'/data/battle_lifecycle.json',jsonLoader:read,
    assetLoader:async asset=>({image:{width:asset.width,height:asset.height},sha256:asset.sha256})});
  await view.prepare();view.setRoster(actors,core.skills);view.nativeControl=core;view.nativeControlIsCurrent=()=>true;
  let oldEvent;
  if(airborne){
    const reaction=reactions.roles['001'].skills.find(skill=>skill.original_id_raw===5);
    Object.assign(target,{current_skill:copy(reaction),native_active:true});
    oldEvent=core.queueLifecycle(target,{kind:'response',skill:reaction,source_skill_index:reaction.original_skill_index});
    view.draw(core.presentationSnapshot(),0);clock=20;view.draw(core.presentationSnapshot(),clock);assert.equal(target.native_z_raw,-40);
    const down=reaction.actions.find(action=>{const raw=Buffer.from(action.raw_hex,'hex');return raw[0]===1&&raw.readUInt32LE(1)===3&&raw[0x47]===3;});
    core.beginNativeVertical('001',down.raw_hex,clock);
  }
  target.raw_hp=0;target.raw_by_address['0x0524a701']=0;target.hp.current=target.resource_bonuses.hp_current;target.effective_hp_raw=target.hp.current;
  target.state_raw=airborne?4:7;target.alive=false;
  if(!airborne)target.current_skill=copy(reactions.roles['001'].skills.find(skill=>skill.original_id_raw===12));
  caster.charge.gauge=scheduling.threshold;
  const responses=[];
  core.playSequence=async(event,hooks)=>{
    const step=compileNativeSequence(view.meta,'004',directSequence(selected),[view.layers,...view.alternateLayers.values()]).steps.find(step=>step.event);
    assert.ok(step);assert.equal(event.skill_id,'004_40');
    const contact={...step,contact_key:event.action_id+':source-contact'};
    responses.push(hooks.onContact(contact));const state=rng.state;
    responses.push(hooks.onContact(contact));assert.equal(rng.state,state);hooks.onPrimaryEnd(clock);return {completed:true};
  };
  return {core,view,target,caster,selected,draws,logs,responses,oldEvent,get clock(){return clock;},get rngState(){return rng.state;},
    frame(){clock+=20;view.draw(core.presentationSnapshot(),clock);for(const completed of view.drainLifecycleCompleted())core.ackLifecycle(completed);}};
}

test('normal choose00440 revives source001 rawHP0/display88 in category7 and airborne category4, preserving type14 RNG and native Z ownership',async()=>{
  for(const airborne of [false,true]){
    const f=await fixture(airborne);
    try{
      assert.equal(f.target.resource_bonuses.hp_current,88);assert.equal(f.target.hp.current,88);assert.equal(f.target.raw_hp,0);
      assert.equal(revivalTargetEligibility(f.target,f.selected).available,true);assert.deepEqual(f.core.targetIdsForSkill('004_40'),['001']);assert.equal(f.core.canChoose('004_40'),true);
      const mp=f.caster.mp.current,rawMp=f.caster.raw_mp,charge=copy(f.target.charge),slots=copy(f.target.native_status_slots),z=f.target.native_z_raw;
      const vertical=airborne?copy(f.core.verticalClocks.get('001')):null;
      await f.core.choose('004_40','001');
      assert.equal(f.target.raw_hp,350);assert.equal(f.target.hp.current,438);assert.equal(f.target.state_raw,0);assert.equal(f.target.alive,true);assert.equal(f.target.life_epoch,1);
      assert.equal(f.caster.mp.current,mp-18);assert.equal(f.caster.raw_mp,rawMp-18);assert.deepEqual(f.target.charge,charge);assert.deepEqual(f.target.native_status_slots,slots);
      assert.deepEqual(f.responses[1],f.responses[0]);assert.equal(f.responses[0].hp_delta,350);assert.equal(f.responses[0].revived,true);
      assert.deepEqual(f.core.state.history[0].contacts[0].result.trace.filter(row=>row.kind==='rng').map(row=>row.label),['reaction-id-14']);
      const revive=f.core.state.lifecycle_events.find(event=>event.kind==='revive');assert.equal(revive.source_id_raw,14);assert.equal(revive.actor_id,'001');
      assert.equal(f.target.native_z_raw,z,'50E3A0 selects type14 without inventing a Z reset');
      if(airborne){assert.deepEqual(f.core.verticalClocks.get('001'),vertical);assert.equal(f.core.ackLifecycle(f.oldEvent),false);f.frame();assert.equal(f.target.native_z_raw,-39);}
      for(let count=0;count<200&&f.core.hasLifecycle();count++)f.frame();
      assert.equal(f.core.hasLifecycle(),false);assert.equal(f.target.native_z_raw,0);assert.equal(f.target.current_skill.original_id_raw??parseInt(f.target.current_skill.fixed_raw_hex.slice(0,2),16),0);
      assert.equal(f.target.native_active,false);assert.equal(f.target.state_raw,0);assert.equal(f.target.raw_hp,350);assert.equal(f.target.hp.current,438);
      assert.equal(f.core.activePlayers().some(actor=>actor.id==='001'),true);assert.equal(f.core.nextNativeVerticalAt(),Infinity);
      const expected=createNativeRng(173),values=[expected(),expected(),expected()];assert.deepEqual(f.draws,values);assert.equal(f.rngState,expected.state);
      assert.deepEqual(f.logs.filter(event=>event.type==='battle-source-completed').map(event=>[event.actor_id,event.descriptor.trace.filter(row=>row.kind==='rng').map(row=>row.label)]),[['004',['reaction-id-0']],['001',['reaction-id-0']]]);
      const finished=f.rngState;assert.equal(f.core.ackLifecycle(revive),false);assert.equal(f.rngState,finished);
    }finally{f.view.dispose?.();f.view.destroy();}
  }
});
