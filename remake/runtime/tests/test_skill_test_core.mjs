// Source-backed test-global gates use the retained x86 instruction oracle.
// Core timing uses explicit animation callbacks, never GAME.exe execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BattleController} from '../web/core/combat.mjs';
import {createNativeRng,resolveAction,applyNativeDamage} from '../web/core/combat_rules.mjs';
import {WorldStore} from '../web/core/world.mjs';
import {createForestSample} from '../web/forest_sample.mjs';
import {consumeBattleMp} from '../web/combat_sample.mjs';
import {partyResourcesForWorld} from '../web/core/party_attributes.mjs';
import {deriveRuntimeConfiguration,compileRuntimeConfiguration} from '../web/core/runtime_config.mjs';
import {compileNativeSequence} from '../web/core/skill_sequence.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
const read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name+'.json',import.meta.url)));
const names={combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'forest_rewards',party_skills:'party_skills',items:'items'};
const data=Object.fromEntries(await Promise.all(Object.entries(names).map(async([key,name])=>[key,await read(name)])));
const [seed,meta,reactions,statuses]=await Promise.all(['route_seed','enemy_battle_view','enemy_reactions','forest_status'].map(read));
const assembly=JSON.parse(await readFile(new URL('../evidence/turn_rules_assembly_20261011.json',import.meta.url))),copy=structuredClone;
function fixture({testMode=true,complete=true,enemyHp=null,party2=false,playReactions=false}={}){
  const config=deriveRuntimeConfiguration(data);config.manifest.mode='debug';config.skills.entries.yanci.parameters.mp_cost=7;
  const configured=compileRuntimeConfiguration(data,config),world=new WorldStore(copy(seed),['M17010','M70010']),sample=createForestSample(world.snapshot(),configured.combat,configured.forest,{map_id:'M70010',members:[{id:'012'},{id:'011'},{id:'013'}]},null,configured.scheduler,
    complete?configured.ai:null,complete?configured.rewards:null,complete?reactions:null,complete?statuses:null);
  if(party2){sample.actors.splice(1,0,{...copy(sample.actors[0]),id:'002',resource_id:'001',name:'second actor command fixture'});sample.order=sample.actors.map(a=>a.id);}
  if(enemyHp!==null)for(const actor of sample.actors.filter(a=>a.side==='enemy')){actor.raw_hp=enemyHp;actor.raw_by_address['0x0524a701']=enemyHp;actor.hp.current=enemyHp;}
  const logs=[],contacts=[],presented=[],consumed=[];let now=0,draws=0,battle;
  battle=new BattleController({world,id:()=> 'skill-test-core',now:()=>now,waitTick:async()=>{now+=20;},resolveAction,applyDamage:applyNativeDamage,itemData:configured.items,
    resourcesForWorld:partyResourcesForWorld,consumeResources:(actor,cost)=>{consumed.push(cost);return consumeBattleMp(actor,cost);},log:e=>logs.push(e),
    playAction:async(event,{onImpact})=>{presented.push(copy(event));onImpact();onImpact();},
    playSequence:async(event,hooks)=>{
      presented.push(copy(event));const actor=battle.actor(event.actor_id),compiled=compileNativeSequence(meta,actor.resource_id??actor.id,event.plan);
      for(const [index,step]of compiled.steps.entries()){
        hooks.onRecord(step);
        if(!step.event)continue;
        const source={...step,contact_key:event.action_id+':'+index},before=draws,result=hooks.onContact(source);
        assert.deepEqual(hooks.onContact(source),result);contacts.push({actor_id:actor.id,target_id:event.target_id,result:copy(result),draws:draws-before});
        if(result.reaction_descriptor){
          const reaction=result.reaction_descriptor;
          if(playReactions){
            const responder=battle.actor(reaction.actor_id),sequence=compileNativeSequence(meta,responder.resource_id??responder.id,reaction.plan);
            for(const [ri,responseStep]of sequence.steps.entries()){
              hooks.onReactionRecord(responseStep,reaction);if(!responseStep.event)continue;
              const counter=hooks.onReactionContact({...responseStep,contact_key:reaction.token+':'+ri},reaction);contacts.push({actor_id:responder.id,target_id:reaction.target_id,result:copy(counter)});
            }
          }
          hooks.onReactionEnd(reaction,true);
        }
      }
      hooks.onPrimaryEnd();
    }});
  battle.start({...sample,test_mode:testMode,rng:()=>{draws++;return 0;}});
  for(const actor of battle.state.actors.filter(a=>a.side==='enemy'))actor.charge.delay=1000000;
  return {battle,world,logs,contacts,presented,consumed,draws:()=>draws,async tick(){await battle.waitTick();battle.advanceClock();if(battle.actionTask)await battle.actionTask;},ready(){Object.assign(battle.actor('001').charge,{gauge:battle.state.scheduler.threshold,delay:0,recovery:0});}};
}

