import test from 'node:test';
import assert from 'node:assert/strict';
import {createMenuFeedback} from '../web/core/menu_feedback.mjs';

function fixture(){
  let state='main';const cues=[],queue=[];
  const feedback=createMenuFeedback({playCue:(name,key)=>cues.push({name,key}),getState:()=>state,schedule:fn=>queue.push(fn)});
  feedback.activate();return {feedback,cues,set:value=>state=value,flush(){while(queue.length)queue.shift()();}};
}
class Root{
  constructor(){this.listeners=[];}
  addEventListener(name,fn,capture){this.listeners.push({name,fn,capture});}
  removeEventListener(name,fn,capture){this.listeners=this.listeners.filter(r=>r.name!==name||r.fn!==fn||r.capture!==capture);}
  event(name,button,action=()=>{}){const event={target:{closest:()=>button}};for(const r of this.listeners)if(r.name===name&&r.capture)r.fn(event);action();for(const r of this.listeners)if(r.name===name&&!r.capture)r.fn(event);}
}
const button=props=>({className:'',dataset:{},disabled:false,...props});

test('changed keyboard selection sounds once; clamped edges and automatic repaint do not sound',()=>{
  const f=fixture();f.feedback.run('select',()=>{f.set('item1');return true;});f.flush();assert.deepEqual(f.cues.map(r=>r.name),['menuSelect']);
  f.feedback.run('select',()=>true);f.flush();assert.equal(f.cues.length,1);f.set('repaint');f.flush();assert.equal(f.cues.length,1);
  f.feedback.run('ignore',()=>true);f.feedback.run('select',()=>false);f.flush();assert.equal(f.cues.length,1);
});
test('keyboard confirmation owns its synthetic click and suppresses held confirmation and Escape',()=>{
  const f=fixture(),root=new Root();f.feedback.attach(root);const target=button();
  f.feedback.run('confirm',()=>{root.event('click',target,()=>f.set('content'));return true;});f.flush();assert.deepEqual(f.cues.map(r=>r.name),['menuConfirm']);
  f.feedback.run('confirm',()=>true,{repeat:true});f.feedback.run('cancel',()=>true,{repeat:true});f.flush();assert.equal(f.cues.length,1);
  f.feedback.run('cancel',()=>true);f.flush();assert.equal(f.cues.at(-1).name,'menuCancel');assert.equal(new Set(f.cues.map(r=>r.key)).size,2);
});
test('a pointer focus and its click coalesce, while scroll controls use selection and unavailable candidates reject',()=>{
  const f=fixture(),root=new Root(),target=button();const detach=f.feedback.attach(root);
  root.event('pointerdown',target,()=>f.set('focus'));root.event('pointerup',target);root.event('click',target,()=>f.set('picker'));f.flush();assert.deepEqual(f.cues.map(r=>r.name),['menuConfirm']);
  const scroll=button({className:'equipment-source-scroll'});root.event('pointerdown',scroll);root.event('click',scroll,()=>f.set('next-page'));f.flush();assert.equal(f.cues.at(-1).name,'menuSelect');
  const filter=button({className:'item-filter'});root.event('pointerdown',filter);root.event('click',filter,()=>f.set('materials'));f.flush();assert.equal(f.cues.at(-1).name,'menuSelect');
  const invalid=button({dataset:{available:'false'}});root.event('pointerdown',invalid,()=>f.set('gray-row'));root.event('click',invalid);f.flush();assert.equal(f.cues.at(-1).name,'menuError');
  detach();assert.equal(root.listeners.length,0);
});
test('disabled pointer targets and unchanged invalid confirmation emit only the error cue',()=>{
  const f=fixture(),root=new Root();f.feedback.attach(root);root.event('pointerdown',button({disabled:true}));root.event('pointerup',button({disabled:true}));f.flush();
  assert.deepEqual(f.cues.map(r=>r.name),['menuError']);f.feedback.run('confirm',()=>true);f.flush();assert.equal(f.cues.at(-1).name,'menuError');
});
test('async commit waits for its result, sounds one confirmation and preserves later gesture ownership',async()=>{
  const f=fixture();let resolve;const pending=new Promise(r=>resolve=r);let transaction;
  f.feedback.run('confirm',()=>{transaction=f.feedback.transaction(()=>pending);return true;});f.flush();assert.equal(f.cues.length,0);
  f.feedback.run('select',()=>{f.set('another-row');return true;});f.flush();resolve('saved');assert.equal(await transaction,'saved');f.flush();
  assert.deepEqual(f.cues.map(r=>r.name),['menuSelect','menuConfirm']);assert.equal(new Set(f.cues.map(r=>r.key)).size,2);
});
test('sync and async rejected transactions suppress the success cue, including duplicate UI error reporting',async()=>{
  const f=fixture();let transaction;
  f.feedback.run('confirm',()=>{transaction=f.feedback.transaction(()=>Promise.reject(new Error('no MP')));return true;});
  await assert.rejects(transaction,/no MP/);f.feedback.reject();f.flush();f.feedback.reject();f.flush();assert.deepEqual(f.cues.map(r=>r.name),['menuError']);
  assert.throws(()=>f.feedback.run('confirm',()=>f.feedback.transaction(()=>{throw new Error('invalid crystal');})),/invalid crystal/);f.flush();assert.equal(f.cues.length,2);assert.equal(f.cues.at(-1).name,'menuError');
});
test('closing during Escape or a successful transaction does not duplicate cancellation, direct closure still sounds',()=>{
  const f=fixture();f.feedback.run('cancel',()=>{f.feedback.closing();return true;});f.flush();assert.deepEqual(f.cues.map(r=>r.name),['menuCancel']);
  f.feedback.activate();f.feedback.run('confirm',()=>{f.feedback.transaction(()=>{f.feedback.closing();return 'used';});return true;});f.flush();assert.equal(f.cues.at(-1).name,'menuConfirm');
  f.feedback.activate();f.feedback.closing();assert.equal(f.cues.at(-1).name,'menuCancel');
});
