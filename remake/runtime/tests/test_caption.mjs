import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {CaptionPlayback,captionLayout} from '../web/core/caption.mjs';
const {createStoryController}=await import('../web/controllers/story.mjs');

test('style3 centers text in its shade and leaves room for the continuation marker',async()=>{
  const fonts=JSON.parse(await fs.readFile(new URL('../web/data/prologue_fonts.json',import.meta.url),'utf8'));
  const layout=captionLayout('一万八千年后………………',19,{font:fonts.fonts.caption19});
  assert.deepEqual(layout.text,{x:195,y:230});
  assert.deepEqual(layout.shade,{x:159,y:222,width:322,height:35});
  assert.equal(layout.text.x+1+248/2,layout.shade.x+layout.shade.width/2);
  assert.equal(layout.text.y+19/2,layout.shade.y+layout.shade.height/2);
  assert.equal(layout.wait.x,446);
  assert.ok(layout.wait.x+31<layout.shade.x+layout.shade.width);
});

test('caption advances at120ms; early confirmation completes text and next closes once',()=>{
  const caption=new CaptionPlayback('时候、时候终于到了。',100);
  assert.equal(caption.tick(100),'时');
  assert.equal(caption.tick(339),'时候');
  assert.equal(caption.advance(),false);assert.equal(caption.complete,true);
  assert.equal(caption.tick(340),'时候、时候终于到了。');
  assert.equal(caption.advance(),true);assert.equal(caption.advance(),false);
});

test('ritual actors await appearance commands and keep source poses; chapter defaults remain available',async()=>{
  const {OpeningView}=await import('../web/opening_view.mjs');
  const map=JSON.parse(await fs.readFile(new URL('../web/data/maps/m72061.json',import.meta.url),'utf8'));
  const manifest=JSON.parse(await fs.readFile(new URL('../web/data/prologue_presentation.json',import.meta.url),'utf8'));
  const role={actions:[{index:0,first_frame:0,frame_count:5,directions:8}]};
  const view=new OpeningView({resources:{roles:{'013':role,'001':role}},prepared:new Map([['M72061',{data:map}]]),
    staging:manifest.staging,install(){},camera(){},log(){}});
  await view.hooks().map({mapId:'M72061'});
  assert.deepEqual(map.opening_npcs.map(n=>n.direction),[0,0,0,0,0]);
  assert.deepEqual(map.opening_npcs.map(n=>view.getActor(n.slot_zero_based).direction),[0,0,0,0,0]);
  assert.deepEqual(map.opening_npcs.map(n=>view.getActor(n.slot_zero_based).visible),[false,false,false,false,false]);
  const actor=view.getActor(14),before={x:actor.x,y:actor.y,direction:actor.direction};
  await view.hooks().actor({kind:'hide',actor:14,x:482,y:762,poseRaw:20});
  assert.deepEqual({x:actor.x,y:actor.y,direction:actor.direction},before);assert.equal(actor.visible,false);
  await view.hooks().actor({kind:'place',actor:14,x:482,y:762,poseRaw:10});
  assert.equal(actor.direction,1);assert.equal(actor.frame,4);
  assert.equal(actor.visible,false);
  const normal=new OpeningView({resources:{roles:{'013':role,'001':role}},prepared:new Map([['M72061',{data:map}]]),install(){},camera(){},log(){}});
  await normal.hooks().map({mapId:'M72061'});assert.equal(normal.getActor(10).direction,0);
});

test('standalone caption owns confirmation and abort; next ordinary dialogue has no caption',async()=>{
  const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{hidden:true,focus(){},textContent:''});return elements.get(id);};
  const state={dialogueView:{active:false,show({speaker,text}){this.active=true;$('dialogue').hidden=false;$('speaker').textContent=speaker;$('dialogueText').textContent=text;},advance(){return true;},close(){this.active=false;}},captionView:{active:false,show(text){this.active=true;this.text=text;this.ready=false;},
    advance(){if(!this.ready){this.ready=true;return false;}this.active=false;return true;},close(){this.active=false;}}};
  const story=createStoryController({state,$,actions:{},canvas:{}});
  let settled=false;const promise=story.say('','字幕',3).then(()=>settled=true);
  assert.equal($('dialogue').hidden,true);assert.equal(state.captionView.active,true);
  story.advanceDialogue();await Promise.resolve();assert.equal(settled,false);
  story.advanceDialogue();await promise;assert.equal(settled,true);assert.equal(state.captionView.active,false);
  const regular=story.say('英格妮','普通对白',1);assert.equal($('dialogue').hidden,false);
  assert.equal(state.captionView.active,false);assert.equal($('speaker').textContent,'英格妮');
  story.advanceDialogue();await regular;
  const abort=new AbortController();const cancelled=story.say('','取消的字幕',3,{signal:abort.signal});
  abort.abort(new Error('演出失败'));await assert.rejects(cancelled,/演出失败/);
  assert.equal(state.captionView.active,false);assert.equal(state.dialogueResolve,null);
});