test('Skill-test HP submission follows the original 5005C0 global gate for both sides without death or raw HP writes',()=>{
  const f=fixture({complete:false});
  for(const member of [f.battle.actor('001'),f.battle.actor('enemy-0')])for(const global of [0,1])for(const damage of [0,1,member.hp.current,member.hp.current+1]){
    const actor=copy(member),before=copy(actor),result={damage,after_settled_raw:actor.settled_raw},actual=applyNativeDamage(actor,result,{global_055ee004:global});
    const oracle=new NativeAssemblyOracle(assembly.functions,[actor],()=>assert.fail('HP submission must not draw'));oracle.write(0x055ee004,global);oracle.run(0x5005c0,[-1,0,damage]);
    assert.equal(actual.raw_hp,oracle.read(0x524a701));assert.equal(actual.state_raw,oracle.read(0x521a77b,1));assert.equal(actual.status_by_address['0x0521f551'],oracle.read(0x521f551));assert.deepEqual(actor,before);
    if(global)assert.deepEqual(actual,before);
  }
});

test('Native test-global contact rejects player targets before RNG while enemy hits retain the normal instruction/RNG result',()=>{
  const f=fixture({complete:false}),player=f.battle.actor('001'),enemy=f.battle.actor('enemy-0');
  for(const [attacker,target,skill]of [[player,enemy,f.battle.skills.yanci],[enemy,player,f.battle.skills[f.battle.state.enemy_skill_ids[enemy.id]]]])for(const global of [0,1]){
    const actual=resolveAction({attacker,target,skill,rng:createNativeRng(12345),context:{global_055ee004:global}}),a=copy(attacker);a.current_skill=copy(skill);
    const oracle=new NativeAssemblyOracle(assembly.functions,[a,target],createNativeRng(12345));oracle.write(0x055ee004,global);const native=oracle.run(0x41d990,[0,1,0x20000000,0]);
    assert.equal(actual.native_return,native.eax);assert.deepEqual(actual.trace.filter(r=>r.kind==='rng').map(r=>r.raw),native.rng_calls);
    if(global&&target.side_raw){assert.equal(actual.reason,'native-global-gate');assert.equal(actual.native_return,-1);assert.deepEqual(actual.trace,[]);}
  }
});

test('Full source contacts still display calculated lethal damage, consume normal gauge/debt, and preserve both raw resources in skill-test',async()=>{
  const f=fixture({enemyHp:1}),player=f.battle.actor('001'),initialPlayer=copy({hp:player.raw_hp,mp:player.raw_mp}),initialEnemies=f.battle.state.actors.filter(a=>a.side==='enemy').map(a=>[a.id,a.raw_hp]);
  assert.equal(f.battle.presentationSnapshot().test_mode,true);assert.equal(f.battle.state.reward_ledger,undefined);
  for(let i=0;i<3;i++){f.ready();await f.battle.choose('yanci','enemy-2');assert.ok(f.contacts.at(-1).result.damage>1);assert.equal(f.contacts.at(-1).result.death,false);assert.equal(f.battle.actor('enemy-2').hp.current,1);assert.equal(player.charge.gauge,-f.battle.state.scheduler.threshold);assert.ok(player.charge.delay>0);}
  assert.deepEqual([player.raw_hp,player.raw_mp],[initialPlayer.hp,initialPlayer.mp]);assert.deepEqual(f.consumed,[]);assert.equal(f.battle.state.outcome,null);assert.equal(f.battle.state.actors.some(a=>a.state_raw>=4),false);
  assert.deepEqual(f.battle.state.actors.filter(a=>a.side==='enemy').map(a=>[a.id,a.raw_hp]),initialEnemies);
  f.battle.state.round=101;f.ready();await f.battle.choose('yanci','enemy-2');assert.equal(f.battle.state.round,102);
});

test('Skill-test targets keep charging without proactive commands or AI draws; ordinary encounters still dispatch their ready enemies',async()=>{
  const f=fixture(),enemy=f.battle.actor('enemy-0'),player=f.battle.actor('001'),hp=copy(player.hp),mp=copy(player.mp),before=player.charge.gauge;
  Object.assign(enemy.charge,{gauge:f.battle.state.scheduler.threshold,delay:0});const gauge=enemy.charge.gauge,draws=f.draws();for(let i=0;i<4;i++)await f.tick();
  assert.deepEqual(f.presented,[]);assert.deepEqual(f.contacts,[]);assert.equal(f.draws(),draws);assert.ok(enemy.charge.gauge>gauge);
  assert.deepEqual(player.hp,hp);assert.deepEqual(player.mp,mp);assert.ok(player.charge.gauge>before);assert.equal(f.battle.state.outcome,null);
  const normal=fixture({testMode:false}),active=normal.battle.actor('enemy-0');Object.assign(active.charge,{gauge:normal.battle.state.scheduler.threshold,delay:0});await normal.tick();assert.ok(normal.presented.some(event=>event.actor_id===active.id));assert.ok(normal.contacts.length);assert.ok(normal.draws()>0);
});

