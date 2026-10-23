import {battleActive,commandReady,chooseReady} from './helpers/battle_clock.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {deriveRuntimeConfiguration,compileRuntimeConfiguration,loadRuntimeConfiguration,expandRuntimeConfiguration,compactRuntimeConfiguration} from '../web/core/runtime_config.mjs';
import {upgradeSkillConfiguration} from '../web/core/skill_registry.mjs';
import {exportRuntimeConfiguration,inspectRuntimeConfiguration} from '../tools/export_runtime_config.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {assembleForestSample} from '../web/forest_sample.mjs';
import {chapterRoleFromDefinition} from '../web/core/chapter.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {BattleView} from '../web/battle_view.mjs';
import {resolveAction,applyNativeDamage,createNativeRng} from '../web/core/combat_rules.mjs';
import {partyResourcesForWorld,consumePartyMp} from '../web/core/party_attributes.mjs';
import {dispatchCharge,initializeScheduler} from '../web/core/battle_scheduler.mjs';
const copy=structuredClone,read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name,import.meta.url),'utf8'));
const names={combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'party_rewards',party_skills:'party_skills',items:'items'};
const data=Object.fromEntries(await Promise.all(Object.entries(names).map(async([id,name])=>[id,await read(name+'.json')])));
const attributes=await read('party_combat.json'),reactions=await read('party_reactions.json'),statuses=await read('forest_status.json');
const config=await loadRuntimeConfiguration(p=>read(p.slice(5))),newIds=['yancui','kai_mieyan','kai_suizu','kai_luoyan','kai_liyan','kai_duanyan'];
const debug=()=>({...expandRuntimeConfiguration(data,config),manifest:{...copy(config.manifest),mode:'debug'}});
async function worldFixture(){const seed=await read('opening_seed.json');seed.party.push(chapterRoleFromDefinition(seed.source.role_definitions['002']));seed.party[1].mp.current=20;seed.opening.status='complete';return new WorldStore(seed,['M72061','M70010']);}

test('unified catalog owns every implemented player/enemy skill and original mode keeps all source bytes',()=>{
  const before=copy(data),bundle=copy(config),compiled=compileRuntimeConfiguration(data,bundle);
  assert.equal(bundle.skills.version,3);assert.equal(Object.keys(bundle.skills.entries).length,24);
  const counts={};for(const row of Object.values(bundle.skills.entries))counts[row.owner.role_id]=(counts[row.owner.role_id]??0)+1;
  assert.deepEqual(counts,{'001':7,'002':5,'003':6,'011':2,'012':2,'013':2});
  for(const [id,source]of Object.entries(data.party_skills.skills)){
    const next=compiled.skill_registry[id];assert.equal(next.fixed_raw_hex,source.fixed_raw_hex);assert.deepEqual(next.actions,source.actions);
    assert.equal(next.configuration.owner.role_id,source.actor_id);assert.equal(next.configuration.owner.skill_index,source.original_skill_index);
  }
  assert.deepEqual(data,before);assert.deepEqual(config,bundle);
});

test('each of the six new skill overlays changes numeric fields, MP debt and charge without changing source actions or effects',async()=>{
  const cfg=debug();for(const id of newIds){const p=cfg.skills.entries[id].parameters;
    Object.assign(p,{mp_cost:3,physical_multiplier_percent:{minimum:73,maximum_exclusive:73},element_power:[400,0,0,0,0,0],
      defense_bonus:{minimum:8,maximum_exclusive:8},term4_bonus:{minimum:9,maximum_exclusive:9},hp_term_bonus:7,hp_max_term_bonus:6,preparation_delay_raw:1234});}
  const before=copy(data),d=compileRuntimeConfiguration(data,cfg),world=await worldFixture(),party=createPartySample(world.snapshot(),attributes,data.party_skills,d);
  for(const id of newIds){const source=data.party_skills.skills[id],skill=party.skills[id],raw=Buffer.from(skill.fixed_raw_hex,'hex');
    assert.equal(skill.mp_cost,3);assert.equal(raw.readInt32LE(0x14f),-3);assert.equal(raw.readInt32LE(0xcb),73);
    assert.equal(raw.readInt32LE(0x105),400);assert.equal(raw.readInt32LE(0xd3),8);assert.equal(raw.readInt32LE(0xe3),9);
    assert.equal(raw.readInt32LE(0xab),7);assert.equal(raw.readInt32LE(0xaf),6);assert.equal(raw.readInt32LE(0x2e),1234);
    assert.deepEqual(skill.actions,source.actions);assert.deepEqual(skill.effect_context,source.effect_context);
    const actors=copy(party.actors),scheduler=initializeScheduler(actors,{...d.scheduler,idle_skills:{...d.scheduler.idle_skills,...data.party_skills.idle_skills}});assert.equal(dispatchCharge(actors.find(a=>a.id===skill.actor_id),skill,scheduler).effective_delay,1234);
  }
  assert.deepEqual(data,before);
});

