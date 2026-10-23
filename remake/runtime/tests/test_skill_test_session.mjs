import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {WorldStore} from '../web/core/world.mjs';
import {chapterRoleFromDefinition} from '../web/core/chapter.mjs';
import {createBattleController} from '../web/controllers/battle.mjs';
import {createSkillTestSample} from '../web/skill_test_sample.mjs';
import {commitSkillTestResources} from '../web/core/skill_test_commit.mjs';
import {loadRuntimeConfiguration,compileRuntimeConfiguration} from '../web/core/runtime_config.mjs';
import {validateForestStage,forestStageAssets,drawForestStageBackground} from '../web/forest_stage.mjs';
const json=async path=>JSON.parse(await readFile(new URL('../web/'+path,import.meta.url),'utf8'));
const load=name=>json('data/'+name+'.json'),copy=structuredClone;
const [seed,attributes,commands,rules,stage]=await Promise.all(['opening_seed','party_combat','party_skills','skill_test','skill_test_stage'].map(load));
const retainedSave=JSON.parse(await readFile(new URL('../evidence/chapter_systems_win_save.json',import.meta.url),'utf8'));
const retainedTea=JSON.parse(retainedSave.payload).inventory.find(a=>a.id===12);
function worldFixture(){const source=copy(seed);source.party.push(chapterRoleFromDefinition(source.source.role_definitions['002']));source.inventory.push(copy(retainedTea));source.opening.status='complete';return new WorldStore(source,['M72061','M70010']);}
const data=Object.fromEntries(await Promise.all(Object.entries({combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'party_rewards',party_skills:'party_skills',items:'items'}).map(async([key,value])=>[key,await load(value)])));
const configured=compileRuntimeConfiguration(data,await loadRuntimeConfiguration(json));
function resultFor(world){return {test_mode:true,outcome:'escaped',battle_id:'test',resources_by_actor:Object.fromEntries(world.value.party.map(a=>[a.id,{hp:a.hp.current,mp:a.mp.current}]))};}
function snapshotFor(world){return {test_mode:true,actors:world.value.party.map(a=>({id:a.id,side:'player'})),inventory:copy(world.value.inventory)};}

test('Technique test assembles the joined source party and fixed targets without healing or modifying the world',()=>{
  const world=worldFixture();world.transact(d=>{d.party[0].hp.current=123;d.party[1].mp.current=0;});const before=world.snapshot();
  const sample=createSkillTestSample(before,attributes,commands,configured,configured.items,rules);
  assert.equal(sample.test_mode,true);assert.equal(sample.reward_data,undefined);
  assert.deepEqual(sample.actors.filter(a=>a.side==='player').map(a=>a.id),['001','002']);
  assert.deepEqual(sample.actors.filter(a=>a.side==='enemy').map(a=>a.resource_id),rules.enemy_resources);
  assert.equal(sample.actors.find(a=>a.id==='001').raw_hp,123);assert.equal(sample.actors.find(a=>a.id==='002').raw_mp,0);
  assert.deepEqual(world.snapshot(),before);assert.equal(sample.source.encounter.map_id,null);
  const invalid=copy(rules);invalid.enemy_resources[1]='missing';assert.throws(()=>createSkillTestSample(before,attributes,commands,configured,configured.items,invalid),/敌人来源/);
});

test('TestStage uses all three audited static source layers and stays static at later times',async()=>{
  validateForestStage(stage);const assets=forestStageAssets(stage),images=new Map();assert.equal(assets.length,3);
  for(const a of assets){const bytes=await readFile(new URL('../web'+a.path,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),a.sha256);images.set(a.path,a.path);}
  const calls=[],ctx={drawImage:(...args)=>calls.push(args)};drawForestStageBackground(ctx,stage,images,0);const initial=copy(calls);calls.length=0;
  assert.equal(initial.length,3);assert.ok(initial[2][0].includes('FBTEST'));
  drawForestStageBackground(ctx,stage,images,100000);assert.deepEqual(calls,initial);assert.ok(calls.some(args=>args[0].includes('FGTEST')));
  const invalid=copy(stage);invalid.layers[0].frames[0].path='assets/forest_stage/foreign.png';assert.throws(()=>validateForestStage(invalid),/图片来源/);
});

