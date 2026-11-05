// Source-bound battle/reward capabilities required by the sealed ruins.
// Item placement below is an explicit handoff fixture; natural acquisition is
// covered by the regional StoryFlow checks, not manufactured by this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {initializeChapterItem} from '../web/core/chapter.mjs';
import {deriveItemConfiguration,compileItemConfiguration} from '../web/core/item_registry.mjs';
import {createPartyActors} from '../web/core/party_attributes.mjs';
import {useWorldItem,changeEquipment,usableItems} from '../web/core/items.mjs';
import {initializeNativeStatuses,applyNativeSkillStatus,tickNativeStatuses} from '../web/core/battle_status.mjs';
import {compileNativeSequence,directSequence} from '../web/core/skill_sequence.mjs';
import {BattleLifecyclePlayback} from '../web/battle_lifecycle_view.mjs';
import {beginNativeCameraPan,advanceNativeCameraPan} from '../web/core/battle_camera.mjs';
import {previewMovement} from '../web/core/encounters.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {assembleForestSample} from '../web/forest_sample.mjs';
import {resolveAction,applyNativeDamage} from '../web/core/combat_rules.mjs';
import {partyResourcesForWorld,consumePartyMp} from '../web/core/party_attributes.mjs';
import {withItemQuantity} from '../web/core/equipment.mjs';
import {createPartySkillSample} from '../web/core/party_skill_sample.mjs';
import {validateForestReactionsData} from '../web/core/battle_reactions.mjs';
import {advanceIdleSkill,validateScheduler} from '../web/core/battle_scheduler.mjs';

const read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [catalog,attributes,seed,ai,view,status,lifecycle]=await Promise.all(
  ['items','party_combat','opening_seed','forest_ai','enemy_battle_view','forest_status','battle_lifecycle'].map(read));
const items=compileItemConfiguration(catalog,deriveItemConfiguration(catalog),'original').data,copy=structuredClone;
const instance=id=>withItemQuantity({id,name:items.definitions[id].name,instance_id:`seal-handoff-${id}`,quantity:1,
  source_raw_hex:Buffer.from(initializeChapterItem(items.definitions[id],{rng:()=>0})).toString('hex')},1);
function world(ids=[]){const value=copy(seed);value.opening.status='complete';value.inventory.push(...ids.map(instance));return new WorldStore(value);}
function actor(){const out=createPartyActors(world().snapshot(),attributes,{},items)[0];
  out.current_skill=copy(ai.roles['124'].skills[0]);return initializeNativeStatuses(out,status);}

