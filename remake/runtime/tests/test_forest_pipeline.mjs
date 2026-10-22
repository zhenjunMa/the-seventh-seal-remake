import {battleActive,chooseReady} from './helpers/battle_clock.mjs';
// Full source records, real exported PNGs, numeric rules and atomic world/save
// integration. Canvas and time are bounded adapters, not a GAME.exe replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BattleController} from '../web/core/combat.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {createNativeRng,resolveAction,applyNativeDamage} from '../web/core/combat_rules.mjs';
import {consumeBattleMp,resourcesForWorld,createBattleSample} from '../web/combat_sample.mjs';
import {createForestSample} from '../web/forest_sample.mjs';
import {composeNativeSequence,directSequence,compileNativeSequence} from '../web/core/skill_sequence.mjs';
import {BattleView} from '../web/battle_view.mjs';
import {planVictoryRewards} from '../web/core/battle_rewards.mjs';
const copy=structuredClone,web=new URL('../web/',import.meta.url),root=new URL('../../../',import.meta.url);
const read=async p=>JSON.parse(await readFile(new URL('data/'+p,web)));
const [seed,base,forest,config,scheduler,ai,rewards,reactions,status,meta]=await Promise.all(['route_seed.json','combat_sample.json','forest_combat.json','skills.json','battle_scheduler.json','forest_ai.json','forest_rewards.json','forest_reactions.json','forest_status.json','enemy_battle_view.json'].map(read));
const maps=['M01010','M01030','M17010','M70010'],assets=new Map();
function canvas(){const ctx={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},save(){},restore(){},drawImage(){},fillText(){},createLinearGradient:()=>({addColorStop(){}})};return {width:960,height:540,getContext:()=>ctx};}
async function assetLoader(a){if(assets.has(a.path))return assets.get(a.path);const b=await readFile(a.path.startsWith('/prototype/')?new URL('remake/prototype/web/'+a.path.slice(11),root):new URL(a.path.slice(1),web));
 assert.equal(createHash('sha256').update(b).digest('hex'),a.sha256,a.path);assert.equal(b.readUInt32BE(16),a.width);assert.equal(b.readUInt32BE(20),a.height);const value={image:{width:a.width,height:a.height,path:a.path},sha256:a.sha256};assets.set(a.path,value);return value;}
async function viewFixture(){const v=new BattleView({canvas:canvas(),metadataPath:'/data/enemy_battle_view.json',assetLoader,jsonLoader:async p=>read(p.slice('/data/'.length))});await v.prepare();return v;}
function sample(ids,world=seed){return createForestSample(world,base,forest,{map_id:'M70010',members:ids.map(id=>({id}))},config,scheduler,ai,rewards,reactions,status);}
async function fixture(ids=['012'],extra={}){const world=new WorldStore(copy(seed),maps),v=await viewFixture(),logs=[];let time=0,battle;
 const input=sample(ids,world.snapshot());v.setRoster(input.actors,input.skills);
 battle=new BattleController({world,id:()=> 'pipeline',now:()=>time,waitTick:async()=>{time+=20;},resolveAction,applyDamage:applyNativeDamage,resourcesForWorld,consumeResources:consumeBattleMp,log:e=>logs.push(e),
  playSequence:async(r,callbacks)=>{const pending=v.playSequence(r,callbacks);v.draw({actors:battle.state.actors},time);let n=0;while(v.run){assert.ok(++n<20000,'bounded sequence');time+=20;battle.advanceClock();v.draw({actors:battle.state.actors},time);}return pending;},...extra});
 const rng=createNativeRng(0x20261011);battle.start({...input,rng});return {world,battle,v,logs,rng,input};}
