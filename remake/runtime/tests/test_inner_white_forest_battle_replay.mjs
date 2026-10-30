// Actual sealed-forest041x2+024 group through the production scheduler, AI,
// BattleView clocks, reactions, death, rewards and private story transaction.
// Canvas is a bounded drawing adapter; PNG bytes/dimensions are checked, but
// this fixture makes no browser-pixel, live-audio or natural-campaign claim.
// Victory uses a development checkpoint grown to40 by the production source
// experience rules; no combat values or learned flags are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {admitPartyMember} from '../web/core/party_members.mjs';
import {applyExperience,progressHeaderForRole} from '../web/core/battle_rewards.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {assembleForestSample} from '../web/forest_sample.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {BattleView} from '../web/battle_view.mjs';
import {AppearanceParticles} from '../web/appearance_particles.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {resolveAction,applyNativeDamage} from '../web/core/combat_rules.mjs';
import {partyResourcesForWorld,consumePartyMp} from '../web/core/party_attributes.mjs';
import {deriveRuntimeConfiguration,compileRuntimeConfiguration} from '../web/core/runtime_config.mjs';
import {nativeScriptedBattle,beginScriptedBattle,commitScriptedBattle} from '../web/core/scripted_battle.mjs';
const copy=structuredClone,web=new URL('../web/',import.meta.url),read=async name=>JSON.parse(await readFile(new URL(`data/${name}.json`,web),'utf8'));
const [seed,story,attributes,commands,forest,scheduler,ai,rewards,reactions,status,items,combat]=await Promise.all([
 'opening_seed','chapter_story','party_combat','party_skills','forest_combat','battle_scheduler','forest_ai','party_rewards','party_reactions','forest_status','items','combat_sample'].map(read));
