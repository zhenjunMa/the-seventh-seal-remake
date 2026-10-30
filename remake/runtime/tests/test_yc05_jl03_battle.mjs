// Actual source identities and the recovered command1 camera update.
// Synthetic wall time/oracle memory below do not run the original GAME.exe.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileNativeSequence,directSequence} from '../web/core/skill_sequence.mjs';
import {beginNativeCameraShake,advanceNativeCameraShake} from '../web/core/battle_camera.mjs';
import {nativeScriptedBattle} from '../web/core/scripted_battle.mjs';
import {runtimeContent,requireRegisteredRoles} from '../web/core/content_registry.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {resolveAction,createNativeRng,nativeEffectContextForTarget} from '../web/core/combat_rules.mjs';
import {BattleView} from '../web/battle_view.mjs';
import {ActionClock} from '../web/phaser/components/action_clock.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {BattleLifecyclePlayback} from '../web/battle_lifecycle_view.mjs';
import {nativeEntryPath} from '../web/core/battle_entry.mjs';
import {skillOwner,deriveSkillConfiguration} from '../web/core/skill_registry.mjs';
const json=async name=>JSON.parse(await readFile(new URL(`../${name}`,import.meta.url),'utf8'));
const [ai,meta,story,camera,combat,partySkills,lifecycle,placement,pathBundle]=await Promise.all(['web/data/forest_ai.json','web/data/party_battle_view.json',
  'web/data/chapter_story.json','evidence/yc05_jl03_20261030/battle_camera_native.json','web/data/forest_combat.json','web/data/party_skills.json',
  'web/data/battle_lifecycle.json','evidence/yc05_jl03_20261030/battle_command9_native.json','evidence/yc05_jl03_20261030/battle_entry_native_bundle.json'].map(json));

test('ambush names bind both distinct shipped CHR files and all13 learned source sequences',async()=>{
  const table=story.maps.M01050,battle=nativeScriptedBattle(table,table.records.find(row=>row.id===103));
  assert.deepEqual(battle.members.map(row=>row.id),['031A1','031B2']);
  requireRegisteredRoles(battle.members.map(row=>row.id),{side:'enemy'});
  const expected={'031A1':[14,15,16,23,24,25],'031B2':[18,20,22,23,24,26,30]};
  for(const [id,learned]of Object.entries(expected)){
    const role=ai.roles[id],raw=await readFile(new URL(`../../../Fight_Role/${id}.CHR`,import.meta.url));
    assert.equal(role.source.path,`Fight_Role/${id}.CHR`);
    assert.equal(createHash('sha256').update(raw).digest('hex'),role.source.sha256);
    assert.deepEqual(role.learned_indices,learned);
    for(const index of learned){
      const skill=role.skills[index],compiled=compileNativeSequence(meta,id,directSequence(skill));
      assert.equal(raw.subarray(skill.source_record_offset,skill.source_record_offset+0x41d).toString('hex'),skill.fixed_raw_hex);
      assert.ok(compiled.steps.some(step=>step.event||step.carrier_spawn?.steps.some(row=>row.event)),`${id}:${index} complete contacts`);
    }
  }
  assert.notEqual(ai.roles['031A1'].source.sha256,ai.roles['031B2'].source.sha256);
});

test('unified skill configuration retains literal enemy source ownership and original indices',()=>{
  const configuration=deriveSkillConfiguration({party_skills:partySkills,ai});
  for(const id of ['031A1','031B2'])for(const index of ai.roles[id].learned_indices){
    assert.deepEqual(skillOwner(ai.roles[id].skills[index],'enemy'),{role_id:id,skill_index:index,side:'enemy'});
    assert.equal(configuration.entries[`${id}_${index}`].source.path,`Fight_Role/${id}.CHR`);
  }
});

