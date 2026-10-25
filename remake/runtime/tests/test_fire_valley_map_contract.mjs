// Actual shipped DAT/DGP inputs versus the published maps and asynchronous
// map loader. This checks source contracts, not a replay of all story phases.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runtimeContent,runtimeContentDefinition} from '../web/core/content_registry.mjs';
import {STORY_RESOURCE_TABLES} from '../web/core/story_packages.mjs';
import {StoryRepository} from '../web/core/story_repository.mjs';
import {MovementMap} from '../web/core/movement.mjs';
import {createMapController} from '../web/controllers/map.mjs';

const copy=structuredClone;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const original=name=>readFile(new URL(`../../../${name}`,import.meta.url));
const read=async name=>JSON.parse(await readFile(new URL(`../web/${name.replace(/^\//,'')}`,import.meta.url),'utf8'));
const names=(await readdir(new URL('../../../Map/',import.meta.url))).filter(name=>/^m170\d{2}(?:-\d+)?\.dat$/i.test(name)).sort();
const ids=names.map(name=>name.slice(0,-4).toUpperCase()),members=new Set(ids);
const [resources,catalog,index,seed]=await Promise.all(['chapter_map_resources','catalog','story/index','opening_seed'].map(name=>read(`data/${name}.json`)));
const maps=new Map(await Promise.all(ids.map(async id=>[id,await read(`data/maps/${id.toLowerCase()}.json`)])));
const sources=new Map(await Promise.all(ids.map(async id=>{
  const bytes=await original(`Map/${id.toLowerCase()}.dat`),width=bytes.readUInt32LE(0x146),height=bytes.readUInt32LE(0x14a);
  const recordBytes=bytes.readUInt32LE(0x18)===1?0x42:0x2b,descriptorStart=0x172+width*height*64+32*0x2a;
  const npcStart=0x172+width*height*64+32*(0x2a+recordBytes+0x1b+0x110)+bytes.readUInt32LE(0x82)*0x112;
  const grid=(x,y)=>0x172+(y*width+x)*64;
  return [id,{bytes,width,height,recordBytes,descriptorStart,npcStart,grid}];
})));

test('all 21 source maps and 147 NPC instances retain exact DAT identity and original ROLE resources',async()=>{
  assert.equal(ids.length,21);assert.ok(ids.every(id=>runtimeContent.maps[id]));
  let count=0;const checkedRoles=new Set();
  for(const id of ids){
    const source=sources.get(id),map=maps.get(id),npcs=resources.npcs_by_map[id];
    assert.equal(map.id,id);assert.equal(digest(source.bytes),map.source.sha256);
    assert.equal(npcs.length,source.bytes[0x86],id);count+=npcs.length;
    for(let index=0;index<npcs.length;index++){
      const offset=source.npcStart+index*0x4c5,raw=source.bytes.subarray(offset,offset+0x4c5),npc=npcs[index];
      assert.equal(npc.id,`${id}-role-${index+10}`);assert.equal(npc.slot_zero_based,index+10);
      assert.equal(npc.source.offset,offset);assert.equal(npc.source.sha256,map.source.sha256);
      assert.equal(npc.resource_id,String(raw.readUInt32LE(0x28)).padStart(3,'0'));
      assert.deepEqual([npc.x,npc.y,npc.direction],[raw.readInt32LE(0x6f)*2,raw.readInt32LE(0x73)*2,raw[0x45]]);
      if(checkedRoles.has(npc.resource_id))continue;checkedRoles.add(npc.resource_id);
      const role=resources.roles[npc.resource_id];assert.ok(role,`${id} slot${index+10} missing ROLE${npc.resource_id}`);
      assert.equal(role.source.path.toLowerCase(),`role/${npc.resource_id}.dgp`);
      assert.equal(digest(await original(role.source.path)),role.source.sha256);
      for(const action of role.actions){
        const png=await readFile(new URL(`../web/${action.sheet.replace(/^\//,'')}`,import.meta.url));
        assert.equal(png.subarray(1,4).toString(),'PNG');
        assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[role.frame_width*action.frame_count,role.frame_height*action.directions]);
      }
    }
  }
  assert.equal(count,147);assert.equal(checkedRoles.size,15);
});