test('future role/index registration is data-driven and does not mix equal skill indices between actors',()=>{
  const next=copy(data),source=copy(next.party_skills.skills.yantu);source.id='004_22';source.actor_id='004';source.source.path='Fight_Role/004.CHR';source.source.sha256='1'.repeat(64);
  next.party_skills.skills[source.id]=source;next.party_skills.source_hashes[source.source.path]=source.source.sha256;
  const cfg=deriveRuntimeConfiguration(next);cfg.manifest.mode='debug';cfg.skills.entries['004_22'].parameters.mp_cost=7;
  const compiled=compileRuntimeConfiguration(next,cfg);
  assert.equal(Object.keys(compiled.skill_registry).length,Object.keys(config.skills.entries).length+1);assert.equal(compiled.skill_registry['004_22'].mp_cost,7);
  assert.equal(compiled.skill_registry.yantu.mp_cost,0);assert.deepEqual(compiled.skill_registry['004_22'].configuration.owner,{role_id:'004',skill_index:22,side:'player'});
  const existing=compactRuntimeConfiguration(data,debug());existing.skills.entries.kai_mieyan.parameters.mp_cost=2;
  const upgraded=upgradeSkillConfiguration(next,existing.skills);assert.equal(upgraded.entries.kai_mieyan.parameters.mp_cost,2);assert.equal(upgraded.entries['004_22'].parameters.mp_cost,0);
  assert.throws(()=>compileRuntimeConfiguration(next,existing),/字段缺失/);
});

test('foreign owner, source/index drift, duplicate bindings, missing config and original-mode edits reject before source/world mutation',async()=>{
  const mutations=[c=>c.skills.entries.kai_mieyan.owner.role_id='001',c=>c.skills.entries.yancui.owner.skill_index=22,
    c=>c.skills.entries.kai_suizu.owner.side='enemy',c=>delete c.skills.entries.kai_liyan,
    c=>c.skills.entries.yancui.source.sha256='0'.repeat(64),c=>c.skills.entries.yancui.parameters.target_side=1];
  const world=await worldFixture(),before=world.snapshot(),sourceBefore=copy(data);
  for(const change of mutations){const cfg=debug();change(cfg);assert.throws(()=>compileRuntimeConfiguration(data,cfg),/配置/);}
  for(const id of newIds){const cfg=copy(config);cfg.skills.entries[id].parameters.mp_cost=deriveRuntimeConfiguration(data).skills.entries[id].original.mp_cost+1;assert.throws(()=>compileRuntimeConfiguration(data,cfg),/原版模式/);}
  const duplicates=copy(data);duplicates.party_skills.skills.duplicate={...copy(duplicates.party_skills.skills.yantu),id:'duplicate'};
  assert.throws(()=>deriveRuntimeConfiguration(duplicates),/重复登记/);
  const wrongIndex=copy(data);wrongIndex.ai.roles['011'].skills[14].original_skill_index=15;assert.throws(()=>deriveRuntimeConfiguration(wrongIndex),/源索引/);
  const unregistered=compileRuntimeConfiguration(data,config);delete unregistered.skill_registry.kai_duanyan;
  assert.throws(()=>createPartySample(world.snapshot(),attributes,data.party_skills,unregistered),/未登记/);
  assert.deepEqual(data,sourceBefore);assert.deepEqual(world.snapshot(),before);
});