test('all admitted sealed-ruins enemy commands compile from their unchanged original CHR records',async()=>{
  const ids=[...Array.from({length:10},(_,i)=>String(i+49).padStart(3,'0')),
    '060','077','078','080','083','086','087',...Array.from({length:24},(_,i)=>String(i+101))];
  for(const id of ids){const role=ai.roles[id],source=await readFile(new URL(`../../../Fight_Role/${id}.CHR`,import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'),role.source.sha256,id);
    for(const index of role.learned_indices){const skill=role.skills[index];
      assert.equal(source.subarray(skill.source_record_offset,skill.source_record_offset+0x41d).toString('hex'),skill.fixed_raw_hex);
      const compiled=compileNativeSequence(view,id,directSequence(skill));assert.ok(compiled.steps.length,`${id}:${index}`);
    }
  }
  //077's second id0 precedes its actual id1. The exported normal reaction
  // must use index2 instead of assuming source index1 universally.
  const final=view.roles.find(row=>row.id==='077');
  assert.equal(final.reaction.action_index,1);
  assert.equal(Buffer.from(ai.roles['077'].skills[2].fixed_raw_hex,'hex')[0],1);
  for(const id of ['055','086']){const skill=ai.roles[id].skills[8],plan=directSequence(skill);
    plan.handler='native-response';plan.allow_no_contacts=true;
    const steps=compileNativeSequence(view,id,plan).steps;
    assert.deepEqual(steps.map(step=>[step.invalid_source_action,step.native_frame_result]),[[17,-2]]);
    assert.ok(steps.every(step=>step.event===null));
  }
});

test('108 source mode1 removes status30 after contact without an application-chance draw',()=>{
  const incoming=ai.roles['108'].skills[12],applied=applyNativeSkillStatus({actor:actor(),skill:ai.roles['124'].skills[13],data:status,now:0,rng:()=>0});
  assert.ok(applied.actor.native_status_slots.some(row=>Buffer.from(row.raw_hex,'hex')[1]===30));
  const removed=applyNativeSkillStatus({actor:applied.actor,skill:incoming,data:status,now:0,
    rng:()=>assert.fail('mode1 must not draw application RNG')});
  assert.equal(removed.reason,'matching-status-removed');
  assert.ok(removed.actor.native_status_slots.every(row=>Buffer.from(row.raw_hex,'hex')[1]!==30));
  assert.equal(applyNativeSkillStatus({actor:removed.actor,skill:incoming,data:status,now:0,
    rng:()=>assert.fail('absent mode1 must not draw')}).native_return,0);
});

test('106 preserves both source effect windows, their unreachable second trigger, and the blank out-of-pool final visit',async()=>{
  const original=await readFile(new URL('../../../Fight_Role/106.CHR',import.meta.url));
  const effect=view.effects.find(row=>row.id==='m16Awz02');assert.equal(effect.frame_count,18);
  for(const index of [12,13]){
    const skill=ai.roles['106'].skills[index],plan=directSequence(skill),compiled=compileNativeSequence(view,'106',plan);
    const calls=skill.actions.filter(action=>{const raw=Buffer.from(action.raw_hex,'hex');return raw[0]===1&&raw.readUInt32LE(1)===4;});
    assert.equal(calls.length,2);
    for(const [position,call]of calls.entries()){
      const raw=Buffer.from(call.raw_hex,'hex');assert.equal(original.subarray(call.offset,call.offset+0xb0).toString('hex'),call.raw_hex);
      const steps=compiled.steps.filter(step=>step.chr_record_index===call.index),first=steps[0].effects.find(row=>row.unconditional);
      assert.deepEqual([raw.readUInt32LE(0x26),raw.readUInt32LE(0x2a),raw.readUInt32LE(0x49)],position?[11,19,11]:[0,11,10]);
      assert.deepEqual(steps.map(step=>step.logical_frame),position?[11,12,13,14,15,16,17,18]:[0,1,2,3,4,5,6,7,8,9,10]);
      assert.deepEqual(steps.filter(step=>step.event).map(step=>step.logical_frame),position?[]:[10]);
      assert.deepEqual(first.source_frames,position?[11,12,13,14,15,16,17,null]:[0,1,2,3,4,5,6,7,8,9,10]);
      assert.equal(first.frame_count,position?8:11);
    }
    assert.equal(compiled.steps.filter(step=>step.effect_contact).length,1);
  }
});

test('29/30 permanently increase original raw maxima, preserve current resources, and survive reload',async()=>{
  const store=world([29,30]),before=createPartyActors(store.snapshot(),attributes,{},items)[0];
  for(const [id,resource,cap]of [[29,'hp',9999],[30,'mp',999]]){
    const result=useWorldItem(store,attributes,items,{instanceId:instance(id).instance_id,targetId:'001'});
    assert.equal(result.applied,true);assert.equal(result.actor[`raw_${resource}_maximum`],Math.min(cap,
      before[`raw_${resource}_maximum`]+Math.trunc(before[`raw_${resource}_maximum`]*5/100)));
    assert.equal(result.actor[`raw_${resource}`],before[`raw_${resource}`]);
    assert.ok(!store.value.inventory.some(row=>row.id===id));
  }
  const loaded=await decodeSave(await encodeSave(store.snapshot()));
  assert.deepEqual(createPartyActors(loaded,attributes,{},items),createPartyActors(store.snapshot(),attributes,{},items));
  assert.deepEqual(store.value.source,seed.source);
});

test('19 uses the shared battle item contact once, consumes one unit, and restores HP through actual status clock pulses',async()=>{
  const [skills,forest,scheduler,reactions]=await Promise.all(['party_skills','forest_combat','battle_scheduler','party_reactions'].map(read));
  const store=world([19]),sample=assembleForestSample(createPartySample(store.snapshot(),attributes,skills,null,items),forest,
    {map_id:'M70010',members:[{id:'013'}]},{...scheduler,idle_skills:{...scheduler.idle_skills,...skills.idle_skills}},ai,null,reactions,status);
  let contacts=0;
  const battle=new BattleController({world:store,itemData:items,resolveAction,applyDamage:applyNativeDamage,
    resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,now:()=>0,
    playSequence:async()=>assert.fail('No ordinary attack is requested by this item fixture'),
    playItem:async(event,{onUse})=>{assert.equal(event.item_id,19);const first=onUse();contacts++;
      assert.equal(first.item_used,true);assert.deepEqual(onUse(),first);}});
  battle.start({...sample,rng:()=>0});
  const target=battle.actor('001');target.raw_hp=1;target.raw_by_address['0x0524a701']=1;
  target.hp.current=1+target.resource_bonuses.hp_current;
  const before=target.raw_hp;
  for(const member of battle.state.actors)member.charge.gauge=member.id==='001'?battle.state.scheduler.threshold:0;
  battle.state.phase='command';battle.selectPlayer('001');
  await battle.chooseItem(instance(19).instance_id,'001');
  assert.equal(contacts,1);assert.ok(!battle.state.inventory.some(row=>row.id===19));
  assert.equal(store.value.inventory.find(row=>row.id===19).quantity,1,'item contact remains private until battle completion');
  assert.equal(target.raw_hp,before,'periodic source does not heal at the application contact');
  assert.ok(target.native_status_slots.some(row=>Buffer.from(row.raw_hex,'hex')[1]===17));
  const interval=status.effects[17].interval_ms;
  for(let now=interval;now<=interval*Math.ceil(battle.state.scheduler.threshold/500);now+=interval)battle.advanceClock(now);
  assert.equal(battle.state.error,null);assert.equal(target.raw_hp,target.raw_hp_maximum);
  battle.finish();assert.ok(!store.value.inventory.some(row=>row.id===19));
  const loaded=await decodeSave(await encodeSave(store.snapshot()));
  assert.equal(createPartyActors(loaded,attributes,{},items)[0].raw_hp,target.raw_hp);
});

test('118/119/135 equip, initialize their real permanent status, and restore inventory through save and removal',async()=>{
  for(const id of [118,119,135]){
    const store=world([id]),definition=items.definitions[id];
    assert.equal(definition.equipment_passive.mode_raw,0);
    changeEquipment(store,attributes,items,{roleId:'001',slotId:definition.slot_id,instanceId:instance(id).instance_id});
    let target=createPartyActors(store.snapshot(),attributes,{},items)[0];target.current_skill=copy(ai.roles['124'].skills[0]);
    const initial=initializeNativeStatuses(target,status,undefined,()=>0);
    assert.ok(initial.native_status_slots.some(row=>row.raw_hex===definition.equipment_passive.effect_raw_hex));
    if(id===135)assert.equal(initial.status_flags_raw&0x200,0x200);
    else{
      const field=id===118?'raw_mp':'raw_hp_maximum',before=initial[field];
      const tick=tickNativeStatuses({actor:initial,data:status,now:status.effects[17].interval_ms,threshold:1,rng:()=>0});
      //41BFB0 adds block MP directly; only its positive HP branches clamp.
      assert.equal(tick.actor[field],id===118?before+10:before+50);
    }
    const saved=await decodeSave(await encodeSave(store.snapshot()));
    assert.deepEqual(createPartyActors(saved,attributes,{},items),createPartyActors(store.snapshot(),attributes,{},items));
    store.replace(saved);changeEquipment(store,attributes,items,{roleId:'001',slotId:definition.slot_id});
    assert.equal(store.value.inventory.find(row=>row.id===id).quantity,1);
    assert.ok(!createPartyActors(store.snapshot(),attributes,{},items)[0].equipment_passives.some(row=>row.item_id===id));
  }
});

test('118 MP above raw maximum and119 periodic HP maximum survive actual BattleController finish and save reload',async()=>{
  const [skills,forest,scheduler,reactions]=await Promise.all(['party_skills','forest_combat','battle_scheduler','party_reactions'].map(read));
  for(const id of [118,119]){
    const store=world([id]),definition=items.definitions[id];
    store.transact(next=>{const role=next.party.find(row=>row.id==='001');role.mp.current=role.mp.maximum;});
    changeEquipment(store,attributes,items,{roleId:'001',slotId:definition.slot_id,instanceId:instance(id).instance_id});
    const before=createPartyActors(store.snapshot(),attributes,{},items)[0];
    const sample=assembleForestSample(createPartySample(store.snapshot(),attributes,skills,null,items),forest,
      {map_id:'M70010',members:[{id:'013'}]},{...scheduler,idle_skills:{...scheduler.idle_skills,...skills.idle_skills}},ai,null,reactions,status);
    const battle=new BattleController({world:store,resolveAction,applyDamage:applyNativeDamage,
      resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,now:()=>0,
      playSequence:async()=>assert.fail('No attack is requested during this source periodic pulse')});
    battle.start({...sample,rng:()=>0});const target=battle.actor('001');
    assert.ok(target.native_status_slots.some(row=>row.raw_hex===definition.equipment_passive.effect_raw_hex));
    const interval=status.effects[17].interval_ms;
    for(let now=interval;now<=interval*Math.ceil(battle.state.scheduler.threshold/500);now+=interval)battle.advanceClock(now);
    assert.equal(battle.state.error,null);
    assert.equal(target.raw_mp,id===118?before.raw_mp+10:before.raw_mp);
    assert.equal(target.raw_hp_maximum,id===119?before.raw_hp_maximum+50:before.raw_hp_maximum);
    assert.equal(target.raw_mp_maximum,before.raw_mp_maximum);
    const result=battle.finish(),persisted=store.value.party.find(row=>row.id==='001');
    assert.equal(result.outcome,'aborted');assert.equal(battle.state.phase,'closed');
    assert.equal(persisted.mp.current,target.raw_mp);assert.equal(persisted.mp.maximum,before.raw_mp_maximum);
    assert.equal(persisted.hp.maximum,target.raw_hp_maximum);
    if(id===118)assert.ok(persisted.mp.current>persisted.mp.maximum);
    else assert.equal(Buffer.from(persisted.combat_progress.header_raw_hex,'hex').readUInt32LE(0x34),before.raw_hp_maximum+50);
    const loaded=await decodeSave(await encodeSave(store.snapshot())),restored=createPartyActors(loaded,attributes,{},items)[0];
    assert.equal(restored.raw_mp,target.raw_mp);assert.equal(restored.raw_hp_maximum,target.raw_hp_maximum);
    assert.equal(restored.raw_mp_maximum,before.raw_mp_maximum);assert.deepEqual(loaded.source,seed.source);
  }
});

test('110-115 native command8 deaths complete with source clock0 instead of the missing-id12 fade220 clock',()=>{
  for(let id=110;id<=115;id++){
    const role=lifecycle.roles.find(row=>row.id===String(id)),skill=role.skills.find(row=>row.skill_id_raw===12);
    assert.deepEqual(skill.timeline.map(row=>[row.kind,row.command_raw,row.mode_raw_0x47]),[['command',8,1]]);
    const playback=new BattleLifecyclePlayback(lifecycle),target={id:'seal-enemy',resource_id:String(id),side:'enemy',life_epoch:0,native_x_raw:0};
    const snapshot={id:`seal-death-${id}`,actors:[target],lifecycle_events:[{token:'death',actor_id:target.id,life_epoch:0,
      kind:'death',source_skill_index:skill.chr_skill_index,source_id_raw:12}]};
    playback.advance(snapshot,[target],0);
    assert.equal(playback.channels.get(target.id).fade_clock_ms,0);
    playback.advance(snapshot,[target],1000);
    assert.equal(playback.hidden(target.id),true);assert.equal(playback.drainCompleted().length,1);
  }
});

test('055/086 source id7 missing group16 keeps the last physical idle pose while applying its real CHR class',async()=>{
  const [scheduler,forest]=await Promise.all(['battle_scheduler','forest_combat'].map(read));validateScheduler(scheduler);
  for(const id of ['055','086']){
    const low=scheduler.low_hp_skills[id],source=await readFile(new URL('../../../'+low.source.path,import.meta.url));
    assert.equal(low.segments.length,0);assert.equal(low.invalid_source_actions.length,1);
    const invalid=low.invalid_source_actions[0],raw=source.subarray(invalid.source.offset,invalid.source.offset+176);
    assert.equal(createHash('sha256').update(raw).digest('hex'),invalid.source.raw_sha256);
    assert.equal(raw.readUInt32LE(1),16);assert.equal(invalid.native_frame_result,-2);
    const target=copy(forest.actors[id]);target.resource_id=id;target.current_skill=copy(scheduler.idle_skills[id]);target.idle_started_at=0;
    advanceIdleSkill(target,scheduler,0);const pose=copy(target.idle_pose);
    target.hp.current=target.raw_hp_maximum>>2;advanceIdleSkill(target,scheduler,100);
    assert.equal(target.current_skill.id,low.id);assert.deepEqual(target.idle_pose,pose);
    assert.equal(target.class_raw,raw[0x24]);assert.equal(target.action_mask_raw,raw[0x78]);
    advanceIdleSkill(target,scheduler,1000);assert.deepEqual(target.idle_pose,pose);
    target.hp.current=target.raw_hp_maximum;advanceIdleSkill(target,scheduler,1100);
    assert.equal(target.current_skill.id,scheduler.idle_skills[id].id);
    const unknown=copy(scheduler);delete unknown.low_hp_skills[id].invalid_source_actions;
    assert.throws(()=>validateScheduler(unknown),/原低血量待机属性缺失/);
  }
});

test('110-115 actual source attributes receive normal/guard/dodge contacts, reach native command8 death, and return through BattleController',async()=>{
  const [skills,forest,scheduler,reactions,rewards,allView]=await Promise.all(
    ['party_skills','forest_combat','battle_scheduler','party_reactions','party_rewards','party_battle_view'].map(read));
  validateForestReactionsData(reactions);
  const missingIdle=copy(reactions);missingIdle.roles['110'].skills[0].original_id_raw=99;
  missingIdle.roles['110'].skills[0].fixed_raw_hex='63'+missingIdle.roles['110'].skills[0].fixed_raw_hex.slice(2);
  assert.throws(()=>validateForestReactionsData(missingIdle),/Required reaction id missing/);
  const incomplete=copy(reactions);incomplete.roles['110'].skills.pop();
  assert.throws(()=>validateForestReactionsData(incomplete),/Reaction skill table incomplete/);
  for(let id=110;id<=115;id++){
    const sourceWorld=createPartySkillSample(seed,rewards,skills,seed.location,{activeRoleIds:['001','002','003','004']});
    sourceWorld.opening.status='complete';const store=new WorldStore(sourceWorld),before=store.snapshot();let roll=50;
    const sample=assembleForestSample(createPartySample(store.snapshot(),attributes,skills,null,items),forest,
      {map_id:'M71080',members:[{id:String(id)}]},{...scheduler,idle_skills:{...scheduler.idle_skills,...skills.idle_skills}},ai,null,reactions,status);
    const battle=new BattleController({world:store,id:()=>`seal-source-${id}`,now:()=>0,resolveAction,applyDamage:applyNativeDamage,
      resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,
      playSequence:async(event,hooks)=>{
        const compiled=compileNativeSequence(allView,battle.actor(event.actor_id).resource_id,event.plan);
        for(const step of compiled.steps){
          hooks.onRecord(step);
          if(!step.event)continue;
          const result=hooks.onContact({...step,contact_key:`${event.action_id}:${step.index}`}),response=result.reaction_descriptor;
          if(response){
            const plan={...response.plan,handler:'native-response',allow_no_contacts:true};
            for(const reply of compileNativeSequence(allView,battle.actor(response.actor_id).resource_id,plan).steps)hooks.onReactionRecord(reply,response);
            hooks.onReactionEnd(response,true,0);
          }
        }
        hooks.onPrimaryEnd(0);
      }});
    battle.start({...sample,lifecycle_enabled:true,rng:()=>roll});
    // Entry completion is the explicit external renderer boundary. All
    // subsequent numeric contacts, responses and death playback are real.
    for(const event of copy(battle.state.lifecycle_events))battle.ackLifecycle(event);
    const attacker=battle.actor('002'),target=battle.actor('enemy-0'),sourceHp=target.raw_hp;
    assert.equal(sourceHp,forest.actors[id].raw_hp);assert.ok(sourceHp>100000);
    const act=async(skillId,value)=>{roll=value;const skill=battle.skills[skillId];
      await battle.performSequence(attacker,target,skill,directSequence(skill));
      return battle.state.history.at(-1).contacts;
    };
    assert.equal(battle.reactionTargetAvailability(battle.skills['002_26'],target).code,'source-reaction-index');
    const normal=await act('002_24',50);assert.ok(normal.some(row=>row.result.damage>0&&row.result.reaction===0),String(id));
    assert.equal(Buffer.from(target.current_skill.fixed_raw_hex,'hex')[0],0);assert.equal(target.native_active,false);
    const guarded=await act('kai_mieyan',0);assert.ok(guarded.some(row=>row.result.reaction===1),String(id));
    assert.ok(guarded.every(row=>row.result.reaction_descriptor===null));
    assert.equal(Buffer.from(target.current_skill.fixed_raw_hex,'hex')[0],0);assert.equal(target.native_active,false);
    const dodged=await act('002_42',50);assert.ok(dodged.some(row=>row.result.reaction===2),String(id));
    assert.equal(target.current_target_id,attacker.id);assert.equal(Buffer.from(target.current_skill.fixed_raw_hex,'hex')[0],0);
    assert.equal(target.native_active,false);
    // Damage comes from unchanged source skills and normal99-level growth;
    // neither the enemy's103k HP nor a reaction result is injected.
    for(let attacks=0;target.hp.current>0&&attacks<100;attacks++)await act('002_24',50);
    assert.equal(target.raw_hp,0);assert.equal(target.state_raw,5);
    const death=battle.state.lifecycle_events.find(event=>event.actor_id===target.id&&event.kind==='death');
    assert.equal(death.source_id_raw,12);assert.equal(death.source_skill_index,3);
    const playback=new BattleLifecyclePlayback(lifecycle),snapshot=battle.presentationSnapshot();
    playback.advance(snapshot,battle.state.actors,0);assert.equal(playback.channels.get(target.id).fade_clock_ms,0);
    playback.advance(snapshot,battle.state.actors,1000);
    for(const completed of playback.drainCompleted())battle.ackLifecycle(completed);
    assert.equal(target.state_raw,7);assert.equal(battle.state.phase,'victory');
    const result=battle.finish();assert.equal(result.outcome,'victory');assert.equal(battle.state.phase,'closed');
    assert.deepEqual(store.value.source,before.source);
  }
});

test('077 command2 camera uses native16-pixel/20ms steps, clamps, and returns through command11',()=>{
  const controls=compileNativeSequence(view,'077',directSequence(ai.roles['077'].skills[19])).steps;
  assert.ok(controls.some(step=>step.command_raw===2&&step.control.mode_raw===1));
  let camera=beginNativeCameraPan(800,100,null,{limit:410});
  camera=advanceNativeCameraPan(camera,100);assert.equal(camera.x,16);
  camera=advanceNativeCameraPan(camera,1000);assert.equal(camera.x,410);assert.equal(camera.active,false);
  camera=advanceNativeCameraPan(beginNativeCameraPan(0,1000,camera),2000);assert.equal(camera.x,0);assert.equal(camera.active,false);
});

test('286 source field side effect stacks100ms ticks without consuming its numerically dormant field item;288 remains inert',async()=>{
  const store=world([286,288]),encounters=await read('encounters');
  assert.equal(items.definitions[288].behavior.kind,'native-inert-item');
  assert.deepEqual(usableItems([instance(288)],items),[]);
  for(const playTimeMs of [1000,1100]){
    const result=useWorldItem(store,attributes,items,{instanceId:instance(286).instance_id,targetId:'001',playTimeMs});
    assert.equal(result.applied,false);
    assert.equal(store.value.inventory.find(row=>row.id===286).quantity,1);
  }
  assert.deepEqual(store.value.encounters.modifier,{value:-100,expires_at_ms:13000});
  const loaded=await decodeSave(await encodeSave(store.snapshot()));assert.deepEqual(loaded.encounters,store.value.encounters);
  const state=copy(loaded.encounters);delete state.global_pool_map_id;state.counters['001']=41;
  const movement={party:loaded.party,leader_id:'001',map_id:'M70010',dx:4,dy:0,distance:4};
  const suppressed=previewMovement(state,{...movement,play_time_ms:12999},encounters,()=>999);
  assert.equal(suppressed.encounter,null);assert.equal(suppressed.state.counters['001'],42);
  let draws=0;const expired=previewMovement(state,{...movement,play_time_ms:13000},encounters,()=>draws++?0:999);
  assert.ok(expired.encounter);assert.equal(expired.state.modifier,undefined);
});
