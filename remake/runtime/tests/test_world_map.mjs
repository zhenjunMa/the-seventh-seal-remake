// Controller callbacks and area1 fixture below are synthetic test scaffolding.
// Area0 destination bytes and command/save semantics are checked independently
// against the immutable shipped-artifact route evidence, not original play.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WorldStore, validateWorld, encodeSave, decodeSave} from '../web/core/world.mjs';
import {WorldMapController, validateWorldMapData} from '../web/core/world_map.mjs';

const runtime = new URL('../', import.meta.url);
const seed = JSON.parse(await readFile(new URL('web/data/world_seed.json', runtime)));
const route = JSON.parse(await readFile(new URL('evidence/route_native_20261011.json', runtime)));
const nativeTable = route.records.find(record => record.operation === 'read_bytes' && record.parameters.address === '0x678ff8');
const bytes = Buffer.from(nativeTable.normalized_result.bytes_hex, 'hex');
const entries = Array.from({length: bytes[5]}, (_, index) => {
  const offset = 6 + index * 23;
  const filename = bytes.subarray(offset + 1, offset + 21).toString('ascii').split('\0')[0];
  return {index, status: bytes[offset], map_id: filename.replace(/\.dat$/i, '').toUpperCase(), entry_marker: bytes[offset + 21], sort: bytes[offset + 22]};
});
const origin = {kind: 'synthetic-test-fixture', file: 'runtime/tests/test_world_map.mjs'};
const data = {source: origin, evidence: ['synthetic:world-map-contract'], areas: [0, 1].map(id => ({
  id, selected_index: 0, statuses: entries.map(entry => entry.status),
  destinations: entries.map(entry => ({index: entry.index, name: `synthetic destination ${entry.index}`, map_id: entry.map_id,
    entry_marker: entry.entry_marker, source: id === 0 ? {evidence_file: 'runtime/evidence/route_native_20261011.json', address: '0x678ff8'} : origin,
    evidence: [id === 0 ? nativeTable.evidence_id : 'synthetic:area1-table']})),
}))};
const mapIds = ['M01010','M01030','M17010','M70010'];
const clone = value => structuredClone(value);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function harness(hooks = {}, initial = seed) {
  const world = new WorldStore(initial, mapIds);
  const state = {view: {map_id: seed.location.map_id}, prepared: [], loads: [], phases: [], menus: [], rollbacks: 0};
  const controller = new WorldMapController({world, data,
    prepare: async destination => {
      state.prepared.push(destination.map_id);
      await hooks.prepare?.(destination, world);
      return {synthetic: true, destination, location: hooks.location?.(destination) ?? {map_id: destination.map_id, x: 120, y: 240, direction: 2}};
    },
    load: (prepared, location) => {
      state.loads.push(location.map_id); state.view = {...location};
      return hooks.load?.(prepared, location, world);
    },
    captureView: () => clone({view: state.view, loads: state.loads}),
    rollbackView: checkpoint => { state.view = checkpoint.view; state.loads = checkpoint.loads; state.rollbacks++; },
    onPhase: phase => state.phases.push(phase), notify: menu => state.menus.push(menu),
  });
  return {world, controller, state};
}
function openForest(hooks = {}) {
  const result = harness(hooks);
  result.controller.initialize();
  result.controller.apply({mode: 1, area: 0, destination: 6});
  result.controller.apply({mode: 0, area: 0, destination: 4});
  return result;
}

