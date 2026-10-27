// Real Resurrect.ANM and TLK resources supply every test program. Hook stubs
// below are synthetic browser boundaries, not original-game runtime evidence.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {OpeningRunner, validateOpeningProgram} from '../web/core/opening.mjs';

const program = JSON.parse(await readFile(new URL('../web/data/opening_program.json', import.meta.url)));
const root = new URL('../../../', import.meta.url);
const sourceBytes = await readFile(new URL(program.source.path, root));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const initialSourceHash = sha256(sourceBytes);
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function harness(overrides = {}) {
  const events = [], hooks = {};
  for (const name of ['map', 'actor', 'move', 'camera', 'fade', 'say', 'wait']) {
    hooks[name] = payload => {
      events.push({name, index: payload.command.index, ...payload});
      return overrides[name]?.(payload);
    };
  }
  return {events, hooks, runner: new OpeningRunner({program, hooks})};
}
function contract(name, run) {
  test(name, {concurrency: false}, run);
}

contract('opening export is byte-for-byte bound to the original ANM and selected TLK records', async () => {
  assert.equal(initialSourceHash, program.source.sha256);
  assert.equal(sourceBytes.length, program.source.bytes);
  assert.equal(program.commands.length, 56);
  for (const command of program.commands) {
    assert.equal(command.raw_hex, sourceBytes.subarray(command.source.offset, command.source.offset + 74).toString('hex'));
  }
  for (const group of Object.values(program.dialogues)) {
    const bytes = await readFile(new URL(group.source.path, root));
    assert.equal(sha256(bytes), group.source.sha256);
    for (const record of group.records) {
      assert.equal(record.raw_hex, bytes.subarray(record.offset, record.offset + record.raw_hex.length / 2).toString('hex'));
    }
  }
  assert.deepEqual(validateOpeningProgram(program), {
    command_count: 56,
    maps: ['M72061', 'M17020'],
    dialogue_ids: ['M72061:13', 'M72061:1', 'M17020:1', 'M17020:2'],
  });
});

contract('complete shipped opening crosses both comment records and returns after the M17020 monologue', async () => {
  const {runner, events} = harness();
  const result = await runner.run();
  assert.equal(runner.phase, 'completed');
  assert.deepEqual(result.executed_indices, Array.from({length: 56}, (_, index) => index));
  assert.deepEqual(result.location, {map_id: 'M17020', x: 1092, y: 986});
  assert.deepEqual(events.filter(event => event.name === 'map').map(event => event.mapId), ['M72061', 'M17020']);
  assert.deepEqual(events.filter(event => event.name === 'say').map(event => [event.mapId, event.records.map(record => record.id)]),
    [['M72061', [13]], ['M72061', [1]], ['M17020', [1, 2]]]);
  const mainSay = events.findIndex(event => event.index === 50 && event.name === 'say');
  const restore = events.findIndex(event => event.index === 52 && event.kind === 'restore');
  assert.ok(mainSay >= 0 && restore > mainSay);
  assert.equal(events.at(-1).index, 55);
  assert.ok(result.limitations.length > 0);
  // These editor x/y fields are nonzero but the native camera operation only
  // receives actor and mode. Accidentally using them misplaces the opening.
  const focus = events.find(event => event.name === 'camera');
  assert.equal(focus.actor, 14);
  assert.equal(focus.modeRaw, 1);
  assert.equal(Object.hasOwn(focus, 'x'), false);
  // ANM byte +29 = 8 is the action ID; +17 = 11 is its end frame.
  const animation = events.find(event => event.index === 32 && event.kind === 'animation');
  assert.equal(animation.actionId, 8);
  assert.equal(animation.frameStart, 1);
  assert.equal(animation.frameEnd, 11);
  assert.equal(animation.repetitions, 1);
  const reveal = events.find(event => event.index === 6 && event.name === 'actor');
  assert.equal(reveal.hidden, false);
  assert.equal(reveal.nativeField, '0x4bd');
  assert.equal(reveal.blendModeRaw, 6);
  assert.equal(Object.hasOwn(reveal, 'directionModeRaw'), false);
  assert.equal(sha256(await readFile(new URL(program.source.path, root))), initialSourceHash);
});

contract('a real four-actor move group starts together and the next group waits for every actor', async () => {
  const gates = new Map([20, 21, 22, 23].map(index => [index, deferred()]));
  const {runner, events} = harness({move: payload => gates.get(payload.command.index)?.promise});
  const running = runner.run();
  await tick();
  assert.deepEqual(events.filter(event => gates.has(event.index) && event.name === 'move').map(event => event.index), [20, 21, 22, 23]);
  assert.equal(events.some(event => event.index === 25), false);
  for (const index of [20, 21, 22]) gates.get(index).resolve();
  await tick();
  assert.equal(events.some(event => event.index === 25), false);
  gates.get(23).resolve();
  await running;
  assert.ok(events.some(event => event.index === 25 && event.name === 'move'));
  const barrier = events.find(event => event.index === 24 && event.name === 'wait');
  assert.equal(barrier.pendingCount, 4);
  assert.equal(barrier.frames, 1);
});

