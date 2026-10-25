import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MapObjectRuntime} from '../web/core/map_objects.mjs';
import {ImageResources} from '../web/core/image_resources.mjs';
import {drawMapScene} from '../web/map_scene_view.mjs';
import {createMapController} from '../web/controllers/map.mjs';
const {OpeningView}=await import('../web/opening_view.mjs');

const root=new URL('../',import.meta.url),read=async path=>JSON.parse(await readFile(new URL(path,root),'utf8'));
const manifest=await read('web/data/map_effects.json');
function clock(){
  const map=manifest.maps.M70010,objects=map.objects.map(row=>({index:row.index}));
  const resources=map.objects.map(row=>({...row,resource:{...manifest.object_banks[row.bank],
    actions:manifest.object_banks[row.bank].actions.map(action=>({...action,
      main_bitmap:{name:`${row.index}:${action.index}:main`},intrinsic_bitmap:{name:`${row.index}:${action.index}:light`}}))}}));
  const runtime=new MapObjectRuntime({objects,resources,mapFlagIndex:map.map_flag_index});
  const world={revision:4,event_records:[],object_states:{},flags:[]};
  return {runtime,world,objects,resources,map};
}
function drawing(){
  const calls=[],stack=[],ctx={globalCompositeOperation:'source-over',
    clearRect(){},fillRect(){},translate(){},scale(){},
    save(){stack.push(this.globalCompositeOperation);},restore(){this.globalCompositeOperation=stack.pop();},
    drawImage(...args){calls.push({args,blend:this.globalCompositeOperation});}};
  return {ctx,calls};
}

test('map light export covers actual native save point and forest crystals with checked output pixels',async()=>{
  assert.equal(manifest.roles['183'].actions[0].frame_count,15);
  assert.equal(manifest.roles['183'].actions[0].interval_raw,130);
  assert.deepEqual(manifest.maps.M70010.objects.map(row=>row.index),[8,10]);
  const report=await read('evidence/map_effects_20261021/export.json');
  assert.equal(report.passed,true);assert.equal(report.source_bytes_unchanged,true);
  assert.equal(report.frame_checks.length,147);
  assert.ok(report.frame_checks.some(row=>row.source==='ROLE/183.dgp'&&row.intrinsic.covered_pixels>0));
  for(const [path,hash] of Object.entries(report.output_hashes)){
    assert.equal(createHash('sha256').update(await readFile(new URL('web'+path,root))).digest('hex'),hash,path);
  }
});

test('forest CF4 state0/1 loops only source action0 and completed state3 stays at action1 last frame',()=>{
  const {runtime,world,objects,map}=clock(),before=structuredClone(world),first=objects[0];
  runtime.update(0,{world});runtime.update(109,{world});assert.equal(first.motion.frame,0);
  runtime.update(110,{world});assert.equal(first.motion.frame,1);assert.match(first.motion.main.name,/:0:main$/);
  for(let t=220;t<=1100;t+=110)runtime.update(t,{world});
  assert.equal(first.motion.frame,0);assert.deepEqual(world,before);
  world.event_records[map.map_flag_index]=[];
  world.event_records[map.map_flag_index][first.index]='0300000000000000000000000000';
  runtime.update(1210,{world});assert.equal(first.motion.frame,15);assert.match(first.motion.main.name,/:1:main$/);
  runtime.update(1320,{world});assert.equal(first.motion.frame,15);
  world.event_records[map.map_flag_index][first.index]='0100000000000000000000000000';
  runtime.update(1321,{world});assert.match(first.motion.main.name,/:0:main$/);
  assert.equal(world.revision,4);
});

test('object clocks discard suspension and independent prepared scenes do not advance each other',()=>{
  const a=clock(),b=clock();a.runtime.update(0,{world:a.world});b.runtime.update(0,{world:b.world});
  a.runtime.update(110,{world:a.world});assert.equal(a.objects[0].motion.frame,1);assert.equal(b.objects[0].motion.frame,0);
  a.runtime.update(220,{world:a.world,paused:true});a.runtime.update(20000,{world:a.world});
  assert.equal(a.objects[0].motion.frame,1);
  a.runtime.update(20110,{world:a.world});assert.equal(a.objects[0].motion.frame,2);
});

