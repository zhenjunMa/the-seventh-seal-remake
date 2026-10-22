import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {resolveAction,applyNativeDamage,createNativeRng} from '../web/core/combat_rules.mjs';
import {createBattleSample,resourcesForWorld} from '../web/combat_sample.mjs';
const root=new URL('../',import.meta.url),paths=['web/data/world_seed.json','web/data/combat_sample.json'];
const bytes=await Promise.all(paths.map(p=>readFile(new URL(p,root)))),[seed,data]=bytes.map(b=>JSON.parse(b)),results=[];
function fixture(rawHP=seed.party[0].hp.current){
  const input=structuredClone(seed);input.party[0].hp.current=rawHP;
  const world=new WorldStore(input,['M01010','M01030']),logs=[];
  const battle=new BattleController({world,resolveAction,applyDamage:applyNativeDamage,resourcesForWorld,log:e=>logs.push(e),id:()=> 'real-source-controlled-sample',
    playAction:async(result,{onImpact})=>{onImpact({source_frame:result.actor_id==='001'?338:91,authority:'synthetic instant animation callback; actual view tested separately'});}});
  battle.start({...createBattleSample(world.snapshot(),data),rng:createNativeRng(0x20261011)});return {world,battle,logs};
}
function contract(name,fn){test(name,async()=>{await fn();results.push({name,passed:true});});}
contract('real actor/skill/rules with controlled seed complete three commands and exactly five actions',async()=>{
  const f=fixture(),before=f.world.snapshot();
  let s=await f.battle.choose('yantu');assert.equal(s.round,2);assert.deepEqual(s.actors.map(a=>a.hp.current),[996,863]);
  s=await f.battle.choose('yantu');assert.equal(s.round,3);assert.deepEqual(s.actors.map(a=>a.hp.current),[932,362]);
  s=await f.battle.choose('yantu');assert.equal(s.phase,'victory');assert.equal(s.action_count,5);assert.equal(s.actors[1].hp.current,0);
  assert.equal(s.actors[0].mp.current,79);assert.deepEqual(f.world.snapshot(),before);
  const done=f.battle.finish();assert.deepEqual(done.resources,{hp:836,mp:72});assert.equal(done.rewards_applied,false);
  assert.equal(f.world.value.revision,before.revision+1);assert.deepEqual(f.world.location,before.location);assert.deepEqual(f.world.value.flags,before.flags);
  assert.deepEqual(f.world.value.inventory,before.inventory);assert.deepEqual(f.world.value.party[1],before.party[1]);assert.equal(f.world.value.leader_id,before.leader_id);
  const once=f.world.snapshot();assert.deepEqual(f.battle.finish(),done);assert.deepEqual(f.world.snapshot(),once);
  const decoded=await decodeSave(await encodeSave(once),['M01010','M01030']);assert.equal(createBattleSample(decoded,data).actors[0].hp.current,932);
});
contract('low raw HP boundary retains equipment death bits and cannot resurrect on save reload',async()=>{
  const f=fixture(0);assert.equal(f.battle.actor('001').hp.current,96);
  await f.battle.choose('yantu');const s=await f.battle.choose('yantu');assert.equal(s.phase,'defeat');assert.equal(s.action_count,4);
  const done=f.battle.finish();assert.equal(done.resources.hp,0xffffffa0);assert.equal(f.battle.actor('001').hp.current,0);
  const decoded=await decodeSave(await encodeSave(f.world.snapshot()),['M01010','M01030']),rebuilt=createBattleSample(decoded,data);
  assert.equal(rebuilt.actors[0].hp.current,0);assert.equal(rebuilt.actors[0].state_raw,4);assert.equal(rebuilt.actors[0].raw_hp,-96);
  assert.throws(()=>f.battle.start({...rebuilt,rng:createNativeRng(1)}),/倒下/);
});
contract('controlled test exit after an enemy action preserves HP and zero-cost MP',async()=>{
  const f=fixture();await f.battle.choose('yantu');const result=f.battle.finish();assert.equal(result.outcome,'aborted');
  assert.equal(result.actions,2);assert.deepEqual(result.resources,{hp:900,mp:72});assert.equal(f.world.value.party[0].hp.current,900);
});
after(async()=>{
  const code=['web/core/combat.mjs','web/core/combat_rules.mjs','web/combat_sample.mjs','tests/test_turn_sample.mjs'];
  const hash=b=>createHash('sha256').update(b).digest('hex');
  await writeFile(new URL('evidence/turn_sample_verification_20261011.json',root),JSON.stringify({schema:'seventh-seal-turn-sample-verification',version:1,tests:3,passed:results.length,failed:3-results.length,
    authority:'real exported actor/equipment/skills + static numeric port + controlled double-action lifecycle; instant animation callback and low-HP world variant are synthetic',
    original_game_execution_observed:false,original_action_queue_claimed:false,rng_seed:0x20261011,
    fixture_sha256:Object.fromEntries(paths.map((p,i)=>[p,hash(bytes[i])])),code_hashes:Object.fromEntries(await Promise.all(code.map(async p=>[p,hash(await readFile(new URL(p,root)))]))),cases:results},null,2)+'\n');
});