test('Passive test targets retain their source counter reaction path and its player contact uses the same test-global immunity',async()=>{
  const f=fixture({playReactions:true}),target=f.battle.actor('enemy-2'),player=f.battle.actor('001'),hp=player.hp.current,resolve=f.battle.resolveAction;
  // Admit a synthetic primary dodge to exercise source counter selection and
  // its actual source contact; this does not assert a native dodge probability.
  target.status_by_address['0x0521f5a9']=100;
  f.battle.resolveAction=input=>input.attacker.side==='player'?{hit:false,damage:0,reaction:2,native_return:0,after_settled_raw:0,mp_cost:input.skill.mp_cost,trace:[]}:resolve(input);
  f.ready();await f.battle.choose('yanci',target.id);
  assert.ok(f.contacts.some(c=>c.actor_id===player.id&&c.result.reaction_descriptor?.kind==='counter'));
  const counter=f.contacts.find(c=>c.actor_id===target.id);assert.ok(counter);assert.equal(counter.result.reason,'native-global-gate');assert.equal(counter.result.native_return,-1);assert.equal(player.hp.current,hp);assert.equal(f.battle.state.outcome,null);
});

test('Skill-test retains original MP admission and normal mode still pays the configured cost and loses HP',async()=>{
  const training=fixture({complete:false}),player=training.battle.actor('001');training.ready();player.mp.current=6;assert.equal(training.battle.canChoose('yanci'),false);await assert.rejects(training.battle.choose('yanci'),/资源不足/);
  const normal=fixture({testMode:false}),enemy=normal.battle.actor('enemy-2'),hp=enemy.hp.current,mp=normal.battle.actor('001').mp.current;normal.ready();await normal.battle.choose('yanci','enemy-2');
  assert.equal(normal.battle.actor('001').mp.current,mp-7);assert.ok(enemy.hp.current<hp);assert.deepEqual(normal.consumed,[7]);assert.equal(normal.battle.presentationSnapshot().test_mode,false);
});

test('Medicine still consumes inventory and restores resources, reported for caller submission; escape succeeds without RNG and core finish is idempotent',async()=>{
  const f=fixture({complete:false}),saved=f.world.snapshot(),tea=f.battle.items().find(i=>i.id===12),quantity=tea.quantity;f.world.transact=()=>assert.fail('Skill-test must never commit into its supplied world');
  const player=f.battle.actor('001');player.raw_mp=0;player.raw_by_address['0x0524a709']=0;player.mp.current=player.resource_bonuses.mp_current;
  f.ready();await f.battle.chooseItem(tea.instance_id,player.id);assert.equal(f.battle.items().find(i=>i.id===12).quantity,quantity-1);assert.ok(player.raw_mp>0);
  f.ready();const draws=f.draws();await f.battle.chooseEscape();assert.equal(f.draws(),draws);assert.equal(f.battle.state.phase,'escaped');
  const result=f.battle.finish();assert.equal(result.test_mode,true);assert.equal(result.rewards_applied,false);assert.equal(result.rewards,null);assert.equal(result.resources_by_actor['001'].mp,player.raw_mp>>>0);assert.equal(f.battle.snapshot().inventory.find(i=>i.id===12).quantity,quantity-1);assert.deepEqual(f.world.snapshot(),saved);assert.deepEqual(f.battle.finish(),result);assert.deepEqual(f.world.snapshot(),saved);
  assert.equal(f.logs.filter(e=>e.type==='battle-test-finished').length,1);assert.equal(f.logs.some(e=>e.type==='battle-world-commit'),false);
});

test('One escape confirmation ends the requested skill-test session for a two-person party without making the other member escape',async()=>{
  const f=fixture({complete:false,party2:true}),saved=f.world.snapshot(),other=f.battle.actor('002');f.ready();const draws=f.draws();await f.battle.chooseEscape();
  assert.equal(f.battle.state.phase,'escaped');assert.equal(f.battle.state.outcome,'escaped');assert.equal(f.battle.actor('001').state_raw,11);assert.equal(other.state_raw,0);assert.equal(f.draws(),draws);
  assert.equal(f.battle.state.test_exit_requested,true);assert.equal(f.battle.finish().outcome,'escaped');assert.deepEqual(f.world.snapshot(),saved);
});
