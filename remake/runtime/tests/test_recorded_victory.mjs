// Replay the real browser-observed victory through the latest return adapter.
// These are captured actor states and native RNG draws, not boosted parameters.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {WorldStore} from '../web/core/world.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {createBattleController} from '../web/controllers/battle.mjs';
import {partyResourcesForWorld} from '../web/core/party_attributes.mjs';
import {createNativeRng} from '../web/core/combat_rules.mjs';
import {deriveRuntimeConfiguration, compileRuntimeConfiguration} from '../web/core/runtime_config.mjs';

test('recorded three-enemy victory preserves its rewards, native RNG and one-time world commit', async () => {
  const read=async name=>JSON.parse(await fs.readFile(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));
  const log=JSON.parse(await fs.readFile(new URL('../evidence/refactor_flow_log.json',import.meta.url),'utf8'));
  const planned=log.events.findLast(e=>e.type==='battle-rewards-planned');
  const values=planned.trace.filter(t=>t.type==='drop-roll').map(t=>t.raw);
  assert.equal(log.current_battle.phase,'victory');
  assert.ok(values.length>=8);
  const search=createNativeRng(log.current_battle.source.rng_seed),recent=[];
  let beforeRewards=null,afterRewards=null;
  for(let i=0;i<2000000;i++){
    const before=search.state,raw=search();recent.push({before,raw});
    if(recent.length>values.length)recent.shift();
    if(recent.length===values.length&&recent.every((v,i)=>v.raw===values[i])){
      beforeRewards=recent[0].before;afterRewards=search.state;break;
    }
  }
  assert.notEqual(beforeRewards,null,'Observed draws must belong to the recorded battle stream');
  const names={combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'party_rewards',party_skills:'party_skills',items:'items'};
  const data=Object.fromEntries(await Promise.all(Object.entries(names).map(async([key,file])=>[key,await read(file)])));
  const configured=compileRuntimeConfiguration(data,deriveRuntimeConfiguration(data));
  const world=new WorldStore(log.world,(await read('catalog')).maps.map(m=>m.id));
  const battle=new BattleController({world,resourcesForWorld:partyResourcesForWorld});
  battle.state=structuredClone(log.current_battle);battle.running=false;battle.expectedRevision=world.value.revision;
  battle.rewardData=configured.rewards;battle.rng=createNativeRng(beforeRewards);
  const state={world,battle,battleNatural:true,battleRng:battle.rng,battleHistory:[],battleView:{stop(){}},
    view:{},battleCheckpoint:log.world.location,scenes:{phase:'battle-result',setPhase(p){this.phase=p;}}};
  const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{hidden:false});return elements.get(id);};
  const controller=createBattleController({state,actions:{buildHud(){},updateNearest(){},resize(){},status(){}},$,canvas:{focus(){}}});
  await controller.returnFromBattle();
  // The frozen 2026-10-13 capture predates presentation/proficiency fields.
  // Compare every captured field verbatim and validate each new field rather
  // than rewriting that observation or dropping the replay's RNG assertion.
  const {notifications,practice_total,practice_bonus,...legacy}=structuredClone(battle.completed.rewards);
  assert.deepEqual(notifications,[]);assert.equal(practice_total,0);assert.equal(practice_bonus,0);
  legacy.experience=legacy.experience.map(row=>{
    const {before_total_experience,before_next_level_experience,levels,...captured}=row;
    assert.equal(before_total_experience,captured.total_experience-captured.experience);
    assert.equal(before_next_level_experience,captured.next_level_experience);assert.deepEqual(levels,[]);
    return captured;
  });
  assert.deepEqual(legacy,planned.summary);
  assert.equal(world.value.encounters.rng_state,afterRewards);
  assert.equal(world.value.reward_records.filter(r=>r.battle_id===battle.state.id).length,1);
  const first=world.snapshot();await controller.returnFromBattle();assert.deepEqual(world.snapshot(),first);
});
