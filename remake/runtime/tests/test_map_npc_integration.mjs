import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {drawMapScene} from '../web/map_scene_view.mjs';
import {WorldStore} from '../web/core/world.mjs';
import {ChapterRunner} from '../web/core/chapter.mjs';

registerHooks({resolve(specifier,context,next){
  if(specifier==='/prototype/movement.mjs')return {url:new URL('../../prototype/web/movement.mjs',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {createMapController}=await import('../web/controllers/map.mjs');
const {createStoryController}=await import('../web/controllers/story.mjs');
const {OpeningView}=await import('../web/opening_view.mjs');
const read=async path=>JSON.parse(await readFile(new URL(`../web/${path}`,import.meta.url),'utf8'));

function elements(){
  const nodes=new Map();
  return id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,dataset:{},replaceChildren(){},focus(){}});return nodes.get(id);};
}
function acceleratedPresentation(){
  const document=globalThis.document,tween=OpeningView.prototype.tween;
  // Pixel effects are exercised separately in the browser; these checks cover
  // the real source ANM's scene installation, actor state and transaction edge.
  globalThis.document={createElement(){return {getContext(){return {drawImage(){},putImageData(){},
    getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4)}),
    createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)})};}};}};
  OpeningView.prototype.tween=async function(_duration,update){update(1);this.updateCamera();};
  return ()=>{globalThis.document=document;OpeningView.prototype.tween=tween;};
}
async function fixture(mapId='M17020'){
  const [catalog,chapterResources,openingResources,chapterStory,data]=await Promise.all([
    read('data/catalog.json'),read('data/chapter_map_resources.json'),read('data/opening_map_resources.json'),
    read('data/chapter_story.json'),read(`data/maps/${mapId.toLowerCase()}.json`)]);
  openingResources.roles={...openingResources.roles,...chapterResources.roles};
  const world={location:{map_id:mapId,x:640,y:592,direction:4},flags:[],event_records:[],object_states:{}};
  const state={catalog,chapterResources,openingResources,chapterStory,events:[],world:{value:world,location:world.location},
    actorResourcesByMap:new Map(),view:{zoom:1,frame:0},resources:{revision:0,retainScopes(){},
      async attach(action,sheet){action.bitmap={sheet};return action.bitmap;}}};
  const $=elements(),actions={json:async()=>structuredClone(data),image:async path=>({path,width:data.width,height:data.height})};
  const controller=createMapController({state,actions,$,canvas:{focus(){}},ctx:{}});
  const scene=await controller.prepareMap(mapId);state.scenes={current:scene,phase:'map'};
  return {state,actions,controller,scene,$};
}

test('map preparation creates independent live NPCs and ordinary view commits preserve their positions',async()=>{
  const {state,controller,scene}=await fixture(),source=structuredClone(state.chapterResources.npcs_by_map.M17020);
  assert.ok(scene.npcRuntime.snapshot().length>0);
  const npc=scene.npcs[0],x=npc.x;npc.x+=32;
  const preview=await controller.prepareMap('M17020',{world:structuredClone(state.world.value)});
  assert.equal(preview.npcs[0].x,x);assert.equal(npc.x,x+32);
  assert.notEqual(preview.npcRuntime,scene.npcRuntime);assert.notEqual(preview.npcs[0].motion,npc.motion);
  const before=scene.npcRuntime.snapshot();scene.probes=[];
  controller.commitView(scene,state.world.location);
  assert.deepEqual(scene.npcRuntime.snapshot(),before);
  assert.deepEqual(state.chapterResources.npcs_by_map.M17020,source);
});

