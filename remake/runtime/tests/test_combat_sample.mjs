import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createBattleSample,resourcesForWorld} from '../web/combat_sample.mjs';
import {buildEffectiveAttributes,createNativeRng,resolveAction,applyNativeDamage} from '../web/core/combat_rules.mjs';
const data=JSON.parse(readFileSync(new URL('../web/data/combat_sample.json',import.meta.url)));
const seed=JSON.parse(readFileSync(new URL('../web/data/world_seed.json',import.meta.url)));
const copy=value=>structuredClone(value);

test('source sample uses saved player and CHR enemy with recovered equipment',()=>{
  const before=JSON.stringify(seed), sample=createBattleSample(seed,data), [player,enemy]=sample.actors;
  assert.deepEqual(player.hp,{current:1056,maximum:1056});
  assert.deepEqual(player.mp,{current:79,maximum:79});
  assert.deepEqual(enemy.hp,{current:1362,maximum:1362});
  assert.deepEqual(enemy.mp,{current:24,maximum:24});
  assert.equal(player.raw_by_address['0x0524a701'],960);
  assert.equal(player.raw_by_address['0x0524a705'],960);
  assert.equal(player.raw_by_address['0x0524a709'],72);
  assert.equal(player.raw_by_address['0x0524a70d'],72);
  assert.equal(player.linked_by_address['0x04f99088'],96);
  assert.equal(player.linked_by_address['0x04f99090'],7);
  assert.deepEqual(resourcesForWorld(player),{hp:960,mp:72});
  assert.equal(JSON.stringify(seed),before,'factory must not mutate persistent world');
  player.hp.current--;
  assert.equal(data.actors[0].hp.current,1056,'sample owns independent actor copy');
});

test('native effective fields use source ranges plus recovered link, not raw HUD',()=>{
  const sample=createBattleSample(seed,data), player=sample.actors[0], enemy=sample.actors[1];
  const p=buildEffectiveAttributes(player,sample.skills.yantu,createNativeRng(1));
  const e=buildEffectiveAttributes(enemy,sample.skills.snow_attack,createNativeRng(1));
  assert.equal(p.attack,63);assert.equal(p.defense,44);assert.equal(p.term4,74);
  assert.equal(e.attack,48);assert.equal(e.defense,24);assert.equal(e.term4,50);
  assert.equal(sample.skills.yantu.mp_cost,0);assert.equal(sample.skills.snow_attack.mp_cost,0);
  for(const skill of Object.values(sample.skills)) {
    const bytes=Buffer.from(skill.fixed_raw_hex,'hex');
    assert.equal(bytes.length,0x41d);
    assert.equal(bytes.readInt32LE(0x14f),0,'source delta proves cost zero');
    assert.equal(bytes[0x23],1,'selected original skill learned');
  }
});

test('native damage resources survive raw DWORD death encoding and restore as dead',()=>{
  const sample=createBattleSample(seed,data), player=sample.actors[0];
  const hurt=applyNativeDamage(player,{damage:17,after_settled_raw:1});
  assert.equal(hurt.raw_hp,943);assert.equal(hurt.hp.current,1039);
  assert.deepEqual(resourcesForWorld(hurt),{hp:943,mp:72});
  const dead=applyNativeDamage(player,{damage:1057,after_settled_raw:1});
  assert.equal(dead.raw_hp,-96);assert.equal(dead.hp.current,0);
  assert.equal(dead.raw_by_address['0x0524a701'],-96);
  assert.deepEqual(resourcesForWorld(dead),{hp:4294967200,mp:72});
  const saved=copy(seed);saved.party[0].hp.current=resourcesForWorld(dead).hp;
  const restored=createBattleSample(saved,data).actors[0];
  assert.equal(restored.hp.current,0);assert.equal(restored.raw_hp,-96);assert.equal(restored.state_raw,4);
});

test('factory preserves depleted raw MP and raw zero HP plus linked bonuses',()=>{
  const world=copy(seed);world.party[0].hp.current=0;world.party[0].mp.current=0;
  const player=createBattleSample(world,data).actors[0];
  assert.equal(player.hp.current,96);assert.equal(player.state_raw,0);
  assert.equal(player.mp.current,7);assert.deepEqual(resourcesForWorld(player),{hp:0,mp:0});
  world.party[0].mp.current=(-7)>>>0;
  assert.equal(createBattleSample(world,data).actors[0].mp.current,0);
});

test('factory rejects unsupported changed imports and inconsistent commits',()=>{
  for(const change of [w=>w.source.sha256='0'.repeat(64),w=>w.party[0].level=13,
                      w=>w.party[0].attributes_stored.attack.current=61,w=>w.party[0].hp.maximum=961]) {
    const world=copy(seed);change(world);assert.throws(()=>createBattleSample(world,data));
  }
  const player=createBattleSample(seed,data).actors[0];
  player.hp.current--;assert.throws(()=>resourcesForWorld(player),/HP显示/);
});

test('both source skills resolve and commit against full source native inputs',()=>{
  const sample=createBattleSample(seed,data), rng=createNativeRng(1234);
  for(const [actorIndex,skillId] of [[0,'yantu'],[1,'snow_attack']]) {
    const attacker=sample.actors[actorIndex],target=sample.actors[1-actorIndex];
    const result=resolveAction({attacker,target,skill:sample.skills[skillId],rng});
    assert.equal(result.mp_cost,0);assert.ok(result.damage>=0);assert.equal(typeof result.hit,'boolean');
    const after=applyNativeDamage(target,result);
    assert.equal(after.hp.current,target.hp.current-result.damage);
    assert.equal(after.raw_by_address['0x0524a701'],after.raw_hp);
    sample.actors[1-actorIndex]=after;
  }
  resourcesForWorld(sample.actors[0]);
});
