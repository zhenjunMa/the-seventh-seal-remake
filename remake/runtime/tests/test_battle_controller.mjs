import test from 'node:test';
import assert from 'node:assert/strict';
import {createBattleFixtureController as createBattleController} from './helpers/battle_controller.mjs';
import {createServicesController} from '../web/controllers/services.mjs';
import {createBattleSessions} from '../web/controllers/battle_sessions.mjs';
import {createRuntimeState} from '../web/controllers/state.mjs';

test('session handoff restores the complete owner and a retired session cannot overwrite its successor',()=>{
  const sessions=createBattleSessions(),original=sessions.current;
  original.futureTargetCache={marker:'retained'};
  const story=sessions.enter('scripted');
  assert.equal(sessions.current.futureTargetCache,undefined);
  const training=sessions.enter('skill-test');
  assert.equal(sessions.leave(story),false);
  assert.equal(sessions.current,training.runtime);
  assert.equal(sessions.leave(training),true);
  assert.equal(sessions.current,story.runtime);
  assert.equal(sessions.leave(story),true);
  assert.equal(sessions.current,original);
  assert.equal(sessions.current.futureTargetCache.marker,'retained');
});

test('menu and input use isolated projections and commands without exposing combat on application state',async()=>{
  const state=createRuntimeState(),actors=[{id:'001',name:'英格妮',level:11,hp:{current:7,maximum:10},mp:{current:3,maximum:5},raw_hex:'source-only'}];
  const calls=[],controller=createBattleController({state,actions:{buildHud:()=>calls.push('hud')},$:()=>({}),canvas:{focus:()=>calls.push('map-focus')}});
  controller.runtime.battle={state:{player_id:'001',inventory:[{instance_id:'tea',quantity:1}]},canCommand:()=>true,players:()=>actors,chooseItem:(...args)=>calls.push(args)};
  const menu=controller.battleMenuState({inventory:true});
  menu.actors[0].hp.current=0;menu.inventory[0].quantity=0;
  assert.equal(actors[0].hp.current,7);assert.equal(controller.runtime.battle.state.inventory[0].quantity,1);
  assert.equal(menu.actors[0].raw_hex,undefined);assert.equal(controller.battleMenuState().inventory,undefined);
  assert.equal(Object.hasOwn(state,'battle'),false);assert.equal(Object.hasOwn(state,'battleView'),false);
  await controller.chooseBattleItem('tea','001');assert.deepEqual(calls,[['tea','001']]);
  controller.host.presentation.refreshExploration();
  assert.deepEqual(calls,[['tea','001'],'hud'],'刷新技巧测试后的地图摘要不能抢走已恢复的菜单焦点');
});

test('battle start notifications cannot unfreeze the loading phase before entry animation completes',()=>{
  const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{dataset:{}});return elements.get(id);};
  const state={battleEntryPending:true,scenes:{phase:'battle-loading',setPhase(p){this.phase=p;}},world:{value:{source:{kind:'native-new-game'}}}};
  const controller=createBattleController({state,actions:{},$,canvas:{}}),snapshot={phase:'charging',round:1,impact_count:0,last_impact:null};
  controller.updateBattle(snapshot);assert.equal(state.scenes.phase,'battle-loading');
  controller.runtime.battleEntryPending=false;controller.updateBattle(snapshot);assert.equal(state.scenes.phase,'battle-charging');
  controller.updateBattle({...snapshot,lifecycle_events:[{kind:'entry'}]});assert.equal(state.scenes.phase,'battle-entry');assert.equal($('battleMessage').textContent,'正在入场');
  controller.updateBattle(snapshot);assert.equal(state.scenes.phase,'battle-charging');
  assert.equal($('battleCommands').dataset.impactCount,0);assert.equal($('battleCommands').dataset.impactFrame,'');
  controller.updateBattle({...snapshot,impact_count:3,last_impact:{actor_id:'001',source_frame:17}});
  assert.equal($('battleCommands').dataset.impactCount,3);assert.equal($('battleCommands').dataset.impactFrame,17);
  assert.equal($('battleCommands').dataset.impactActor,'001');
  let inputs=0;controller.runtime.battleMenu={update(){},key(){inputs++;return true;}};
  controller.updateBattle({...snapshot,lifecycle_events:[{kind:'entry'}]});assert.equal(controller.battleKey('Escape'),true);assert.equal(inputs,0);
  controller.updateBattle({...snapshot,phase:'interrupted',error:'entry failed',lifecycle_events:[{kind:'entry'}]});assert.equal(controller.battleKey('Escape'),true);assert.equal(inputs,1);
});

