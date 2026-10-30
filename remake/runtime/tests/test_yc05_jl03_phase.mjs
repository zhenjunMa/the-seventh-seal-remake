import test from 'node:test';
import {WorldStore} from '../web/core/world.mjs';
import {innerWhiteForestSource} from './helpers/inner_white_forest_world.mjs';
import {floatingCityComplete} from './helpers/floating_city_world.mjs';
import {yc05Jl03Complete} from './helpers/yc05_jl03_world.mjs';

const source=await innerWhiteForestSource();
let earned;
test.before(async()=>{earned=(await floatingCityComplete(source)).world.snapshot();});
for(const split of [false,true])test(`YC-05/JL-03 ${split?'split':'together'} pursuit completes boarding; ordinary source roots replay separately from NPC visibility`,async()=>{
  await yc05Jl03Complete(source,{world:new WorldStore(structuredClone(earned),source.mapIds),split});
});
