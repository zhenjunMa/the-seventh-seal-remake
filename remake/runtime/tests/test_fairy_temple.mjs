import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {innerWhiteForestSource} from './helpers/inner_white_forest_world.mjs';
import {templeComplete} from './helpers/fairy_forest_temple_world.mjs';
import {compileNativeTriggerFlow,nativeTriggerFlowId} from '../web/core/story_flow_compiler.mjs';
import {StoryRepository} from '../web/core/story_repository.mjs';
import {runtimeContent,runtimeContentDefinition} from '../web/core/content_registry.mjs';

test('FF-02 follows the earned seal through five stairs, the plaza and full93-command revival, then restores retreat',async()=>{
  const {world,trace}=await templeComplete(await innerWhiteForestSource());
  assert.equal(world.location.map_id,'M72061');assert.equal(trace.battles.length,6);
  assert.deepEqual(trace.animations.map(row=>[row.id,row.commands]),[['m72061-1',50],['m72062-1',18],['m72063',12],
    ['m72062-2',14],['m72063-2',16],['m72062-3',16],['m72063-3',16],['m72064-1',93]]);
});

test('the actual DAT state1 gate compiles directly to shared StoryFlow without a fabricated TLK record',async()=>{
  const source=await innerWhiteForestSource(),table=source.story.maps['M72050-1'],descriptor=table.descriptors.find(row=>row.id===2);
  const flow=compileNativeTriggerFlow(table,descriptor);
  assert.equal(flow.id,nativeTriggerFlowId('M72050-1',2));assert.deepEqual(flow.commands.map(row=>row.op),['animation','end']);
  assert.equal(flow.commands[0].program_id,'m72061-1');assert.deepEqual(flow.commands[0].source,descriptor.source);
  assert.equal(flow.commands[0].record_id,undefined);
  assert.throws(()=>compileNativeTriggerFlow(table,{...descriptor,source:{...descriptor.source,sha256:'0'.repeat(64)}}),/来源无效/);
});

test('the formal asynchronous map package loads its DAT gate flow and the complete cross-map ANM dependency lease',async()=>{
  const read=async path=>JSON.parse(await readFile(new URL(`../web/${path}`,import.meta.url),'utf8'));
  const repository=await StoryRepository.create({read,index:await read('data/story/index.json'),content:runtimeContent,definition:runtimeContentDefinition});
  await repository.ensureMap('M72050-1');
  const id=nativeTriggerFlowId('M72050-1',2),flow=repository.story.flows[id];
  assert.deepEqual(flow.commands.map(row=>row.op),['animation','end']);
  const lease=await repository.ensureProgram('m72061-1',{callerMap:'M72050-1'});
  assert.ok(lease.program.context_sources.caller_descriptors.some(row=>row.map_id==='M72050-1'&&row.descriptor_id===2));
  for(const mapId of lease.program.maps)assert.ok(repository.story.maps[mapId]);
  lease.release();assert.equal(repository.pins.size,0);
});
