import test from 'node:test';
import assert from 'node:assert/strict';
import {createBattleController} from '../web/controllers/battle.mjs';

test('battle start notifications cannot unfreeze the loading phase before entry animation completes',()=>{
  const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{dataset:{}});return elements.get(id);};
  const state={battleEntryPending:true,scenes:{phase:'battle-loading',setPhase(p){this.phase=p;}},world:{value:{source:{kind:'native-new-game'}}}};
  const controller=createBattleController({state,actions:{},$,canvas:{}}),snapshot={phase:'charging',round:1,history:[]};
  controller.updateBattle(snapshot);assert.equal(state.scenes.phase,'battle-loading');
  state.battleEntryPending=false;controller.updateBattle(snapshot);assert.equal(state.scenes.phase,'battle-charging');
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