test('all eight skills retain every original CHR record and logical contact',async()=>{
 const v=await viewFixture();assert.ok(assets.size>50);let contacts=0;
 for(const actor of sample(['011','012','013']).actors){const skills=actor.side==='player'?Object.values(sample(['012']).skills).filter(s=>s.actor_id==='001'):ai.roles[actor.resource_id].learned_indices.map(i=>ai.roles[actor.resource_id].skills[i]);
  for(const skill of skills){const plan=directSequence(skill),compiled=compileNativeSequence(meta,actor.resource_id??actor.id,plan,[v.layers,...v.alternateLayers.values()]);
   const b=await readFile(new URL(skill.source.path,root)),offset=skill.source.fixed_record_offset;assert.equal(b.subarray(offset,offset+1053).toString('hex'),skill.fixed_raw_hex);
   for(const r of plan.records)assert.equal(b.subarray(r.source_offset,r.source_offset+176).toString('hex'),r.raw_hex);
   const expected=skill.actions.filter(a=>{const b=Buffer.from(a.raw_hex,'hex');return b[0]===0&&b.readUInt32LE(0x49)!==0;}).length;
   assert.equal(compiled.steps.filter(s=>s.event).length,expected,`${actor.resource_id}:${skill.original_skill_index}`);contacts+=expected;
  }
 }assert.ok(contacts>8,'eagle exposes multiple source contacts');
});
test('native composition retains prefix binding and rewrites only body range and skill provenance',()=>{
 for(const id of ['011','012','013'])for(const n of [3,4,5]){const role=ai.roles[id],indices=Array.from({length:n},(_,i)=>role.learned_indices[i%2]),plan=composeNativeSequence(role.skills,indices),compiled=compileNativeSequence(meta,id,plan);
  assert.deepEqual(plan.skill_indices,indices);assert.ok(compiled.steps.filter(s=>s.event).length>=n);
  assert.equal(Buffer.from(plan.records[0].raw_hex,'hex')[0x92],Buffer.from(plan.records[0].source_raw_hex,'hex')[0x92]);
  for(const r of plan.records){const actual=Buffer.from(r.raw_hex,'hex'),original=Buffer.from(r.source_raw_hex,'hex');for(let p=0;p<176;p++)if(![0x92,0x2f,0x30,0x31,0x32,0x33,0x34,0x35,0x36].includes(p))assert.equal(actual[p],original[p]);}
  const bodies=plan.records.filter(r=>Buffer.from(r.raw_hex,'hex')[0x2e]);assert.equal(Buffer.from(bodies[0].raw_hex,'hex').readInt32LE(0x2f),Buffer.from(bodies[0].raw_hex,'hex').readInt32LE(0x37));
  assert.equal(Buffer.from(bodies.at(-1).raw_hex,'hex').readInt32LE(0x2f),Buffer.from(bodies.at(-1).raw_hex,'hex').readInt32LE(0x3f));
 }
});
test('slow RAF merges response completion before later parent contact and visits each contact once',async()=>{
 const v=await viewFixture(),s=sample(['011']);v.setRoster(s.actors,s.skills);const skill=ai.roles['011'].skills[14],counter=reactions.roles['001'].skills.find(s=>s.original_id_raw===19),events=[];let idle=false;
 const d={actor_id:'001',target_id:'enemy-0',skill:counter,plan:{...directSequence(counter),allow_no_contacts:true}};
 const promise=v.playSequence({actor_id:'enemy-0',target_id:'001',skill_id:skill.id,plan:directSequence(skill)},{onRecord(){},onReactionRecord(){},onReactionEnd:()=>{idle=true;events.push('end');},onReactionContact:s=>({hit:true,damage:1,remainingHp:100}),
  onContact:s=>{events.push(s.contact_key);return {hit:true,damage:1,remainingHp:100,reaction_descriptor:events.length===1?d:null,idle};}});
 v.draw({actors:s.actors},0);v.draw({actors:s.actors},100000);const result=await promise;assert.equal(new Set(result.observations.contacts.map(c=>c.contact_key)).size,result.contact_count);assert.ok(events.includes('end'));assert.equal(result.contact_count,4);
});
test('real numeric forest fight submits every contact, reaction RNG, one reward and a reloadable save',async()=>{
 const {world,battle,logs,rng}=await fixture(['013']);let commands=0;while(battleActive(battle)){assert.ok(++commands<=30);await chooseReady(battle,commands%2?'yanci':'yantu','enemy-0');}
 assert.equal(battle.state.phase,'victory');assert.ok(logs.some(e=>e.reaction));assert.equal(battle.state.rewards.experience.find(r=>r.role_id==='001').experience,50);
 const stateBefore=rng.state,revision=world.value.revision,first=battle.finish(),saved=world.snapshot();assert.equal(first.rewards_applied,true);assert.equal(world.value.revision,revision+1);assert.equal(saved.reward_records.length,1);
 assert.deepEqual(battle.finish(),first);assert.equal(rng.state,stateBefore);assert.equal(world.value.revision,revision+1);
 const restored=await decodeSave(await encodeSave(saved),maps);assert.deepEqual(restored.reward_records,saved.reward_records);assert.deepEqual(restored.party,saved.party);assert.deepEqual(restored.inventory,saved.inventory);
 const replay=planVictoryRewards({world:restored,ledger:battle.state.reward_ledger,data:rewards,actors:battle.state.actors,rng:()=>{throw Error('duplicate RNG');}});assert.equal(replay.applied,false);
});