test('map drawing uses live action atlases and physical frames without advancing NPC or world state',()=>{
  const images=[],ctx={clearRect(){},fillRect(){},save(){},restore(){},translate(){},scale(){},drawImage(...args){images.push(args);}};
  const idle={name:'idle'},walk={name:'walk'},hero={name:'hero'},background={name:'background'},foreground={name:'foreground'};
  const role={frame_width:40,frame_height:60,anchor:{x:20,y:48},actions:[{index:1,bitmap:walk}]};
  const npc={id:'roaming',x:96,y:128,direction:5,bitmap:idle,motion:{role,action:1,frame:3}};
  const scene={data:{id:'M17020'},bitmap:background,npcs:[npc],objects:[{bitmap:foreground,layer:2,sort_y:180,draw_x:0,draw_y:0}]};
  const world={location:{x:80,y:100,direction:1},object_states:{},flags:[]},before=JSON.stringify({npc,world});
  const options={scene,world,role:{frame_width:16,frame_height:24,map_draw_offset:{x:0,y:0}},action:{bitmap:hero},
    view:{zoom:1,x:80,y:100},width:640,height:480};
  drawMapScene(ctx,{...options,time:0});drawMapScene(ctx,{...options,time:999999});
  for(const call of [images[2],images[6]]){
    assert.equal(call[0],walk);assert.deepEqual(call.slice(1),[120,300,40,60,92,80,40,60]);
  }
  assert.deepEqual(images.slice(0,4).map(call=>call[0].name),['background','hero','walk','foreground']);
  assert.equal(JSON.stringify({npc,world}),before);
});

test('RAF advances environment NPCs in exploration and ordinary dialogue and pauses other presentations',()=>{
  const original=globalThis.requestAnimationFrame;globalThis.requestAnimationFrame=()=>1;
  try{
    const updates=[],role={id:'001',actions:[{index:0,interval_raw:180,frames_per_direction:2}]},$=elements();
    const world={location:{map_id:'M17020',x:80,y:100,direction:1},party:[{id:'001',hp:{current:1}}],flags:[1]};
    const state={world:{value:world,location:world.location},scenes:{phase:'map',current:{data:{id:'M17020'},npcs:[],
      npcRuntime:{update:(now,options)=>updates.push({now,...options})}}},startupView:{tick(){},sequence:{stage:'menu'}},
      resources:{revision:0,retainScopes(){}},actorResourcesByMap:new Map(),openingResources:{roles:{}},
      keys:new Set(),selectedRole:'001',catalog:{roles:[role]},mapVitals:new Map(),view:{action:0,frame:0,follow:false},
      clock:0,lastTime:0,chapterStory:{maps:{}},battleUnavailable:''};
    const before=structuredClone(world),controller=createMapController({state,actions:{},$,canvas:{},ctx:{}});
    for(const [phase,opening,paused] of [['map',false,false],['event',false,false],['event',true,true],
      ['opening',true,true],['party-menu',false,true],['menu',false,true],['battle-loading',false,true]]){
      state.scenes.phase=phase;state.openingView={active:opening};controller.render(100+updates.length*16);
      assert.equal(updates.at(-1).paused,paused,`${phase}, opening=${opening}`);
      assert.equal(updates.at(-1).player,world.location);
      assert.equal(updates.at(-1).visible({hidden:true}),false);
      assert.equal(updates.at(-1).visible({event:{conditions:[{index:0,value:1}]}}),true);
    }
    assert.deepEqual(world,before);
  }finally{globalThis.requestAnimationFrame=original;}
});

test('interaction holds the live NPC identity and releases it after success, missing dialogue or failure',async()=>{
  for(const outcome of ['success','missing','failure']){
    const trace=[],live={id:'live-NPC',slot_zero_based:10},event={id:'event'},nearest={...live,event:outcome==='missing'?null:event};
    const state={nearest,world:{location:{map_id:'M17020'}},scenes:{phase:'map',current:{npcs:[live],npcRuntime:{
      hold(id){assert.equal(id,live.id);trace.push('hold');return ()=>trace.push('release');}}}},
      chapterStory:{maps:{M17020:{index_nonzero:[]}}},runner:{async run(value){
        assert.equal(value,event);assert.deepEqual(trace,['hold']);
        if(outcome==='failure')throw new Error('dialogue failed');}},
      captionView:{close(){}},dialogueView:{close(){}}};
    const controller=createStoryController({state,actions:{buildHud(){},status(){}},$:elements(),canvas:{focus(){}}});
    await controller.interact();assert.deepEqual(trace,['hold','release']);
  }
});

