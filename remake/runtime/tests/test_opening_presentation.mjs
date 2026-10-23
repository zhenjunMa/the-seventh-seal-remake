import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {openingCamera,approachPoint,directArrivalMoves} from '../web/core/opening_presentation.mjs';
import {OpeningRunner} from '../web/core/opening.mjs';
const {OpeningView}=await import('../web/opening_view.mjs');
const read=async name=>JSON.parse(await fs.readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));

test('camera preserves the initial temple crop and usable borders, with continuous follow during motion',()=>{
  assert.deepEqual(openingCamera({x:464,y:752},992,832),{x:448,y:560});
  assert.deepEqual(openingCamera({x:486,y:536},992,832),{x:470,y:520});
  assert.deepEqual(openingCamera({x:0,y:0},992,832),{x:320,y:240});
  assert.deepEqual(openingCamera({x:9999,y:9999},992,832),{x:640,y:560});
  assert.deepEqual(approachPoint({x:550,y:630},{x:550,y:560},1,true),{x:550,y:560,dx:0,dy:-70});
});

test('temple and fire-valley follow do not jump at any crossed terrain cell',async()=>{
  const temple=await read('maps/m72061'),village=await read('maps/m17020');
  for(const [map,from,to] of [[temple,{x:464,y:752},{x:486,y:536}],
    [village,{x:1188,y:772},{x:1092,y:986}]]){
    const width=map.movement.width*16,height=map.movement.height*16;
    let previous=null;
    // Less than one pixel per sample crosses every former 16px discontinuity.
    for(let i=0;i<=1000;i++){
      const actor=approachPoint(from,to,i/1000,map===temple),camera=openingCamera(actor,width,height);
      if(previous){
        for(const axis of ['x','y']){
          const moved=actor[axis]-previous.actor[axis],scrolled=camera[axis]-previous.camera[axis];
          assert.ok(Math.abs(scrolled)<=Math.abs(moved)+1e-9,`${map.id} camera jumps on ${axis}`);
          assert.ok(scrolled*moved>=-1e-9,`${map.id} camera reverses on ${axis}`);
        }
      }
      previous={actor,camera};
    }
  }
});

test('all56 source commands show empty caption, solo arrival, five upward actors, full wings, retirement then map loading',async()=>{
  const [program,resources,presentation]=await Promise.all([read('opening_program'),read('opening_map_resources'),read('prologue_presentation')]);
  const sequence=[],logs=[],dialogues=[];
  // Pixel storage is stubbed here; actual sprite compositing is browser-checked.
  const previousDocument=globalThis.document;
  globalThis.document={createElement(){return {width:0,height:0,getContext(){return {
    drawImage(){},getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4)}),
    createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(){}};}};}};
  try{
    const view=new OpeningView({resources,program,prepared:new Map(),staging:presentation.staging,effects:presentation.effects,nativeViewport:true,
      prepare:async id=>{sequence.push(`load:${id}`);const data=await read(`maps/${id.toLowerCase()}`);
        return {data,bitmap:{width:data.movement.width*16,height:data.movement.height*16}};},
      install(){},camera(){},shade(){},log:entry=>{logs.push(entry);sequence.push(entry.type);},
      say:async(_speaker,text,style)=>dialogues.push({text,style,actors:[...view.actors.entries()].filter(([,a])=>a.visible).map(([slot,a])=>({slot,direction:a.direction}))})});
    view.tween=async(_duration,update,signal)=>{signal?.throwIfAborted();for(const t of [0,.25,.5,.75,1]){update(t);view.updateCamera();}};
    const result=await new OpeningRunner({program,hooks:view.hooks()}).run();
    assert.equal(result.executed_indices.length,56);
    assert.deepEqual(dialogues[0].actors,[]);
    assert.deepEqual(dialogues[1].actors.map(a=>a.slot).sort((a,b)=>a-b),[10,11,12,13,14]);
    assert.ok(dialogues[1].actors.every(a=>a.direction===3));
    for(const slot of [10,11,12,13]){
      const moves=logs.filter(e=>e.type==='opening-move-complete'&&e.actor===slot);
      assert.equal(moves.length,2);assert.equal(moves[0].presentation,'deferred-to-direct-arrival');
      assert.equal(moves[0].motion_frames.length,0);assert.equal(moves[1].presentation,'direct-arrival');
      const samples=moves[1].motion_frames,from=samples[0],to=samples.at(-1);
      assert.equal(samples.length,5);
      for(const point of samples){
        assert.ok(Math.abs((point.x-from.x)*(to.y-from.y)-(point.y-from.y)*(to.x-from.x))<1e-7,`actor${slot} detours`);
      }
      assert.equal(moves[1].actors.find(a=>a.slot===slot).direction,3);
    }
    const solo=logs.find(e=>e.type==='opening-move-complete'&&e.actor===14);
    assert.deepEqual(solo.actors.filter(a=>a.visible).map(a=>a.slot),[14]);
    const wings=logs.find(e=>e.type==='opening-animation-complete'&&e.actor===14).actors.find(a=>a.slot===14);
    assert.deepEqual({action:wings.action,frame:wings.frame,direction:wings.direction},{action:8,frame:9,direction:3});
    const retired=logs.find(e=>e.type==='opening-effect-complete'&&e.kind==='behavior');
    assert.equal(retired.actors.find(a=>a.slot===14).visible,false);
    assert.equal(retired.actors.filter(a=>a.visible).length,4);
    const retirement=sequence.lastIndexOf('opening-effect-complete');
    assert.ok(sequence.indexOf('load:M17020')>retirement);
    assert.equal(dialogues[2].style,1);assert.equal(view.mapId,'M17020');
    view.dispose();assert.equal(view.active,false);assert.equal(view.actors.size,0);
  }finally{globalThis.document=previousDocument;}
});

test('direct arrival coalescing stops at dialogue and never changes unconfigured actors',async()=>{
  const program=await read('opening_program'),presentation=await read('prologue_presentation');
  const plan=directArrivalMoves(program,presentation.staging);
  assert.deepEqual([...plan.keys()].sort((a,b)=>a-b),[20,21,22,23,25,26,27,28]);
  assert.equal(plan.has(8),false);assert.equal(plan.has(44),false);
  const interrupted=structuredClone(program);interrupted.commands[24].opcode=14;
  assert.equal(directArrivalMoves(interrupted,presentation.staging).size,0);
});

test('disposing the presentation prevents late async map installation',async()=>{
  let finish,installed=false;
  const view=new OpeningView({resources:{roles:{}},prepared:new Map(),prepare:()=>new Promise(resolve=>finish=resolve),install:()=>installed=true});
  const promise=view.hooks().map({mapId:'M72061'});view.dispose();finish({data:{opening_npcs:[]}});
  await assert.rejects(promise,/演出已关闭/);assert.equal(installed,false);
});
