import test from 'node:test';
import {innerWhiteForestSource} from './helpers/inner_white_forest_world.mjs';
import {forestSealComplete} from './helpers/fairy_forest_temple_world.mjs';

test('FF-01 runs all six source switches, partial/all remote predicates, both forest variants and complete unsealing',async()=>{
  await forestSealComplete(await innerWhiteForestSource());
});
