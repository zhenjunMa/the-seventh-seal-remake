import {battleActive,chooseReady} from './helpers/battle_clock.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileRuntimeConfiguration,loadRuntimeConfiguration,expandRuntimeConfiguration,createRuntimeConfigurationSession} from '../web/core/runtime_config.mjs';
import {createServicesController} from '../web/controllers/services.mjs';
import {createPartyActors} from '../web/core/party_attributes.mjs';
import {exportRuntimeConfiguration} from '../tools/export_runtime_config.mjs';
import {createBattleSample,consumeBattleMp,resourcesForWorld} from '../web/combat_sample.mjs';
import {createForestSample} from '../web/forest_sample.mjs';
import {createNativeRng,resolveAction,applyNativeDamage} from '../web/core/combat_rules.mjs';
import {initializeScheduler,dispatchCharge} from '../web/core/battle_scheduler.mjs';
import {selectNativeSkills,planForestEnemyAction} from '../web/core/forest_ai.mjs';
import {createRewardLedger,collectEnemyDefeat,planVictoryRewards} from '../web/core/battle_rewards.mjs';
import {composeNativeSequence,compileNativeSequence} from '../web/core/skill_sequence.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {BattleView} from '../web/battle_view.mjs';
import {supportedBattleRecoverySkills} from '../web/core/battle_skill_access.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
const copy=structuredClone,web=new URL('../web/',import.meta.url),read=async name=>JSON.parse(await readFile(new URL('data/'+name,web),'utf8'));
const [base,forest,scheduler,ai,rewards,seed,meta]=await Promise.all(['combat_sample.json','forest_combat.json','battle_scheduler.json','forest_ai.json','forest_rewards.json','route_seed.json','enemy_battle_view.json'].map(read));
const data={combat:base,forest,scheduler,ai,rewards,party_skills:await read('party_skills.json'),items:await read('items.json')},config=await loadRuntimeConfiguration(p=>read(p.slice(5))),maps=['M01010','M01030','M17010','M70010'];
data.source_skills=await read('library/skills.json');
data.source_magic=await read('library/magic.json');
const debug=()=>({...expandRuntimeConfiguration(data,config),manifest:{...copy(config.manifest),mode:'debug'}});
function sample(c,ids=['012'],world=seed){const d=compileRuntimeConfiguration(data,c);return createForestSample(world,d.combat,d.forest,{map_id:'M70010',members:ids.map(id=>({id}))},null,d.scheduler,d.ai,d.rewards);}
const byte=(s,p)=>Buffer.from(s.fixed_raw_hex,'hex')[p];
const draws=values=>{let i=0;return()=>{assert.ok(i<values.length,'unexpected RNG');return values[i++];};};

