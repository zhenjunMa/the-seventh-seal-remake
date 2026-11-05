import test from 'node:test';
import assert from 'node:assert/strict';
import {innerWhiteForestSource} from './helpers/inner_white_forest_world.mjs';
import {sealRegionComplete} from './helpers/seal_region_world.mjs';
import {nativeOwnedQuantity} from '../web/core/native_economy.mjs';

test('the earned six tablets open every original trial and the complete three-battle finale, returning with its reward once',async()=>{
  const source=await innerWhiteForestSource(),{world,trace}=await sealRegionComplete(source);
  assert.equal(trace.seal_region.scripted_battles.length,27);
  assert.deepEqual(new Set(trace.seal_region.scripted_battles.flatMap(group=>group.members.map(member=>member.id))),
    new Set(['033','034','077',...Array.from({length:24},(_,i)=>String(i+101))]));
  assert.equal(world.location.map_id,'REBIRTH-S01');
  assert.ok(world.value.flags[215]&1);assert.ok(world.value.flags[227]&1);
  assert.equal(nativeOwnedQuantity(world.value,135),1);
  assert.equal(world.value.inventory.find(row=>row.id===387)?.quantity,1);
  assert.ok([299,300,301,302,303,304].every(id=>world.value.inventory.some(row=>row.id===id)));
  assert.ok(trace.animations.some(row=>row.id==='m72065'));
});
