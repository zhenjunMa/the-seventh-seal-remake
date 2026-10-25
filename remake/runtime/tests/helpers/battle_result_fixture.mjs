// Active adapter of evidence/battle_result_20261020/fixtures/replay_fixture.mjs.
// The historical evidence stays frozen; this test helper follows runtime module migrations.
// Independent, read-only headless replay of a saved input. Never injects an
// outcome, damage value, enemy HP or a reward pool. This is not GAME.exe play.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {WorldStore,decodeSave,encodeSave} from '../../web/core/world.mjs';
import {BattleController} from '../../web/core/combat.mjs';
import {createPartySample} from '../../web/party_sample.mjs';
import {assembleForestSample} from '../../web/forest_sample.mjs';
import {partyResourcesForWorld,consumePartyMp} from '../../web/core/party_attributes.mjs';
import {resolveAction,applyNativeDamage,createNativeRng} from '../../web/core/combat_rules.mjs';
import {previewMovement} from '../../web/core/encounters.mjs';
import {loadRuntimeConfiguration,compileRuntimeConfiguration} from '../../web/core/runtime_config.mjs';
import {BattleView} from '../../web/battle_view.mjs';
import {MovementMap} from '../../web/core/movement.mjs';

const runtime=new URL('../../',import.meta.url);
const read=async path=>JSON.parse(await readFile(new URL(path,runtime),'utf8'));
const web=path=>read('web/'+path);
export async function replayFixture(save,{commandLimit=35}={}){
  const names={combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'party_rewards',party_skills:'party_skills',items:'items'};
  const data=Object.fromEntries(await Promise.all(Object.entries(names).map(async([key,name])=>[key,await web('data/'+name+'.json')])));
  [data.source_skills,data.source_magic]=await Promise.all(['skills','magic'].map(name=>web('data/library/'+name+'.json')));
  const [attributes,reactions,statuses,encounters]=await Promise.all(['party_combat','party_reactions','forest_status','encounters'].map(name=>web('data/'+name+'.json')));
  const configured=compileRuntimeConfiguration(data,await loadRuntimeConfiguration(web));
  assert.equal(configured.audit.mode,'original');assert.equal(configured.audit.differences.length,0);
  const world=new WorldStore(await decodeSave(save)),entry=world.snapshot(),map=new MovementMap((await web('data/maps/m70010.json')).movement);
  const moved=map.move(world.location.x,world.location.y,16,0);assert.ok(moved.moved&&!moved.blocked,'The actual forest terrain must accept the entry movement');
  world.setPosition(moved.x,moved.y,1);
  const movement=previewMovement(world.value.encounters,{party:world.value.party,leader_id:world.value.leader_id,map_id:world.location.map_id,dx:moved.x-entry.location.x,dy:moved.y-entry.location.y},encounters);
  assert.ok(movement.encounter,'One successful 16px movement must naturally trigger the controlled encounter');
  world.setEncounterState(movement.state);
  const sample=assembleForestSample(createPartySample(world.snapshot(),attributes,data.party_skills,configured,configured.items),configured.forest,movement.encounter,
    {...configured.scheduler,idle_skills:{...configured.scheduler.idle_skills,...data.party_skills.idle_skills}},configured.ai,configured.rewards,reactions,statuses);
  const context={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},save(){},restore(){},drawImage(){},fillText(){},createLinearGradient:()=>({addColorStop(){}})};
  const view=new BattleView({canvas:{width:960,height:540,getContext:()=>context},metadataPath:'/data/party_battle_view.json',lifecycleMetadataPath:'/data/battle_lifecycle.json',jsonLoader:path=>web(path.slice(1)),assetLoader:async asset=>{
    const path=asset.path.startsWith('/prototype/')?new URL('../prototype/web/'+asset.path.slice(11),runtime):new URL('web/'+asset.path.slice(1),runtime),bytes=await readFile(path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256,asset.path);
    return {image:{width:asset.width,height:asset.height,path:asset.path},sha256:asset.sha256};
  }});
  await view.prepare();view.setRoster(sample.actors,sample.skills);
  let clock=0,battle;const events=[],commands=[];
  const frame=()=>{clock+=20;battle.advanceClock();view.draw(battle.presentationSnapshot(),clock);for(const row of view.drainLifecycleCompleted())battle.ackLifecycle(row);};
  battle=new BattleController({world,resolveAction,applyDamage:applyNativeDamage,consumeResources:consumePartyMp,resourcesForWorld:partyResourcesForWorld,itemData:configured.items,
    now:()=>clock,waitTick:async()=>frame(),id:()=> 'independent-battle-result-20261020',log:event=>events.push(event),playAction:async()=>{throw new Error('Expected complete original source sequence');},
    playSequence:async(event,hooks)=>{const pending=view.playSequence(event,hooks);view.draw(battle.presentationSnapshot(),clock);let ticks=0;
      while(view.run){assert.ok(++ticks<20000,'Bounded source animation');frame();}return pending;}});
  const rng=createNativeRng(movement.state.rng_state);
  battle.start({...sample,lifecycle_enabled:true,rng,source:{...sample.source,rng_seed:movement.state.rng_state}});
  view.nativeControl=battle;view.nativeControlIsCurrent=()=>view.nativeControl===battle;
  async function pump(predicate){for(let ticks=0;ticks<120000;ticks++){if(predicate()||!['charging','command','action'].includes(battle.state.phase))return;frame();if(battle.actionTask)await battle.actionTask;}throw new Error('Bounded replay clock exceeded');}
  while(['charging','command','action'].includes(battle.state.phase)&&commands.length<commandLimit){
    const living=battle.players().filter(actor=>actor.hp.current>0),enemies=battle.state.actors.filter(actor=>actor.side==='enemy'&&actor.hp.current>0);
    const selected=living.find(actor=>actor.id==='001')??living[0];
    await pump(()=>battle.canCommand(selected.id));if(!battle.canCommand(selected.id))break;
    battle.selectPlayer(selected.id);
    const practiceYantu=selected.id==='001'&&entry.party.find(role=>role.id==='001').skill_progress?.records?.some(row=>row.index===22)&&!commands.some(row=>row.skill_id==='yantu');
    const spell=selected.id==='001'&&selected.mp.current>=battle.skills.yancui.mp_cost;
    const skill=selected.id==='002'?'kai_suizu':practiceYantu?'yantu':spell?'yancui':'yantu',target=enemies.find(actor=>actor.resource_id===(practiceYantu?'012':'011'))??enemies[0];
    commands.push({actor_id:selected.id,skill_id:skill,target_id:target.id,at_ms:clock});
    await battle.choose(skill,target.id);
    await pump(()=>!battle.running&&!battle.state.scheduler.pending);
  }
  if(battle.state.pending_outcome||battle.hasLifecycle())await pump(()=>!battle.hasLifecycle()&&!battle.state.pending_outcome);
  assert.equal(battle.state.phase,'victory',JSON.stringify({phase:battle.state.phase,error:battle.state.error,commands:commands.length,actors:battle.state.actors.map(a=>({id:a.id,hp:a.hp.current,mp:a.mp.current}))}));
  const plan=battle.prepareRewards(),final=battle.finish(),finished=world.snapshot(),finishedRng=rng.state;
  assert.deepEqual(battle.finish(),final);assert.deepEqual(world.snapshot(),finished);assert.equal(rng.state,finishedRng);
  assert.deepEqual(await decodeSave(await encodeSave(finished)),finished);
  return {scope:'Headless remake replay; real exported action records/assets and numeric original configuration, bounded 20ms frame clock, no native executable execution or browser pixels.',
    entry:{location:entry.location,encounters:entry.encounters},movement:{steps:movement.steps,encounter:movement.encounter,state:movement.state},original_configuration:{mode:configured.audit.mode,differences:configured.audit.differences},
    commands,elapsed_ms:clock,rng_after:rng.state,idempotent_finish:true,save_roundtrip:true,final:{battle_id:final.battle_id,outcome:final.outcome,rounds:final.rounds,actions:final.actions,world_revision:final.world_revision,resources_by_actor:final.resources_by_actor,rewards_applied:final.rewards_applied},summary:plan.summary,trace:plan.trace,
    impacts:events.filter(e=>e.type==='battle-impact').map(({actor_id,target_id,skill_id,hit,damage,hp_after,skipped})=>({actor_id,target_id,skill_id,hit,damage,hp_after,skipped})),
    party_after:world.value.party};
}
