import test from 'node:test';
import assert from 'node:assert/strict';
import {AnmActions} from '../web/core/anm_runtime.mjs';

const command = (opcode, actor=0) => ({opcode, u32_plus5:actor, u32_plus1:0,
  u32_plus13:10, u32_plus17:20, u32_plus25:1, byte_plus29:0, byte_plus30:0});
test('parallel movement launches before the native barrier and all positions settle before advancing', async () => {
  const finished = [], trace = [], positions = new Map();
  const actions = new AnmActions({positions, nativeMetadata:true, context:() => ({mapId:'M17029'}),
    hooks:{move:payload => { trace.push(`move:${payload.actor}`); return new Promise(resolve => finished.push(resolve)); },
      wait:async payload => trace.push(`barrier:${payload.pendingCount}`)}});
  await actions.execute(command(33, 1)); await actions.execute(command(33, 2));
  let advanced=false;
  const barrier=actions.execute(command(31)).then(() => {advanced=true;});
  finished[0](); await Promise.resolve(); assert.equal(advanced,false);
  finished[1](); await barrier;
  assert.deepEqual(trace,['move:1','move:2','barrier:2']);
  assert.deepEqual(positions.get(1),{map_id:'M17029',x:20,y:40});
  assert.deepEqual(positions.get(2),positions.get(1));
});
test('an action failure aborts a hanging renderer and prevents its late position write', async () => {
  let finish;
  const positions=new Map();
  const actions=new AnmActions({positions, context:() => ({mapId:'M17029'}),
    hooks:{move:payload => payload.actor===1 ? new Promise(resolve => {finish=resolve;}) : Promise.reject(new Error('renderer failed'))}});
  await actions.execute(command(33,1));
  actions.launch('move',command(33,2),{actor:2});
  await assert.rejects(actions.flush(),/renderer failed/);
  assert.equal(actions.controller.signal.aborted,true);
  finish(); await Promise.resolve(); assert.equal(positions.size,0);
});