test('mode4 placement and eight-pixel entry path match512B50/51D5B0 source assembly and complete both entry timelines',()=>{
  const pathRecord=pathBundle.records.find(row=>row.parameters.procedure==='0x51d5b0');
  class EntryOracle extends NativeAssemblyOracle{external(target){if(target===0x571090){this.reg.EAX=Math.abs(this.read(this.reg.ESP));return;}return super.external(target);}}
  for(const id of ['031A1','031B2']){
    const source=lifecycle.roles.find(row=>row.id===id),entry=source.skills.find(row=>row.skill_id_raw===11),width=source.frame_width;
    const control=new BattleController({});control.state={actors:[{id:'member',immune_raw:0,native_x_raw:-146,native_y_raw:152,native_z_raw:0,native_home_y_raw:152}]};
    const oracle=new EntryOracle({'0x512b50':placement.normalized_result.assembly,'0x51d5b0':pathRecord.normalized_result.assembly},[],()=>assert.fail('Entry uses no combat RNG'));
    oracle.write(0x521a77d,-146);oracle.write(0x521a781,152);oracle.write(0x521a785,0);oracle.write(0x521a78d,152);
    oracle.write(0x521a770,1);oracle.write(0x52193c7,width,2);oracle.run(0x512b50,[0,4]);
    const raw=entry.timeline[0].raw_hex,actual=control.beginNativeEntry('member',raw,width);
    assert.equal(actual.x,oracle.read(0x521a77d));assert.equal(control.actor('member').immune_raw,oracle.read(0x521f5f5,1));
    oracle.run(0x51d5b0,[actual.x,152,0,actual.origin_x,152,0,0x24000000,0x24100000]);
    const path=nativeEntryPath(actual,0),count=oracle.read(0x24000000);
    assert.equal(path.points.length,count);assert.deepEqual(path.points,Array.from({length:count},(_,i)=>oracle.read(0x24100000+i*12)));
    const points=[],playback=new BattleLifecyclePlayback(lifecycle,{nativeBridge:()=>({record:raw=>control.nativeSourceRecord('member',raw),
      entry:(raw,w)=>control.beginNativeEntry('member',raw,w),entryPoint:x=>{control.advanceNativeEntry('member',x);points.push(x);}})});
    // Restore the source home before the independent lifecycle invocation.
    control.actor('member').native_x_raw=-146;
    const event={token:`${id}:source-entry`,actor_id:'member',kind:'entry',life_epoch:0,source_skill_index:entry.chr_skill_index,source_id_raw:11},
      snapshot={id:`${id}-entry`,actors:[{id:'member',life_epoch:0}],lifecycle_events:[event]},roster=[{id:'member',resource_id:id,side:'enemy'}];
    playback.advance(snapshot,roster,0);let now=0;
    while(playback.snapshot().active.length&&now<20000){now+=20;playback.advance(snapshot,roster,now);}
    assert.ok(now<20000);assert.ok(points.length>3,'Entry movement repeats the original three-frame running record');
    assert.equal(points.at(-1),-146);assert.equal(control.actor('member').native_x_raw,-146);assert.equal(control.actor('member').immune_raw,0);
    assert.deepEqual(playback.drainCompleted(),[{token:event.token,actor_id:'member',life_epoch:0}]);
  }
});

test('suffix-bearing enemy effect carriers settle under their literal CHR owner after runtime actor IDs change',()=>{
  for(const id of ['031A1','031B2'])for(const index of ai.roles[id].learned_indices){
    const original=ai.roles[id].skills[index];if(original.battle_handler!=='effect-carrier')continue;
    const compiled=compileNativeSequence(meta,id,directSequence(original));
    const step=compiled.steps.flatMap(row=>row.carrier_spawn?row.carrier_spawn.steps:[row]).find(row=>row.effect_contact);
    if(!step)continue; // Source sprite contacts retain token0.
    const attacker=structuredClone(combat.actors[id]),target=structuredClone(combat.actors['012']);
    attacker.id='enemy-0';attacker.resource_id=id;attacker.class_raw=step.class_raw;attacker.action_mask_raw=step.action_mask_raw;
    const skill={...structuredClone(original),actor_id:attacker.id};attacker.current_skill=skill;
    target.resource_id='012';target.current_skill=structuredClone(combat.skills['012_attack']);
    const context=nativeEffectContextForTarget(skill,target,ai.roles);
    assert.doesNotThrow(()=>resolveAction({attacker,target,skill,rng:createNativeRng(1),context}),`${id}:${index}`);
    const truncated={...skill,source:{...skill.source,path:'Fight_Role/031.CHR'}};
    assert.throws(()=>resolveAction({attacker,target,skill:truncated,rng:createNativeRng(1),context}),/outside the fresh registered carrier scope/);
  }
});

