// Complete original042 fights through the normal scheduler, source AI,
// BattleView clocks, reactions, death, rewards and private story transaction.
// Canvas is a bounded drawing adapter; PNG bytes/dimensions are checked, but
// this fixture makes no browser-pixel, live-audio or natural-campaign claim.
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
import {resolveAction,applyNativeDamage} from '../web/core/combat_rules.mjs';
import {partyResourcesForWorld,consumePartyMp} from '../web/core/party_attributes.mjs';
import {deriveRuntimeConfiguration,compileRuntimeConfiguration} from '../web/core/runtime_config.mjs';
import {nativeScriptedBattle,beginScriptedBattle,commitScriptedBattle} from '../web/core/scripted_battle.mjs';
const copy=structuredClone,web=new URL('../web/',import.meta.url),read=async name=>JSON.parse(await readFile(new URL(`data/${name}.json`,web),'utf8'));
const [seed,story,attributes,commands,forest,scheduler,ai,rewards,reactions,status,items,combat]=await Promise.all([
 'opening_seed','chapter_story','party_combat','party_skills','forest_combat','battle_scheduler','forest_ai','party_rewards','party_reactions','forest_status','items','combat_sample'].map(read));
const original={combat,forest,scheduler,ai,rewards,party_skills:commands,items},configured=compileRuntimeConfiguration(original,deriveRuntimeConfiguration(original));
const group=nativeScriptedBattle(story.maps.M71013,story.maps.M71013.records.find(record=>record.id===5)),assets=new Map();
const context={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},save(){},restore(){},drawImage(){},fillText(){},createLinearGradient:()=>({addColorStop(){}})};
async function loadAsset(asset){
 if(assets.has(asset.path))return assets.get(asset.path);
 const bytes=await readFile(new URL(asset.path.replace(/^\//,''),web));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256,asset.path);
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
 assert.equal(width,asset.width);assert.equal(height,asset.height);
 const value={image:{width,height,path:asset.path},sha256:asset.sha256};assets.set(asset.path,value);return value;
}
function checkpoint(victory){
 const draft=copy(seed);draft.opening.status='complete';draft.location={map_id:'M71013',x:832,y:800,direction:0};
 if(victory){
  for(const id of ['002','003','004'])admitPartyMember(draft,id);
  draft.party=draft.party.map(role=>{
   while(role.level<24){const raw=progressHeaderForRole(role,rewards),view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
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
  lifecycleMetadataPath:'/data/battle_lifecycle.json',stageMetadataPath:'/'+runtimeContent.stages.stage07.path,assetLoader:loadAsset,
  jsonLoader:path=>read(path.replace(/^\/data\//,'').replace(/\.json$/,''))});
 await view.prepare({actors:source.actors});view.setRoster(source.actors,source.skills);
 let now=0,battle,error=null,submitted=0;const pending=new Set(),logs=[];
 battle=new BattleController({world,id:()=>victory?'ember042-victory':'ember042-defeat',now:()=>now,
  resolveAction,applyDamage:applyNativeDamage,resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,
  log:event=>logs.push(event),playSequence:(action,hooks)=>view.playSequence(action,hooks)});
 view.nativeControl=battle;view.nativeControlIsCurrent=()=>true;
 battle.start({...source,lifecycle_enabled:true,rng:session.rng});
 assert.equal(battle.actor('enemy-0').raw_hp,7200);
 const primary=Object.fromEntries(source.actors.filter(actor=>actor.side==='player').map(actor=>[actor.id,
  Object.values(source.skills).find(skill=>skill.actor_id===actor.id&&skill.battle_handler==='direct'&&skill.mp_cost===0)?.id]));
 for(let tick=0;tick<90000;tick++){
  if(error)throw error;
  if(victory)for(const id of battle.readyPlayerIds())if(battle.canCommand(id)){
   battle.selectPlayer(id);const skill=primary[id];assert.ok(skill,`${id} source primary command`);
   if(!battle.canChoose(skill)||!battle.targetIdsForSkill(skill).includes('enemy-0'))continue;
   const action=battle.choose(skill,'enemy-0');submitted++;pending.add(action);
   action.then(()=>pending.delete(action),cause=>{error=cause;pending.delete(action);});
  }
  battle.advanceClock(now);view.draw(battle.presentationSnapshot(),now);
  for(const event of view.drainLifecycleCompleted())battle.ackLifecycle(event);
  assert.notEqual(battle.state.phase,'interrupted',battle.state.error);
  if(['victory','defeat'].includes(battle.state.phase)&&!battle.running&&!pending.size)break;
  now+=20;await new Promise(resolve=>setImmediate(resolve));
 }
 if(error)throw error;await Promise.all(pending);
 assert.equal(battle.state.phase,victory?'victory':'defeat',JSON.stringify({now,submitted,phase:battle.state.phase,z:battle.state.actors.map(actor=>[actor.id,actor.native_z_raw,actor.state_raw])}));
 assert.equal(battle.state.lifecycle_events.length,0);assert.equal(battle.pendingCarriers.size,0);
 assert.ok(battle.state.history.some(action=>action.actor_id==='enemy-0'));
 assert.ok(battle.state.history.every(action=>action.contacts.length>0));
 assert.deepEqual(draft,before,'combat cannot independently publish its enclosing story draft');
 const rng=session.rng.state,result=battle.finish(),finished=world.snapshot();assert.deepEqual(battle.finish(),result);assert.equal(session.rng.state,rng);
 if(victory){
  assert.equal(result.rewards_applied,true);assert.equal(finished.reward_records.length,1);
  assert.ok(result.rewards.experience.every(row=>row.experience===450));
  assert.equal(result.rewards.money,0);commitScriptedBattle(draft,session,result);
  assert.equal(draft.encounters.rng_state,session.rng.state);
  const restored=await decodeSave(await encodeSave(draft));assert.deepEqual(restored.reward_records,draft.reward_records);
  assert.deepEqual(restored.party,draft.party);assert.deepEqual(restored.inventory,draft.inventory);
 }else{
  assert.equal(result.rewards_applied,false);assert.ok(battle.players().every(actor=>[5,7].includes(actor.state_raw)));
  assert.throws(()=>commitScriptedBattle(draft,session,result),/正常返回/);assert.deepEqual(draft,before);
 }
 assert.ok(logs.some(event=>event.type==='battle-source-completed'));
 return {actions:battle.state.action_count,submitted,elapsed_ms:now,assets:assets.size};
}
test('actual042 source AI and all contacts complete victory, source rewards, one private story merge and save reload',async()=>{
 await replay(true);
});
test('actual042 source AI defeats the unassisted source party after death presentations and rolls back its story draft',async()=>{
 await replay(false);
});