async function fixture(cfg){
  const world=await worldFixture(),d=cfg?compileRuntimeConfiguration(data,cfg):copy(data);
  const party=createPartySample(world.snapshot(),attributes,data.party_skills,cfg?d:null);
  const sample=assembleForestSample(party,d.forest,{map_id:'M70010',members:[{id:'013'}]},
    {...d.scheduler,idle_skills:{...d.scheduler.idle_skills,...data.party_skills.idle_skills}},d.ai,d.rewards,reactions,statuses);
  const ctx={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},save(){},restore(){},drawImage(){},fillText(){},createLinearGradient:()=>({addColorStop(){}})};
  const view=new BattleView({canvas:{width:960,height:540,getContext:()=>ctx},metadataPath:'/data/party_battle_view.json',jsonLoader:p=>read(p.slice(6)),assetLoader:async a=>({image:{width:a.width,height:a.height},sha256:a.sha256})});
  await view.prepare();view.setRoster(sample.actors,sample.skills);let time=0,battle;const logs=[],rng=createNativeRng(0x20261011);
  battle=new BattleController({world,id:()=> 'party-config',now:()=>time,waitTick:async()=>{time+=20;},resolveAction,applyDamage:applyNativeDamage,resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,log:e=>logs.push(e),
    playSequence:async(result,hooks)=>{const promise=view.playSequence(result,hooks);view.draw({actors:battle.state.actors},time);let ticks=0;
      while(view.run){assert.ok(++ticks<20000);time+=20;battle.advanceClock();view.draw({actors:battle.state.actors},time);}return promise;}});
  battle.start({...sample,rng});return {world,battle,logs,rng};
}

test('default configured party spell and Kai contacts retain damage, RNG and persisted resources of source-only play',async()=>{
  const before=await fixture(null),after=await fixture(config);
  for(const f of [before,after]){await chooseReady(f.battle,'yancui');if(battleActive(f.battle)&&await commandReady(f.battle,'002')){f.battle.selectPlayer('002');await chooseReady(f.battle,'kai_suizu');}f.battle.finish();}
  const contacts=f=>f.logs.filter(e=>e.type==='battle-impact').map(e=>({actor:e.actor_id,skill:e.skill_id,damage:e.damage,hp:e.hp_after,trace:e.trace,token:e.effect_token,reaction:e.reaction}));
  assert.deepEqual(contacts(after),contacts(before));assert.equal(after.rng.state,before.rng.state);assert.deepEqual(after.world.snapshot(),before.world.snapshot());
});

test('debug spell and Kai MP costs apply through real source playback, isolated battle snapshots, one commit and reload',async()=>{
  const cfg=debug();cfg.skills.entries.yancui.parameters.mp_cost=9;cfg.skills.entries.kai_mieyan.parameters.mp_cost=3;cfg.skills.entries.yancui.parameters.preparation_delay_raw=1200;
  cfg.battle.entries.enemy_013.parameters.hp_maximum=5000;const f=await fixture(cfg),worldBefore=f.world.snapshot();
  cfg.skills.entries.yancui.parameters.mp_cost=50;cfg.skills.entries.kai_mieyan.parameters.mp_cost=50;
  await chooseReady(f.battle,'yancui');assert.equal(f.battle.actor('001').mp.current,63);
  await commandReady(f.battle,'002');f.battle.selectPlayer('002');await chooseReady(f.battle,'kai_mieyan');assert.equal(f.battle.actor('002').mp.current,17);
  assert.deepEqual(f.world.snapshot(),worldBefore);assert.equal(f.battle.state.source.runtime_configuration.parameters.skills.yancui.mp_cost,9);
  const impacts=f.logs.filter(e=>e.type==='battle-impact'&&['yancui','kai_mieyan'].includes(e.skill_id));
  assert.ok(impacts.some(e=>e.effect_token===1&&e.damage>0));assert.ok(impacts.some(e=>e.skill_id==='kai_mieyan'));
  assert.equal(f.battle.skills.kai_mieyan.configuration.owner.role_id,'002');assert.equal(f.battle.skills.yancui.configuration.parameters.preparation_delay_raw,1200);
  const done=f.battle.finish();assert.equal(done.resources_by_actor['001'].mp,57);assert.equal(done.resources_by_actor['002'].mp,17);
  const once=f.world.snapshot();f.battle.finish();assert.deepEqual(f.world.snapshot(),once);
  assert.deepEqual(await decodeSave(await encodeSave(once),['M72061','M70010']),once);
  const next=compileRuntimeConfiguration(data,cfg);assert.equal(next.skill_registry.yancui.mp_cost,50);
});

