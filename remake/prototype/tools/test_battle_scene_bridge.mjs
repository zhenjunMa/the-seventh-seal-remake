import assert from 'node:assert/strict';
import {BattleSceneBridge, buildBattleSceneURL, isBattleSceneMessage,
  SCENE_SCHEMA, SCENE_VERSION} from '../web/battle_scene_bridge.mjs';

const origin = 'http://127.0.0.1:8765';
const baseURL = `${origin}/index.html?keep=1`;
const source = {};
const dataFor = (session, type, extra = {}) => ({schema: SCENE_SCHEMA,
  version: SCENE_VERSION, session_id: session, type, ...extra});
const message = (session, type, extra = {}) => ({origin, source,
  data: dataFor(session, type, extra)});
const expected = {origin, source, sessionId: 'session'};
assert.equal(buildBattleSceneURL(baseURL, 'one two'),
  `${origin}/battle.html?embedded=1&sceneSession=one+two`);
assert.equal(isBattleSceneMessage(message('session', 'battle-ready'), expected), true);
assert.equal(isBattleSceneMessage(message('session', 'battle-return'), expected), true);
for (const badEvent of [
  {...message('session', 'battle-ready'), origin: 'http://elsewhere.example'},
  {...message('session', 'battle-ready'), origin: 'null'},
  {...message('session', 'battle-ready'), source: {}},
  {...message('session', 'battle-ready'), source: null},
  message('old-session', 'battle-ready'), message('session', 'battle-enter'),
  message('session', 'battle-world-change'),
  message('session', 'battle-ready', {schema: 'another'}),
  message('session', 'battle-ready', {version: 2}),
  {...message('session', 'battle-ready'), data: null},
  {...message('session', 'battle-ready'), data: []},
]) assert.equal(isBattleSceneMessage(badEvent, expected), false);
assert.equal(isBattleSceneMessage(message('session', 'battle-ready'), {...expected, sessionId: null}), false);

function fixture(url = baseURL) {
  const listeners = new Map(), frameListeners = new Map(), timers = new Map();
  let nonce = 0, timerNumber = 0, readyCount = 0, returnCount = 0;
  const errors = [], posts = [], returnArguments = [];
  const child = {postMessage: (...args) => posts.push(args)};
  const frame = {contentWindow: child, src: 'about:blank',
    addEventListener: (type, fn) => frameListeners.set(type, fn),
    removeEventListener: (type, fn) => { if (frameListeners.get(type) === fn) frameListeners.delete(type); }};
  const host = {location: {href: url},
    crypto: {getRandomValues: bytes => { bytes.fill(++nonce); return bytes; }},
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    setTimeout: fn => { const id = ++timerNumber; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id)};
  const bridge = new BattleSceneBridge({frame, hostWindow: host,
    onReady: () => readyCount++,
    onReturn: (...args) => { returnCount++; returnArguments.push(args); },
    onError: text => errors.push(text)});
  return {bridge, frame, child, listeners, frameListeners, timers, errors, posts,
    readyCount: () => readyCount, returnCount: () => returnCount, returnArguments,
    emit: (session, type, extra = {}) => listeners.get('message')?.({origin: new URL(url).origin,
      source: child, data: dataFor(session, type, extra)})};
}

const f = fixture();
const context = {player_role_id: '002', map: {id: 'M01010', x: 320.25, y: 1500.75}, hp: 999};
const session = f.bridge.enter(context);
assert.match(session, /^[0-9a-f]{32}$/);
assert.equal(new URL(f.frame.src).searchParams.get('sceneSession'), session);
assert.equal(new URL(f.frame.src).searchParams.get('embedded'), '1');
assert.equal(f.timers.size, 1);
assert.equal(f.bridge.enter({player_role_id: '001', map: {id: 'other', x: 1, y: 2}}), session);
assert.equal(f.timers.size, 1);
context.map.x = 999;
assert.equal(f.bridge.handleMessage({origin, source: {}, data: dataFor(session, 'battle-return')}), false);
assert.equal(f.bridge.sessionId, session);
f.emit('stale-session', 'battle-ready');
assert.equal(f.posts.length, 0);
f.emit(session, 'battle-ready');
assert.equal(f.readyCount(), 1);
assert.equal(f.timers.size, 0);
assert.deepEqual(f.posts, [[{
  schema: SCENE_SCHEMA, version: SCENE_VERSION, type: 'battle-enter', session_id: session,
  context: {entry_kind: 'development_demo', player_role_id: '002',
    map: {id: 'M01010', x: 320.25, y: 1500.75}},
}, origin]]);
f.emit(session, 'battle-ready');
assert.equal(f.posts.length, 1, 'duplicate ready must not restart combat');
assert.equal(f.readyCount(), 1);
f.emit(session, 'battle-return', {hp: -200, map: {id: 'unknown', x: 0, y: 0}, victory: true});
assert.equal(f.returnCount(), 1);
assert.deepEqual(f.returnArguments, [[]], 'combat payload must not reach map callback');
assert.equal(f.frame.src, 'about:blank');
assert.equal(f.bridge.sessionId, null);
f.emit(session, 'battle-return');
assert.equal(f.returnCount(), 1);

const secondSession = f.bridge.enter({player_role_id: '001', map: {id: 'M01010', x: 320, y: 1500}});
assert.notEqual(secondSession, session);
f.emit(session, 'battle-return');
assert.equal(f.bridge.sessionId, secondSession);
const [timerId, timeout] = [...f.timers.entries()][0];
f.timers.delete(timerId); timeout();
assert.equal(f.errors.length, 1);
assert.equal(f.bridge.sessionId, secondSession, 'load timeout must keep fallback exit available');
f.frameListeners.get('error')();
assert.equal(f.errors.length, 2);
f.bridge.exit();
assert.equal(f.frame.src, 'about:blank');
assert.equal(f.timers.size, 0);
assert.equal(f.bridge.sessionId, null);
f.bridge.destroy();
assert.equal(f.listeners.size, 0);
assert.equal(f.frameListeners.size, 0);

const opaque = fixture('file:///D:/game/index.html');
assert.throws(() => opaque.bridge.enter({player_role_id:'001', map:{id:'M01010',x:1,y:2}}), /本地 HTTP/);
assert.equal(opaque.bridge.sessionId, null);
assert.equal(opaque.timers.size, 0);
opaque.bridge.destroy();

console.log('PASS: same-origin/source/session navigation, ready handshake, duplicate/stale messages, payload isolation, timeout exit, child teardown, opaque origin.');
