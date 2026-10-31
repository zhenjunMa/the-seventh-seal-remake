import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {innerWhiteForestSource,innerWhiteForestRunner} from './helpers/inner_white_forest_world.mjs';
import {floatingCitySecondComplete} from './helpers/floating_city_pc02_world.mjs';

test('PC-02 earns the inn puzzle and continues the main arrival through the complete203-command flight and006 admission',async()=>{
  await floatingCitySecondComplete(await innerWhiteForestSource());
});

test('the original500 inn option pays and runs the complete28-command rest with explicitly handed-in funds',async()=>{
  const source=await innerWhiteForestSource(),value=structuredClone(source.seed);
  value.opening.status='complete';value.location={map_id:'M03012_1F',x:400,y:320,direction:0};
  value.money=500;value.party[0].hp.current=1;value.party[0].mp.current=1;
  const world=new WorldStore(value,source.mapIds),{runner,trace}=innerWhiteForestRunner(source,world);
  await runner.runTlk({mapId:'M03012_1F',recordId:1,context:{steps:0,explicitInteraction:true,npcMapId:'M03012_1F',npcSlot:11}});
  assert.equal(world.value.money,0);assert.ok(world.value.party[0].hp.current>1);assert.ok(world.value.party[0].mp.current>1);
  assert.deepEqual(trace.animations,[{id:'rest',commands:28}]);
  assert.deepEqual(await decodeSave(await encodeSave(world.snapshot()),source.mapIds),world.snapshot());
});