test('031B2 non-waiting Y shake replays510F10 signed steps, lower clamp and final restoration',()=>{
  const source=ai.roles['031B2'].skills[22],compiled=compileNativeSequence(meta,'031B2',directSequence(source));
  const step=compiled.steps.find(row=>row.command_raw===1);
  assert.deepEqual(step.control,{mode_raw:1,step_i32_raw:3,amount_i32_raw:5});
  const oracle=new NativeAssemblyOracle({'0x510f10':camera.normalized_result.assembly},[],()=>assert.fail('XY shake consumed RNG'));
  oracle.write(0x55efac8,1,1);oracle.write(0x55efac9,0,1);oracle.write(0x55efacb,0);
  oracle.write(0x55efad3,6);oracle.write(0x55efae3,5);
  let state=beginNativeCameraShake(step.control,0);
  for(const now of [0,19,20,40,60,80,100,120,140,200]){
    // Replay every native due call; extra calls on either side of20ms are
    // retained so the strict threshold is compared independently.
    oracle.run(0x510f10,[now]);state=advanceNativeCameraShake(state,now);
    assert.equal(state.y,oracle.read(0x55f1654),`Y at${now}`);
    assert.equal(state.remaining,oracle.read(0x55efad3),`remaining at${now}`);
    assert.equal(Number(state.active),oracle.read(0x55efac8,1),`active at${now}`);
  }
  assert.equal(state.y,0);assert.equal(state.active,false);
  const jump=advanceNativeCameraShake(beginNativeCameraShake(step.control,0),200);
  assert.deepEqual(jump,state,'slow rendering preserves the complete source shake');
});

test('real command1 enters BattleView scene projection, freezes on the shared paused clock and clears on stop',async()=>{
  const translations=[],ctx={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},ellipse(){},fill(){},save(){},restore(){},fillText(){},drawImage(){},
    translate(x,y){translations.push([x,y]);}};
  const view=new BattleView({canvas:{width:960,height:540,getContext:()=>ctx},metadataPath:'/data/party_battle_view.json',stageMetadataPath:'/data/stages/stage01.json',
    jsonLoader:path=>json('web'+path),assetLoader:async row=>({width:row.width,height:row.height})});
  await view.prepare();
  const actors=[{id:'001',resource_id:'001',side:'player'},{id:'enemy-0',resource_id:'031B2',side:'enemy'}];
  view.setRoster(actors,{player:{id:meta.roles.find(row=>row.id==='001').skill.runtime_skill_id,actor_id:'001'},enemy:{id:'source-shake',actor_id:'enemy-0'}});
  const snapshot={actors:actors.map(row=>({...row,hp:{current:1000},alive:true}))};
  const plan=directSequence(ai.roles['031B2'].skills[22]);
  // Isolate only the newly admitted original command, retaining its exact
  // source bytes/offset. Full13 source sequences are compiled above.
  plan.records=plan.records.filter(row=>{const raw=Buffer.from(row.raw_hex,'hex');return raw[0]===1&&raw.readUInt32LE(1)===1;});plan.allow_no_contacts=true;
  const done=view.playSequence({actor_id:'enemy-0',target_id:'001',skill_id:'source-shake',plan},{onRecord(){},onContact:()=>assert.fail('Camera command changes no HP')});
  const clock=new ActionClock();clock.time=0;view.draw(snapshot,clock.time);const before=view.actorPositions()['001'];
  clock.advance(20);view.draw(snapshot,clock.time);assert.equal(view.cameraShake.y,5);
  assert.deepEqual(translations.at(-1),[-0,-5*1.125]);assert.equal(view.actorPositions()['001'][1],before[1]-5);
  const paused=structuredClone(view.cameraShake);clock.paused=true;clock.advance(1000);view.draw(snapshot,clock.time);
  assert.deepEqual(view.cameraShake,paused);clock.paused=false;clock.advance(20);view.draw(snapshot,clock.time);assert.equal(view.cameraShake.y,0);
  clock.advance(5000);view.draw(snapshot,clock.time);await done;assert.equal(view.cameraShake.active,false);assert.equal(view.cameraShake.y,0);
  view.stop();assert.equal(view.cameraShake,null);view.destroy();clock.destroy();
});
