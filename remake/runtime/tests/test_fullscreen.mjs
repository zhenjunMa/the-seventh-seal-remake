import test from 'node:test';
import assert from 'node:assert/strict';
import {createFullscreenController} from '../web/controllers/fullscreen.mjs';
import {createInputController} from '../web/controllers/input.mjs';

function fixture({supported=true,lock=async()=>{}}={}){
  const nodes=new Map(),calls=[];
  const $=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,textContent:''});return nodes.get(id);};
  const document={fullscreenElement:null};
  const keyboard=supported?{lock:async codes=>{calls.push(['lock',codes]);await lock();},unlock:()=>calls.push(['unlock'])}:undefined;
  const canvas={focus:()=>calls.push(['focus'])};
  const controller=createFullscreenController({$,canvas,document,keyboard});
  $('screen').requestFullscreen=async()=>{calls.push(['enter']);document.fullscreenElement=$('screen');controller.changed();};
  document.exitFullscreen=async()=>{calls.push(['exit']);document.fullscreenElement=null;controller.changed();};
  return {controller,$,document,calls,canvas};
}

test('game fullscreen captures only Escape, focuses the game and keeps an explicit exit',async()=>{
  const {controller,$,calls,document}=fixture();
  await controller.toggle();
  assert.equal(document.fullscreenElement,$('screen'));
  assert.deepEqual(calls,[['enter'],['focus'],['lock',['Escape']]]);
  assert.equal($('fullscreenControls').hidden,false);
  assert.equal($('fullscreen').textContent,'退出全屏');
  assert.match($('fullscreenHint').textContent,/Esc 返回游戏上一级/);
  assert.match($('fullscreenHint').textContent,/长按 Esc/);
  await controller.toggle();
  assert.equal(document.fullscreenElement,null);
  assert.deepEqual(calls.slice(-2),[['exit'],['unlock']]);
  assert.equal($('fullscreenControls').hidden,true);
  assert.equal($('fullscreen').textContent,'全屏');
});

test('browser-initiated exit and input disposal both release keyboard lock',async()=>{
  const {controller,document,calls}=fixture();
  await controller.toggle();
  document.fullscreenElement=null;controller.changed();
  assert.deepEqual(calls.at(-1),['unlock']);
  await controller.toggle();controller.dispose();
  assert.deepEqual(calls.at(-1),['unlock']);
  const count=calls.length;await controller.toggle();assert.equal(calls.length,count);
});

test('unsupported and denied keyboard lock keep fullscreen usable with a visible fallback',async()=>{
  for(const options of [{supported:false},{lock:async()=>{throw new Error('NotAllowedError');}}]){
    const {controller,$,document}=fixture(options);
    await controller.toggle();
    assert.equal(document.fullscreenElement,$('screen'));
    assert.equal($('fullscreenControls').hidden,false);
    assert.match($('fullscreenHint').textContent,/F11/);
    assert.doesNotMatch($('fullscreenHint').textContent,/Esc 返回游戏上一级/);
    await controller.toggle();assert.equal(document.fullscreenElement,null);
  }
});

test('failed fullscreen request never captures keyboard or changes the game focus',async()=>{
  const {controller,$,calls}=fixture();
  $('screen').requestFullscreen=async()=>{throw new Error('Fullscreen denied');};
  await assert.rejects(controller.toggle(),/Fullscreen denied/);
  assert.deepEqual(calls,[]);
});

test('a late keyboard grant after exit or disposal cannot restore the fullscreen hint or leave a lock',async()=>{
  for(const dispose of [false,true]){
    let grant;
    const pending=new Promise(resolve=>{grant=resolve;});
    const {controller,$,calls,document}=fixture({lock:()=>pending});
    const entering=controller.toggle();
    await new Promise(resolve=>setImmediate(resolve));
    if(dispose)controller.dispose();else await document.exitFullscreen();
    grant();await entering;
    assert.deepEqual(calls.at(-1),['unlock']);
    assert.doesNotMatch($('fullscreenHint').textContent,/Esc 返回游戏上一级/);
  }
});

test('fullscreen Escape still reaches the existing game cancel handler once and cancels the DOM default',()=>{
  const previousDocument=globalThis.document,previousWindow=globalThis.window;
  const document=new EventTarget(),window=new EventTarget(),nodes=new Map();
  const $=id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);};
  document.fullscreenElement=$('screen');document.activeElement={tagName:'CANVAS'};
  globalThis.document=document;globalThis.window=window;
  try{
    let cancelled=0,closed=0;
    const state={keys:new Set(),engine:{paused:false},scenes:{phase:'menu'},menuContext:{},operationMenu:{escape(){cancelled++;return true;}}};
    const actions={guarded:fn=>fn,menuOperation:fn=>fn,closePartyMenu(){closed++;},releaseInput(){},resize(){}};
    const canvas={addEventListener(){}};
    const controller=createInputController({state,actions,$,canvas});controller.wire();
    for(const repeat of [false,true]){
      const event=new Event('keydown',{cancelable:true});Object.assign(event,{key:'Escape',repeat});
      window.dispatchEvent(event);assert.equal(event.defaultPrevented,true);
    }
    assert.equal(cancelled,1);assert.equal(closed,1);assert.equal(document.fullscreenElement,$('screen'));
    controller.disposeInput();
  }finally{globalThis.document=previousDocument;globalThis.window=previousWindow;}
});
