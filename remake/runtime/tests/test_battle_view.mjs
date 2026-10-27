// Real exported frame metadata and PNG fingerprints; synthetic canvas/clock.
// This verifies renderer contracts, not original-game animation execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BattleView, compileActionTimeline} from '../web/battle_view.mjs';

const base = new URL('../', import.meta.url), root = new URL('../../../', import.meta.url);
const meta = JSON.parse(await readFile(new URL('web/data/battle_view.json', base)));
const layers = JSON.parse(await readFile(new URL('web/data/yantu_layers.json', base)));
const clone = value => structuredClone(value);
const assetChecks = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const snapshot = () => ({phase: 'battle', round: 1, actors: [
  {id: '001', side: 'player', hp: {current: 960, maximum: 960}, alive: true},
  {id: '012', side: 'enemy', hp: {current: 1362, maximum: 1362}, alive: true},
]});
const playerAction = () => ({actor_id: '001', target_id: '012', skill_id: 'yantu', hit: true, damage: 219, remainingHp: 1143, death: false});
const enemyAction = () => ({actor_id: '012', target_id: '001', skill_id: 'snow_attack', hit: true, damage: 47, remainingHp: 913, death: false});

function canvas() {
  const calls = [], stack = [];
  const ctx = {globalAlpha: 1, globalCompositeOperation: 'source-over',
    setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {},
    stroke() {}, ellipse() {}, fill() {},
    createLinearGradient: () => ({addColorStop() {}}),
    save() {stack.push({globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation});},
    restore() {Object.assign(this, stack.pop());},
    drawImage(image, ...coordinates) {calls.push({path: image.path, alpha: this.globalAlpha, blend: this.globalCompositeOperation, coordinates});},
    fillText(text, ...coordinates) {calls.push({text, coordinates});},
  };
  return {width: 960, height: 540, getContext: () => ctx, calls, ctx};
}

async function realAssets(asset) {
  const path = new URL('web/' + asset.path.slice(1), base);
  const bytes = await readFile(path);
  assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  assert.equal(hash(bytes), asset.sha256);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.equal(width, asset.width); assert.equal(height, asset.height);
  assetChecks.set(asset.path, {path: asset.path, sha256: asset.sha256, width, height});
  return {image: {width, height, path: asset.path}, sha256: asset.sha256};
}

const jsonLoader = async path => clone(path === '/data/battle_view.json' ? meta : layers);
async function viewFixture(options = {}) {
  const target = canvas();
  const view = new BattleView({canvas: target, jsonLoader, assetLoader: realAssets, ...options});
  await view.prepare();
  return {view, target};
}

function contract(name, run) {
  test(name, {concurrency: false}, run);
}

contract('source timelines bind both Yantu layers and original logical event positions', async () => {
  const player = compileActionTimeline(meta, layers, '001'), enemy = compileActionTimeline(meta, layers, '012');
  assert.equal(player.length, 32); assert.equal(enemy.length, 24);
  const hit = player.find(step => step.event), snowHit = enemy.find(step => step.event);
  assert.equal(hit.source_frame, 338); assert.equal(hit.logical_frame, 5); assert.equal(hit.action_index, 28);
  assert.equal(hit.pair.source_frame, hit.source_frame);
  assert.match(hit.pair.main.path, /frame_0338_main/); assert.match(hit.pair.intrinsic.path, /frame_0338_intrinsic/);
  assert.equal(snowHit.action_index, 14); assert.equal(snowHit.logical_frame, 4); assert.equal(snowHit.source_frame, 91);
  return {player_frames: player.length, enemy_frames: enemy.length, source_impact_frames: [338, 91]};
});

contract('all actual PNG fingerprints and geometry complete before commands become available', async () => {
  let release, reachedBlocked, loaded = 0;
  const gate = new Promise(resolve => {release = resolve;});
  const blocked = new Promise(resolve => {reachedBlocked = resolve;});
  const target = canvas(), view = new BattleView({canvas: target, jsonLoader, assetLoader: async asset => {
    loaded++; if (asset.path.includes('frame_0342_intrinsic')) {reachedBlocked();await gate;}
    return realAssets(asset);
  }});
  const preparing = view.prepare();
  await blocked;
  assert.equal(view.ready, false); assert.ok(loaded > 0);
  await assert.rejects(view.playAction(playerAction(), {onImpact() {}}), /准备好/);
  release(); await preparing;
  assert.equal(view.ready, true); assert.equal(view.images.size, loaded);
  return {all_assets_loaded: loaded, early_command_rejected: true};
});

contract('exact +0x49 frame commits once and main/intrinsic share identical projection', async () => {
  const {view, target} = await viewFixture(), impacts = [];
  const done = view.playAction(playerAction(), {onImpact: detail => impacts.push(detail)});
  view.draw(snapshot(), 0); view.draw(snapshot(), 974);
  assert.equal(impacts.length, 0);
  target.calls.length = 0; view.draw(snapshot(), 975);
  assert.equal(impacts.length, 1); assert.equal(impacts[0].source_frame, 338);
  const main = target.calls.find(call => call.path?.endsWith('frame_0338_main.png'));
  const intrinsic = target.calls.find(call => call.path?.endsWith('frame_0338_intrinsic.png'));
  assert.ok(main); assert.ok(intrinsic); assert.deepEqual(main.coordinates, intrinsic.coordinates);
  assert.equal(main.blend, 'source-over'); assert.equal(intrinsic.blend, 'lighter');
  view.draw(snapshot(), 975); view.draw(snapshot(), 1500); view.draw(snapshot(), 2340);
  const end = await done;
  assert.equal(impacts.length, 1); assert.equal(end.impact_committed, true); assert.equal(view.playback, null);
  return {impact_source_frame: 338, identical_coordinates: main.coordinates, callback_count: impacts.length};
});