test('all 44 admitted physical exits match actual DAT destinations and unblocked native entry markers',()=>{
  let total=0;
  for(const id of ids){
    const source=sources.get(id),referenced=new Set();
    for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){
      const at=source.grid(x,y),trigger=source.bytes.readUInt32LE(at+0x38);
      if(trigger)referenced.add(trigger);
      assert.equal(maps.get(id).movement.terrain_rows[y][x],String(source.bytes[at+0x20]));
    }
    const expected=[];
    for(const descriptor of referenced){
      const offset=source.descriptorStart+(descriptor-1)*source.recordBytes,raw=source.bytes.subarray(offset,offset+source.recordBytes);
      const filename=raw.subarray(0x11,0x26).toString('ascii').split('\0')[0],target=filename.replace(/\.dat$/i,'').toUpperCase();
      if(raw[0]===0&&members.has(target))expected.push({descriptor,offset,raw,target});
    }
    const exits=(resources.exits_by_map[id]??[]).filter(exit=>members.has(exit.target_map));
    assert.equal(exits.length,expected.length,id);total+=exits.length;
    for(const sourceExit of expected){
      const exit=exits.find(exit=>exit.id===sourceExit.descriptor);assert.ok(exit,`${id}:${sourceExit.descriptor}`);
      assert.equal(exit.target_map,sourceExit.target);assert.equal(exit.state,'ready');
      assert.equal(exit.source.descriptor_offset,sourceExit.offset);assert.equal(exit.source.descriptor_hex,sourceExit.raw.toString('hex'));
      assert.equal(exit.source.sha256,digest(source.bytes));
      const marker=source.recordBytes===0x2b?sourceExit.raw[0x26]:sourceExit.raw.readUInt32LE(0x26);
      const target=sources.get(exit.target_map),entry=exit.entry,at=target.grid(entry.cell_x,entry.cell_y);
      assert.equal(exit.source.target_entry_marker,marker);assert.equal(target.bytes[at+0x21],marker);
      assert.equal(target.bytes[at+0x20],0);assert.equal(target.bytes.readUInt32LE(at+0x38),0);
      assert.deepEqual([entry.x,entry.y],[entry.cell_x*16,entry.cell_y*16]);
      assert.equal(new MovementMap(maps.get(exit.target_map).movement).at(entry.x,entry.y).blocked,false);
      for(const cell of exit.cells)assert.equal(source.bytes.readUInt32LE(source.grid(cell.x,cell.y)+0x38),exit.id);
    }
  }
  assert.equal(total,44);
});