test('encounters start their transition before resource preparation, block reentry and roll back on failure',async()=>{
  const nodes=new Map(),$=id=>{
    if(!nodes.has(id))nodes.set(id,{hidden:true,dataset:{},textContent:'',classList:{toggle(){}}});
    return nodes.get(id);
  };
  const canvas={hidden:false},audioEvents=[],state={world:{location:{map_id:'M70010'},value:{revision:7,source:{kind:'legacy'}}},
    audio:{setScene:scene=>audioEvents.push(scene)},
    keys:new Set(),view:{x:12,y:34,action:0,frame:0},phaseNames:{},battleData:{}};
  let rejectPreparation,preparations=0,loadingCalls=0,transitions=0;
  const gate=new Promise((_,reject)=>{rejectPreparation=reject;});
  const actions={readConfiguredData:()=>{preparations++;return gate;}};
  const services=createServicesController({state,actions,$,canvas});
  state.scenes={phase:'map',setPhase(phase){this.phase=phase;services.busy(phase);}};
  state.loadingView={run(){loadingCalls++;throw Error('Battle must not show a loading page');}};
  const before={destroy(){}};
  state.battleTransition={capture:()=>before,async run(snapshot,paint){
    transitions++;assert.equal(snapshot,before);assert.equal(preparations,0);
    return paint(new AbortController().signal);
  }};
  const controller=createBattleController({state,actions,$,canvas});
  // Other scene loads still use the generic loading overlay.
  services.busy('boot');assert.equal($('loading').hidden,false);
  services.busy('loading');assert.equal($('loading').hidden,true);
  state.scenes.setPhase('map');
  const pending=controller.startBattle({stage:'stage13.scn'});
  assert.equal(state.scenes.phase,'battle-loading');assert.equal(canvas.hidden,false);
  assert.equal(transitions,1);assert.equal(controller.runtime.battleEntryPending,true);
  assert.equal($('loading').hidden,true);assert.equal($('sceneLoading').hidden,true);
  assert.deepEqual(audioEvents,[],'Battle music starts after actor preparation');
  await controller.startBattle();assert.equal(preparations,1);assert.equal(loadingCalls,0);
  rejectPreparation(Error('resource decode failed'));await assert.rejects(pending,/resource decode failed/);
  assert.equal(state.scenes.phase,'map');assert.equal(canvas.hidden,false);
  assert.equal(controller.runtime.battleEntryPending,false);
  assert.equal($('loading').hidden,true);assert.equal($('sceneLoading').hidden,true);
  assert.deepEqual([state.view.x,state.view.y],[12,34]);assert.equal(state.world.value.revision,7);
  assert.deepEqual(audioEvents,[{mapId:'M70010',battle:false}]);
});

test('technique entry captures the menu and covers it before shared resource preparation; failure restores its original owner',async()=>{
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,dataset:{},textContent:id,style:{}});return nodes.get(id);};
  const context={combat:false,page:'skills'},ticket={},before={destroy(){}},canvas={hidden:false};
  const world={value:{revision:7},location:{map_id:'M70010'}},previousView={retained:true},events=[];
  const state={world,menuContext:context,view:{x:12,y:34},battleData:{},battleViews:new Map(),battleCursorMemory:new Map(),battleView:previousView,
    scenes:{phase:'party-menu',setPhase(phase){this.phase=phase;}},engine:{captureInterface(root){assert.equal(root,$('operationFrame'));events.push('capture-menu');return before;}}};
  let rejectPreparation,preparations=0;
  const gate=new Promise((_,reject)=>{rejectPreparation=reject;});
  const actions={
    beginTechniqueTestMenu(options){assert.equal(options.retainVisible,true);state.menuContext=null;return ticket;},
    hideTechniqueTestMenu(value){assert.equal(value,ticket);$('partyMenu').hidden=true;events.push('covered');},
    resumeTechniqueTestMenu(value){assert.equal(value,ticket);state.menuContext=context;$('partyMenu').hidden=false;state.scenes.setPhase('party-menu');},
    readConfiguredData(){preparations++;events.push('prepare');return gate;},json:async()=>({}),resize(){}
  };
  state.battleTransition={async run(snapshot,paint,options){
    assert.equal(snapshot,before);assert.equal(preparations,0);assert.equal($('partyMenu').hidden,false);
    events.push('transition');options.onCovered();return paint(new AbortController().signal);
  }};
  const controller=createBattleController({state,actions,$,canvas}),pending=controller.startTechniqueTest();
  assert.deepEqual(events,['capture-menu','transition','covered','prepare']);assert.equal(state.scenes.phase,'battle-loading');
  await controller.startTechniqueTest();assert.equal(preparations,1);
  rejectPreparation(new Error('测试资源不可用'));await assert.rejects(pending,/测试资源不可用/);
  assert.equal(state.scenes.phase,'party-menu');assert.equal(state.menuContext,context);assert.equal($('partyMenu').hidden,false);
  assert.equal(controller.runtime.battleView,previousView);assert.equal(controller.runtime.skillTestSession,null);assert.equal(controller.runtime.battleEntryPending,false);
  assert.equal(state.world,world);assert.equal(world.value.revision,7);
});