contract('slow RAF cannot skip impact and resolve occurs after return frames', async () => {
  const {view} = await viewFixture(), impacts = [];
  const done = view.playAction(enemyAction(), {onImpact: detail => impacts.push(detail)});
  view.draw(snapshot(), 200); view.draw(snapshot(), 900);
  assert.equal(impacts.length, 1); assert.equal(impacts[0].source_frame, 91);
  assert.notEqual(view.playback, null);
  view.draw(snapshot(), 6000); view.draw(snapshot(), 7000);
  const end = await done;
  assert.equal(end.source_frame, 91); assert.equal(impacts.length, 1);
  return {skipped_draw_frames_retained_event: true, callback_count: impacts.length};
});

contract('next command waits for asynchronous external impact commit', async () => {
  const {view} = await viewFixture(); let release, count = 0;
  const gate = new Promise(resolve => {release = resolve;});
  const done = view.playAction(playerAction(), {onImpact: () => {count++; return gate;}});
  view.draw(snapshot(), 0); view.draw(snapshot(), 5000); view.draw(snapshot(), 6000);
  assert.equal(count, 1); assert.equal(view.playback.impact_done, false);
  await assert.rejects(view.playAction(enemyAction(), {onImpact() {}}), /尚未播放结束/);
  release(); await gate; await Promise.resolve(); view.draw(snapshot(), 6001);
  assert.equal((await done).completed, true); assert.equal(count, 1);
  return {next_command_blocked_until_commit: true};
});

contract('cancel before or after impact never replays a stale callback', async () => {
  const {view} = await viewFixture(); let count = 0;
  let done = view.playAction(playerAction(), {onImpact: () => count++});
  const rejected = assert.rejects(done, {name: 'AbortError'});
  view.draw(snapshot(), 0); view.draw(snapshot(), 500); view.stop('开发中断'); await rejected;
  view.draw(snapshot(), 5000); assert.equal(count, 0);
  done = view.playAction(enemyAction(), {onImpact: () => count++});
  const secondRejected = assert.rejects(done, {name: 'AbortError'});
  view.draw(snapshot(), 6000); view.draw(snapshot(), 6600); assert.equal(count, 1);
  view.stop(); await secondRejected; view.draw(snapshot(), 16000);
  assert.equal(count, 1); assert.equal(view.ready, true);
  return {before_impact_callbacks: 0, after_impact_callbacks: 1};
});

contract('asset failure and cancelled preparation keep command readiness false', async () => {
  const failed = new BattleView({canvas: canvas(), jsonLoader, assetLoader: async () => {throw new Error('missing PNG');}});
  await assert.rejects(failed.prepare(), /missing PNG/); assert.equal(failed.ready, false);
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const cancelled = new BattleView({canvas: canvas(), jsonLoader, assetLoader: async asset => {await gate; return realAssets(asset);}});
  const pending = cancelled.prepare();
  const rejection = assert.rejects(pending, {name: 'AbortError'});
  await new Promise(resolve => setImmediate(resolve)); cancelled.stop(); release(); await rejection;
  assert.equal(cancelled.ready, false); assert.equal(cancelled.images.size, 0);
  return {missing_asset_rejected: true, stale_preparation_discarded: true};
});

contract('unknown skill and mismatched same-source pair fail before any impact', async () => {
  const {view} = await viewFixture(); let count = 0;
  await assert.rejects(view.playAction({...playerAction(), skill_id: 'invented'}, {onImpact: () => count++}), /缺少/);
  const wrong = clone(layers); wrong.frames[15].source_frame = 339;
  assert.throws(() => compileActionTimeline(meta, wrong, '001'), /同一个源帧/);
  assert.equal(count, 0);
  return {unknown_skill_rejected: true, mispaired_layer_rejected: true};
});

contract('MISS keeps target pose and suppresses damage-only target effects', async () => {
  const {view, target} = await viewFixture(); let count = 0;
  const input = {...playerAction(), hit: 'miss', damage: 0};
  const before = clone(input), world = snapshot(), worldBefore = clone(world);
  const done = view.playAction(input, {onImpact: () => count++});
  view.draw(world, 0); target.calls.length = 0; view.draw(world, 975);
  assert.equal(count, 1);
  assert.ok(target.calls.some(call => call.text === 'MISS'));
  assert.equal(target.calls.some(call => call.path?.includes('BFr01_Dn')), false);
  assert.equal(target.calls.some(call => call.path?.includes('/012/action_01')), false);
  assert.deepEqual(input, before); assert.deepEqual(world, worldBefore);
  view.draw(world, 2340); await done;
  return {external_input_and_snapshot_unchanged: true, miss_target_effects: 0};
});

contract('external commit error rejects playback and destroy cancels an unfinished commit', async () => {
  const {view} = await viewFixture();
  const done = view.playAction(playerAction(), {onImpact: () => {throw new Error('world revision conflict');}});
  const rejected = assert.rejects(done, /world revision conflict/);
  view.draw(snapshot(), 0); view.draw(snapshot(), 975); await rejected;
  assert.equal(view.playback, null);
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const second = view.playAction(enemyAction(), {onImpact: () => gate});
  const aborted = assert.rejects(second, {name: 'AbortError'});
  view.draw(snapshot(), 2000); view.draw(snapshot(), 2700); view.destroy(); await aborted;
  release(); await gate; await Promise.resolve();
  assert.equal(view.ready, false); assert.equal(view.images.size, 0); assert.equal(view.playback, null);
  return {commit_error_propagated: true, stale_async_completion_discarded: true};
});
