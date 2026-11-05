import test from 'node:test';
import assert from 'node:assert/strict';
import {innerWhiteForestSource} from './helpers/inner_white_forest_world.mjs';
import {sealTabletsComplete} from './helpers/seal_tablets_world.mjs';

test('the six original tablet errands continue the earned main/guild world with source materials, both fire branches and atomic failures',async()=>{
  const source=await innerWhiteForestSource(),{world,trace}=await sealTabletsComplete(source);
  assert.deepEqual(trace.seal.tablets,[9,290,291,292,293,294].map(id=>({id,quantity:1})));
  assert.deepEqual(trace.animations.slice(trace.seal.animation_start).filter(row=>['m03050-1','m72040-q','m03011','m29011-1'].includes(row.id)).map(row=>[row.id,row.commands]),
    [['m03050-1',8],['m72040-q',15],['m03011',51],['m29011-1',29]]);
  assert.deepEqual(trace.battles.slice(trace.seal.battle_start).map(group=>group.members.map(member=>member.id)),[['083','083','083'],['023']]);
  assert.equal(trace.seal.failures.length,7);assert.equal(trace.seal.cancellations.length,3);
  assert.equal(trace.seal.threat_branch.money_paid,0);assert.equal(trace.seal.threat_branch.fire_tablets,1);
  assert.ok(trace.seal.financing.money_after>=trace.seal.financing.target);assert.ok(trace.services.some(row=>row.action.mode==='synthesize'&&row.action.id===177));
  assert.ok(trace.checkpoints.some(row=>row.name==='seal_moon_key_used'));
  assert.deepEqual(trace.seal.reward_use.map(row=>row.id),[29,30]);assert.ok(trace.checkpoints.some(row=>row.name==='seal_fire_ring_reequipped'));
  assert.ok(world.value.flags[434]&4);assert.ok(world.value.flags[519]&16);assert.ok(world.value.flags[521]&16);
  assert.equal(world.value.inventory.some(row=>[388,389,390,401].includes(row.id)),false);
});