test('native area0 bytes identify seven initially closed destinations and route indices', () => {
  assert.equal(bytes.length, 236); assert.equal(bytes[4], 0); assert.equal(bytes[5], 7);
  assert.deepEqual(entries.map(entry => entry.status), Array(7).fill(1));
  assert.deepEqual(entries[4], {index: 4, status: 1, map_id: 'M17010', entry_marker: 1, sort: 5});
  assert.deepEqual(entries[6], {index: 6, status: 1, map_id: 'M70010', entry_marker: 1, sort: 5});
  const save = route.records.find(record => record.operation === 'procedure_pseudo_code' && record.parameters.procedure === '0x49f260');
  assert.match(save.normalized_result, /WriteFile\(param_1,&DAT_00678ff8,0x1d8/);
  const mutation = route.records.find(record => record.parameters.procedure === '0x49f340' && typeof record.normalized_result === 'string');
  assert.match(mutation.normalized_result, /MOV byte ptr \[EBP \+ -0x4\], 0x0/);
  assert.match(mutation.normalized_result, /MOV byte ptr \[EBP \+ -0x3\], 0x0/);
  assert.match(mutation.normalized_result, /MOV byte ptr \[EBP \+ -0x2\], 0x2/);
});

test('legacy v1 saves retain absent world_map; initialization is explicit and source identified', async () => {
  const {world, controller} = harness(), before = world.snapshot();
  assert.equal('world_map' in before, false);
  assert.deepEqual(await decodeSave(await encodeSave(before), mapIds), before);
  assert.throws(() => controller.open(0), /尚未初始化/);
  assert.throws(() => controller.apply({mode: 0, area: 0, destination: 4}), /尚未初始化/);
  assert.deepEqual(world.snapshot(), before);
  const result = controller.initialize();
  assert.equal(result.initialized, true); assert.deepEqual(result.source, data.source);
  assert.equal(world.value.revision, before.revision + 1);
  assert.deepEqual(world.value.world_map, controller.initialState());
  assert.deepEqual(controller.initialize(), {initialized: false});
  assert.equal(world.value.revision, before.revision + 1);
});

test('type9 modes 0/1 open status0, mode0 persists selection, mode2 makes destination unavailable', async () => {
  const {world, controller} = harness(); controller.initialize();
  controller.apply({mode: 1, area: 0, destination: 6});
  assert.equal(controller.phase, 'closed'); assert.equal(world.value.world_map.areas[0].selected_index, 0);
  controller.apply({mode: 0, area: 0, destination: 4});
  assert.equal(controller.phase, 'open'); assert.equal(controller.area, 0);
  assert.equal(world.value.world_map.areas[0].selected_index, 4);
  assert.equal(controller.snapshot().destinations[6].available, true);
  controller.apply({mode: 2, area: 0, destination: 6});
  assert.equal(world.value.world_map.areas[0].statuses[6], 2);
  assert.equal(controller.snapshot().destinations[6].available, false);
  await assert.rejects(controller.select(6), /尚未开放/);
  const restored = await decodeSave(await encodeSave(world.snapshot()), mapIds);
  assert.deepEqual(restored, world.snapshot()); assert.deepEqual(Object.keys(restored.world_map), ['areas']);
  assert.deepEqual(Object.keys(restored.world_map.areas[0]).sort(), ['id','selected_index','statuses']);
  const beforeClose = world.snapshot(); controller.close(); assert.deepEqual(world.snapshot(), beforeClose);
  const fresh = harness({}, restored); assert.equal(fresh.controller.phase, 'closed'); assert.equal(fresh.controller.area, null);
});

test('open status does not make an unconnected destination loadable', async () => {
  const {world, controller, state} = harness(); controller.initialize();
  controller.apply({mode: 0, area: 0, destination: 0});
  const before = world.snapshot();
  assert.equal(controller.snapshot().destinations[0].status, 0);
  assert.equal(controller.snapshot().destinations[0].available, false);
  await assert.rejects(controller.select(0), /尚未接入/);
  assert.deepEqual(world.snapshot(), before); assert.deepEqual(state.prepared, []); assert.equal(controller.phase, 'open');
});

test('unknown mode/area/index/extra parameters reject without world or menu changes', () => {
  const {world, controller} = openForest(), before = world.snapshot(), menu = controller.snapshot();
  for (const parameters of [null, {}, {mode: 3, area: 0, destination: 4}, {mode: '0', area: 0, destination: 4},
    {mode: 0, area: 2, destination: 4}, {mode: 0, area: 0, destination: -1}, {mode: 0, area: 0, destination: 7},
    {mode: 0, area: 0, destination: 4, active: true}]) assert.throws(() => controller.apply(parameters));
  assert.deepEqual(world.snapshot(), before); assert.deepEqual(controller.snapshot(), menu);
});

test('strict optional saved state rejects bad statuses, selection, areas and UI fields', async () => {
  const {world} = openForest(), before = world.snapshot();
  for (const alter of [
    next => { next.world_map = null; },
    next => { next.world_map.active = true; },
    next => { next.world_map.areas[0].active = true; },
    next => { next.world_map.areas[0].selected_index = 7; },
    next => { next.world_map.areas[0].statuses[0] = 3; },
    next => { next.world_map.areas[0].statuses[0] = '0'; },
    next => { next.world_map.areas[0].statuses.pop(); },
    next => { next.world_map.areas.pop(); },
    next => { next.world_map.areas[1].id = 0; },
  ]) {
    const corrupt = clone(before); alter(corrupt);
    assert.throws(() => validateWorld(corrupt, mapIds)); assert.throws(() => world.replace(corrupt));
    assert.deepEqual(world.snapshot(), before);
    await assert.rejects(encodeSave(corrupt));
  }
});

test('source-backed destination contract rejects missing provenance and inconsistent indices', () => {
  for (const alter of [
    next => { delete next.source; }, next => { next.evidence = []; },
    next => { delete next.areas[0].destinations[0].source; }, next => { next.areas[0].destinations[0].evidence = []; },
    next => { next.areas[0].destinations[0].index = 1; }, next => { next.areas[0].destinations[0].entry_marker = -1; },
    next => { next.areas[0].destinations.pop(); },
  ]) { const corrupt = clone(data); alter(corrupt); assert.throws(() => validateWorldMapData(corrupt)); }
});

test('selection waits without persistent writes, prevents duplicate loads and commits position/selection together', async () => {
  const gate = deferred(), {world, controller, state} = openForest({prepare: () => gate.promise});
  const before = world.snapshot(), previousView = clone(state.view);
  const pending = controller.select(6);
  assert.equal(controller.phase, 'loading'); assert.deepEqual(world.snapshot(), before); assert.deepEqual(state.view, previousView);
  await assert.rejects(controller.select(6), /正在加载/);
  assert.throws(() => controller.close(), /正在加载/); assert.throws(() => controller.open(0), /正在加载/);
  assert.throws(() => controller.apply({mode: 0, area: 0, destination: 4}), /正在加载/);
  assert.deepEqual(state.prepared, ['M70010']); assert.deepEqual(state.loads, []);
  gate.resolve(); await pending;
  assert.deepEqual(world.location, {map_id: 'M70010', x: 120, y: 240, direction: 2});
  assert.equal(world.value.world_map.areas[0].selected_index, 6); assert.equal(world.value.revision, before.revision + 1);
  assert.deepEqual(state.view, world.location); assert.deepEqual(state.phases, ['open','loading','closed']);
  assert.equal(controller.phase, 'closed'); assert.equal(controller.area, null);
});

for (const failure of ['prepare','entry','partial-view']) {
  test(`synthetic ${failure} failure retains previous selection/location and open menu`, async () => {
    let fail = true;
    const {world, controller, state} = openForest({
      prepare: () => { if (fail && failure === 'prepare') throw new Error('synthetic prepare failure'); },
      location: destination => ({map_id: fail && failure === 'entry' ? 'M99999' : destination.map_id, x: 120, y: 240, direction: 2}),
      load: () => { if (fail && failure === 'partial-view') throw new Error('synthetic partial view failure'); },
    });
    const before = world.snapshot(), oldView = clone(state.view), menu = controller.snapshot();
    await assert.rejects(controller.select(6));
    assert.deepEqual(world.snapshot(), before); assert.deepEqual(state.view, oldView);
    assert.equal(state.rollbacks, failure === 'partial-view' ? 1 : 0);
    assert.deepEqual(controller.snapshot(), menu); assert.equal(controller.phase, 'open');
    fail = false; await controller.select(6); assert.equal(world.location.map_id, 'M70010');
  });
}

test('revision conflict preserves intervening input, rejects scene commit and keeps menu open', async () => {
  const gate = deferred(), {world, controller, state} = openForest({prepare: () => gate.promise});
  const pending = controller.select(6);
  world.setPosition(seed.location.x + 8, seed.location.y, 6); const intervening = world.snapshot();
  gate.resolve(); await assert.rejects(pending, /世界状态已变化/);
  assert.deepEqual(world.snapshot(), intervening); assert.deepEqual(state.loads, []);
  assert.equal(controller.phase, 'open'); assert.equal(world.value.world_map.areas[0].selected_index, 4);
});

test('callbacks that mutate world are rejected without overwriting their newer revision', async () => {
  for (const stage of ['prepare', 'load']) {
    let changed;
    const mutate = (_unused, _location, world) => { world.setPosition(seed.location.x + 8, seed.location.y, 6); changed = world.snapshot(); };
    const hooks = stage === 'prepare' ? {prepare: (destination, world) => mutate(destination, null, world)} : {load: mutate};
    const {world, controller, state} = openForest(hooks);
    await assert.rejects(controller.select(6), /世界状态已变化/);
    assert.deepEqual(world.snapshot(), changed); assert.equal(controller.phase, 'open');
    assert.equal(state.rollbacks, stage === 'load' ? 1 : 0);
  }
});
