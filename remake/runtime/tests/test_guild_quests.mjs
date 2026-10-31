import test from 'node:test';
import assert from 'node:assert/strict';
import {innerWhiteForestSource} from './helpers/inner_white_forest_world.mjs';
import {guildComplete} from './helpers/guild_world.mjs';
import {WorldStore} from '../web/core/world.mjs';

const source=await innerWhiteForestSource();
let earnedStart;

test('the original guild errands, special synthesis, peaceful wolf resolution and research return earn every rank without injected materials',async()=>{
  const {world,trace}=await guildComplete(source,{checkpoint:(name,current)=>{
    if(name==='guild_start')earnedStart=current.snapshot();
  }});
  const groups=trace.battles.map(group=>group.members.map(member=>member.id));
  assert.ok(groups.some(ids=>ids.length===3&&ids.every(id=>id==='040')));
  assert.ok(groups.some(ids=>ids.length===4&&ids.every(id=>id==='041')));
  assert.ok(groups.some(ids=>JSON.stringify(ids)===JSON.stringify(['062','061','025','025','061','062'])),
    'Research obj95 follows literal r4→r8 to its complete six-enemy group');
  assert.equal(groups.flat().filter(id=>id==='043').length,0,'Ocean Heart resolves the wolf event through its original dialogue branch');
  assert.deepEqual(groups.slice(-2),[['024'],['085']]);
  assert.deepEqual(trace.house_reentry,{map_id:'M01066',x:592,y:400,direction:6});
  assert.deepEqual(trace.sounds.map(row=>row.token),['E017.wav','E018.wav','E017.wav']);
  assert.equal(world.value.flags[126]&0x3ff,0x3ff,'Every return portal was earned from its original floor trigger');
  assert.ok(trace.farming.some(row=>row.summary.drops.some(drop=>drop.id===331)),'The second seal stone comes from the original STG and reward RNG');
  assert.ok(trace.services.some(row=>row.action.mode==='sell')&&trace.services.some(row=>row.action.mode==='buy'));
  assert.deepEqual(trace.services.filter(row=>row.action.mode==='forge').map(row=>row.action.id),[253,259]);
  for(const id of [162,163,164,165,166,173,176,185,194,200,259,260,261,262,263])
    assert.ok(world.value.recipe_unlock_indices.includes(id-1),`Original recipe ${id} must be earned`);
  assert.ok(trace.checkpoints.some(row=>row.name==='research_final_before'));
  assert.equal(world.location.map_id,'M03032');
});

test('without Ocean Heart the three original forest encounters resolve the guild case through 043 battles',async()=>{
  const {world,trace}=await guildComplete(source,{world:new WorldStore(earnedStart,source.mapIds),peaceful:false,verifyFailures:false});
  const wolf=trace.battles.filter(group=>group.members.some(member=>member.id==='043'));
  assert.equal(wolf.length,3);assert.ok(wolf.every(group=>group.stage==='stage02.scn'&&group.members.length===1));
  for(const index of [584,588,601])assert.ok(world.value.flags[index]&1);
  assert.equal(world.value.flags[474]&2,0,'Violent resolution must not invent Tina’s peaceful completion');
  assert.ok(world.value.flags[521]&2);assert.ok(world.value.flags[419]&256);
});
