// Runtime contracts use the exported historical world seed and real map data.
// Every event and async-load callback below is an explicitly synthetic test
// fixture. A passing interpreter test is not evidence of original NPC behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {WorldStore, validateWorld, encodeSave, decodeSave} from '../web/core/world.mjs';
import {SceneController} from '../web/core/scenes.mjs';
import {EventRunner, validateProgram} from '../web/core/events.mjs';
import {MovementMap} from '../web/core/movement.mjs';

const runtime = new URL('../', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const seedBytes = await readFile(new URL('web/data/world_seed.json', runtime));
const seed = JSON.parse(seedBytes);
const mapIndexBytes = await readFile(new URL('web/data/map_index.json', runtime));
const mapIndex = JSON.parse(mapIndexBytes);
const mapIds = mapIndex.maps.map(map => map.id);
const mapBytes = await Promise.all(mapIds.map(id => readFile(new URL(`web/data/maps/${id.toLowerCase()}.json`, runtime))));
const maps = new Map(mapBytes.map(bytes => { const data = JSON.parse(bytes); return [data.id, data]; }));
const FIXTURE_FLAG = 1937;

function contract(name, scope, run) {
  test(name, {concurrency: false}, run);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function world() { return new WorldStore(seed, mapIds); }
function syntheticWorld() {
  const value = clone(seed);
  value.flags[FIXTURE_FLAG] = 0;
  return new WorldStore(value, mapIds);
}
function syntheticCommand(op, fields = {}) {
  return {op, ...fields,
    source: {kind: 'synthetic-test-fixture', file: 'runtime/tests/test_runtime.mjs'},
    evidence: ['synthetic:test-runtime-contract']};
}
function syntheticEvent(commands, id = 'synthetic:branch-test') {
  return {id, synthetic: true, authority: 'unit-test-only', program: commands};
}
function nativeEntryFixture(commands, id = 'synthetic:native-entry') {
  return {...syntheticEvent(commands, id), commit_policy: 'native-entry'};
}
function branchEvent() {
  return syntheticEvent([
    syntheticCommand('if_flag', {index: FIXTURE_FLAG, compare: 'eq', value: 1, target: 4}),
    syntheticCommand('say', {speaker: 'synthetic fixture', text: 'synthetic first visit'}),
    syntheticCommand('set_flag', {index: FIXTURE_FLAG, value: 1}),
    syntheticCommand('end'),
    syntheticCommand('say', {speaker: 'synthetic fixture', text: 'synthetic repeat visit'}),
    syntheticCommand('end'),
  ]);
}
function accessibleLocation(mapId) {
  const data = maps.get(mapId), movement = new MovementMap(data.movement);
  for (let y = 8; y < data.height; y += 16) {
    for (let x = 8; x < data.width; x += 16) {
      if (!movement.at(x, y).blocked) return {map_id: mapId, x, y, direction: 7};
    }
  }
  throw new Error(`No accessible test point in ${mapId}`);
}
function sceneHarness(store, hooks = {}) {
  const state = {synthetic: true, prepared: [], commits: [], phases: [], view: null, rollbacks: 0};
  const controller = new SceneController({
    world: store,
    prepare: async mapId => {
      state.prepared.push(mapId);
      await hooks.prepare?.(mapId);
      const data = maps.get(mapId);
      assert.ok(data, 'synthetic harness must use an exported real map');
      return {synthetic_harness: true, data, movement: new MovementMap(data.movement)};
    },
    validateEntry: (prepared, location) => {
      if (prepared.movement.at(location.x, location.y).blocked) throw new Error('synthetic entry rejection: blocked actual map cell');
      hooks.validateEntry?.(prepared, location);
    },
    commitView: (prepared, location, reason) => {
      hooks.beforeCommit?.(prepared, location, reason);
      state.view = {map_id: prepared.data.id, ...location, camera: {x: location.x, y: location.y},
        map_name: prepared.data.name, options: (prepared.data.probes ?? []).map(probe => probe.name)};
      state.commits.push({map_id: prepared.data.id, reason});
      hooks.afterPartialCommit?.(state.view);
    },
    captureView: () => ({view: clone(state.view), commits: clone(state.commits)}),
    rollbackView: checkpoint => {
      state.view = clone(checkpoint.view); state.commits = clone(checkpoint.commits); state.rollbacks++;
    },
    onPhase: phase => state.phases.push(phase),
  });
  return {controller, state};
}
async function bootScene(store, hooks = {}) {
  const harness = sceneHarness(store, hooks);
  await harness.controller.loadLocation(store.location, {reason: 'synthetic boot'});
  return harness;
}

contract('historical seed identity, counts, isolated snapshots and SHA save round trip', 'real-exported-seed', async () => {
  assert.match(seed.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(seed.source.original_map, 'M01060.DAT');
  assert.equal(seed.location.map_id, 'M01010');
  assert.equal(seed.leader_id, '001');
  assert.equal(seed.flags.length, 2000);
  assert.equal(seed.event_records.length, 2000);
  assert.equal(seed.event_records.flat().length, 344);
  assert.equal(seed.inventory.length, 19);
  assert.deepEqual(seed.party.map(actor => [actor.id, actor.hp.current, actor.mp.current]), [['001', 960, 72], ['002', 900, 0]]);
  const store = world(), detached = store.snapshot();
  detached.party[0].hp.current = 1;
  detached.flags[10] = 123456;
  assert.deepEqual(store.snapshot(), seed);
  const envelope = await encodeSave(store.snapshot());
  assert.equal(envelope.sha256, hash(envelope.payload)); // independent Node hash against WebCrypto result
  assert.deepEqual(await decodeSave(JSON.parse(JSON.stringify(envelope)), mapIds), seed);
  return {source_sha256_verified: true, flags: 2000, raw_event_records: 344, party: 2, inventory: 19,
    seed_development_relocation: true, original_new_game_state_claimed: false};
});

contract('exit source coordinates are normalized out of persistent current position', 'world-save-contract', async () => {
  const withEvidence = clone(seed);
  Object.assign(withEvidence.location, {cell_x:65, cell_y:6, native_x:520, native_y:48});
  const store = new WorldStore(withEvidence, mapIds);
  assert.deepEqual(store.location, seed.location);
  store.setPosition(346, 1500, 3);
  assert.deepEqual(store.location, {map_id:'M01010', x:346, y:1500, direction:3});
  assert.deepEqual((await decodeSave(await encodeSave(withEvidence), mapIds)).location, seed.location);
  return {synthetic_exit_metadata: true, persistent_location_fields: ['map_id','x','y','direction']};
});

contract('committed HP, resource, inventory, flag and object changes persist across save/restore', 'world-save-contract', async () => {
  const store = world();
  store.transact(next => {
    next.party[0].hp.current -= 17;
    next.party[0].mp.current -= 3;
    next.inventory[0].quantity -= 1;
    next.flags[FIXTURE_FLAG] = 7;
    next.object_states['synthetic:test-object'] = {visible: false, frame: 4, direction: 3};
  });
  store.setPosition(seed.location.x + 16, seed.location.y, 6);
  const expected = store.snapshot();
  const fresh = world();
  fresh.replace(await decodeSave(await encodeSave(expected), mapIds));
  assert.deepEqual(fresh.snapshot(), expected);
  assert.equal(expected.revision, seed.revision + 2);
  assert.deepEqual(expected.event_records, seed.event_records);
  assert.equal(expected.inventory[0].source_raw_hex, seed.inventory[0].source_raw_hex);
  return {revision: expected.revision, opaque_records_and_item_bytes_retained: true, object_fixture: 'synthetic:test-object'};
});

for (const [label, alter, rehash] of [
  ['tampered checksum', envelope => { envelope.payload = envelope.payload.replace('960', '959'); }, false],
  ['unsupported envelope version', envelope => { envelope.version = 2; }, false],
  ['unsupported world version', envelope => { const value = JSON.parse(envelope.payload); value.version = 2; envelope.payload = JSON.stringify(value); }, true],
  ['unavailable map', envelope => { const value = JSON.parse(envelope.payload); value.location.map_id = 'M99999'; envelope.payload = JSON.stringify(value); }, true],
  ['invalid JSON with correct checksum', envelope => { envelope.payload = '{synthetic malformed JSON'; }, true],
  ['invalid raw event record with correct checksum', envelope => { const value = JSON.parse(envelope.payload); value.event_records[0] = ['00']; envelope.payload = JSON.stringify(value); }, true],
  ['duplicate inventory instance', envelope => { const value = JSON.parse(envelope.payload); value.inventory.push(clone(value.inventory[0])); envelope.payload = JSON.stringify(value); }, true],
  ['leader absent from party', envelope => { const value = JSON.parse(envelope.payload); value.leader_id = 'synthetic:absent-role'; envelope.payload = JSON.stringify(value); }, true],
]) {
  contract(`rejected save preserves progress: ${label}`, 'synthetic-corruption-of-real-seed-save', async () => {
    const store = world();
    store.setPosition(seed.location.x + 4, seed.location.y, 6);
    const before = store.snapshot();
    const envelope = await encodeSave(seed);
    alter(envelope);
    if (rehash) envelope.sha256 = hash(envelope.payload);
    await assert.rejects(async () => store.replace(await decodeSave(envelope, mapIds)));
    assert.deepEqual(store.snapshot(), before);
    return {synthetic_corruption: true, current_progress_preserved: true, checksum_recomputed_to_reach_schema_validation: rehash};
  });
}

contract('invalid direct transaction/replace preserves current world', 'world-atomic-validation', async () => {
  const store = world(), before = store.snapshot();
  assert.throws(() => store.transact(next => { next.party[0].hp.current = -1; }));
  assert.deepEqual(store.snapshot(), before);
  const invalid = clone(before); invalid.flags.pop();
  assert.throws(() => store.replace(invalid));
  assert.deepEqual(store.snapshot(), before);
  const badMap = clone(before); badMap.location.map_id = 'M99999';
  assert.throws(() => validateWorld(badMap, mapIds));
  return {failed_transaction_not_committed: true, failed_replace_not_committed: true};
});

contract('second scene load rejected while first waits; event phase also blocks loads', 'synthetic-lifecycle-real-map-fixtures', async () => {
  const gate = deferred(); let hold = false;
  const store = world();
  const {controller, state} = await bootScene(store, {prepare: () => hold ? gate.promise : undefined});
  const destination = accessibleLocation('M01030'), before = store.snapshot(), oldView = clone(state.view);
  hold = true;
  const pending = controller.loadLocation(destination, {reason: 'synthetic load'});
  assert.equal(controller.phase, 'loading');
  assert.equal(controller.canSave(), false);
  await assert.rejects(controller.loadLocation(seed.location), /尚未完成/);
  assert.equal(state.prepared.length, 2);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(state.view, oldView);
  gate.resolve(); await pending;
  assert.equal(controller.phase, 'map');
  assert.equal(controller.canSave(), true);
  assert.deepEqual(store.location, destination);
  assert.equal(store.snapshot().revision, before.revision + 1);
  for(const phase of ['event','inspect','battle-loading','battle-command','battle-action','battle-result','battle-interrupted']){
    controller.setPhase(phase);assert.equal(controller.canSave(),false);
    await assert.rejects(controller.loadLocation(seed.location), /尚未完成/);
    assert.equal(state.prepared.length, 2);
  }
  return {synthetic_callback_gate: true, duplicate_prepare_prevented: true, old_state_preserved_until_preparation_finishes: true};
});

for (const failure of ['prepare', 'entry', 'world', 'commit-before-side-effect']) {
  contract(`scene failure preserves active scene and world: ${failure}`, 'synthetic-lifecycle-real-map-fixtures', async () => {
    let fail = false;
    const store = world();
    const hooks = {
      prepare: async () => { if (fail && failure === 'prepare') throw new Error('synthetic prepare failure'); },
      validateEntry: () => { if (fail && failure === 'entry') throw new Error('synthetic entry failure'); },
      beforeCommit: () => { if (fail && failure === 'commit-before-side-effect') throw new Error('synthetic commit failure'); },
    };
    const {controller, state} = await bootScene(store, hooks);
    const before = store.snapshot(), oldScene = controller.current, oldView = clone(state.view), commits = state.commits.length;
    fail = true;
    const restoredWorld = failure === 'world' ? {...clone(before), version: 999} : null;
    await assert.rejects(controller.loadLocation(accessibleLocation('M01030'), {restoredWorld}));
    assert.deepEqual(store.snapshot(), before);
    assert.equal(controller.current, oldScene);
    assert.deepEqual(state.view, oldView);
    assert.equal(state.commits.length, commits);
    assert.equal(controller.phase, 'map');
    assert.equal(controller.canSave(), true);
    return {injected_failure_synthetic: true, active_scene_and_progress_retained: true,
      commit_callback_rollback_claimed: false};
  });
}

contract('failed initial preparation returns to boot and disallows save', 'synthetic-boot-failure', async () => {
  const store = world(), before = store.snapshot();
  const {controller, state} = sceneHarness(store, {prepare: async () => { throw new Error('synthetic boot failure'); }});
  await assert.rejects(controller.loadLocation(store.location), /boot failure/);
  assert.equal(controller.phase, 'boot');
  assert.equal(controller.current, null);
  assert.equal(controller.canSave(), false);
  assert.equal(state.commits.length, 0);
  assert.deepEqual(store.snapshot(), before);
});

contract('partially changed synthetic camera, map label and options roll back when commit throws', 'synthetic-view-rollback-contract', async () => {
  const store = world();
  let fail = false, partial = null;
  const {controller, state} = await bootScene(store, {
    afterPartialCommit: view => {
      if (fail) { partial = clone(view); throw new Error('synthetic partial view commit failure'); }
    },
  });
  const before = store.snapshot(), oldScene = controller.current, oldView = clone(state.view), oldCommits = clone(state.commits);
  fail = true;
  await assert.rejects(controller.loadLocation(accessibleLocation('M01030')), /partial view commit failure/);
  assert.equal(partial.map_id, 'M01030');
  assert.notDeepEqual(partial, oldView); // injection happened after observable synthetic view changes
  assert.deepEqual(state.view, oldView);
  assert.deepEqual(state.commits, oldCommits);
  assert.equal(state.rollbacks, 1);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(controller.current, oldScene);
  assert.equal(controller.phase, 'map');
  assert.equal(controller.canSave(), true);
  return {partial_view_mutation_observed: true, capture_and_rollback_hooks_verified: true,
    synthetic_camera_and_map_label_restored: true, browser_dom_verified: false};
});

contract('restored scene installs saved state without inventing another revision', 'save-scene-lifecycle', async () => {
  const store = world(), {controller} = await bootScene(store);
  const restore = clone(seed);
  restore.location = accessibleLocation('M01030'); restore.revision = 123;
  restore.party[0].hp.current -= 5; restore.flags[FIXTURE_FLAG] = 9;
  await controller.loadLocation(restore.location, {restoredWorld: restore, reason: 'synthetic restore'});
  assert.deepEqual(store.snapshot(), restore);
  assert.equal(store.snapshot().revision, 123);
});

contract('synthetic first/repeat event branches commit exactly once each', 'synthetic-interpreter-fixture', async () => {
  const store = syntheticWorld(), before = store.snapshot(), said = [], phases = [], logs = [];
  const runner = new EventRunner({world: store, say: async (speaker, text) => said.push({speaker, text}),
    wait: async () => {}, setPhase: phase => phases.push(phase), log: item => logs.push(item)});
  const first = await runner.run(branchEvent());
  assert.deepEqual(first.changes, [{index: FIXTURE_FLAG, before: 0, after: 1}]);
  const again = await runner.run(branchEvent());
  assert.deepEqual(again.changes, []);
  assert.deepEqual(said.map(item => item.text), ['synthetic first visit', 'synthetic repeat visit']);
  const after = store.snapshot();
  assert.equal(after.revision, before.revision + 2);
  assert.deepEqual(after.party, before.party);
  assert.deepEqual(after.inventory, before.inventory);
  assert.deepEqual(after.event_records, before.event_records);
  assert.deepEqual(phases, ['event', 'map', 'event', 'map']);
  assert.equal(logs.filter(item => item.type === 'event-commit').length, 2);
  return {event_authority: 'synthetic-unit-test-only', original_npc_behavior_verified: false, first_changes: first.changes, repeat_changes: []};
});

contract('synthetic unknown command after state write rejects whole program before any effect', 'synthetic-interpreter-fixture', async () => {
  const store = syntheticWorld(), before = store.snapshot(), effects = [];
  const runner = new EventRunner({world: store, say: async () => effects.push('say'), wait: async () => effects.push('wait'),
    setPhase: phase => effects.push(phase), log: item => effects.push(item.type)});
  const event = syntheticEvent([
    syntheticCommand('set_flag', {index: FIXTURE_FLAG, value: 123}),
    syntheticCommand('say', {text: 'synthetic message should not be displayed'}),
    syntheticCommand('synthetic_unknown_opcode'),
    syntheticCommand('end'),
  ], 'synthetic:unknown-opcode');
  await assert.rejects(runner.run(event), /未支持/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(effects, []);
  assert.equal(runner.running, false);
  return {unknown_command_rejected_before_dialogue_and_commit: true, synthetic: true};
});

contract('synthetic dialogue waiting rejects reentry and conflicting input revision without losing input', 'synthetic-interpreter-concurrency', async () => {
  const store = syntheticWorld(), enteredDialogue = deferred(), releaseDialogue = deferred(), logs = [], phases = [];
  const runner = new EventRunner({world: store,
    say: async () => { enteredDialogue.resolve(); await releaseDialogue.promise; }, wait: async () => {},
    log: item => logs.push(item), setPhase: phase => phases.push(phase)});
  const pending = runner.run(branchEvent());
  await enteredDialogue.promise;
  assert.equal(runner.running, true);
  await assert.rejects(runner.run(branchEvent()), /正在执行/);
  store.setPosition(seed.location.x + 8, seed.location.y, 6);
  const interveningInput = store.snapshot();
  releaseDialogue.resolve();
  await assert.rejects(pending, /状态.*变化/);
  assert.deepEqual(store.snapshot(), interveningInput);
  assert.equal(store.snapshot().flags[FIXTURE_FLAG], 0);
  assert.equal(runner.running, false);
  assert.deepEqual(phases, ['event', 'map']);
  assert.equal(logs.filter(item => item.type === 'event-commit').length, 0);
  assert.equal(logs.find(item => item.type === 'event-failed').committed, false);
  return {dialogue_fixture_synthetic: true, conflicting_revision_rejected: true,
    new_input_position_retained: true, staged_event_flag_not_committed: true};
});

contract('synthetic invalid staged state and dialogue rejection do not partially commit', 'synthetic-interpreter-atomicity', async () => {
  const store = syntheticWorld(), before = store.snapshot();
  const runner = new EventRunner({world: store, say: async () => {}, wait: async () => {}});
  await assert.rejects(runner.run(syntheticEvent([
    syntheticCommand('set_flag', {index: FIXTURE_FLAG, value: 8}),
    syntheticCommand('set_object', {id: 'synthetic:object', state: {visible: 'invalid synthetic value'}}),
    syntheticCommand('end'),
  ])));
  assert.deepEqual(store.snapshot(), before);
  assert.equal(runner.running, false);
  const rejecting = new EventRunner({world: store, say: async () => { throw new Error('synthetic dialogue rejected'); }, wait: async () => {}});
  await assert.rejects(rejecting.run(branchEvent()), /dialogue rejected/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(rejecting.running, false);
});

contract('synthetic missing end and looping program stop without committing', 'synthetic-interpreter-control-flow', async () => {
  const store = syntheticWorld(), before = store.snapshot();
  const runner = new EventRunner({world: store, say: async () => {}, wait: async () => {}});
  await assert.rejects(runner.run(syntheticEvent([syntheticCommand('set_flag', {index: FIXTURE_FLAG, value: 9})])), /结束命令/);
  assert.deepEqual(store.snapshot(), before);
  await assert.rejects(runner.run(syntheticEvent([syntheticCommand('jump', {target: 0})])), /步数上限/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(runner.running, false);
});

contract('native-entry synthetic bit32 mutation precedes dialogue; repeat branch and saved state retain it', 'synthetic-native-entry-bit-fixture', async () => {
  const store = syntheticWorld(), before = store.snapshot(), dialogueSnapshots = [], logs = [];
  const event = nativeEntryFixture([
    syntheticCommand('test_flag_bit', {index: FIXTURE_FLAG, bit: 32, if_true: 4, if_false: 1}),
    syntheticCommand('set_flag_bit', {index: FIXTURE_FLAG, bit: 32}),
    syntheticCommand('say', {text: 'synthetic native-entry first visit'}),
    syntheticCommand('end'),
    syntheticCommand('say', {text: 'synthetic native-entry repeat visit'}),
    syntheticCommand('end'),
    syntheticCommand('unsupported', {reason: 'synthetic intentionally unreachable branch'}),
  ]);
  const runner = new EventRunner({world: store, say: async (_speaker, text) => {
    dialogueSnapshots.push({text, world: store.snapshot(), mutationLogPresent: logs.some(item => item.type === 'event-mutation')});
  }, wait: async () => {}, log: item => logs.push(item)});
  const first = await runner.run(event);
  assert.equal(dialogueSnapshots[0].world.flags[FIXTURE_FLAG], 0x80000000);
  assert.equal(dialogueSnapshots[0].world.revision, before.revision + 1);
  assert.equal(dialogueSnapshots[0].mutationLogPresent, true);
  assert.deepEqual(first.changes, [{index: FIXTURE_FLAG, before: 0, after: 0x80000000}]);
  const once = store.snapshot();
  const second = await runner.run(event);
  assert.equal(second.changes.length, 0);
  assert.equal(store.snapshot().revision, once.revision); // dialogue-only second entry adds no native mutation
  assert.deepEqual(dialogueSnapshots.map(item => item.text), [
    'synthetic native-entry first visit', 'synthetic native-entry repeat visit',
  ]);
  const fresh = world();
  fresh.replace(await decodeSave(await encodeSave(once), mapIds));
  const restoredSaid = [];
  const restoredRunner = new EventRunner({world: fresh, say: async (_speaker, text) => restoredSaid.push(text), wait: async () => {}});
  await restoredRunner.run(event);
  assert.deepEqual(restoredSaid, ['synthetic native-entry repeat visit']);
  assert.deepEqual(fresh.snapshot(), once);
  assert.equal(logs.filter(item => item.type === 'event-mutation').length, 1);
  assert.equal(logs.find(item => item.type === 'event-mutation').timing, 'native-record-entry');
  return {fixture_synthetic: true, high_bit_unsigned_value: 0x80000000,
    mutation_visible_before_say: true, unreachable_unsupported_not_pre_rejected: true,
    repeat_branch_and_save_restore_verified: true};
});

contract('native-entry synthetic six flag conditions use AND, including bit32 and each single missing condition', 'synthetic-native-entry-six-condition-fixture', async () => {
  const conditions = [
    {index: 1937, bit: 32}, {index: 1938, bit: 1}, {index: 1939, bit: 5},
    {index: 1940, bit: 17}, {index: 1941, bit: 31}, {index: 1942, bit: 12},
  ];
  const event = nativeEntryFixture([
    syntheticCommand('test_all_flag_bits', {conditions, if_true: 1, if_false: 3}),
    syntheticCommand('say', {text: 'synthetic AND true'}), syntheticCommand('end'),
    syntheticCommand('say', {text: 'synthetic AND false'}), syntheticCommand('end'),
  ], 'synthetic:six-condition-and');
  const outputs = [];
  for (const missing of [-1, 0, 1, 2, 3, 4, 5]) {
    const input = clone(seed);
    for (let index = 0; index < conditions.length; index++) {
      const condition = conditions[index];
      // Arithmetic reference masks avoid the VM's signed shift implementation.
      input.flags[condition.index] = index === missing ? 0 : 2 ** (condition.bit - 1);
    }
    const store = new WorldStore(input, mapIds), before = store.snapshot(), said = [];
    const runner = new EventRunner({world: store, say: async (_speaker, text) => said.push(text), wait: async () => {}});
    await runner.run(event);
    assert.deepEqual(said, [missing === -1 ? 'synthetic AND true' : 'synthetic AND false']);
    assert.deepEqual(store.snapshot(), before);
    outputs.push({missing_condition: missing, branch: said[0]});
  }
  return {fixture_synthetic: true, six_conditions: conditions, all_true_and_each_single_false_verified: outputs};
});

contract('native-entry synthetic reached unsupported stops while retaining earlier mutation and committed log', 'synthetic-native-entry-partial-support', async () => {
  const store = syntheticWorld(), before = store.snapshot(), logs = [], phases = [], said = [];
  const runner = new EventRunner({world: store, say: async (_speaker, text) => said.push(text), wait: async () => {},
    log: item => logs.push(item), setPhase: phase => phases.push(phase)});
  const event = nativeEntryFixture([
    syntheticCommand('set_flag_bit', {index: FIXTURE_FLAG, bit: 32}),
    syntheticCommand('say', {text: 'synthetic mutation has already happened'}),
    syntheticCommand('unsupported', {reason: 'synthetic reached unknown native branch'}),
    syntheticCommand('set_flag_bit', {index: FIXTURE_FLAG, bit: 1}),
    syntheticCommand('end'),
  ], 'synthetic:reached-unsupported');
  await assert.rejects(runner.run(event), /分支尚未恢复/);
  assert.equal(store.snapshot().flags[FIXTURE_FLAG], 0x80000000);
  assert.equal(store.snapshot().revision, before.revision + 1);
  assert.deepEqual(said, ['synthetic mutation has already happened']);
  assert.equal(logs.find(item => item.type === 'event-failed').committed, true);
  assert.equal(logs.filter(item => item.type === 'event-commit').length, 0);
  assert.equal(logs.filter(item => item.type === 'event-mutation').length, 1);
  assert.deepEqual(phases, ['event', 'map']);
  assert.equal(runner.running, false);
  const restored = await decodeSave(await encodeSave(store.snapshot()), mapIds);
  assert.equal(restored.flags[FIXTURE_FLAG], 0x80000000);
  return {fixture_synthetic: true, reached_unknown_branch_rejected: true,
    earlier_native_entry_mutation_retained: true, later_mutation_not_executed: true, failure_log_committed: true};
});

contract('native-entry synthetic no-mutation revision conflict does not label external input as event commit', 'synthetic-native-entry-concurrency', async () => {
  const store = syntheticWorld(), entered = deferred(), release = deferred(), logs = [];
  const runner = new EventRunner({world: store, say: async () => { entered.resolve(); await release.promise; }, wait: async () => {}, log: item => logs.push(item)});
  const pending = runner.run(nativeEntryFixture([
    syntheticCommand('say', {text: 'synthetic waiting without event mutation'}), syntheticCommand('end'),
  ], 'synthetic:no-mutation-conflict'));
  await entered.promise;
  store.setPosition(seed.location.x + 8, seed.location.y, 6);
  const externalState = store.snapshot();
  release.resolve();
  await assert.rejects(pending, /状态.*变化/);
  assert.deepEqual(store.snapshot(), externalState);
  assert.equal(logs.filter(item => item.type === 'event-mutation').length, 0);
  assert.equal(logs.find(item => item.type === 'event-failed').committed, false);
  return {fixture_synthetic: true, external_revision_change_not_misattributed_to_event: true};
});

contract('malformed future scalar mutation values are rejected before native-entry side effects', 'synthetic-invalid-program-values', async () => {
  const invalidValues = [NaN, Infinity, undefined, -1, 1.25, '1', 0x100000000];
  for (const op of ['set_flag', 'add_flag']) {
    for (const value of invalidValues) {
      const event = nativeEntryFixture([
        syntheticCommand('set_flag_bit', {index: FIXTURE_FLAG, bit: 32}),
        syntheticCommand(op, {index: FIXTURE_FLAG, value}), syntheticCommand('end'),
      ], `synthetic:invalid-${op}`);
      assert.throws(() => validateProgram(event), undefined, `${op} must reject ${String(value)}`);
      const store = syntheticWorld(), before = store.snapshot();
      const runner = new EventRunner({world: store, say: async () => {}, wait: async () => {}});
      await assert.rejects(runner.run(event));
      assert.deepEqual(store.snapshot(), before);
      assert.equal(runner.running, false);
    }
  }
  return {fixture_synthetic: true, scalar_values_rejected: ['NaN', 'Infinity', 'undefined', '-1', '1.25', 'string', 'u32 overflow']};
});

contract('synthetic conditional and mutation index/bit/target boundaries reject malformed programs', 'synthetic-invalid-program-boundaries', async () => {
  const invalid = [
    syntheticCommand('test_flag_bit', {index: FIXTURE_FLAG, bit: 0, if_true: 1, if_false: 1}),
    syntheticCommand('test_flag_bit', {index: FIXTURE_FLAG, bit: 33, if_true: 1, if_false: 1}),
    syntheticCommand('test_flag_bit', {index: FIXTURE_FLAG, bit: 1.5, if_true: 1, if_false: 1}),
    syntheticCommand('set_flag_bit', {index: FIXTURE_FLAG, bit: 0}),
    syntheticCommand('set_flag_bit', {index: FIXTURE_FLAG, bit: 33}),
    syntheticCommand('test_flag_bit', {index: 2000, bit: 32, if_true: 1, if_false: 1}),
    syntheticCommand('set_flag_bit', {index: -1, bit: 1}),
    syntheticCommand('test_flag_bit', {index: FIXTURE_FLAG, bit: 32, if_true: -1, if_false: 1}),
    syntheticCommand('test_flag_bit', {index: FIXTURE_FLAG, bit: 32, if_true: 1, if_false: 2}),
    syntheticCommand('test_flag_bit', {index: FIXTURE_FLAG, bit: 32, if_true: 1.5, if_false: 1}),
    syntheticCommand('test_all_flag_bits', {conditions: [{index: 2000, bit: 1}], if_true: 1, if_false: 1}),
    syntheticCommand('test_all_flag_bits', {conditions: [{index: FIXTURE_FLAG, bit: 33}], if_true: 1, if_false: 1}),
    syntheticCommand('test_all_flag_bits', {conditions: [{index: FIXTURE_FLAG, bit: 32}], if_true: 2, if_false: 1}),
    syntheticCommand('test_all_flag_bits', {conditions: [{index: FIXTURE_FLAG, bit: 32}], if_true: 1, if_false: undefined}),
  ];
  for (const command of invalid) {
    const event = nativeEntryFixture([command, syntheticCommand('end')], 'synthetic:invalid-bit-or-target');
    assert.throws(() => validateProgram(event));
    const store = syntheticWorld(), before = store.snapshot();
    const runner = new EventRunner({world: store, say: async () => {}, wait: async () => {}});
    await assert.rejects(runner.run(event));
    assert.deepEqual(store.snapshot(), before);
    assert.equal(runner.running, false);
  }
  return {fixture_synthetic: true, rejected_cases: invalid.length,
    valid_bit32_exercised_by_separate_native_entry_tests: true};
});

contract('synthetic valid flag endpoints, bit1/bit32 and uint32 scalar wrap remain usable', 'synthetic-valid-program-boundaries', async () => {
  const input = clone(seed); input.flags[0] = 0; input.flags[1999] = 0; input.flags[FIXTURE_FLAG] = 0;
  const store = new WorldStore(input, mapIds), before = store.snapshot(), said = [];
  const event = nativeEntryFixture([
    syntheticCommand('set_flag_bit', {index: 0, bit: 1}),
    syntheticCommand('set_flag_bit', {index: 1999, bit: 32}),
    syntheticCommand('set_flag', {index: FIXTURE_FLAG, value: 0xffffffff}),
    syntheticCommand('add_flag', {index: FIXTURE_FLAG, value: 1}),
    syntheticCommand('test_all_flag_bits', {conditions: [{index: 0, bit: 1}, {index: 1999, bit: 32}], if_true: 5, if_false: 7}),
    syntheticCommand('say', {text: 'synthetic valid endpoints'}), syntheticCommand('end'),
    syntheticCommand('unsupported', {reason: 'synthetic endpoints did not match'}),
  ], 'synthetic:valid-endpoints');
  const runner = new EventRunner({world: store, say: async (_speaker, text) => said.push(text), wait: async () => {}});
  await runner.run(event);
  assert.deepEqual(said, ['synthetic valid endpoints']);
  assert.equal(store.snapshot().flags[0], 1);
  assert.equal(store.snapshot().flags[1999], 0x80000000);
  assert.equal(store.snapshot().flags[FIXTURE_FLAG], 0);
  assert.equal(store.snapshot().revision, before.revision + 4);
  return {fixture_synthetic: true, flag_indices: [0, 1999], bits: [1, 32], scalar_add_u32_wrap: true};
});
