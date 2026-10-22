import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){
  if(specifier==='/prototype/movement.mjs')return {url:new URL('../../prototype/web/movement.mjs',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {createStoryController}=await import('../web/controllers/story.mjs');
const {dialoguePages,DialoguePlayback}=await import('../web/core/dialogue.mjs');

test('ordinary dialogue scrolls one row; thought pages clear; width uses ink cell before extra spacing',()=>{
  const profile={width:350,height:60,fontHeight:17,lineHeight:21};
  const ordinary=dialoguePages('字'.repeat(80),{...profile,scroll:true});
  assert.equal(ordinary.length,3);assert.equal(ordinary[0].runs.length,54);
  assert.deepEqual(ordinary[0].pen,{x:342,y:42});
  assert.equal(ordinary[1].carriedRuns.length,36);assert.equal(ordinary[1].runs.length,18);
  assert.ok(ordinary[1].runs.every(run=>run.y===42));
  const thought=dialoguePages('字'.repeat(26),{width:130,height:54,fontHeight:13,lineHeight:15});
  assert.equal(thought[0].runs.length,24);assert.equal(thought[1].carriedRuns.length,0);
  assert.deepEqual(thought[1].runs.map(({x,y})=>({x,y})),[{x:0,y:0},{x:15,y:0}]);
  const latin=dialoguePages('12 34中',{...profile,measureLatin:word=>word.length*8});
  assert.deepEqual(latin[0].runs.map(run=>run.text),['12','34','中']);
  assert.deepEqual(latin[0].runs.map(run=>run.x),[0,26,52]);
});

test('slow frames retain every token; one confirmation fills, scrolls, selects or exits separately',()=>{
  const pages=dialoguePages('字'.repeat(60),{width:350,height:60,fontHeight:17,lineHeight:21,scroll:true});
  const playback=new DialoguePlayback(pages,{now:100,choices:[{index:3,text:'休息。'},{index:7,text:'不用。'}]});
  assert.equal(playback.tick(100).length,1);assert.equal(playback.tick(1000).length,8);
  assert.equal(playback.advance(1000).kind,'reveal');assert.equal(playback.complete,true);
  assert.equal(playback.advance(1000).kind,'page');assert.equal(playback.page,1);
  assert.equal(playback.tick(1e6).length,6);assert.equal(playback.stage,'choices');
  assert.equal(playback.move(-1),false);assert.equal(playback.move(1),true);assert.equal(playback.move(1),false);
  assert.deepEqual(playback.advance(1e6),{kind:'choice',index:7});
});

test('finishing a question reveals choices automatically; the fill input cannot select a branch',()=>{
  const pages=dialoguePages('需要休息一下吗？',{width:350,height:60,fontHeight:17,lineHeight:21});
  const choices=[{index:0,text:'休息。'},{index:1,text:'不用。'}];
  const natural=new DialoguePlayback(pages,{choices});natural.tick(2000);assert.equal(natural.stage,'choices');
  const fast=new DialoguePlayback(pages,{choices});fast.tick(0);
  assert.deepEqual(fast.advance(10),{kind:'reveal'});fast.tick(10);assert.equal(fast.stage,'choices');
  assert.deepEqual(fast.advance(20),{kind:'choice',index:0});
});

function fixture(){
  const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{hidden:true});return elements.get(id);};
  const view={active:false,ready:false,show(options){this.active=true;this.ready=false;this.options=options;},
    close(){this.active=false;},advance(){if(!this.ready){this.ready=true;return false;}return !this.options.choices;},key(){}};
  const state={keys:new Set(['ArrowUp']),dialogueView:view,captionView:{close(){}},chapterResources:{npcs_by_map:{}}};
  const actions=createStoryController({state,$,actions:{},canvas:{}});
  return {state,view,actions,$};
}

test('held confirmation cannot consume two lines or leak a synthesized button click',async()=>{
  const {state,view,actions}=fixture();let settled=0;
  const first=actions.say('英格妮','第一段',1).then(()=>settled++);
  assert.equal(state.keys.size,0);
  actions.dialogueKey(' ');assert.equal(view.ready,true);
  actions.dialogueKey(' ',true);actions.dialogueKey(' ');await Promise.resolve();assert.equal(settled,0);
  assert.equal(actions.dialogueKeyUp(' '),true);
  actions.dialogueKey(' ');await first;assert.equal(settled,1);
  const second=actions.say('凯','第二段',1);
  actions.dialogueKey(' ',true);assert.equal(view.ready,false);
  assert.equal(actions.dialogueKeyUp(' '),true);
  actions.dialogueKey('Enter');actions.dialogueKeyUp('Enter');
  actions.dialogueKey('Enter');actions.dialogueKeyUp('Enter');await second;
  assert.equal(state.dialogueResolve,null);assert.equal(view.active,false);
});

test('aborted and replaced dialogue sessions cannot close a later session',async()=>{
  const {state,view,actions}=fixture(),abort=new AbortController();
  const first=actions.say('','先前',1,{signal:abort.signal});const rejected=assert.rejects(first,{name:'AbortError'});
  const oldAdvance=state.dialogueResolve;
  const second=actions.say('','当前',1);await rejected;
  oldAdvance();abort.abort();assert.equal(view.active,true);
  actions.advanceDialogue();actions.advanceDialogue();await second;
  const third=actions.say('','清理',1);const cancelled=assert.rejects(third,{name:'AbortError'});
  actions.clearDialogue();await cancelled;
  assert.equal(state.choicePending,false);assert.equal(state.dialogueResolve,null);
});

test('choice resolution validates stable index and session, and commits only once',async()=>{
  const {state,view,actions}=fixture(),choices=[{index:0,text:'休息。'},{index:1,text:'不用。'}];
  const first=actions.chooseChapter({mapId:'M17026',record:{speaker:1,text_raw:'需要休息一下吗？',style:1},choices});
  const firstId=view.options.sessionId;actions.chooseDialogue(50,firstId);assert.equal(state.choicePending,true);
  actions.chooseDialogue(1,firstId);actions.chooseDialogue(0,firstId);assert.equal(await first,1);
  const second=actions.chooseChapter({mapId:'M17026',record:{speaker:1,text_raw:'需要休息一下吗？',style:1},choices});
  actions.chooseDialogue(0,firstId);assert.equal(state.choicePending,true);
  actions.chooseDialogue(0,view.options.sessionId);assert.equal(await second,0);
  assert.equal(state.choicePending,false);assert.equal(view.active,false);
});
