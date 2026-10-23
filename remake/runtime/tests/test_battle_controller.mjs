import test from 'node:test';
import assert from 'node:assert/strict';
import {createBattleController} from '../web/controllers/battle.mjs';
import {createServicesController} from '../web/controllers/services.mjs';

test('battle start notifications cannot unfreeze the loading phase before entry animation completes',()=>{
  const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{dataset:{}});return elements.get(id);};
  const state={battleEntryPending:true,scenes:{phase:'battle-loading',setPhase(p){this.phase=p;}},world:{value:{source:{kind:'native-new-game'}}}};
  const controller=createBattleController({state,actions:{},$,canvas:{}}),snapshot={phase:'charging',round:1,history:[]};
  controller.updateBattle(snapshot);assert.equal(state.scenes.phase,'battle-loading');
  state.battleEntryPending=false;controller.updateBattle(snapshot);assert.equal(state.scenes.phase,'battle-charging');
});

test('battle preparation retains the map without either loading overlay, blocks reentry and rolls back on failure',async()=>{
  const nodes=new Map(),$=id=>{
    if(!nodes.has(id))nodes.set(id,{hidden:true,dataset:{},textContent:'',classList:{toggle(){}}});
    return nodes.get(id);
  };
  const canvas={hidden:false},state={world:{value:{revision:7,source:{kind:'legacy'}}},
    keys:new Set(),view:{x:12,y:34,action:0,frame:0},phaseNames:{},battleData:{}};
  let rejectPreparation,preparations=0,loadingCalls=0;
  const gate=new Promise((_,reject)=>{rejectPreparation=reject;});
  const actions={readConfiguredData:()=>{preparations++;return gate;}};
  const services=createServicesController({state,actions,$,canvas});
  state.scenes={phase:'map',setPhase(phase){this.phase=phase;services.busy(phase);}};
  state.loadingView={run(){loadingCalls++;throw Error('Battle must not show a loading page');}};
  const controller=createBattleController({state,actions,$,canvas});
  // Other scene loads still use the generic loading overlay.
  for(const phase of ['boot','loading']){services.busy(phase);assert.equal($('loading').hidden,false);}
  state.scenes.setPhase('map');
  const pending=controller.startBattle();
  assert.equal(state.scenes.phase,'battle-loading');assert.equal(canvas.hidden,false);
  assert.equal($('loading').hidden,true);assert.equal($('sceneLoading').hidden,true);
  await controller.startBattle();assert.equal(preparations,1);assert.equal(loadingCalls,0);
  rejectPreparation(Error('resource decode failed'));await assert.rejects(pending,/resource decode failed/);
  assert.equal(state.scenes.phase,'map');assert.equal(canvas.hidden,false);
  assert.equal($('loading').hidden,true);assert.equal($('sceneLoading').hidden,true);
  assert.deepEqual([state.view.x,state.view.y],[12,34]);assert.equal(state.world.value.revision,7);
});

test('natural battle return stores its RNG, restores exploration and cannot submit twice', async () => {
  const elements=new Map(), events=[];
  const $=id=>{if(!elements.has(id))elements.set(id,{hidden:false});return elements.get(id);};
  let finished=0;
  const state={
    scenes:{phase:'battle-result',setPhase(phase){this.phase=phase;}},
    world:{value:{source:{kind:'native-new-game'},encounters:{rng_state:1,counters:{'001':0},remainders:{'001':0}}},
      location:{map_id:'M70010'},setEncounterState(next){this.value.encounters=next;}},
    battle:{finish(){finished++;return {outcome:'victory',rewards_applied:true};},snapshot(){return {scheduler:{side_priority:1}};}},
    battleNatural:true,battleRng:{state:123456},battleHistory:[],
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
  assert.equal(state.battleHistory.length,1);
  assert.ok(events.some(e=>typeof e==='string'&&e.includes('战斗胜利')));
  await controller.returnFromBattle();
  assert.equal(finished,1);
});
