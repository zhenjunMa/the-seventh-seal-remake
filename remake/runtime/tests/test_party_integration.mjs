import {battleActive,commandReady,chooseReady} from './helpers/battle_clock.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BattleView} from '../web/battle_view.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {assembleForestSample} from '../web/forest_sample.mjs';
import {partyResourcesForWorld,consumePartyMp,createPartyActors} from '../web/core/party_attributes.mjs';
import {chapterRoleFromDefinition} from '../web/core/chapter.mjs';
import {resolveAction,applyNativeDamage,createNativeRng} from '../web/core/combat_rules.mjs';
import {loadRuntimeConfiguration,compileRuntimeConfiguration} from '../web/core/runtime_config.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {directSequence,compileNativeSequence} from '../web/core/skill_sequence.mjs';
import {fullSkillGroups,level99SkillWorld,namedPartySourceSkills,nativeSequenceSteps} from './helpers/party_skill_fixture.mjs';
const read=async p=>JSON.parse(await readFile(new URL('../'+p,import.meta.url)));
const json=p=>read('web/'+p),clone=structuredClone;
const attributes=await json('data/party_combat.json'),commands=await json('data/party_skills.json');
const data={combat:await json('data/combat_sample.json'),forest:await json('data/forest_combat.json'),scheduler:await json('data/battle_scheduler.json'),ai:await json('data/forest_ai.json'),rewards:await json('data/party_rewards.json'),party_skills:commands,items:await json('data/items.json')};
data.source_skills=await json('data/library/skills.json');
data.source_magic=await json('data/library/magic.json');
const reaction=await json('data/party_reactions.json'),statuses=await json('data/forest_status.json'),assembly=await read('evidence/turn_rules_assembly_20261011.json');
const config=await loadRuntimeConfiguration(json);