test('the actual map controller keeps source objects animated during ANM while loading still pauses them',()=>{
  const {runtime,world,objects}=clock();world.location={map_id:'M70010',x:32,y:32,direction:0};
  const before=structuredClone(world),role={id:'001',actions:[{index:0}]};
  const state={world:{value:world,location:world.location},scenes:{phase:'event',current:{data:{id:'M70010'},objects,objectRuntime:runtime}},
    openingView:{active:true,nativeViewport:true,drawQueue:()=>[]},catalog:{roles:[role]},selectedRole:'001',
    view:{action:0,zoom:1},cssWidth:640,cssHeight:480,engine:{presentMap(){}}};
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{dataset:{}});return nodes.get(id);};
  const controller=createMapController({state,actions:{},$,canvas:{},ctx:{}});
  controller.updateExploration(0,0);controller.updateExploration(110,110);
  assert.equal(objects[0].motion.frame,1,'cutscene NPC control does not freeze independent source scenery');
  state.scenes.phase='loading';controller.updateExploration(220,110);assert.equal(objects[0].motion.frame,1);
  state.scenes.phase='event';controller.updateExploration(330,110);assert.equal(objects[0].motion.frame,2);
  assert.deepEqual(world,before,'presentation never submits story or encounter state');
});

test('live map emits main and same-frame light in the existing depth queue and respects hidden NPCs/objects',()=>{
  const {ctx,calls}=drawing(),main={name:'npc'},light={name:'light'},staticImage={name:'object'};
  const role={frame_width:150,frame_height:170,anchor:{x:75,y:138},actions:[{index:0,bitmap:main,intrinsic_bitmap:light}]};
  const npc={id:'point',x:400,y:300,direction:0,motion:{role,action:0,frame:7}};
  const object={index:8,bitmap:staticImage,layer:2,sort_y:200,draw_x:10,draw_y:20,
    motion:{main:{name:'crystal'},intrinsic:{name:'crystal-light'},width:96,height:128,frame:3}};
  const scene={data:{id:'M70010'},bitmap:{name:'map'},npcs:[npc,{...npc,id:'hidden',hidden:true}],objects:[object]};
  const world={location:{x:50,y:100,direction:0},object_states:{},flags:[]};
  const options={scene,world,role:{frame_width:16,frame_height:24,map_draw_offset:{x:0,y:0}},
    action:{bitmap:{name:'hero'}},view:{zoom:1,x:320,y:240,frame:0},width:640,height:480};
  drawMapScene(ctx,options);
  assert.deepEqual(calls.map(c=>[c.args[0].name,c.blend]),[
    ['map','source-over'],['hero','source-over'],['crystal','source-over'],['crystal-light','lighter'],['npc','source-over'],['light','lighter']]);
  assert.deepEqual(calls[4].args.slice(1),calls[5].args.slice(1));
  assert.equal(calls[4].args[1],7*150);assert.equal(ctx.globalCompositeOperation,'source-over');
  world.object_states['M70010:8']={visible:false};npc.hidden=true;calls.length=0;drawMapScene(ctx,options);
  assert.deepEqual(calls.map(c=>c.args[0].name),['map','hero']);
});

test('ANM actor draw uses the same indexed atlas frame and anchor as exploration',async()=>{
  const {ctx,calls}=drawing(),role={frame_width:150,frame_height:170,anchor:{x:75,y:138},
    actions:[{index:0,bitmap:{name:'point'},intrinsic_bitmap:{name:'light'}}]};
  const source={slot_zero_based:10,resource_id:'183',x:400,y:300,direction:0};
  const scene={data:{id:'M17010',opening_npcs:[source]},npcs:[source]};
  const view=new OpeningView({resources:{roles:{'001':role,'183':role}},prepared:new Map([['M17010',scene]]),install(){},camera(){}});
  await view.hooks().map({mapId:'M17010'});view.getActor(10).frame=7;
  view.drawQueue()[0].draw(ctx);
  assert.deepEqual(calls.map(c=>[c.args[0].name,c.blend]),[['point','source-over'],['light','lighter']]);
  assert.deepEqual(calls[0].args.slice(1),calls[1].args.slice(1));view.dispose();
});

test('light atlas attachment obeys scope release without replacing the main bitmap',async()=>{
  const images=[],cache=new ImageResources({createImage:()=>{const image={};images.push(image);return image;}});
  const action={bitmap:{main:true}},pending=cache.attach(action,'light.png','role:183','intrinsic_bitmap');
  cache.retainScopes([]);images[0].onload();await pending;
  assert.equal(action.intrinsic_bitmap,undefined);assert.deepEqual(action.bitmap,{main:true});
  const current=cache.attach(action,'light.png','role:183','intrinsic_bitmap');images[1].onload();await current;
  assert.equal(action.intrinsic_bitmap,images[1]);assert.deepEqual(action.bitmap,{main:true});
});
