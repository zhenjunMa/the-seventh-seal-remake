import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {WorldMapController} from '../web/core/world_map.mjs';
import {planRouteExit} from '../web/core/route.mjs';
import {initialEncounterState,previewMovement,generateGroup} from '../web/core/encounters.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {createNativeRng,resolveAction,applyNativeDamage} from '../web/core/combat_rules.mjs';
import {createForestSample} from '../web/forest_sample.mjs';
import {consumeBattleMp,resourcesForWorld} from '../web/combat_sample.mjs';
import {validateBattleViewMetadata,compileActionTimeline} from '../web/battle_view.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
const read=async p=>JSON.parse(await readFile(new URL('../web/data/'+p,import.meta.url),'utf8'));
const [seed,data,wm,events,base,forest,meta,config]=await Promise.all(['route_seed.json','encounters.json','world_map.json','route_events.json','combat_sample.json','forest_combat.json','forest_battle_view.json','skills.json'].map(read));
const clone=structuredClone,mapIds=['M01010','M01030','M17010','M70010'];
const input=(dx=16,extra={})=>({party:seed.party,leader_id:'001',map_id:'M70010',dx,dy:0,...extra});
const queue=values=>{let i=0;const rng=()=>{assert.ok(i<values.length,'Unexpected RNG call');return values[i++];};rng.used=()=>i;return rng;};
test('route fixture retains verified story flags rather than inventing an unlock',async()=>{
 const original=await read('world_seed.json');assert.equal(seed.flags[48],original.flags[48]);assert.equal(seed.flags[51],original.flags[51]);assert.ok(seed.flags[48]&1);assert.deepEqual(seed.party,original.party);
 assert.deepEqual(seed.location,{map_id:'M17010',x:1232,y:1456,direction:2});assert.deepEqual(seed.world_map.areas.map(a=>a.statuses),[Array(7).fill(1),Array(7).fill(1)]);
});
test('fire gate denial has no unlock writes; native type9 chain opens destinations 6 and4',()=>{
 const denied=clone(seed);denied.flags[48]&=~1;assert.equal(planRouteExit(denied,'M17010',48,events).commands.length,0);
 assert.deepEqual(planRouteExit(seed,'M17010',48,events).commands,[{mode:1,area:0,destination:6},{mode:1,area:0,destination:4},{mode:0,area:0,destination:4}]);
 const before=clone(seed);assert.throws(()=>planRouteExit(seed,'M17010',49,events));assert.deepEqual(seed,before);
});
test('forest return issues recovered menu command even when its next branch flag is clear',()=>{
 const s=clone(seed);s.flags[10]=0;s.flags[384]=0;
 assert.deepEqual(planRouteExit(s,'M70010',1,events).commands,[{mode:0,area:0,destination:6}]);
 s.flags[10]|=2;s.flags[384]|=1;assert.equal(planRouteExit(s,'M70010',1,events).commands.length,2);
});
test('counter <=40 never draws; standing and non-map phases do not count',()=>{
 const state=initialEncounterState(seed.party),rng=queue([]);
 let s=state;for(let i=0;i<40;i++)s=previewMovement(s,input(),data,rng).state;
 assert.equal(s.counters['001'],40);assert.equal(rng.used(),0);
 assert.deepEqual(previewMovement(s,input(0),data,rng).state,s);assert.deepEqual(previewMovement(s,input(16,{phase:'event'}),data,rng).state,s);
});
test('native byte counter wraps; cities and transition completion suppress draws',()=>{
 const s=initialEncounterState(seed.party);s.counters['001']=255;
 assert.equal(previewMovement(s,input(),data,queue([])).state.counters['001'],0);
 s.counters['001']=40;assert.equal(previewMovement(s,input(16,{map_id:'M17010'}),data,queue([])).state.counters['001'],41);
 assert.equal(previewMovement(s,input(16,{transition:true}),data,queue([])).state.counters['001'],41);
});
test('fractional accepted travel accumulates; diagonal 16x16 is one grid completion',()=>{
 let s=initialEncounterState(seed.party);s=previewMovement(s,input(8),data,queue([])).state;assert.equal(s.counters['001'],0);assert.equal(s.remainders['001'],8);
 s=previewMovement(s,input(8),data,queue([])).state;assert.equal(s.counters['001'],1);assert.equal(s.remainders['001'],0);
 assert.equal(previewMovement(s,input(16,{dy:16}),data,queue([])).steps,1);
});
test('frequency1 zero-modifier chance is roll%1000 >=998; preview does not mutate',()=>{
 const s=initialEncounterState(seed.party);s.counters['001']=40;const before=clone(s);
 const no=previewMovement(s,input(),data,queue([997]));assert.equal(no.encounter,null);assert.equal(no.state.counters['001'],41);
 const yes=previewMovement(s,input(),data,queue([998,0,0,0,1]));assert.equal(yes.encounter.members.length,1);assert.equal(yes.encounter.members[0].id,'012');assert.equal(yes.state.counters['001'],0);assert.deepEqual(s,before);
});
test('native count tiers and clamping retain all1-4 enemies including duplicates',()=>{
 for(const [tier,countRoll,expected] of [[0,0,1],[39,2,3],[40,3,4],[60,4,4],[80,5,4]]){
  const rng=queue([tier,countRoll,0,...Array(expected).fill(2)]),g=generateGroup(data.maps.M70010,data,rng);
  assert.equal(g.members.length,expected);assert.ok(g.members.every(m=>m.id==='013'));assert.equal(rng.used(),3+expected);
 }
});
test('source STG/CHR pools and composition bytes match retained native table',async()=>{
 const root=new URL('../../../',import.meta.url),stg=await readFile(new URL('Map/m70010.STG',root));assert.equal(stg[209],3);
 data.maps.M70010.members.forEach((m,i)=>assert.equal(stg.subarray(210+i*20,230+i*20).toString().split('\0')[0],m.id+'.dgp'));
 const report=JSON.parse(await readFile(new URL('../evidence/route_export_20261011.json',import.meta.url),'utf8'));
 for(const [path,expected] of Object.entries(report.source_hashes))assert.equal(createHash('sha256').update(await readFile(new URL(path,root))).digest('hex'),expected,path);
});
test('persistent encounter RNG continues identically after save and restore',async()=>{
 const world=new WorldStore(clone(seed),mapIds);world.setEncounterState(initialEncounterState(seed.party));
 for(let i=0;i<55;i++){const p=previewMovement(world.value.encounters,input(),data);world.setEncounterState(p.state);if(p.encounter)break;}
 const loaded=await decodeSave(await encodeSave(world.snapshot()),mapIds),before=clone(loaded);
 assert.deepEqual(previewMovement(loaded.encounters,input(),data),previewMovement(world.value.encounters,input(),data));assert.deepEqual(loaded,before);
 const bad=clone(loaded);bad.encounters.remainders['001']=16;assert.throws(()=>new WorldStore(bad,mapIds));bad.encounters.remainders['001']=0;bad.encounters.active=true;assert.throws(()=>new WorldStore(bad,mapIds));
});
test('historical four-role route metadata binds first contact, retaining later hawk contacts as deferred',async()=>{
 const content=clone(runtimeContent);content.battle_rosters['forest-source-group']=meta.roles.map(role=>role.id);
 validateBattleViewMetadata(meta,content);
 const layers=await read('yantu_layers.json');
 for(const r of meta.roles){const timeline=compileActionTimeline(meta,layers,r.id,null,null,content);assert.equal(timeline.filter(s=>s.event).length,1);}
 assert.equal(meta.roles.find(r=>r.id==='011').skill.segments.filter(s=>s.deferred_source_event).length,2);
});
test('multi-enemy loop skips killed attacker while surviving enemies still act; win requires every enemy',async()=>{
 const world=new WorldStore(clone(seed),mapIds),g=generateGroup(data.maps.M70010,data,queue([40,3,0,0,1,2,0]));
 const sample=createForestSample(world.snapshot(),base,forest,g,config),calls=[];
 const battle=new BattleController({world,id:()=> 'multi',resolveAction:({attacker,skill})=>{calls.push(attacker.id);return {hit:true,damage:attacker.side==='player'?9999:1,mp_cost:skill.mp_cost,after_settled_raw:1};},applyDamage:applyNativeDamage,consumeResources:consumeBattleMp,resourcesForWorld,
  playAction:async(r,{onImpact})=>{onImpact();onImpact();}});
 battle.start({...sample,rng:()=>0});await battle.choose('yantu','enemy-1');assert.deepEqual(calls,['001','enemy-0','enemy-2','enemy-3']);assert.equal(battle.snapshot().phase,'command');
 assert.throws(()=>battle.start({...sample,rng:()=>0}));
 for(const id of ['enemy-0','enemy-2','enemy-3'])await battle.choose('yantu',id);
 assert.equal(battle.snapshot().phase,'victory');const before=world.location,result=battle.finish(),after=world.snapshot();assert.equal(result.rewards_applied,false);assert.deepEqual(world.location,before);assert.deepEqual(battle.finish(),result);assert.deepEqual(world.snapshot(),after);
});
test('flying hawk rejects Yantu mask5; verified learned Yanci mask6 can resolve damage and win',async()=>{
 const world=new WorldStore(clone(seed),mapIds),group=generateGroup(data.maps.M70010,data,queue([0,0,0,0])),sample=createForestSample(world.snapshot(),base,forest,group,config);
 const battle=new BattleController({world,resolveAction,applyDamage:applyNativeDamage,consumeResources:consumeBattleMp,resourcesForWorld,playAction:async(r,{onImpact})=>onImpact()});
 battle.start({...sample,rng:createNativeRng(0x20261011)});await battle.choose('yantu');assert.equal(battle.snapshot().history[0].result.reason,'action-class-rejected');
 for(let i=0;i<15&&battle.snapshot().phase==='command';i++)await battle.choose('yanci');
 assert.equal(battle.snapshot().phase,'victory');assert.ok(battle.snapshot().history.some(h=>h.skill_id==='yanci'&&h.result.damage>0));
});
test('post-story route→native group→bounded real numeric battle→save→reload preserves position and menu',async()=>{
 const world=new WorldStore(clone(seed),mapIds),controller=new WorldMapController({world,data:wm,prepare:async d=>{const map=await read('maps/'+d.map_id.toLowerCase()+'.json');const e=map.route_entry;return {location:{map_id:d.map_id,x:e.x,y:e.y,direction:e.direction}};},load:()=>{}});
 for(const command of planRouteExit(world.value,'M17010',48,events).commands)controller.apply(command);await controller.select(6);
 assert.deepEqual(world.location,{map_id:'M70010',x:272,y:736,direction:2});
 const group=generateGroup(data.maps.M70010,data,queue([0,0,0,1])),sample=createForestSample(world.snapshot(),base,forest,group,config),rng=createNativeRng(0x20261011);
 const battle=new BattleController({world,resolveAction,applyDamage:applyNativeDamage,consumeResources:consumeBattleMp,resourcesForWorld,playAction:async(r,{onImpact})=>onImpact()});
 battle.start({...sample,rng});for(let i=0;i<30&&battle.snapshot().phase==='command';i++)await battle.choose('yantu');assert.equal(battle.snapshot().phase,'victory');battle.finish();
 const state=initialEncounterState(seed.party);state.rng_state=rng.state;world.setEncounterState(state);
 const loaded=await decodeSave(await encodeSave(world.snapshot()),mapIds);assert.deepEqual(loaded,world.snapshot());
 for(const command of planRouteExit(world.value,'M70010',1,events).commands)controller.apply(command);await controller.select(4);assert.equal(world.location.map_id,'M17010');
});