test('export migrates v1 source identities, adds new skills and preserves all edits; invalid input writes nothing',async()=>{
  const temporary=await mkdtemp(path.join(tmpdir(),'seventh-seal-party-config-')),directory=pathToFileURL(temporary+path.sep),output=new URL('config/',directory);
  try{
    for(const [id,name]of Object.entries(names))await writeFile(new URL(name+'.json',directory),JSON.stringify(data[id]));
    await writeFile(new URL('forest_rewards.json',directory),JSON.stringify(await read('forest_rewards.json')));
    const original=deriveRuntimeConfiguration(data),legacy=copy(original.skills);legacy.version=1;
    delete legacy.entries.yannuan;
    // Revival was registered after the historical v1 catalog. Migration must
    // add it from the retained source, not impersonate a legacy source row.
    delete legacy.entries['001_43'];
    for(const [id,row]of Object.entries(legacy.entries))if(row.owner.side==='player'&&!['yanci','yantu'].includes(id))delete legacy.entries[id];
    for(const id of newIds)delete legacy.entries[id];for(const row of Object.values(legacy.entries))delete row.owner;
    legacy.entries.yantu.source=copy(data.combat.skills.yantu.source);legacy.entries.yanci.source=copy(data.forest.player_skills.yanci.source);
    legacy.entries.yantu.parameters.mp_cost=6;legacy.entries['011_14'].parameters.preparation_delay_raw=1100;original.manifest.mode='debug';
    await mkdir(output);
    for(const [id,name]of Object.entries({manifest:'index',skills:'skills',battle:'battle',rewards:'rewards',items:'items'}))await writeFile(new URL(name+'.json',output),JSON.stringify(id==='skills'?legacy:original[id]));
    const first=await exportRuntimeConfiguration({dataDirectory:directory,outputDirectory:output});assert.deepEqual(first.written,['skills.json','battle.json','rewards.json','items.json']);assert.equal(first.skills,Object.keys(original.skills.entries).length);
    const readTemp=async name=>JSON.parse(await readFile(new URL(name+'.json',output),'utf8')),migrated=await readTemp('skills');
    assert.equal(migrated.version,3);assert.equal(migrated.entries.yantu.parameters.mp_cost,6);assert.equal(migrated.entries['011_14'].parameters.preparation_delay_raw,1100);
    const reference=await inspectRuntimeConfiguration({dataDirectory:directory,outputDirectory:output,section:'skills'});
    assert.equal(reference.entries.yantu.source.path,'Fight_Role/001.CHR');assert.equal(reference.entries.yancui.parameters.mp_cost,5);
    assert.deepEqual(reference.entries['001_43'].parameters,original.skills.entries['001_43'].parameters);
    assert.deepEqual(migrated.entries['001_43'].parameters,{});
    assert.deepEqual((await exportRuntimeConfiguration({dataDirectory:directory,outputDirectory:output})).written,[]);
    migrated.entries.kai_mieyan.parameters.mp_cost=3;await writeFile(new URL('skills.json',output),JSON.stringify(migrated));
    assert.deepEqual((await exportRuntimeConfiguration({dataDirectory:directory,outputDirectory:output})).written,[]);
    assert.equal((await readTemp('skills')).entries.kai_mieyan.parameters.mp_cost,3);
    const bad=copy(migrated);bad.entries.kai_mieyan.owner.role_id='001';await writeFile(new URL('skills.json',output),JSON.stringify(bad));
    const files=['index','skills','battle','rewards','items'],bytesBefore=await Promise.all(files.map(name=>readFile(new URL(name+'.json',output),'utf8')));
    await assert.rejects(exportRuntimeConfiguration({dataDirectory:directory,outputDirectory:output}),/配置/);
    assert.deepEqual(await Promise.all(files.map(name=>readFile(new URL(name+'.json',output),'utf8'))),bytesBefore);
    await writeFile(new URL('skills.json',output),'{broken json');
    await exportRuntimeConfiguration({dataDirectory:directory,outputDirectory:output,reset:true});assert.equal((await readTemp('index')).mode,'original');assert.deepEqual((await readTemp('skills')).entries.kai_mieyan.parameters,{});
  }finally{assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir())+path.sep));await rm(temporary,{recursive:true,force:true});}
});
