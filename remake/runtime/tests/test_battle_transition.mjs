import test from 'node:test';
import assert from 'node:assert/strict';
import {BattleTransitionView,battleTransitionFrame} from '../web/battle_transition_view.mjs';
function fixture(){const root={hidden:true,dataset:{}},calls={count:0,last:null},context={clearRect(){},drawImage(...args){calls.count++;calls.last=args;}};
 const view=new BattleTransitionView({loadingView:{root,canvas:{},context,resize(){}},random:()=>.5});return {view,root,calls};}
test('all seven transitions retain native frame counts and delay directions',()=>{
 assert.deepEqual(Array.from({length:7},(_,i)=>battleTransitionFrame(i,0).count),[16,64,16,16,20,30,20]);
 assert.equal(battleTransitionFrame(0,15).delay,0);assert.equal(battleTransitionFrame(3,15).delay,180);assert.equal(battleTransitionFrame(4,0).delay,30);
});
test('pixel/row transitions explicitly reveal the complete battle and clear the overlay',async()=>{
 const original=globalThis.requestAnimationFrame;let now=0;globalThis.requestAnimationFrame=callback=>queueMicrotask(()=>callback(now+=200));
 try{for(const kind of [0,2,3,4,5,6]){const {view,root,calls}=fixture(),before={},after={};await view.run(before,()=>after,{kind});assert.deepEqual(calls.last,[after,0,0]);assert.equal(root.hidden,true);assert.deepEqual(root.dataset,{});}}
 finally{globalThis.requestAnimationFrame=original;}
});
test('a failed first battle draw never opens an overlay; cancelling cannot leave a stale progress state',async()=>{
 const {view,root}=fixture();await assert.rejects(view.run({},()=>{throw Error('draw failed');}),/draw failed/);assert.equal(root.hidden,true);
 const original=globalThis.requestAnimationFrame;globalThis.requestAnimationFrame=callback=>queueMicrotask(()=>callback(100));
 try{const pending=view.run({},()=>({}),{kind:6});view.cancel();await assert.rejects(pending,/取消/);assert.equal(root.hidden,true);assert.deepEqual(root.dataset,{});}
 finally{globalThis.requestAnimationFrame=original;}
});
