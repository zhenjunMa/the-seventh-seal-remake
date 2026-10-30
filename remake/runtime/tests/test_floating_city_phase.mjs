import test from 'node:test';
import {innerWhiteForestSource} from './helpers/inner_white_forest_world.mjs';
import {floatingCityComplete} from './helpers/floating_city_world.mjs';

const source=await innerWhiteForestSource();
test('PC-01 continues the seal through Franco, the complete book dream, rest and natural471:1',async()=>{
  await floatingCityComplete(source);
});