test('OpeningView seeds chapter actors from live poses and preserves raw defaults and resource records',async()=>{
  const role={actions:[{index:0},{index:1}]},source={id:'npc',slot_zero_based:10,resource_id:'030',x:16,y:32,direction:0};
  const live={...source,x:96,y:128,direction:5,motion:{role,action:1,frame:3}},scene={data:{id:'M17020',opening_npcs:[source]},npcs:[live]};
  const view=new OpeningView({resources:{roles:{'030':role,'001':role}},prepared:new Map([['M17020',scene]]),install(){},camera(){}});
  await view.hooks().map({mapId:'M17020'});
  const actor=view.getActor(10);assert.deepEqual({x:actor.x,y:actor.y,direction:actor.direction,action:actor.action,frame:actor.frame},
    {x:96,y:128,direction:5,action:1,frame:3});
  actor.x=500;actor.action=0;assert.equal(live.x,96);assert.equal(live.motion.action,1);assert.equal(source.x,16);
  view.dispose();
});

test('same-map chapter ANM inherits roaming poses and adopts actors before disposing the presentation',async()=>{
  const {state,actions,controller:map,scene,$}=await fixture('M17029'),restore=acceleratedPresentation();
  try{
    const npc=scene.npcs[0];npc.x+=32;npc.y+=16;const expected={x:npc.x,y:npc.y,direction:npc.direction};
    const draft={location:{map_id:'M17029',x:640,y:592,direction:4}};
    Object.assign(actions,{prepareMap:map.prepareMap,commitView(){},validateEntry:map.validateEntry,log(){}});
    const controller=createStoryController({state,actions,$,canvas:{focus(){}}});
    await controller.animateChapter({program:state.chapterStory.programs['m17029-1'],mapId:'M17029',draft,runTlk:async()=>{},joinActor:async()=>{}});
    const next=state.scenes.current.npcs.find(actor=>actor.id===npc.id);
    assert.notEqual(state.scenes.current,scene);assert.notEqual(next,npc);assert.equal(state.openingView.active,false);
    assert.deepEqual({x:next.x,y:next.y,direction:next.direction},expected);
    assert.deepEqual({x:npc.x,y:npc.y,direction:npc.direction},expected);
  }finally{restore();}
});

test('failed chapter ANM restores the previous roaming scene and leaves persistent world state untouched',async()=>{
  const {state,actions,controller:map,scene,$}=await fixture('M17029'),restore=acceleratedPresentation();
  try{
    const seed=await read('data/opening_seed.json');seed.opening.status='complete';seed.location={map_id:'M17029',x:640,y:592,direction:4};
    state.world=new WorldStore(seed,state.catalog.maps.map(map=>map.id));
    scene.npcs[0].x+=32;const before=scene.npcRuntime.snapshot(),world=state.world.snapshot(),errors=[];
    state.scenes.captureView=()=>({});state.scenes.rollbackView=()=>{};
    Object.assign(actions,{prepareMap:map.prepareMap,commitView(){},validateEntry:map.validateEntry,log(){},buildHud(){},updateNearest(){},
      status:(message,error)=>{if(error)errors.push(message);}});
    const controller=createStoryController({state,actions,$,canvas:{focus(){}}});
    state.chapterRunner=new ChapterRunner({world:state.world,data:state.chapterStory,
      say:async()=>{if(state.openingView?.active)throw new Error('ANM dialogue failed');},animate:controller.animateChapter,
      setPhase:phase=>state.scenes.phase=phase});
    await controller.runChapter({mapId:'M17029',recordId:25});
    assert.deepEqual(errors,['ANM dialogue failed']);assert.equal(state.scenes.current,scene);
    assert.deepEqual(scene.npcRuntime.snapshot(),before);assert.deepEqual(state.world.snapshot(),world);
    assert.equal(state.openingView.active,false);
  }finally{restore();}
});
