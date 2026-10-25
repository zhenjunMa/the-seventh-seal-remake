import test from 'node:test';
import assert from 'node:assert/strict';
import {preparePhaseFixtures,sourceRecord} from '../evidence/fire_valley_20261025/prepare_phase_fixtures.mjs';

test('source NPC11 incoming chain, both real M17032 triggers and independent phase save contracts execute through production runners',async()=>{
  const {manifest,worlds}=await preparePhaseFixtures({write:false});
  assert.equal(manifest.files.length,9);
  assert.equal(manifest.regression.length,5);
  assert.ok(manifest.regression.every(row=>row.result==='pass'));
  assert.deepEqual(manifest.incoming.trace.animations.map(row=>row.id),['m17010-3']);
  assert.equal(manifest.incoming.trace.animations[0].commands,67);
  assert.equal(worlds.after_incoming.location.map_id,'M17032');
  assert.equal(worlds.first_altar_entry.location.map_id,'M17030-1');
  assert.equal(worlds.finale23_false_entrance.flags[23]&1,0);
  assert.equal(worlds.finale23_true_entrance.flags[23]&1,1);
  assert.ok(manifest.source_inputs.every(row=>row.unchanged));
});

test('post-holy source rejoin is gated by late valley return, then preserves native full-party no-op instead of forcing004 active',async()=>{
  const [late,returnGate,rejoinGate,writer]=await Promise.all([sourceRecord('M55010',12),sourceRecord('M55010',13),sourceRecord('M03030',14),sourceRecord('M55010',16)]);
  assert.deepEqual([late.condition_index,late.condition_bit,late.if_true],[10,5,13]);
  assert.deepEqual([returnGate.condition_index,returnGate.condition_bit,returnGate.if_true,returnGate.next],[0,2,8,14]);
  assert.deepEqual([rejoinGate.condition_index,rejoinGate.condition_bit,rejoinGate.if_true],[477,2,15]);
  assert.deepEqual([writer.mutation_type,writer.mutation_index,writer.mutation_bit],[0,0,2]);
  const {manifest,worlds}=await preparePhaseFixtures({write:false});
  assert.deepEqual(worlds.finale23_true_entrance.party.map(role=>role.id),['003','001','005','002']);
  assert.ok(worlds.finale23_true_entrance.reserve_party.some(entry=>entry.role.id==='004'));
  assert.equal(manifest.late_preparation.optional_return.operations.at(-1).result.reason,'formation-full');
});
