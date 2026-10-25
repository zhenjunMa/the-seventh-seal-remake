import test from 'node:test';
import assert from 'node:assert/strict';
import {ChapterRunner} from '../web/core/chapter.mjs';
import {ChapterAnimationRunner} from '../web/core/chapter_animation.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {firstReturnSource,firstReturnWorld,originalTlk} from './helpers/first_return_source.mjs';
const data=await firstReturnSource(),copy=structuredClone;
function fixture(options={}){
  const world=new WorldStore(firstReturnWorld(data,options),Object.keys(data.content.maps)),animations=[],dialogues=[];
  const runner=new ChapterRunner({world,data:data.story,content:data.content,say:async({mapId,record})=>dialogues.push([mapId,record.id]),
    choose:async()=>options.choice??0,animate:async({program,runTlk,joinActor,leaveActor,flagCommand,draft})=>{
      animations.push(program.id);
      const result=await new ChapterAnimationRunner({program,runTlk,joinActor,leaveActor,flagCommand,content:data.content,
        initialLocation:draft.location,hooks:Object.fromEntries(['map','actor','move','camera','wait','fade'].map(key=>[key,async()=>{}]))}).run();
      draft.location={...result.location,direction:draft.location.direction};
    }});
  return {world,runner,animations,dialogues};
}
test('NPC15 actual root and all three source material choices consume299 once, then execute the full first return and the regional005 join',async()=>{
  assert.equal(data.story.maps.M01050.index_nonzero.find(row=>row.slot===15).record,17);
  assert.deepEqual(data.content.maps.M01050.npcs,[15]);assert.equal(Object.keys(data.content.maps).filter(id=>id.startsWith('M170')).length,21);
  assert.equal(data.story.programs['m01050-1'].commands.length,18);assert.equal(data.story.programs['m01050-2'].commands.length,44);
  for(const [choice,id]of [[0,358],[1,348],[2,342]]){
    const f=fixture({choice}),before=f.world.snapshot();
    const result=await f.runner.runTlk({mapId:'M01050',recordId:17,context:{steps:0,explicitInteraction:true}});
    assert.deepEqual(f.animations,['m01050-2']);assert.equal(f.world.location.map_id,'M17010');
    assert.deepEqual(f.dialogues.slice(-6).map(row=>row[1]),[5,6,7,8,9,10]);
    assert.equal(f.world.value.flags[5]&4,4);assert.equal(f.world.value.flags[10]&1,1);
    assert.equal(f.world.value.inventory.some(row=>row.id===299),false);assert.equal(f.world.value.inventory.find(row=>row.id===id)?.quantity,1);
    assert.deepEqual(f.world.value.party,before.party);assert.equal(result.world.revision,before.revision+1);
    assert.deepEqual(await decodeSave(await encodeSave(f.world.snapshot()),Object.keys(data.content.maps)),f.world.snapshot());
    const after=copy(f.world.value.inventory);f.world.transact(draft=>{draft.location.map_id='M01050';});
    await f.runner.runTlk({mapId:'M01050',recordId:17,context:{steps:0,explicitInteraction:true}});
    assert.deepEqual(f.world.value.inventory,after);assert.deepEqual(f.animations,['m01050-2']);
    f.world.transact(draft=>{draft.location.map_id='M17010';});
    await f.runner.runTlk({mapId:'M17010',recordId:49});
    assert.deepEqual(f.animations,['m01050-2','m17010-2']);assert.equal(f.world.location.map_id,'M17014');
    assert.deepEqual(f.world.value.party.map(role=>role.id),['001','002','005']);assert.ok(f.world.value.recipe_unlock_indices.includes(256));
  }
});
test('NPC15 unaccepted source branch executes all18 m01050-1 commands and grants source332 once; no299 cannot complete the return',async()=>{
  const f=fixture({accepted:false,returnedItem:false});
  await f.runner.runTlk({mapId:'M01050',recordId:17,context:{steps:0,explicitInteraction:true}});
  assert.deepEqual(f.animations,['m01050-1']);assert.equal(f.world.value.flags[5]&1,1);
  assert.equal(f.world.value.inventory.find(row=>row.id===332)?.quantity,1);assert.equal(f.world.value.flags[10]&1,0);
  await f.runner.runTlk({mapId:'M01050',recordId:17,context:{steps:0,explicitInteraction:true}});
  assert.deepEqual(f.animations,['m01050-1']);assert.equal(f.world.value.inventory.find(row=>row.id===332)?.quantity,1);
});
test('failed incoming presentation rolls back the selected material,299 removal and both source completion flags',async()=>{
  const f=fixture(),before=f.world.snapshot();f.runner.animate=async()=>{throw Error('incoming frame unavailable');};
  await assert.rejects(f.runner.runTlk({mapId:'M01050',recordId:17,context:{steps:0,explicitInteraction:true}}),/incoming frame unavailable/);
  assert.deepEqual(f.world.snapshot(),before);
});
test('development handoff prerequisites retain their concrete external source writers and original map flag indices',async()=>{
  const [accepted,completed,permission,item]=await Promise.all([originalTlk('m01050',14),originalTlk('m01050',24),originalTlk('m01051',29),originalTlk('Hellway-j04',7)]);
  assert.deepEqual([accepted.mutation_type,accepted.mutation_index,accepted.mutation_bit],[0,0,1]);
  assert.deepEqual([completed.mutation_type,completed.mutation_index,completed.mutation_bit],[0,0,3]);
  assert.deepEqual([permission.mutation_type,permission.mutation_index,permission.mutation_bit],[0,0,2]);
  assert.deepEqual([item.mutation_type,item.mutation_index,item.mutation_bit],[5,0,299]);
});