test('A test with unchanged resources does not add a world revision; recovery and inventory consumption commit together only',()=>{
  const world=worldFixture(),before=world.snapshot(),result=resultFor(world),battle=snapshotFor(world);
  assert.equal(commitSkillTestResources(world,battle,result,before.revision).changed,false);assert.deepEqual(world.snapshot(),before);
  result.resources_by_actor['002'].mp=12;battle.inventory.pop();const commit=commitSkillTestResources(world,battle,result,before.revision);
  assert.equal(commit.resources_changed,true);assert.equal(commit.inventory_changed,true);
  const after=world.snapshot(),expected=copy(before);expected.revision++;expected.party[1].mp.current=12;expected.inventory.pop();assert.deepEqual(after,expected);
  assert.throws(()=>commitSkillTestResources(world,battle,result,before.revision),/地图进度已变化/);assert.deepEqual(world.snapshot(),after);
});

test('Invalid training inventory rejects the entire recovery transaction',()=>{
  const world=worldFixture(),before=world.snapshot(),battle=snapshotFor(world),result=resultFor(world);result.resources_by_actor['002'].mp=12;battle.inventory=[{instance_id:'invalid'}];
  assert.throws(()=>commitSkillTestResources(world,battle,result,before.revision));assert.deepEqual(world.snapshot(),before);
});

function controllerFixture(){
  const world=worldFixture(),ticket=Object.freeze({}),events=[],nodes=new Map(),canvas={hidden:false},context={combat:false,page:'skills'};
  const $=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,textContent:id==='mapName'?'原地图':'',dataset:{},querySelector(){return this;}});return nodes.get(id);};
  const previous={battle:null,battleView:{old:true},battleMenu:null,battleRng:{old:true},battleNatural:true,battleCursorMemory:new Map([['001',3]]),sidePriority:1,battlePresentationError:'old',itemData:{old:true}};
  const state={...previous,world,view:{x:12,y:34},catalog:{},battleViews:new Map(),battleHistory:[],menuContext:context,scenes:{phase:'party-menu',setPhase(p){this.phase=p;}},audio:{setScene:s=>events.push(s)}};
  const actions={beginTechniqueTestMenu(){state.menuContext=null;$('partyMenu').hidden=true;return ticket;},resumeTechniqueTestMenu(value){assert.equal(value,ticket);state.menuContext=context;state.scenes.setPhase('party-menu');$('partyMenu').hidden=false;events.push('resume');},resize(){},buildHud(){events.push('hud');},refreshPartyMenu(){events.push('refresh');},log:e=>events.push(e),status:s=>events.push(s),json:async()=>({}),readConfiguredData:async()=>({items:{}})};
  const controller=createBattleController({state,actions,$,canvas});
  return {world,state,actions,controller,previous,ticket,events,$,canvas};
}
test('Failed test startup releases battle UI and returns to the same retained menu and world',async()=>{
  const f=controllerFixture(),before=f.world.snapshot();
  f.state.loadingView={run(){throw Error('Technique test must not show a loading page');}};
  await assert.rejects(f.controller.startTechniqueTest(),/技巧测试来源/);
  assert.equal(f.state.skillTestSession,null);assert.equal(f.state.scenes.phase,'party-menu');assert.equal(f.state.menuContext.page,'skills');assert.equal(f.$('partyMenu').hidden,false);
  for(const [key,value]of Object.entries(f.previous))assert.equal(f.state[key],value,key);assert.deepEqual(f.world.snapshot(),before);assert.equal(f.canvas.hidden,false);
});
test('Training return commits item effects once, restores map/cursor ownership and refreshes the retained techniques page',async()=>{
  const f=controllerFixture(),before=f.world.snapshot(),result=resultFor(f.world),snapshot=snapshotFor(f.world);result.resources_by_actor['002'].mp=12;snapshot.inventory.pop();let finishes=0;
  f.state.menuContext=null;f.state.scenes.setPhase('battle-result');f.state.battle={state:{phase:'escaped'},finish(){finishes++;return result;},snapshot(){return snapshot;}};
  f.state.skillTestSession={ticket:f.ticket,mapWorld:f.world,revision:before.revision,previous:f.previous,viewState:{x:12,y:34},mapName:'原地图',visibility:{canvas:false,dialogue:true},view:{stop:r=>f.events.push(r)}};
  await f.controller.returnFromBattle();await f.controller.returnFromBattle();
  assert.equal(finishes,1);assert.equal(f.state.scenes.phase,'party-menu');assert.equal(f.state.skillTestSession,null);assert.equal(f.state.battleCursorMemory,f.previous.battleCursorMemory);
  assert.equal(f.world.value.party[1].mp.current,12);assert.deepEqual(f.world.value.encounters,before.encounters);assert.deepEqual(f.world.location,before.location);assert.equal(f.world.value.money,before.money);
  assert.ok(f.events.includes('hud')&&f.events.includes('refresh'));assert.equal(f.state.battleHistory.length,1);
});