test('natural battle return stores its RNG, restores exploration and cannot submit twice', async () => {
  const elements=new Map(), events=[];
  const $=id=>{if(!elements.has(id))elements.set(id,{hidden:false});return elements.get(id);};
  let finished=0;
  const state={
    scenes:{phase:'battle-result',setPhase(phase){this.phase=phase;}},
    world:{value:{source:{kind:'native-new-game'},encounters:{rng_state:1,counters:{'001':0},remainders:{'001':0}}},
      location:{map_id:'M70010'},setEncounterState(next){this.value.encounters=next;}},
    battle:{state:{phase:'victory',scheduler:{side_priority:1}},finish(){finished++;this.state.phase='closed';return {outcome:'victory',rewards_applied:true};}},
    battleNatural:true,battleRng:{state:123456},lastBattle:null,
    view:{x:0,y:0},battleCheckpoint:{x:769,y:412},
    battleView:{stop:reason=>events.push(reason)},audio:{setScene:scene=>events.push(scene)},
  };
  const actions={buildHud(){},updateNearest(){},resize(){},status:message=>events.push(message)};
  const canvas={hidden:true,focus(){}};
  const controller=createBattleController({state,actions,$,canvas});
  await controller.returnFromBattle();
  assert.equal(state.world.value.encounters.rng_state,123456);
  assert.equal(state.sidePriority,1);
  assert.equal(state.scenes.phase,'map');
  assert.deepEqual(state.view,state.battleCheckpoint);
  assert.equal(canvas.hidden,false);
  assert.equal(elements.get('battleCanvas').hidden,true);
  assert.equal(state.lastBattle.battle,controller.runtime.battle.state);assert.equal(state.lastBattle.result.outcome,'victory');
  assert.ok(events.some(e=>typeof e==='string'&&e.includes('战斗胜利')));
  await controller.returnFromBattle();
  assert.equal(finished,1);
});


test('presentation advancement acknowledges lifecycle completion without requiring HUD painting',async()=>{
 const state={scenes:{phase:'battle-charging'}},nodes=new Map();
 const $=id=>{if(!nodes.has(id))nodes.set(id,{dataset:{}});return nodes.get(id);};
 const controller=createBattleController({state,actions:{},$,canvas:{}}),events=[];
 const battle={presentationSnapshot:()=>({phase:'charging'}),ackLifecycle:event=>events.push(event.token)};
 const completed=[{token:'entry',actor_id:'001',life_epoch:0}];
 controller.runtime.battle=battle;
 controller.runtime.battleView={advance:()=>events.push('advance'),drainLifecycleCompleted:()=>completed.splice(0),lifecycleSnapshot:()=>({}),actorPositions:()=>({})};
 controller.runtime.battleMenu={draw(){events.push('paint');},paintTo(){}};
 controller.drawBattleInterface(0);await Promise.resolve();assert.deepEqual(events,['paint']);
 controller.advanceBattlePresentation(0);await Promise.resolve();assert.deepEqual(events,['paint','advance','entry']);
 controller.drawBattleInterface(0);await Promise.resolve();assert.deepEqual(events,['paint','advance','entry','paint']);
});