contract('the linked final dialogue must finish before actor restore and completion', async () => {
  const gate = deferred();
  const {runner, events} = harness({say: payload => payload.mapId === 'M17020' ? gate.promise : undefined});
  const running = runner.run();
  await tick();
  assert.equal(runner.phase, 'running');
  assert.equal(runner.result, null);
  const lastSay = events.find(event => event.index === 50 && event.name === 'say');
  assert.deepEqual(lastSay.records.map(record => record.id), [1, 2]);
  assert.equal(events.some(event => event.index === 52), false);
  gate.resolve();
  assert.equal((await running).control_map, 'M17020');
});

contract('a failed concurrent move aborts promptly without running later source commands', async () => {
  const failed = deferred(), never = deferred();
  const {runner, events} = harness({move: payload => payload.command.index === 20 ? failed.promise
    : [21, 22, 23].includes(payload.command.index) ? never.promise : undefined});
  const running = runner.run();
  const rejection = assert.rejects(running, /command 20.*renderer failed/);
  await tick();
  assert.deepEqual(events.filter(event => [20, 21, 22, 23].includes(event.index) && event.name === 'move').map(event => event.index), [20, 21, 22, 23]);
  failed.reject(new Error('renderer failed'));
  await rejection;
  assert.equal(runner.phase, 'failed');
  assert.equal(runner.result, null);
  assert.equal(events.some(event => event.index >= 25), false);
  assert.ok(events.every(event => event.signal.aborted));
  // Resolving abandoned work must not resurrect completion or advance state.
  never.resolve();
  await tick();
  assert.equal(runner.phase, 'failed');
});

contract('a rejected map prepare prevents placement, monologue and completion in that map', async () => {
  const {runner, events} = harness({map: payload => {
    if (payload.mapId === 'M17020') throw new Error('map prepare failed');
  }});
  await assert.rejects(runner.run(), /map prepare failed/);
  assert.equal(runner.phase, 'failed');
  assert.equal(runner.result, null);
  assert.equal(events.some(event => event.index > 38), false);
});

contract('opening start rejects reentry and cannot replay completed effects', async () => {
  const gate = deferred();
  const {runner, events} = harness({map: payload => payload.command.index === 0 ? gate.promise : undefined});
  const running = runner.run();
  assert.equal(runner.phase, 'running');
  await assert.rejects(runner.run(), /phase running/);
  assert.equal(events.length, 1);
  gate.resolve();
  await running;
  const eventCount = events.length;
  await assert.rejects(runner.run(), /phase completed/);
  assert.equal(events.length, eventCount);
});

contract('an unknown opcode is rejected in preflight before any UI callback', async () => {
  const changed = clone(program), {hooks, events} = harness();
  changed.commands[37].opcode = 250;
  changed.commands[37].raw_hex = 'fa' + changed.commands[37].raw_hex.slice(2);
  assert.throws(() => new OpeningRunner({program: changed, hooks}), /command 37.*unsupported opcode/);
  assert.equal(events.length, 0);
});

contract('field tampering and an unsupported dialogue mutation fail before playback', async () => {
  const changed = clone(program), {hooks, events} = harness();
  changed.commands[44].u32_plus13++;
  assert.throws(() => new OpeningRunner({program: changed, hooks}), /field \+13 differs from source bytes/);
  const statefulDialogue = clone(program);
  statefulDialogue.dialogues.M17020.records[1].mutation_type = 1;
  assert.throws(() => new OpeningRunner({program: statefulDialogue, hooks}), /unsupported control\/state payload/);
  const cycle = clone(program);
  cycle.dialogues.M17020.records[1].next = 1;
  const cycleBytes = Buffer.from(cycle.dialogues.M17020.records[1].raw_hex, 'hex');
  cycleBytes.writeUInt32LE(1, 0x33);
  cycle.dialogues.M17020.records[1].raw_hex = cycleBytes.toString('hex');
  assert.throws(() => new OpeningRunner({program: cycle, hooks}), /dialogue cycle/);
  const falseText = clone(program);
  falseText.dialogues.M17020.records[1].text_raw += ' modified';
  assert.throws(() => new OpeningRunner({program: falseText, hooks}), /text differs from source bytes/);
  assert.equal(events.length, 0);
});

after(async () => {
  assert.equal(sha256(await readFile(new URL(program.source.path, root))), initialSourceHash, 'the original ANM must remain read-only');
});