test('a real scheduled snow fight can be won with physical attacks and no spell',async()=>{
 const {battle,world,logs}=await fixture(['012']);const before=world.snapshot();let commands=0;
 while(battleActive(battle)){assert.ok(++commands<=30,'physical attacks must not miss forever');await chooseReady(battle,'yanci','enemy-0');}
 assert.equal(battle.state.phase,'victory');
 assert.ok(logs.some(e=>e.type==='battle-impact'&&e.actor_id==='001'&&e.hit&&e.damage>0));
 assert.ok(battle.state.history.filter(e=>e.actor_id==='001').every(e=>e.skill_id==='yanci'));
 assert.deepEqual(world.snapshot(),before);assert.equal(battle.finish().rewards_applied,true);
});
test('first lethal eagle contact interrupts defender but retains killer remaining source contacts and raw HP',async()=>{
 const {battle,world}=await fixture(['011'],{resolveAction:({skill})=>({hit:true,damage:5000,reaction:0,native_return:5000,mp_cost:skill.mp_cost,after_settled_raw:1,trace:[]})});
 const enemy=battle.actor('enemy-0'),player=battle.actor('001'),skill=ai.roles['011'].skills[14];battle.running=true;battle.state.phase='action';battle.chargeClock=0;
 await battle.performSequence(enemy,player,skill,directSequence(skill));battle.running=false;battle.state.phase='defeat';battle.state.outcome='defeat';
 assert.equal(player.hp.current,0);assert.equal(battle.state.history[0].contacts.length,3);assert.equal(battle.state.history[0].contacts.filter(c=>c.result.death).length,1);
 const committed=battle.finish();assert.equal(committed.rewards_applied,false);assert.equal(world.value.reward_records?.length??0,0);assert.equal(committed.resources.hp,(-player.linked_by_address['0x04f99088'])>>>0);
});
test('full skill MP validation and presentation failure never fabricate contact or rewards',async()=>{
 const {battle,world,rng}=await fixture(['012'],{playSequence:async()=>{throw Error('asset playback failure');}});const previous=world.snapshot();
 await assert.rejects(chooseReady(battle,'yanci'),/asset playback failure/);assert.equal(battle.state.phase,'interrupted');assert.equal(battle.state.history[0].contacts.length,0);
 assert.equal(battle.finish().rewards_applied,false);assert.deepEqual(world.snapshot(),previous);assert.ok(Number.isInteger(rng.state));
});
test('persisted level13 original growth recomputes equipment and fresh raw speed on next battle',async()=>{
 const {battle,world}=await fixture(['012'],{resolveAction:({skill})=>({hit:true,damage:5000,reaction:0,native_return:5000,mp_cost:skill.mp_cost,after_settled_raw:1,trace:[]})});
 // This is a declared experience-boundary fixture, separate from enemy EXP.
 battle.state.reward_ledger.experience=1566;await chooseReady(battle,'yanci');assert.equal(battle.state.phase,'victory');battle.finish();const player=world.value.party.find(a=>a.id==='001');assert.equal(player.level,13);
 const next=createBattleSample(world.snapshot(),base,config).actors.find(a=>a.id==='001');assert.equal(next.raw_by_address['0x0524a729'],54);assert.equal(next.hp.current,1144);assert.equal(next.raw_hp,1040);
 const restored=await decodeSave(await encodeSave(world.snapshot()),maps);assert.deepEqual(createBattleSample(restored,base,config).actors[0],next);
});
test('counter executes its source contact during parent attack and lethal counter cancels later parent hits',async()=>{
 const {battle,logs}=await fixture(['011'],{resolveAction:({attacker,skill})=>attacker.side==='enemy'?{hit:false,damage:0,reaction:2,native_return:0,mp_cost:skill.mp_cost,after_settled_raw:0,trace:[]}:{hit:true,damage:5000,reaction:0,native_return:5000,mp_cost:skill.mp_cost,after_settled_raw:1,trace:[]}});
 battle.rng=()=>0;battle.running=true;battle.state.phase='action';battle.chargeClock=0;
 const plan=composeNativeSequence(ai.roles['011'].skills,[14,15,14]);await battle.performSequence(battle.actor('enemy-0'),battle.actor('001'),ai.roles['011'].skills[14],plan);
 const impacts=logs.filter(e=>e.type==='battle-impact'),enemyContacts=impacts.filter(e=>e.actor_id==='enemy-0');assert.ok(enemyContacts.length<7,'lethal counter cancels remaining combination contacts');assert.ok(enemyContacts.length>=1);assert.equal(impacts.filter(e=>e.actor_id==='001').length,1);
 assert.equal(impacts[0].reaction.kind,'counter');assert.equal(impacts.find(e=>e.actor_id==='001').source_skill_index,20);assert.ok(enemyContacts.slice(1).every(e=>e.skipped==='native-contact-gate'));assert.equal(battle.actor('enemy-0').state_raw,5);assert.equal(battle.state.reward_ledger.defeated_ids.length,1);
});
test('all 1-4 enemy rosters and duplicate slots complete full AI/contact lifecycle and collect only once',async()=>{
 for(const ids of [['011'],['012','013'],['013','013','011'],['011','012','013','013']]){
  const {battle,world}=await fixture(ids,{resolveAction:({attacker,skill})=>({hit:true,damage:attacker.side==='player'?5000:1,reaction:0,native_return:attacker.side==='player'?5000:1,mp_cost:skill.mp_cost,after_settled_raw:1,trace:[]})});
  for(let i=0;battleActive(battle);i++){assert.ok(i<10);await chooseReady(battle,'yanci');}
  assert.equal(battle.state.phase,'victory');assert.equal(new Set(battle.state.reward_ledger.defeated_ids).size,ids.length);assert.equal(battle.state.reward_ledger.experience,ids.reduce((n,id)=>n+rewards.enemies[id].experience,0));
  battle.finish();battle.finish();assert.equal(world.value.reward_records.length,1);
 }
});
