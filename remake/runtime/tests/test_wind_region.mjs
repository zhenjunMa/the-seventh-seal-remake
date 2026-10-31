import test from 'node:test';
import assert from 'node:assert/strict';
import {innerWhiteForestSource} from './helpers/inner_white_forest_world.mjs';
import {windRegionComplete,windIslandChests} from './helpers/wind_region_world.mjs';

test('LC-01/WI-01/WI-02 earn transport, island rewards, complete guardian event and the original retreat after465:1',async()=>{
  const {world,trace}=await windRegionComplete(await innerWhiteForestSource());
  assert.deepEqual(trace.animations.map(row=>[row.id,row.commands]),[['m19010-1',36],['m73013-1',113],['m17010-6',30]]);
  assert.equal(trace.battles.length,1,'Rule victory callback only: no rendered battle or natural growth claim');
  assert.equal(world.location.map_id,'M17010');assert.ok(world.value.flags[10]&16);
  assert.equal(windIslandChests.length,7);assert.deepEqual(trace.objects.map(([mapId,index])=>[mapId,index]),windIslandChests.map(row=>[row.mapId,row.objectIndex]));
});
