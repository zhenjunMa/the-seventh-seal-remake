// Current phase contracts execute checked-in runners. Historical save-byte
// regeneration remains a separate history check, not a runtime dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldStore} from '../web/core/world.mjs';
import {admitPartyMember} from '../web/core/party_members.mjs';
import {fireValleyPartyFixture,headlessRunner} from './helpers/fire_valley_world.mjs';
import {originalTlk as sourceRecord} from './helpers/first_return_source.mjs';

test('incoming source ANM and both real M17032 triggers execute through production runners across source flag states',async()=>{
  const {worlds,trace}=await fireValleyPartyFixture();
  assert.deepEqual(trace.animations,[{id:'m17010-3',commands:67}]);
  assert.equal(worlds.after_incoming.location.map_id,'M17032');
  assert.deepEqual(worlds.after_incoming.party.map(role=>role.id),['003','001','005']);
  assert.ok(worlds.after_incoming.reserve_party.some(entry=>entry.role.id==='004'));
  // Data drives the shared transition rule; no copied phase generator/report.
  for(const {triggerId,recordId,late,completed,target} of [
    {triggerId:2,recordId:1,late:false,completed:false,target:'M17030'},
    {triggerId:2,recordId:1,late:true,completed:false,target:'M17030-1'},
    {triggerId:1,recordId:2,late:false,completed:false,target:'M17023'},
    {triggerId:1,recordId:2,late:true,completed:false,target:'M17032'},
    {triggerId:1,recordId:2,late:true,completed:true,target:'M17023'}
  ]){
    const value=structuredClone(worlds.after_incoming);
    value.flags[10]=late?value.flags[10]|2:value.flags[10]&~2;
    value.flags[471]=completed?value.flags[471]|1:value.flags[471]&~1;
    const world=new WorldStore(value),{runner}=headlessRunner(world);
    await runner.runTlk({mapId:'M17032',recordId,triggerId,context:{explicitInteraction:true,steps:0}});
    assert.equal(world.location.map_id,target);
  }
});

test('post-holy source rejoin retains its late-return gates and native full-party no-op preserves004 in reserve',async()=>{
  const [late,returnGate,rejoinGate,writer]=await Promise.all([
    sourceRecord('M55010',12),sourceRecord('M55010',13),sourceRecord('M03030',14),sourceRecord('M55010',16)]);
  assert.deepEqual([late.condition_index,late.condition_bit,late.if_true],[10,5,13]);
  assert.deepEqual([returnGate.condition_index,returnGate.condition_bit,returnGate.if_true,returnGate.next],[0,2,8,14]);
  assert.deepEqual([rejoinGate.condition_index,rejoinGate.condition_bit,rejoinGate.if_true],[477,2,15]);
  assert.deepEqual([writer.mutation_type,writer.mutation_index,writer.mutation_bit],[0,0,2]);
  const {worlds}=await fireValleyPartyFixture(),value=structuredClone(worlds.after_incoming);
  admitPartyMember(value,'002');
  const before=structuredClone(value);
  assert.equal(admitPartyMember(value,'004').reason,'formation-full');
  assert.deepEqual(value,before);
  assert.deepEqual(value.party.map(role=>role.id),['003','001','005','002']);
  assert.ok(value.reserve_party.some(entry=>entry.role.id==='004'));
});
