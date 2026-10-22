import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
import {MapNpcRuntime} from '../web/core/map_npcs.mjs';
import {drawMapScene} from '../web/map_scene_view.mjs';
import {MovementMap} from '../../prototype/web/movement.mjs';
registerHooks({resolve(specifier,context,next){
  if(specifier==='/prototype/movement.mjs')return {url:new URL('../../prototype/web/movement.mjs',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {createMapController}=await import('../web/controllers/map.mjs');
const {OpeningView}=await import('../web/opening_view.mjs');
const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
const [resources,story,map]=await Promise.all([read('../web/data/chapter_map_resources.json'),read('../web/data/chapter_story.json'),
  read('../web/data/maps/m17010.json')]);
const evidenceId='ev_cc8392615a7d78e2d6d4cc2dbfbc632ed4e69ade06250acba27d0a0c5a951b2b';

test('every exported map NPC includes the original loader +2AC initial hide rule and exact source bytes',async()=>{
  const retained=await read('../evidence/npc_motion_20261021/native_4b4f10.json');
  assert.equal(retained.evidence_id,evidenceId);assert.match(retained.normalized_result,/0x2ac/);assert.match(retained.normalized_result,/0x97/);
  const groups=[...Object.values(resources.npcs_by_map)];
  for(const id of ['m72061','m17020','m17026','m17029']){
    const data=await read(`../web/data/maps/${id}.json`);groups.push(data.opening_npcs);
    if(data.chapter_npcs)groups.push(data.chapter_npcs);
  }
  for(const npcs of groups)for(const npc of npcs){
    const original=await readFile(new URL('../../../'+npc.source.path,import.meta.url)),raw=original.subarray(npc.source.offset,npc.source.offset+0x4c5);
    assert.equal(createHash('sha256').update(original).digest('hex'),npc.source.sha256);
    assert.equal(npc.hidden_raw_97,raw[0x97]);assert.equal(npc.hidden_on_load_raw_2ac,raw[0x2ac]);
    assert.equal(npc.hidden,Boolean(raw[0x97]||raw[0x2ac]),npc.id);assert.ok(npc.initial_visibility_evidence.includes(evidenceId));
  }
  assert.deepEqual(resources.npcs_by_map.M17010.filter(npc=>npc.hidden).map(npc=>npc.slot_zero_based),[13,18,27,28,29]);
  assert.deepEqual(resources.npcs_by_map.M17020.filter(npc=>npc.hidden).map(npc=>npc.slot_zero_based),[30]);
});

function fixture(){
  const npcs=structuredClone(resources.npcs_by_map.M17010).map(npc=>({...npc,bitmap:{id:npc.id},resource:{frame_width:1,frame_height:1,
    frames_per_direction:1,anchor_x:0,anchor_y:0}}));
  const scene={data:map,npcs,objects:[],bitmap:{id:'map'},movement:new MovementMap(map.movement)};
  scene.npcRuntime=new MapNpcRuntime({scene,table:story.maps.M17010,roles:resources.roles});
  return scene;
}

test('loader-hidden story actors are absent from exploration, previews, interaction and live occupancy',()=>{
  const scene=fixture(),images=[],ctx={clearRect(){},fillRect(){},save(){},restore(){},translate(){},scale(){},drawImage(bitmap){images.push(bitmap.id);}};
  const world={location:{map_id:'M17010',x:0,y:0,direction:0},flags:[],object_states:{}};
  const options={scene,world,role:{frame_width:1,frame_height:1,map_draw_offset:{x:0,y:0}},action:{bitmap:{id:'hero'}},
    view:{zoom:1,x:0,y:0},width:640,height:480,time:0};
  drawMapScene(ctx,options);const first=[...images];images.length=0;drawMapScene(ctx,{...options,time:999999});assert.deepEqual(images,first);
  const state={world:{value:world,location:world.location},scenes:{phase:'map',current:scene},chapterStory:story};
  const controller=createMapController({state,actions:{},$:()=>({}),canvas:{},ctx});scene.npcRuntime.update(0);
  for(const npc of scene.npcs.filter(npc=>npc.hidden)){
    assert.equal(images.includes(npc.id),false,npc.id);assert.equal(controller.npcAvailable(npc),false);
    Object.assign(world.location,{x:npc.x,y:npc.y});controller.updateNearest();assert.notEqual(state.nearest?.id,npc.id);
    assert.equal(scene.npcRuntime.occupied(Math.floor(npc.x/16),Math.floor(npc.y/16),null,null),false,npc.id);
  }
});

test('ANM can explicitly reveal an initially hidden actor and hand it back without changing loader defaults',async()=>{
  const scene=fixture(),target=scene.npcs.find(npc=>npc.slot_zero_based===28),source=resources.npcs_by_map.M17010.find(npc=>npc.id===target.id);
  assert.equal(target.hidden,true);assert.equal(source.hidden_on_load_raw_2ac,1);
  const view=new OpeningView({resources,prepared:new Map([['M17010',scene]]),install(){},camera(){}});
  await view.hooks().map({mapId:'M17010'});assert.equal(view.getActor(28).visible,false);
  await view.hooks().actor({kind:'place',actor:28,x:target.x,y:target.y,poseRaw:1});
  scene.npcRuntime.adoptActors(view.actors);assert.equal(target.hidden,false);assert.equal(source.hidden,true);
  view.dispose();
});
