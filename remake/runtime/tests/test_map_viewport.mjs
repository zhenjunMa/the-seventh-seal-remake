import test from 'node:test';
import assert from 'node:assert/strict';
import {drawGameScene,drawOpeningScene} from '../web/map_scene_view.mjs';
import {openingCamera} from '../web/core/opening_presentation.mjs';
const {createMapController}=await import('../web/controllers/map.mjs');
const {createStoryController}=await import('../web/controllers/story.mjs');
const {OpeningView}=await import('../web/opening_view.mjs');

test('ANM started within a RAF frame never produces a negative logical frame',async()=>{
  const original=globalThis.requestAnimationFrame,queued=[],progress=[];
  globalThis.requestAnimationFrame=callback=>{queued.push(callback);};
  try{
    const presentation=new OpeningView({});
    const animation=presentation.tween(20,value=>progress.push(value));
    queued.shift()(performance.now()-10000);
    queued.shift()(performance.now()+10000);
    await animation;assert.deepEqual(progress,[0,1]);
  }finally{globalThis.requestAnimationFrame=original;}
});

function drawing(){
  let transform=[1,0,0,1,0,0];const stack=[],images=[];
  const ctx={clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},
    save(){stack.push([...transform]);},restore(){transform=stack.pop();},
    translate(x,y){transform[4]+=x*transform[0];transform[5]+=y*transform[3];},
    scale(x,y){transform[0]*=x;transform[3]*=y;},
    drawImage(...args){images.push({image:args[0],transform:[...transform],args:args.slice(1)});}};
  return {ctx,images};
}
const actor={x:1240,y:820,direction:2};
const scene={bitmap:{width:1600,height:1504},data:{id:'M17010'},objects:[],npcs:[],probes:[]};
const role={frame_width:64,frame_height:128,map_draw_offset:{x:-16,y:-96}};
const world={location:{map_id:'M17010',...actor},object_states:{},flags:[]};
const options={scene,world,role,action:{bitmap:{}},view:{...openingCamera(actor,1600,1504),zoom:1},time:0};

test('opening handoff preserves the background crop and scale at window and fullscreen sizes',()=>{
  for(const [width,height] of [[900,675],[1445,1005],[1745,1052],[480,650]]){
    const opening=drawing(),map=drawing();
    drawOpeningScene(opening.ctx,{...options,width,height,openingQueue:[]});
    drawGameScene(map.ctx,{...options,width,height});
    assert.deepEqual(map.images[0],opening.images[0]);
    const scale=Math.min(width/640,height/480),matrix=map.images[0].transform;
    assert.equal(matrix[0],scale);assert.equal(matrix[3],scale);
    assert.equal(matrix[4]+options.view.x*scale,width/2);
    assert.equal(matrix[5]+options.view.y*scale,height/2);
  }
});

test('map entry clears overview zoom, keeps the opening focus, and fit uses logical dimensions',()=>{
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{replaceChildren(){}});return nodes.get(id);};
  const state={view:{zoom:.3},world:{location:world.location},events:[],scenes:{current:scene},cssWidth:1745,cssHeight:1052};
  const controller=createMapController({state,actions:{},$,canvas:{},ctx:{}});
  controller.commitView(scene,world.location);
  assert.equal(state.view.zoom,1);assert.equal(state.view.follow,true);
  assert.deepEqual({x:state.view.x,y:state.view.y},openingCamera(actor,1600,1504));
  controller.fit();assert.equal(state.view.zoom,Math.min(640/1600,480/1504)*.97);
  state.cssWidth=480;state.cssHeight=650;controller.fit();
  assert.equal(state.view.zoom,Math.min(640/1600,480/1504)*.97);
  controller.commitView(scene,world.location);controller.follow();
  assert.equal(state.view.zoom,1);assert.equal(state.view.x,options.view.x);assert.equal(state.view.y,options.view.y);
});

test('dialogue head anchors stay in map logical coordinates across resize and ANM handoff',async()=>{
  const node={hidden:true},state={keys:new Set(),view:{...options.view},world:{location:world.location},scenes:{current:scene},
    captionView:{close(){}},dialogueView:{show(value){this.options=value;},close(){}}};
  const controller=createStoryController({state,actions:{},$:()=>node,canvas:{}});
  const completion=controller.say('英格妮','测试',2,{record:{speaker:1}});
  const anchor=state.dialogueView.options.getAnchor;
  const expected={x:320+actor.x+16-state.view.x,y:240+actor.y-state.view.y};
  for(const [width,height] of [[900,675],[1745,1052],[480,650]]){
    state.cssWidth=width;state.cssHeight=height;assert.deepEqual(anchor(),expected);
  }
  state.openingView={active:true,nativeViewport:true,actors:new Map([[0,actor]])};
  assert.deepEqual(anchor(),expected);
  controller.advanceDialogue();await completion;
});
