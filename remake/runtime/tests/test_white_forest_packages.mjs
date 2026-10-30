// Pure in-memory packaging and the formal asynchronous repository. No builder,
// original game file, PNG decoder or evidence-writing helper is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolveContentDefinition} from '../web/core/content_definition.mjs';
import {compileStoryPackages} from '../tools/export_story_packages.mjs';
import {StoryRepository} from '../web/core/story_repository.mjs';
import {ChapterRunner,initializeChapterItem} from '../web/core/chapter.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {nativeMapMovement} from '../web/core/map_locomotion.mjs';
import {MovementMap} from '../web/core/movement.mjs';
import {nativeKeyedChest} from '../web/core/native_map_chests.mjs';
const ids=['M70010','M70020','M70030','M70040','M70050','M70060'];
const read=async path=>JSON.parse(await readFile(new URL(`../web/${path}`,import.meta.url),'utf8'));
const definition=await read('data/runtime_content.json');
const needed=['chapter_story','chapter_map_resources','opening_seed','opening_program','route_events','forest_combat'];
const missing=[...needed.map(name=>`data/${name}.json`),...Object.keys(definition.maps).map(id=>`data/maps/${id.toLowerCase()}.json`)]
  .filter(path=>!existsSync(new URL(`../web/${path}`,import.meta.url)));
const options={skip:missing.length?`Generated package source tables unavailable: ${missing.join(', ')}`:false};
let prepared;
async function fixture(){
  if(!prepared)prepared=(async()=>{
    const [seed,forest,story]=await Promise.all(['opening_seed','forest_combat','chapter_story'].map(name=>read(`data/${name}.json`)));
    const maps=Object.fromEntries(await Promise.all(Object.keys(definition.maps).map(async id=>[id,await read(`data/maps/${id.toLowerCase()}.json`)])));
    const content=resolveContentDefinition(definition,{seed,forest,story,maps});
    const {output}=await compileStoryPackages({content,definition});
    const readPackage=async path=>{assert.ok(output.has(path),path);return JSON.parse(output.get(path));};
    const index=await readPackage('data/story/index.json');
    return {seed,maps,content,output,index,readPackage};
  })();
  return prepared;
}
async function repository(){
  const value=await fixture();
  return {...value,repository:await StoryRepository.create({read:value.readPackage,index:value.index,content:value.content,definition})};
}

test('all six formal compact map packages load, including direct-object tables whose original TLK file is absent',options,async()=>{
  const {repository:repo,content}=await repository();
  let directObjects=0;
  for(const id of ids){
    const loaded=await repo.ensureMap(id),table=repo.story.maps[id];assert.ok(loaded&&table,id);
    if(['M70020','M70040','M70050'].includes(id)){
      assert.equal(table.dialogue_status,'source-file-absent');assert.deepEqual(table.records,[]);
      assert.equal(table.flow_id,undefined);assert.deepEqual(loaded.flows,[]);
    }else {
      assert.ok(table.records.length>0);assert.ok(repo.story.flows[table.flow_id]);
    }
    for(const binding of content.maps[id].objects){
      assert.ok(table.objects.some(row=>row.index===binding.index));
      assert.ok(repo.resources.interactive_objects[id].some(row=>row.object_index_zero_based===binding.index));
      directObjects++;
    }
  }
  assert.equal(directObjects,13);
});

test('compact source tables retain the native blocked marker and ordinary movement can only leave that landing',options,async()=>{
  const {repository:repo,maps}=await repository();await repo.ensureMap('M70010');await repo.ensureMap('M70020');
  const exit=repo.resources.exits_by_map.M70020.find(row=>row.id===1),at=exit.entry;
  const movement=new MovementMap(nativeMapMovement(maps.M70010.movement,repo.story.maps.M70010,repo.story.programs));
  assert.deepEqual([at.x,at.y],[288,288]);assert.equal(movement.at(at.x,at.y).blocked,true);
  assert.equal(movement.validEntry(at.x,at.y),true);
  const leave=movement.move(at.x,at.y,0,16);assert.deepEqual([leave.x,leave.y,leave.blocked],[288,304,false]);
  assert.equal(movement.move(leave.x,leave.y,0,-16).blocked,true);
});

test('a source-absent compact map opens its real direct chest without a dialogue flow and saves the completed reward once',options,async()=>{
  const {repository:repo,seed,content}=await repository();await repo.ensureMap('M70020');
  const table=repo.story.maps.M70020,object=table.objects.find(row=>row.index===3),chest=nativeKeyedChest(object);
  const initial=structuredClone(seed);initial.opening.status='complete';initial.location={map_id:'M70020',x:0,y:0,direction:0};
  const key=repo.story.item_definitions[chest.keyId],raw=initializeChapterItem(key);new DataView(raw.buffer).setUint32(4,1,true);
  initial.inventory.push({instance_id:`package-test-key-${key.id}`,id:key.id,name:key.name,quantity:1,source_raw_hex:Buffer.from(raw).toString('hex')});
  const world=new WorldStore(initial,Object.keys(content.maps));let animations=0;
  const runner=new ChapterRunner({world,data:repo.story,content,objectData:repo.resources.interactive_objects,
    say:async()=>assert.fail('No TLK exists for this source map'),objectAnimation:async()=>{animations++;}});
  const result=await runner.runObject({mapId:'M70020',objectIndex:3});assert.equal(result.state,3);assert.equal(animations,1);
  const reward=world.value.inventory.find(row=>row.id===chest.rewards[0].id);assert.equal(reward.quantity,1);
  world.replace(await decodeSave(await encodeSave(world.snapshot()),Object.keys(content.maps)));
  const after=world.snapshot();assert.equal((await runner.runObject({mapId:'M70020',objectIndex:3})).already_done,true);
  assert.deepEqual(world.snapshot(),after);assert.equal(animations,1);
});