test('all 154 six-member commands execute through the production controller, native controls and BattleView at level99',async t=>{
  const [seed,library,metadata,...banks]=await Promise.all(['data/opening_seed.json','data/library/skills.json','data/party_battle_view.json',
    ...['001','002','003','004','005','006'].map(id=>`data/party_role_layers_${id}.json`)].map(json));
  const sourceSkills=namedPartySourceSkills(library),configured=compileRuntimeConfiguration(data,config),exercised=new Set(),attempted=new Set(),expandedGroups=new Set();
  const ctx={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},save(){},restore(){},drawImage(){},fillText(){},createLinearGradient:()=>({addColorStop(){}})};
  let probe=null,transform=[1,0,0,1,0,0];const transforms=[];
  Object.assign(ctx,{beginFrame(){if(probe)probe.frame=[];},setTransform(...values){transform=values;},save(){transforms.push([...transform]);},restore(){transform=transforms.pop()??[1,0,0,1,0,0];},
    drawImage(image,...rect){if(!probe||image.path!==probe.path)return;
      const [x,y,w,h]=rect.slice(-4),[a,b,c,d,e,f]=transform;
      probe.frame.push([a*x+c*y+e,b*x+d*y+f,a*w+c*h,b*w+d*h]);}});
  const view=new BattleView({canvas:{width:960,height:540,getContext:()=>ctx},metadataPath:'/data/party_battle_view.json',lifecycleMetadataPath:'/data/battle_lifecycle.json',
    jsonLoader:path=>json(path.slice(1)),assetLoader:async asset=>({image:{width:asset.width,height:asset.height,path:asset.path},sha256:asset.sha256})});
  await view.prepare();
  try{
    for(const ids of fullSkillGroups){
      const at99=level99SkillWorld(seed,data.rewards,commands,ids),initial=createPartySample(at99,attributes,commands,configured);
      const groupSample=assembleForestSample(initial,configured.forest,{kind:'skill-test',map_id:null,members:[{id:'012'},{id:'013'}]},
        {...configured.scheduler,idle_skills:{...configured.scheduler.idle_skills,...commands.idle_skills}},configured.ai,null,reaction,statuses);
      const candidates=Object.values(initial.skills).filter(skill=>skill.battle_handler!=='combination'&&!attempted.has(`${skill.actor_id}:${skill.original_skill_index}`));
      for(const skill of candidates)await t.test(`${skill.actor_id}:${skill.original_skill_index} ${skill.name}`,async()=>{
        attempted.add(`${skill.actor_id}:${skill.original_skill_index}`);
        const world=new WorldStore(clone(at99),['M72061','M70010']),sample=clone(groupSample);
        const compiled=compileNativeSequence(metadata,skill.actor_id,directSequence(skill),banks),expected=nativeSequenceSteps(compiled).filter(step=>step.event);
        assert.ok(expected.length,`${skill.id}: source command has an executable contact`);
        const logs=[],playbacks=[];let clock=0,battle;
        const visualSkill=skill.actor_id==='001'&&[40,42].includes(skill.original_skill_index);
        probe=visualSkill?{path:metadata.effects.find(asset=>asset.id===(skill.original_skill_index===42?'_iReHP':'_m64spit')).main_sheet,frame:[],frames:[],beforeContact:[]}:null;
        const draw=()=>{view.draw({actors:battle.state.actors},clock);if(probe&&probe.frame.length){probe.frames.push(clone(probe.frame));
          if(!battle.state.history.some(action=>action.skill_id===skill.id&&action.contacts.length))probe.beforeContact.push(clone(probe.frame));}};
        battle=new BattleController({world,id:()=>`all-party-${skill.id}`,now:()=>clock,waitTick:async()=>{clock+=80;},
          resolveAction,applyDamage:applyNativeDamage,resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,log:event=>logs.push(event),
          playAction:async()=>{throw Error('Every party skill must use its complete source sequence');},
          playSequence:async(event,hooks)=>{
            const promise=view.playSequence(event,hooks);draw();let frames=0;
            while(view.run||view.detachedRuns.length){
              assert.ok(++frames<20000,`${skill.id}: bounded source playback`);clock+=visualSkill?20:80;battle.advanceClock();draw();
            }
            const played=await promise;playbacks.push(played);return played;
          }});
        battle.start({...sample,rng:createNativeRng(0x20261027),test_mode:true});
        view.setRoster(sample.actors,sample.skills);view.nativeControl=battle;view.nativeControlIsCurrent=()=>view.nativeControl===battle;
        const caster=battle.actor(skill.actor_id),other=battle.players().find(actor=>actor.id!==skill.actor_id);
        if(skill.battle_handler==='native-revival'){
          other.state_raw=7;other.alive=false;other.raw_hp=-other.resource_bonuses.hp_current;
          other.raw_by_address['0x0524a701']=other.raw_hp;other.hp.current=0;
        }
        const before=world.snapshot();
        assert.ok(await commandReady(battle,skill.actor_id),`${skill.id}: caster reaches native command gauge`);
        battle.selectPlayer(skill.actor_id);assert.equal(battle.canChoose(skill.id),true,`${skill.id}: actually selectable`);
        const target=skill.battle_handler==='native-revival'?other.id:battle.targetIdsForSkill(skill.id)[0];
        assert.ok(target,`${skill.id}: supported target`);
        await chooseReady(battle,skill.id,target);
        assert.equal(battle.state.error,null,`${skill.id}: no interrupted execution`);
        const history=battle.state.history.find(action=>action.actor_id===skill.actor_id&&action.skill_id===skill.id);
        assert.ok(history,`${skill.id}: actual command reaches controller settlement`);
        const contacts=history.contacts.filter(contact=>contact.source.source_skill_index===skill.original_skill_index),visited=new Set(contacts.map(contact=>contact.source.chr_record_index));
        for(const contact of expected)assert.ok(visited.has(contact.chr_record_index),`${skill.id}: source contact record ${contact.chr_record_index}`);
        assert.equal(new Set(contacts.map(contact=>contact.key)).size,contacts.length,`${skill.id}: contacts settle once`);
        const source=sourceSkills.find(source=>source.actor_id===skill.actor_id&&source.original_skill_index===skill.original_skill_index),fixed=Buffer.from(source.fixed_raw_hex,'hex');
        if(fixed[0x24]===1){
          const targets=sample.actors.filter(actor=>fixed[0x25]?actor.side_raw===caster.side_raw:actor.side_raw!==caster.side_raw).map(actor=>actor.id).sort();
          assert.equal(targets.length,fixed[0x25]?4:2,`${skill.id}: source group has its complete target side`);
          for(const contact of expected){
            const actual=contacts.filter(actual=>actual.source.chr_record_index===contact.chr_record_index).map(actual=>actual.before.target.id).sort();
            assert.deepEqual(actual,targets,`${skill.id}: source group record ${contact.chr_record_index} settles every target`);
          }
          expandedGroups.add(`${skill.actor_id}:${skill.original_skill_index}`);
        }
        assert.ok(logs.some(event=>event.type==='battle-skill-practice'&&event.actor_id===skill.actor_id&&event.skill_index===skill.original_skill_index));
        assert.ok(playbacks.length&&playbacks.every(result=>result.observations.draws>0),`${skill.id}: source frames are actually drawn`);
        if(skill.battle_handler==='native-revival')assert.ok(contacts.some(contact=>contact.result.revived),`${skill.id}: revival branch executes`);
        if(skill.battle_handler==='native-support')assert.ok(contacts.some(contact=>contact.result.supported),`${skill.id}: allied support branch executes`);
        if(visualSkill&&skill.original_skill_index===42){
          assert.ok(probe.beforeContact.some(frame=>frame.length===4&&new Set(frame.map(rect=>rect.slice(0,2).join(','))).size===4),'group healing visibly starts at four distinct allies before its first contact');
          assert.ok(probe.frames.every(frame=>frame.length===4),'each group-healing frame draws exactly one main layer for each ally');
        }
        if(visualSkill&&skill.original_skill_index===40){
          assert.ok(probe.frames.length,'fullscreen spell really draws its original main effect layer');
          assert.ok(probe.frames.every(frame=>frame.length===1),'fullscreen spell draws one visual for the entire viewport');
          for(const frame of probe.frames)assert.deepEqual(frame[0],[120,0,720,540],'fullscreen spell covers the fitted 640x480 viewport');
        }
        assert.deepEqual(world.snapshot(),before,`${skill.id}: test battle remains isolated from official save`);
        assert.equal(caster.level,99);
        battle.finish();assert.deepEqual(world.snapshot(),before,`${skill.id}: test finish does not commit`);
        exercised.add(`${skill.actor_id}:${skill.original_skill_index}`);
        probe=null;
      });
    }
    assert.deepEqual([...exercised].sort(),sourceSkills.map(skill=>`${skill.actor_id}:${skill.original_skill_index}`).sort());
    assert.deepEqual([...expandedGroups].sort(),sourceSkills.filter(skill=>Buffer.from(skill.fixed_raw_hex,'hex')[0x24]===1).map(skill=>`${skill.actor_id}:${skill.original_skill_index}`).sort());
    assert.ok(expandedGroups.has('005:31'),'source physical group contact for 群袭落 reaches both enemies');
  }finally{view.nativeControl=null;view.nativeControlIsCurrent=null;view.destroy();}
});
async function worldFixture(){const seed=await json('data/opening_seed.json');seed.party.push(chapterRoleFromDefinition(seed.source.role_definitions['002']));seed.opening.status='complete';return new WorldStore(seed,['M72061','M70010']);}
test('Direct new-game attacks use their contact masks against every forest role and match original instructions and RNG',async()=>{
  const world=await worldFixture(),party=createPartySample(world.snapshot(),attributes,commands),actors=party.actors;
  for(const skill of Object.values(party.skills))for(const enemy of Object.values(data.forest.actors))for(const seed of [0,1,12345,0x20261011]){
    if(skill.effect_context||['native-revival','native-support'].includes(skill.battle_handler))continue; // Carrier and allied support have their own source oracles.
    const attacker=clone(actors.find(a=>a.id===skill.actor_id)),target=clone(enemy);
    const contact=skill.actions.find(a=>a.contact_u32_raw_0x49);
    attacker.current_skill=clone(skill);attacker.class_raw=contact.class_raw;attacker.action_mask_raw=contact.action_mask_raw;
    const actual=resolveAction({attacker,target,skill,rng:createNativeRng(seed)}),oracle=new NativeAssemblyOracle(assembly.functions,[attacker,target],createNativeRng(seed));
    const native=oracle.run(0x41d990,[0,1,0x20000000,0]);
    assert.equal(actual.native_return,native.eax,`${skill.id} against ${enemy.id}`);assert.equal(actual.reaction,oracle.read(0x20000000));
    assert.deepEqual(actual.trace.filter(r=>r.kind==='rng').map(r=>r.raw),native.rng_calls);
  }
});
test('New-game commands use the unified registry and reject a different actor source',async()=>{
  const world=await worldFixture(),bundle=clone(config);bundle.manifest.mode='debug';bundle.skills.entries.yantu.parameters.mp_cost=6;
  const configured=compileRuntimeConfiguration(data,bundle),sample=createPartySample(world.snapshot(),attributes,commands,configured);
  assert.equal(sample.skills.yantu.mp_cost,6);assert.equal(sample.skills.kai_mieyan.mp_cost,0);assert.equal(sample.skills.kai_suizu.mp_cost,0);
  const wrong=clone(commands);wrong.skills.kai_mieyan.actor_id='001';
  assert.throws(()=>createPartySample(world.snapshot(),attributes,wrong),/来源|技能|指纹|角色/);
});
test('Source party, complete contact reactions, two-person rewards and re-entry form one transaction',async()=>{
  const world=await worldFixture(),configured=compileRuntimeConfiguration(data,config);
  const sample=assembleForestSample(createPartySample(world.snapshot(),attributes,commands,configured),configured.forest,{map_id:'M70010',members:['012','013','013'].map(id=>({id}))},
    {...configured.scheduler,idle_skills:{...configured.scheduler.idle_skills,...commands.idle_skills}},configured.ai,configured.rewards,reaction,statuses);
  const ctx={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},save(){},restore(){},drawImage(){},fillText(){},createLinearGradient:()=>({addColorStop(){}})};
  const view=new BattleView({canvas:{width:960,height:540,getContext:()=>ctx},metadataPath:'/data/party_battle_view.json',jsonLoader:path=>json(path.slice(1)),assetLoader:async asset=>{
    const b=await readFile(new URL('../web/'+asset.path.slice(1),import.meta.url));
    assert.equal(createHash('sha256').update(b).digest('hex'),asset.sha256);assert.equal(b.readUInt32BE(16),asset.width);assert.equal(b.readUInt32BE(20),asset.height);
    return {image:{width:asset.width,height:asset.height,path:asset.path},sha256:asset.sha256};
  }});await view.prepare();view.setRoster(sample.actors,sample.skills);
  let clock=0;const events=[];
  const battle=new BattleController({world,resolveAction,applyDamage:applyNativeDamage,resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,
    id:()=> 'source-party-integration',now:()=>clock,waitTick:async()=>{clock+=20;},log:event=>events.push(event),playAction:async()=>{throw new Error('Complete source contact path expected');},
    playSequence:async(result,hooks)=>{
      const pending=view.playSequence(result,hooks);view.draw({actors:battle.state.actors},clock);let frames=0;
      while(view.run){assert.ok(++frames<20000,'Bounded source playback');clock+=20;battle.advanceClock();view.draw({actors:battle.state.actors},clock);}
      return pending;
    }});
  battle.start({...sample,rng:createNativeRng(0x20261011)});
  const before=world.snapshot();let actions=0,usedKai=false,usedSpell=false;
  while(battleActive(battle)&&actions++<30){
    const living=battle.players().filter(a=>a.hp.current>0),snow=battle.actor('enemy-0').hp.current>0;
    const selected=living.find(a=>a.id===(snow?'001':actions%2?'002':'001'))??living[0];
    if(!await commandReady(battle,selected.id))break;battle.selectPlayer(selected.id);const skill=selected.id==='002'?'kai_suizu':snow?'yancui':'yantu';usedKai||=selected.id==='002';usedSpell||=skill==='yancui';await chooseReady(battle,skill);
  }
  assert.ok(usedKai);assert.ok(usedSpell);assert.ok(events.some(e=>e.type==='battle-impact'&&e.effect_token===1&&e.damage>0));assert.equal(battle.snapshot().phase,'victory',JSON.stringify({actors:battle.snapshot().actors.map(a=>({id:a.id,hp:a.hp,state:a.state_raw,immune:a.immune_raw,busy:a.reaction_busy_raw,flags:a.status_flags_raw,skill:a.current_skill?.fixed_raw_hex.slice(0,2)})),events:events.filter(e=>e.type==='battle-impact').slice(-4).map(e=>({actor:e.actor_id,skill:e.skill_id,hit:e.hit,damage:e.damage,skipped:e.skipped}))}));assert.deepEqual(world.snapshot(),before);
  assert.equal(battle.snapshot().rewards.experience.length,2);
  const done=battle.finish();assert.equal(done.rewards_applied,true);assert.ok(Object.hasOwn(done.resources_by_actor,'002'));
  const once=world.snapshot();assert.deepEqual(battle.finish(),done);assert.deepEqual(world.snapshot(),once);
  const reloaded=await decodeSave(await encodeSave(once),['M72061','M70010']);assert.deepEqual(reloaded,once);
  const resumed=createPartyActors(reloaded,attributes);assert.equal(resumed.length,2);assert.equal(reloaded.reward_records.length,1);
});
