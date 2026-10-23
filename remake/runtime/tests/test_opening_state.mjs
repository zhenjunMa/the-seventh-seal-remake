import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateWorld, WorldStore, encodeSave, decodeSave} from '../web/core/world.mjs';
import {completedOpeningWorld} from '../web/core/opening_state.mjs';
import {MovementMap} from '../web/core/movement.mjs';

const load = async name => JSON.parse(await readFile(new URL(`../web/data/${name}.json`, import.meta.url)));
const seed = await load('opening_seed'), legacy = await load('route_seed');
const catalog = await load('catalog'), ids = catalog.maps.map(m => m.id);
const result = {program_id:'new-game-resurrect', control_map:'M17020', location:{map_id:'M17020', x:1092, y:986}};

test('new game uses native defaults and empty story state, with both real positions traversable', async () => {
  validateWorld(seed, ids);
  assert.equal(catalog.seed, 'data/opening_seed.json');
  assert.equal(seed.source.path, 'GAME.exe');
  assert.equal(seed.money, 50); assert.deepEqual(seed.party.map(r=>r.id), ['001']);
  assert.equal(seed.party[0].level, 11); assert.equal(seed.party[0].hp.current, 880); assert.equal(seed.party[0].mp.current, 66);
  assert.equal(seed.inventory.length, 0); assert.ok(seed.flags.every(f=>f===0)); assert.ok(seed.event_records.every(r=>r.length===0));
  for (const at of [seed.location, result.location]) {
    const map = await load(`maps/${at.map_id.toLowerCase()}`);
    assert.equal(new MovementMap(map.movement).at(at.x,at.y).blocked, false);
  }
});
test('completion constructs one final world without altering the initial state', () => {
  const before = structuredClone(seed), next = completedOpeningWorld(seed,result,6,ids);
  assert.deepEqual(seed,before); assert.deepEqual(next.location,{...result.location,direction:6});
  assert.equal(next.opening.status,'complete'); assert.equal(next.revision,seed.revision+1);
  assert.deepEqual(next.flags,seed.flags); assert.deepEqual(next.inventory,[]);
});
test('completed opening survives save/load and legacy v1 saves do not replay a prologue', async () => {
  const next = completedOpeningWorld(seed,result,6,ids);
  assert.deepEqual(await decodeSave(await encodeSave(next),ids),next);
  const old = await decodeSave(await encodeSave(legacy),ids);
  assert.equal('opening' in old,false); assert.deepEqual(old,legacy);
});
test('invalid or repeated completion cannot replace the current progress', () => {
  const store = new WorldStore(legacy,ids), before = store.snapshot();
  for (const bad of [null,{...result,location:{...result.location,x:1}},{...result,control_map:'M72061'}])
    assert.throws(()=>store.replace(completedOpeningWorld(seed,bad,6,ids)));
  assert.deepEqual(store.snapshot(),before);
  assert.throws(()=>completedOpeningWorld(completedOpeningWorld(seed,result,6,ids),result,6,ids));
});
test('opening v1 extension rejects unsupported or inconsistent progress states', () => {
  for (const opening of [{id:'other',status:'pending'},{id:'resurrect',status:'running'},{id:'resurrect',status:'complete',cursor:14}])
    assert.throws(()=>validateWorld({...seed,opening},ids));
  assert.throws(()=>validateWorld({...seed,location:result.location},ids));
});