test('config loader uses one manifest and four dedicated files, rejects arbitrary paths before reads',async()=>{
  const requests=[],options=[];const loaded=await loadRuntimeConfiguration(async(p,o)=>{requests.push(p);options.push(o);return read(p.slice(5));});
  assert.deepEqual(loaded,config);assert.deepEqual(requests,['data/config/index.json','data/config/skills.json','data/config/battle.json','data/config/rewards.json','data/config/items.json']);
  assert.deepEqual(options,Array.from({length:5},()=>({cache:'no-store'})));
  await assert.rejects(loadRuntimeConfiguration(async()=>({...config.manifest,files:{...config.manifest.files,skills:'../skills.json'}})),/路径/);
});
test('startup session preserves both reward profiles and isolates every returned runtime snapshot',async()=>{
  const partyRewards=await read('party_rewards.json'),cfg=copy(config);cfg.manifest.mode='debug';
  cfg.skills.entries.yantu.parameters.mp_cost=5;
  cfg.rewards.entries['013'].parameters={experience:123,money:25,drop_item_ids:[242,242]};
  cfg.items.entries['242'].parameters.drop_rate=100;
  const session=createRuntimeConfigurationSession(data,cfg,partyRewards);
  const legacy=compileRuntimeConfiguration(data,cfg),native=compileRuntimeConfiguration({...data,rewards:partyRewards},cfg);
  assert.deepEqual(session.snapshot('legacy'),legacy);
  assert.deepEqual(session.snapshot('native-new-game'),native);
  const first=session.snapshot('native-new-game');
  first.skill_registry.yantu.mp_cost=999;first.forest.actors['012'].hp.current=0;
  first.items.definitions['242'].drop_rate=-1;first.rewards.enemies['013'].reward_slots.fill(0);
  first.rewards.initial_roles['001'].header_raw_hex='00';first.rewards.tables.growth_rows[0][0]=999;
  assert.deepEqual(session.snapshot('native-new-game'),native);
  assert.deepEqual(session.snapshot('legacy'),legacy);
  const drift=copy(partyRewards);drift.enemies['013'].experience++;
  assert.throws(()=>createRuntimeConfigurationSession(data,cfg,drift),/奖励来源不同/);
  drift.enemies=partyRewards.enemies;drift.source_hashes['GAME.exe']='0'.repeat(64);
  assert.throws(()=>createRuntimeConfigurationSession(data,cfg,drift),/奖励来源指纹不同/);
});
test('services read configuration once at startup; rewards and restored progress stay live until page refresh reloads edits',async t=>{
  const files=copy(config);files.manifest.mode='debug';files.skills.entries.yantu.parameters.mp_cost=5;
  files.rewards.entries['013'].parameters={experience:1,money:25,drop_item_ids:[242,242]};
  files.items.entries['242'].parameters.drop_rate=100;
  const requests=[],byPath=()=>Object.fromEntries(Object.entries({manifest:'index',skills:'skills',battle:'battle',rewards:'rewards',items:'items'})
    .map(([key,name])=>[`data/config/${name}.json`,files[key]]));
  t.mock.method(globalThis,'fetch',async(path,options)=>{requests.push({path,options});return {ok:true,json:async()=>copy(byPath()[path])};});
  const nativeSeed=await read('opening_seed.json'),attributes=await read('party_combat.json');
  const state={catalog:{},world:new WorldStore(nativeSeed,['M72061']),battleData:data.combat,forestData:data.forest,
    schedulerData:data.scheduler,aiData:data.ai,rewardData:data.rewards,partyRewards:await read('party_rewards.json'),
    partySkills:data.party_skills,sourceItemData:data.items,sourceSkills:data.source_skills,sourceMagic:data.source_magic};
  const services=createServicesController({state,actions:{}});
  await assert.rejects(services.readConfiguredData(),/尚未初始化/);
  const [initial,concurrent]=await Promise.all([services.initializeRuntimeConfiguration(),services.initializeRuntimeConfiguration()]);
  assert.equal(requests.length,5);assert.notEqual(initial,concurrent);
  assert.equal(initial.skill_registry.yantu.mp_cost,5);
  const beforeHp=createPartyActors(state.world.snapshot(),attributes,{},initial.items)[0].hp.current;
  const actors=[{id:'001',side:'player',hp:{current:beforeHp},state_raw:0,immune_raw:0},
    {id:'enemy-0',resource_id:'013',side:'enemy',hp:{current:0},state_raw:5}],ledger=createRewardLedger('cached-rewards',actors);
  collectEnemyDefeat(ledger,actors[1],{data:initial.rewards});
  const plan=planVictoryRewards({world:state.world.snapshot(),ledger,data:initial.rewards,rng:draws([99,99]),actors});
  state.world.transact(next=>{Object.assign(next,plan.world_patch);next.reward_records=[plan.reward_record];next.party[0].hp.current-=3;});
  state.world=new WorldStore(await decodeSave(await encodeSave(state.world.snapshot()),['M72061']),['M72061']);
  files.skills.entries.yantu.parameters.mp_cost=9;
  initial.skill_registry.yantu.mp_cost=777;
  const next=await services.readConfiguredData();
  assert.equal(requests.length,5);assert.equal(next.skill_registry.yantu.mp_cost,5);
  assert.equal(state.world.value.inventory.find(item=>item.id===242).quantity,2);
  assert.equal(createPartyActors(state.world.snapshot(),attributes,{},next.items)[0].hp.current,beforeHp-3);
  const nativeWorld=state.world;state.world={value:{source:{kind:'legacy'}}};
  assert.equal((await services.readConfiguredData()).rewards.schema,'seventh-seal-forest-rewards');
  state.world=nativeWorld;assert.equal((await services.readConfiguredData()).rewards.schema,'seventh-seal-party-rewards');
  assert.equal(requests.length,5);
  // A fresh controller represents a refreshed page. Title/new-game/load reuse
  // the existing controller and therefore never opt into the edited files.
  const refreshed=createServicesController({state,actions:{}}),afterRefresh=await refreshed.initializeRuntimeConfiguration();
  assert.equal(requests.length,10);assert.equal(afterRefresh.skill_registry.yantu.mp_cost,9);
});
test('failed startup exposes no configuration and requires a refreshed owner after files are corrected',async t=>{
  const files=copy(config),requests=[];files.skills.source_hashes['Fight_Role/001.CHR']='0'.repeat(64);
  const byPath=Object.fromEntries(Object.entries({manifest:'index',skills:'skills',battle:'battle',rewards:'rewards',items:'items'})
    .map(([key,name])=>[`data/config/${name}.json`,key]));
  t.mock.method(globalThis,'fetch',async path=>{requests.push(path);return {ok:true,json:async()=>copy(files[byPath[path]])};});
  const state={catalog:{},world:{value:{source:{kind:'native-new-game'}}},battleData:data.combat,forestData:data.forest,
    schedulerData:data.scheduler,aiData:data.ai,rewardData:data.rewards,partyRewards:await read('party_rewards.json'),
    partySkills:data.party_skills,sourceItemData:data.items,sourceSkills:data.source_skills,sourceMagic:data.source_magic};
  const services=createServicesController({state,actions:{}});
  await assert.rejects(services.initializeRuntimeConfiguration(),/来源指纹/);
  files.skills=copy(config.skills);
  await assert.rejects(services.readConfiguredData(),/来源指纹/);
  await assert.rejects(services.initializeRuntimeConfiguration(),/来源指纹/);
  assert.equal(requests.length,5);
  const refreshed=createServicesController({state,actions:{}});
  assert.equal((await refreshed.initializeRuntimeConfiguration()).audit.mode,'original');assert.equal(requests.length,10);
});
test('default profile covers all admitted skills, three enemies, six drops and retains numeric source bytes',()=>{
  const before=copy(data),cfgBefore=copy(config),d=compileRuntimeConfiguration(data,config);
  assert.equal(Object.keys(config.skills.entries).length,Object.keys(data.source_skills.skills).length+Object.keys(data.source_magic.magic).length);
  const expectedIds=[...Object.keys({...data.party_skills.skills,...data.party_skills.field_skills,...supportedBattleRecoverySkills(data.party_skills)}),
    ...Object.entries(data.ai.roles).flatMap(([id,role])=>role.learned_indices.map(index=>`${id}_${index}`))];
  assert.deepEqual(Object.keys(d.skill_registry).sort(),expectedIds.sort());assert.deepEqual(Object.keys(config.rewards.entries).sort(),Object.keys(forest.actors).sort());assert.equal(Object.keys(config.items.entries).length,416);
  assert.deepEqual(Object.values(d.skill_registry).filter(s=>s.actor_id==='005').map(s=>s.original_skill_index).sort((a,b)=>a-b),[19,20,21,22]);
  assert.deepEqual(d.audit.differences,[]);
  for(const [id,s]of Object.entries(data.party_skills.skills))assert.equal(d.party_skills.skills[id].fixed_raw_hex,s.fixed_raw_hex);
  for(const [id,s]of Object.entries(base.skills))assert.equal(d.combat.skills[id].fixed_raw_hex,s.fixed_raw_hex);
  for(const id of ['011','012','013']){
    assert.deepEqual(d.forest.actors[id].raw_by_address,forest.actors[id].raw_by_address);
    for(const i of ai.roles[id].learned_indices)assert.equal(d.ai.roles[id].skills[i].fixed_raw_hex,ai.roles[id].skills[i].fixed_raw_hex);
  }
  assert.deepEqual(d.rewards,rewards);assert.deepEqual(data,before);assert.deepEqual(config,cfgBefore);
});
test('default profile preserves scheduler, enemy plan, damage and final RNG state against source inputs',()=>{
  const old=createForestSample(seed,base,forest,{map_id:'M70010',members:[{id:'013'},{id:'012'}]},null,scheduler,ai,rewards),next=sample(config,['013','012']);
  for(const s of [old,next])initializeScheduler(s.actors,s.scheduler_data);
  const run=s=>{const rng=createNativeRng(0x20261011),plan=planForestEnemyAction({actors:s.actors,actor_id:'enemy-0',data:s.enemy_ai_data,rng}),result=resolveAction({attacker:s.actors[0],target:s.actors[1],skill:s.skills.yanci,rng});delete result.configuration;return {plan,result,state:rng.state};};
  assert.deepEqual(run(next),run(old));assert.deepEqual(initializeScheduler(next.actors,next.scheduler_data),initializeScheduler(old.actors,old.scheduler_data));
});
test('enemy initial HP MP attributes and resistance apply to every duplicate and keep player save intact',()=>{
  const cfg=debug(),p=cfg.battle.entries.enemy_012.parameters;p.hp_maximum=700;p.mp_maximum=35;p.attack={minimum:60,maximum_exclusive:65};p.speed={minimum:80,maximum_exclusive:80};p.element_resistance=[1,2,3,4,5,6];
  const before=copy(seed),s=sample(cfg,['012','012']),oldPlayer=sample(config).actors[0],newPlayer=copy(s.actors[0]);assert.deepEqual(seed,before);delete oldPlayer.current_skill.configuration;delete newPlayer.current_skill.configuration;assert.deepEqual(newPlayer,oldPlayer);
  for(const a of s.actors.slice(1)){assert.equal(a.hp.current,700);assert.equal(a.mp.current,35);assert.equal(a.raw_by_address['0x0524a711'],60);assert.equal(a.raw_by_address['0x0524a715'],65);assert.equal(a.raw_by_address['0x0524a75f'],6);}
  s.actors[1].hp.current=1;assert.equal(s.actors[2].hp.current,700);assert.equal(sample(cfg).actors[1].hp.current,700);
  assert.equal(createBattleSample(seed,compileRuntimeConfiguration(data,cfg).combat).actors[1].hp.current,700);
});
test('all eight skill overlays reach forest singles and native combo numeric records without changing actions',()=>{
  const cfg=debug();for(const row of Object.values(cfg.skills.entries)){if(Object.hasOwn(row.parameters,'enabled'))continue;row.parameters.physical_multiplier_percent={minimum:90,maximum_exclusive:90};row.parameters.element_power=[0,0,0,0,0,0];row.parameters.preparation_delay_raw=1200;}
  const s=sample(cfg,['011','012','013']);for(const skill of Object.values(s.skills)){assert.equal(Buffer.from(skill.fixed_raw_hex,'hex').readInt32LE(0xcb),90);assert.equal(Buffer.from(skill.fixed_raw_hex,'hex').readInt32LE(0x2e),1200);}
  for(const [id,role]of Object.entries(s.enemy_ai_data.roles))for(const index of role.learned_indices){
    const skill=role.skills[index];assert.equal(Buffer.from(skill.fixed_raw_hex,'hex').readInt32LE(0xcb),90);assert.deepEqual(skill.actions,ai.roles[id].skills[index].actions);
  }
  const role=s.enemy_ai_data.roles['011'],plan=composeNativeSequence(role.skills,[14,15,14]),steps=compileNativeSequence(meta,'011',plan).steps;
  for(const step of steps.filter(s=>s.event))assert.equal(Buffer.from(role.skills[step.source_skill_index].fixed_raw_hex,'hex').readInt32LE(0xcb),90);
  const r=resolveAction({attacker:s.actors[0],target:s.actors[2],skill:s.skills.yanci,rng:createNativeRng(9)});assert.equal(r.elemental,0);assert.equal(r.configuration.mode,'debug');
});
test('enemy AI weights and chance retain fallback without overriding native loaded-code eligibility',()=>{
  const cfg=debug(),p=cfg.battle.entries.ai_011.parameters;p.combination_chance_percent=0;p.skill_weights={'14':100,'15':0};cfg.skills.entries['011_14'].parameters.physical_multiplier_percent={minimum:90,maximum_exclusive:90};
  const d=compileRuntimeConfiguration(data,cfg),actor={side_raw:0,status_flags_raw:0},role=d.ai.roles['011'];
  assert.equal(byte(role.skills[14],0x27),100);assert.equal(selectNativeSkills({actor,role,rng:draws([0,99])}).skill_indices[0],14);
  p.skill_weights={'14':0,'15':0};const empty=compileRuntimeConfiguration(data,cfg).ai.roles['011'];assert.equal(selectNativeSkills({actor,role:empty,rng:draws([99,99,1])}).skill_indices[0],15);
  p.combination_chance_percent=100;const combo=compileRuntimeConfiguration(data,cfg).ai.roles['011'];
  assert.equal(selectNativeSkills({actor,role:combo,rng:draws([99,0,1])}).kind,'single','Even100% chance cannot bypass4FED00 zero-code eligibility');
  assert.equal(selectNativeSkills({actor,role:combo,rng:draws([99,0,0,1,0]),load_mode_raw:1}).kind,'combination','Explicit native nonzero load mode retains source codes');
});
test('charge factor, default debt and explicit skill debt change real scheduler arithmetic',()=>{
  const cfg=debug();cfg.battle.entries.scheduler.parameters={average_speed_factor:100,default_preparation_delay:500};cfg.skills.entries.yanci.parameters.preparation_delay_raw=0;
  const s=sample(cfg),state=initializeScheduler(s.actors,s.scheduler_data);assert.equal(state.threshold,5000);assert.equal(dispatchCharge(s.actors[0],s.skills.yanci,state).effective_delay,500);
  cfg.skills.entries.yanci.parameters.preparation_delay_raw=1200;const explicit=sample(cfg),state2=initializeScheduler(explicit.actors,explicit.scheduler_data);assert.equal(dispatchCharge(explicit.actors[0],explicit.skills.yanci,state2).effective_delay,1200);
});
test('configured reward money experience and repeat drops settle once and survive save reload',async()=>{
  const cfg=debug();cfg.rewards.entries['013'].parameters={experience:123,money:25,drop_item_ids:[242,242]};cfg.items.entries['242'].parameters.drop_rate=100;
  const d=compileRuntimeConfiguration(data,cfg),actors=[{id:'001',side:'player',hp:{current:100},state_raw:0,immune_raw:0},{id:'enemy-0',resource_id:'013',side:'enemy',hp:{current:0},state_raw:5}],ledger=createRewardLedger('config-rewards',actors);
  collectEnemyDefeat(ledger,actors[1],{data:d.rewards});assert.equal(collectEnemyDefeat(ledger,actors[1],{data:d.rewards}),false);
  const world=new WorldStore(copy(seed),maps),plan=planVictoryRewards({world:world.snapshot(),ledger,data:d.rewards,rng:draws([99,99]),actors});
  assert.equal(plan.summary.money,25);assert.equal(plan.summary.experience[0].experience,123);assert.equal(plan.summary.drops[0].quantity,2);
  world.transact(next=>{Object.assign(next,plan.world_patch);next.reward_records=[plan.reward_record];});
  const saved=await decodeSave(await encodeSave(world.snapshot()),maps);assert.equal(saved.money,75);assert.deepEqual(saved.reward_records,world.value.reward_records);
  assert.equal(planVictoryRewards({world:saved,ledger,data:d.rewards,actors,rng:()=>{throw Error('duplicate draw');}}).applied,false);
});
test('drop -1 skips RNG and 0 always drops while preserving source candidate order',()=>{
  const cfg=debug();cfg.rewards.entries['011'].parameters.drop_item_ids=[331,240];cfg.items.entries['331'].parameters.drop_rate=-1;cfg.items.entries['240'].parameters.drop_rate=0;
  const d=compileRuntimeConfiguration(data,cfg),actors=[{id:'001',side:'player',hp:{current:100},state_raw:0,immune_raw:0},{id:'enemy-0',resource_id:'011',side:'enemy',hp:{current:0},state_raw:5}],ledger=createRewardLedger('special-drops',actors);
  collectEnemyDefeat(ledger,actors[1],{data:d.rewards});const plan=planVictoryRewards({world:seed,ledger,data:d.rewards,rng:draws([99]),actors});assert.deepEqual(plan.summary.drops.map(d=>d.id),[240]);
});
test('unknown fields, source drift, bad mode, invalid ranges and unsupported effects fail before mutation',()=>{
  const mutations=[c=>c.manifest.mode='typo',c=>c.skills.entries.yanci.parameters.extra=1,c=>c.skills.entries.yanci.original.mp_cost=1,
    c=>c.battle.entries.enemy_011.source.sha256='0'.repeat(64),c=>c.battle.entries.enemy_011.parameters.hp_maximum=0,
    c=>c.battle.entries.enemy_011.parameters.speed.maximum_exclusive=0,c=>c.battle.entries.ai_011.parameters.skill_weights['16']=30,
    c=>c.rewards.entries['011'].parameters.drop_item_ids=[999],c=>c.rewards.entries['011'].parameters.drop_item_ids=[331,331,331,331,331,331,331],
    c=>c.items.entries['331'].parameters.drop_rate=101,c=>c.items.entries['331'].parameters.use_effect='heal',c=>c.skills.entries['011_14'].parameters.mp_cost=5,
    c=>{c.battle.entries.enemy_011.parameters.speed={minimum:1000000,maximum_exclusive:1000000};c.battle.entries.scheduler.parameters.average_speed_factor=10000;}];
  const before=copy(data);for(const mutate of mutations){const cfg=debug();mutate(cfg);assert.throws(()=>compileRuntimeConfiguration(data,cfg),/配置/);}assert.deepEqual(data,before);
  const cfg=copy(config);cfg.items.entries['331'].parameters.drop_rate=30;assert.throws(()=>compileRuntimeConfiguration(data,cfg),/原版模式/);
  const sparse=copy(config);sparse.manifest.mode='debug';sparse.skills.entries.yantu.parameters={physical_multiplier_percent:{minimum:2}};
  assert.equal(compileRuntimeConfiguration(data,sparse).audit.parameters.skills.yantu.physical_multiplier_percent.minimum,2);
  sparse.skills.source_hashes['Fight_Role/001.CHR']='0'.repeat(64);assert.throws(()=>compileRuntimeConfiguration(data,sparse),/来源指纹/);
  const unknown=copy(config);unknown.skills.entries.yantu.parameters={physical_multiplier_percent:{typo:2}};assert.throws(()=>compileRuntimeConfiguration(data,unknown),/字段缺失或未知/);
});
test('battle uses entry snapshot and configured player MP cost commits raw resources once',async()=>{
  const cfg=debug();cfg.skills.entries.yantu.parameters.mp_cost=5;const d=compileRuntimeConfiguration(data,cfg),world=new WorldStore(copy(seed),maps),logs=[];
  const battle=new BattleController({world,resolveAction,applyDamage:applyNativeDamage,resourcesForWorld,consumeResources:consumeBattleMp,playAction:async(_,{onImpact})=>onImpact(),log:e=>logs.push(e),id:()=> 'config-cost'});
  battle.start({...createBattleSample(world.snapshot(),d.combat),rng:createNativeRng(0x20261011)});cfg.skills.entries.yantu.parameters.mp_cost=20;cfg.battle.entries.enemy_012.parameters.hp_maximum=1;
  await chooseReady(battle,'yantu');assert.equal(battle.actor('001').mp.current,74);assert.equal(battle.actor('001').raw_mp,67);assert.equal(battle.state.source.runtime_configuration.parameters.skills.yantu.mp_cost,5);
  assert.equal(battle.state.history[0].result.configuration.parameters.mp_cost,5);assert.equal(logs[0].source.runtime_configuration.mode,'debug');battle.finish();assert.equal(world.value.party[0].mp.current,67);
  assert.equal(sample(cfg).actors[1].hp.current,1);
});
test('export migrates old debug edits once, preserves new edits, and resets only on explicit request',async()=>{
  const temporary=await mkdtemp(path.join(tmpdir(),'seventh-seal-config-')),directory=pathToFileURL(temporary+path.sep),output=new URL('config/',directory);
  try{
    for(const [key,name]of Object.entries({combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'forest_rewards',party_skills:'party_skills',items:'items'}))await writeFile(new URL(name+'.json',directory),JSON.stringify(data[key]));
    const legacy=await read('skills.json');legacy.mode='debug';legacy.skills.yantu.parameters.mp_cost=5;await writeFile(new URL('skills.json',directory),JSON.stringify(legacy));
    const first=await exportRuntimeConfiguration({dataDirectory:directory,outputDirectory:output});assert.equal(first.written.length,5);
    const readTemp=async file=>JSON.parse(await readFile(new URL(file,output),'utf8'));assert.equal((await readTemp('skills.json')).entries.yantu.parameters.mp_cost,5);
    const before=await readFile(new URL('skills.json',output),'utf8'),second=await exportRuntimeConfiguration({dataDirectory:directory,outputDirectory:output});assert.deepEqual(second.written,[]);assert.equal(await readFile(new URL('skills.json',output),'utf8'),before);
    await exportRuntimeConfiguration({dataDirectory:directory,outputDirectory:output,reset:true});assert.equal((await readTemp('index.json')).mode,'original');assert.deepEqual((await readTemp('skills.json')).entries.yantu.parameters,{});
  }finally{assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir())+path.sep));await rm(temporary,{recursive:true,force:true});}
});