const original={combat,forest,scheduler,ai,rewards,party_skills:commands,items},configured=compileRuntimeConfiguration(original,deriveRuntimeConfiguration(original));
const group=nativeScriptedBattle(story.maps.M70078_2,story.maps.M70078_2.records.find(record=>record.id===6)),assets=new Map();
const context={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},save(){},restore(){},drawImage(){},fillText(){},createLinearGradient:()=>({addColorStop(){}})};
async function loadAsset(asset){
 if(assets.has(asset.path))return assets.get(asset.path);
 const bytes=await readFile(new URL(asset.path.replace(/^\//,''),web));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256,asset.path);
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
 assert.equal(width,asset.width);assert.equal(height,asset.height);
 const value={image:{width,height,path:asset.path},sha256:asset.sha256};assets.set(asset.path,value);return value;
}
test('appearance3 source callback and column motion match original550975/550F12 instruction execution',async()=>{
  const proof=JSON.parse(await readFile(new URL('../evidence/inner_white_forest_20261030/appearance_native.json',import.meta.url)));
  const functions=Object.fromEntries(proof.records.map(record=>[record.parameters.procedure,record.normalized_result.assembly]));
  const sprite=0x20000000,records=0x21000000,oracle=new NativeAssemblyOracle(functions,[],()=>0);
  oracle.write(sprite+0xdd,records);oracle.run(0x550975,[sprite,0,20,0xffff]);
  assert.equal(oracle.read(records+0x19),5);assert.equal(oracle.read(records+0x1d),0);
  assert.equal(oracle.read(records+0xc),0,'fresh zeroed target remains source zero');
  const effect=new AppearanceParticles({pixels:[{x:0,y:20,rgb:[255,255,255]},{x:1,y:20,rgb:[255,255,255]}],random:()=>0});
  assert.deepEqual(effect.particles.map(p=>[p.speed,p.y,p.life]),[[4,-20,5],[-4,60,5]]);
  oracle.write(0x5659104,1);oracle.write(0x67c3a0,640,2);oracle.write(0x67c3a2,480,2);
  oracle.write(0x56590fc,0x23000000);oracle.write(0x5659108,1280);
  oracle.write(sprite+0x47,1,2);oracle.write(sprite+0x49,1,2);oracle.write(sprite+0x4b,1);
  oracle.write(sprite+0x81,0);oracle.write(sprite+0x85,-32);oracle.write(sprite+0xc9,2);
  for(const [index,p]of effect.particles.entries())for(const [at,value]of [[0,p.x],[4,p.y],[0xc,p.target_y],[0x10,p.speed],[0x14,0xffff],[0x19,p.life],[0x1d,p.age]])oracle.write(records+index*0x21+at,value);
  for(let render=0;render<36;render++){
    const actual=effect.step(),native=oracle.run(0x550f12,[sprite,200,200,1,1,0,1]);
    assert.equal(Number(actual),native.eax,`render${render}`);
    effect.particles.forEach((p,index)=>{assert.equal(p.y,oracle.read(records+index*0x21+4));assert.equal(p.age,oracle.read(records+index*0x21+0x1d));});
  }
  assert.equal(effect.step(),false);
});

function checkpoint(victory){
 const draft=copy(seed);draft.opening.status='complete';draft.location={map_id:'M70078_2',x:528,y:736,direction:0};
 if(victory){
  for(const id of ['002','005'])admitPartyMember(draft,id);
  draft.party=draft.party.map(role=>{
   while(role.level<40){const raw=progressHeaderForRole(role,rewards),view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
    role=applyExperience(role,Math.max(1,view.getInt32(0x2c,true)-view.getInt32(0x28,true)),rewards,()=>0,[]).role;
   }return role;
  });
 }
 return new WorldStore(draft).snapshot();
}
async function replay(victory){
 const draft=checkpoint(victory),before=copy(draft),session=beginScriptedBattle(draft),world=session.world;
 const source=assembleForestSample(createPartySample(world.snapshot(),attributes,commands,configured,configured.items),configured.forest,group,
  {...configured.scheduler,idle_skills:{...configured.scheduler.idle_skills,...commands.idle_skills}},configured.ai,configured.rewards,reactions,status);
 const view=new BattleView({canvas:{width:960,height:540,getContext:()=>context},metadataPath:'/data/party_battle_view.json',
  lifecycleMetadataPath:'/data/battle_lifecycle.json',stageMetadataPath:'/'+runtimeContent.stages.stage03.path,assetLoader:loadAsset,
  jsonLoader:path=>read(path.replace(/^\/data\//,'').replace(/\.json$/,''))});
 await view.prepare({actors:source.actors});view.setRoster(source.actors,source.skills);
 // Use the fractional timestamps delivered by RAF. Integer20ms clocks hide
 // disagreement between absolute due times and elapsed-time subtraction.
 const clockOrigin=12.299999999999972;
 let now=clockOrigin,battle,error=null,submitted=0;const pending=new Set(),logs=[];
 battle=new BattleController({world,id:()=>victory?'seal-victory':'seal-defeat',now:()=>now,
  resolveAction,applyDamage:applyNativeDamage,resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,
  log:event=>logs.push(event),playSequence:(action,hooks)=>view.playSequence(action,hooks)});
 view.nativeControl=battle;view.nativeControlIsCurrent=()=>true;
 battle.start({...source,lifecycle_enabled:true,rng:session.rng});
 assert.deepEqual(group.members.map(member=>[member.id,member.source_slot]),[['041',0],['041',2],['024',4]]);
 assert.deepEqual(battle.state.actors.filter(actor=>actor.side==='enemy').map(actor=>actor.raw_hp),[5000,5000,15000]);
 const primary={'001':'001_25','002':'kai_duanyan','005':'005_22'};
 if(victory)for(const actor of source.actors.filter(actor=>actor.side==='player')){
  const skill=source.skills[primary[actor.id]];assert.ok(skill,`${actor.id} source-grown learned command`);
  assert.equal(actor.level,40);assert.equal(skill.learned_effective,true);assert.equal(skill.mp_cost,0);assert.equal(skill.battle_handler,'direct');
 }
 for(let tick=0;tick<90000;tick++){
  if(error)throw error;
  if(victory)for(const id of battle.readyPlayerIds())if(battle.canCommand(id)){
   battle.selectPlayer(id);const skill=primary[id];assert.ok(skill,`${id} source primary command`);
   const targets=battle.targetIdsForSkill(skill),target=targets.includes('enemy-2')?'enemy-2':targets[0];
   if(!battle.canChoose(skill)||!target)continue;
   const action=battle.choose(skill,target);submitted++;pending.add(action);
   action.then(()=>pending.delete(action),cause=>{error=cause;pending.delete(action);});
  }
  battle.advanceClock(now);view.draw(battle.presentationSnapshot(),now);
  for(const event of view.drainLifecycleCompleted())battle.ackLifecycle(event);
  assert.notEqual(battle.state.phase,'interrupted',battle.state.error);
  if(['victory','defeat'].includes(battle.state.phase)&&!battle.running&&!pending.size)break;
  // Include frames exactly on real primary/reaction/carrier deadlines, with
  // their original tail. RAF may land on those same fractional timestamps.
  const deadlines=[...view.detachedRuns,view.run].filter(run=>run?.sequence&&run.started!==null).flatMap(run=>
   view._sequenceChannels(run).filter(channel=>!channel.done&&!(channel===run&&run.main_done)).map(channel=>{
    const ending=channel.visited+1>=channel.steps.length;
    return run.started+(channel.next_at+(ending&&channel===run&&!run.independent_carriers?view.meta.policy.tail_ms:0));
   }));
  now=Math.min(now+1000/60,...deadlines.filter(at=>at>now));await new Promise(resolve=>setImmediate(resolve));
 }
 if(error)throw error;await Promise.all(pending);
 assert.equal(battle.state.phase,victory?'victory':'defeat',JSON.stringify({now,submitted,phase:battle.state.phase,z:battle.state.actors.map(actor=>[actor.id,actor.native_z_raw,actor.state_raw])}));
 assert.equal(battle.state.lifecycle_events.length,0);assert.equal(battle.pendingCarriers.size,0);
 assert.ok(battle.state.history.some(action=>action.actor_id==='enemy-2'));
 const supportActions=battle.state.history.filter(action=>['enemy-0','enemy-1'].includes(action.actor_id)
  &&action.skill_id===`${action.actor_id}_skill_21`&&battle.skills[action.skill_id].battle_handler==='native-support');
 if(victory)for(const action of supportActions){
  assert.equal(battle.actor(action.actor_id).resource_id,'041');
  assert.equal(battle.skills[action.skill_id].fixed_raw_hex,configured.ai.roles['041'].skills[21].fixed_raw_hex);
  assert.ok(action.contacts.length>0);
  for(const contact of action.contacts){
   assert.equal(contact.source.source_skill_index,21);assert.equal(contact.after.target.side,'enemy');
   assert.equal(contact.result.supported,true);assert.equal(contact.result.native_return,1);
   assert.equal(contact.result.hp_delta,Math.min(1000,contact.before.target.hp.maximum-contact.before.target.hp.current));
   assert.equal(contact.after.target.hp.current-contact.before.target.hp.current,contact.result.hp_delta);
  }
 }
 assert.ok(battle.state.history.every(action=>action.contacts.length>0));
 assert.deepEqual(draft,before,'combat cannot independently publish its enclosing story draft');
 const rng=session.rng.state,result=battle.finish(),finished=world.snapshot();assert.deepEqual(battle.finish(),result);assert.equal(session.rng.state,rng);
 if(victory){
  assert.equal(result.rewards_applied,true);assert.equal(finished.reward_records.length,1);
  assert.ok(result.rewards.experience.every(row=>row.experience===1800));
  assert.equal(result.rewards.money,0);commitScriptedBattle(draft,session,result);
  assert.equal(draft.encounters.rng_state,session.rng.state);
  const restored=await decodeSave(await encodeSave(draft));assert.deepEqual(restored.reward_records,draft.reward_records);
  assert.deepEqual(restored.party,draft.party);assert.deepEqual(restored.inventory,draft.inventory);
 }else{
  assert.equal(result.rewards_applied,false);assert.ok(battle.players().every(actor=>[5,7].includes(actor.state_raw)));
  assert.throws(()=>commitScriptedBattle(draft,session,result),/正常返回/);assert.deepEqual(draft,before);
 }
 assert.ok(logs.some(event=>event.type==='battle-source-completed'));
 return {actions:battle.state.action_count,submitted,elapsed_ms:now-clockOrigin,assets:assets.size,native_support_actions:supportActions.length};
}
test('actual041x2+024 source-growth level40 checkpoint wins with learned commands, source rewards, one story merge and save reload',async context=>{
 context.diagnostic(JSON.stringify(await replay(true)));
});
test('actual041x2+024 group defeats the unassisted party after source death presentations and rolls back its story draft',async()=>{
 await replay(false);
});