test('map variants keep their own identities while every object uses its source-declared Mapm base',async()=>{
  const hashes=new Map();
  for(const id of ids){
    const base=sources.get(id).bytes.subarray(0x14e,0x16e).toString('ascii').split('\0')[0].replaceAll('\\','/').replace(/^\.\//,'').replace(/\/$/,'').toLowerCase();
    assert.match(base,/^mapm\/[a-z0-9_-]+$/);
    for(const object of maps.get(id).objects){
      assert.equal(object.source,`${base}/${object.resource_filename.toLowerCase()}`);
      if(!hashes.has(object.source))hashes.set(object.source,digest(await original(object.source)));
      assert.equal(object.resource_sha256,hashes.get(object.source));
    }
    for(const animation of resources.object_animations[id]??[]){
      assert.equal(animation.source.path,`${base}/${animation.resource_id}.dgp`);
      if(!hashes.has(animation.source.path))hashes.set(animation.source.path,digest(await original(animation.source.path)));
      assert.equal(animation.source.sha256,hashes.get(animation.source.path));
    }
  }
  assert.ok(maps.get('M17024').objects.every(object=>object.source==='mapm/m01021_2/026.dgp'));
  assert.ok(maps.get('M17030-1').objects.every(object=>object.source.startsWith('mapm/m17030/')));
  assert.ok(maps.get('M17030-2').objects.every(object=>object.source.startsWith('mapm/m17030/')));
  assert.notEqual(maps.get('M17030').source.sha256,maps.get('M17030-1').source.sha256);
  assert.notEqual(maps.get('M17030-1').source.sha256,maps.get('M17030-2').source.sha256);
});

async function loader(){
  const world=copy(seed),openingResources=await read('data/opening_map_resources.json');
  const state={catalog,openingResources,world:{value:world,location:world.location},actorResourcesByMap:new Map(),view:{zoom:1,frame:0},
    scenes:{current:null,phase:'map'},resources:{revision:0,retainScopes(){},async attach(action,sheet,_scope,key='bitmap'){return action[key]=await image(sheet);}}};
  const jsonCache=new Map(),images=new Map(),reads=new Map();
  async function json(path){
    await Promise.resolve();
    reads.set(path,(reads.get(path)??0)+1);
    if(!jsonCache.has(path))jsonCache.set(path,await read(path));return copy(jsonCache.get(path));
  }
  async function image(path){
    if(!images.has(path))images.set(path,readFile(new URL(`../web/${path.replace(/^\//,'')}`,import.meta.url)).then(bytes=>({width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)})));
    return images.get(path);
  }
  state.storyRepository=await StoryRepository.create({read:json,index,content:runtimeContent,definition:runtimeContentDefinition,currentMap:()=>state.scenes.current?.data.id});
  state.chapterStory=state.storyRepository.story;state.chapterResources=state.storyRepository.resources;state.events=state.storyRepository.events;
  state.openingResources.roles={...openingResources.roles,...state.chapterResources.roles};
  const controller=createMapController({state,actions:{json,image},$:()=>({}),canvas:{},ctx:{}});
  return {state,controller,reads};
}
test('asynchronous real-map preparation keeps all 147 actors and releases old packages across repeated region visits',async()=>{
  const {state,controller,reads}=await loader(),repository=state.storyRepository,before=copy(state.world.value);
  const first=await Promise.all([repository.ensureMap('M17011'),repository.ensureMap('M17011')]);
  assert.equal(first[0],first[1]);assert.equal(reads.get(index.maps.M17011.path),1,'concurrent callers share one verified read');
  for(let cycle=0;cycle<3;cycle++){
    let actorCount=0;
    for(const id of cycle%2?[...ids].reverse():ids){
      const scene=await controller.prepareMap(id);state.scenes.current=scene;
      assert.equal(scene.data.movement.native_step_shift,sources.get(id).bytes[0x144],`${id} native movement header`);
      assert.equal(scene.data.movement.native_camera_step_shift,sources.get(id).bytes[0x145],`${id} native camera header`);
      assert.equal(scene.npcs.length,sources.get(id).bytes[0x86],id);actorCount+=scene.npcs.length;
      assert.equal(scene.npcRuntime.snapshot().length,scene.npcs.length,`${id} live source actors`);
      for(const exit of scene.data.exits.filter(exit=>exit.target_map&&members.has(exit.target_map)))
        assert.ok(exit.cells.some(cell=>!scene.movement.cell(cell.x,cell.y).blocked),`${id} exit${exit.id} has a usable source cell`);
      const loaded=new Set(repository.loaded.keys());
      assert.ok(loaded.size<=4);assert.equal(repository.pending.size,0);assert.equal(repository.pins.size,0);
      for(const key of STORY_RESOURCE_TABLES)assert.deepEqual(new Set(Object.keys(repository.resources[key])),loaded,`${key} retains only live packages`);
      assert.deepEqual(new Set(Object.keys(repository.story.programs)),new Set([...repository.loaded.values()].flatMap(owner=>owner.programs)));
      assert.deepEqual(new Set(Object.keys(repository.story.flows)),new Set([...repository.loaded.values()].flatMap(owner=>owner.flows)));
    }
    assert.equal(actorCount,147);
  }
  assert.deepEqual(state.world.value,before,'map loading and layout projection do not write saved progress');
});