async function fullFixture(cfg){
  const world=new WorldStore(copy(seed),maps),d=cfg?compileRuntimeConfiguration(data,cfg):data;
  const s=createForestSample(world.snapshot(),d.combat,d.forest,{map_id:'M70010',members:[{id:'013'}]},null,d.scheduler,d.ai,d.rewards,
    await read('enemy_reactions.json'),await read('forest_status.json'));
  const ctx={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},save(){},restore(){},drawImage(){},fillText(){},createLinearGradient:()=>({addColorStop(){}})};
  const v=new BattleView({canvas:{width:960,height:540,getContext:()=>ctx},metadataPath:'/data/enemy_battle_view.json',jsonLoader:p=>read(p.slice(6)),assetLoader:async a=>({image:{width:a.width,height:a.height},sha256:a.sha256})});
  await v.prepare();v.setRoster(s.actors,s.skills);let time=0,battle;const logs=[],rng=createNativeRng(0x20261011);
  battle=new BattleController({world,id:()=> 'configured-full',now:()=>time,waitTick:async()=>{time+=20;},resolveAction,applyDamage:applyNativeDamage,resourcesForWorld,consumeResources:consumeBattleMp,log:e=>logs.push(e),
    playSequence:async(r,callbacks)=>{const promise=v.playSequence(r,callbacks);v.draw({actors:battle.state.actors},time);let n=0;while(v.run){assert.ok(++n<20000);time+=20;battle.advanceClock();v.draw({actors:battle.state.actors},time);}return promise;}});
  battle.start({...s,rng});return {battle,world,logs,rng};
}
async function win(f){let commands=0;while(battleActive(f.battle)){assert.ok(++commands<=50);await chooseReady(f.battle,'yanci','enemy-0');}assert.equal(f.battle.state.phase,'victory');f.battle.finish();return commands;}
test('default configured full fight matches source contacts RNG rewards and persisted world',async()=>{
  const old=await fullFixture(null),next=await fullFixture(config);assert.equal(await win(next),await win(old));
  const contacts=f=>f.logs.filter(e=>e.type==='battle-impact').map(e=>({actor:e.actor_id,skill:e.source_skill_index,damage:e.damage,hp:e.hp_after,trace:e.trace,reaction:e.reaction}));
  assert.deepEqual(contacts(next),contacts(old));assert.equal(next.rng.state,old.rng.state);assert.deepEqual(next.world.snapshot(),old.world.snapshot());
});
test('full forest profile applies player MP enemy HP money drops and persists exactly once',async()=>{
  const cfg=debug();cfg.skills.entries.yanci.parameters.mp_cost=3;cfg.battle.entries.enemy_013.parameters.hp_maximum=150;
  cfg.rewards.entries['013'].parameters={experience:123,money:25,drop_item_ids:[242]};cfg.items.entries['242'].parameters.drop_rate=100;
  const f=await fullFixture(cfg);cfg.rewards.entries['013'].parameters.money=1000;cfg.skills.entries.yanci.parameters.mp_cost=50;
  const commands=await win(f);assert.equal(f.world.value.party[0].mp.current,72-commands*3);assert.equal(f.world.value.money,75);assert.equal(f.battle.state.rewards.experience[0].experience,123);assert.equal(f.battle.state.rewards.drops[0].quantity,1);
  const revision=f.world.value.revision,state=f.rng.state;f.battle.finish();assert.equal(f.world.value.revision,revision);assert.equal(f.rng.state,state);
  const loaded=await decodeSave(await encodeSave(f.world.snapshot()),maps);assert.deepEqual(loaded,f.world.snapshot());assert.equal(loaded.reward_records.length,1);
});
