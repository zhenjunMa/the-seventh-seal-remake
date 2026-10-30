import test from 'node:test';
import assert from 'node:assert/strict';
import {BattleTransitionView,battleTransitionFrame} from '../web/battle_transition_view.mjs';
test('all seven transitions retain native frame counts and delay directions',()=>{
 assert.deepEqual(Array.from({length:7},(_,i)=>battleTransitionFrame(i,0).count),[16,64,16,16,20,30,20]);
 assert.equal(battleTransitionFrame(0,15).delay,0);assert.equal(battleTransitionFrame(3,15).delay,180);assert.equal(battleTransitionFrame(4,0).delay,30);
});
test('the view passes GPU snapshots, source kind, owning clock and cancellation to the renderer without scene readback',async()=>{
 const before={gpuTexture:true},after={gpuTexture:true},clock={},random=()=>.5,signal=new AbortController().signal,calls=[];
 const renderer={capture:image=>image,async run(image,paint,options){calls.push({image,after:paint(),options});},cancel(){calls.push('cancel');}};
 const view=new BattleTransitionView({renderer,clock,random});assert.equal(view.capture(before),before);
 for(let kind=0;kind<7;kind++)await view.run(before,()=>after,{kind,signal});view.cancel();
 assert.equal(calls.length,8);assert.equal(calls.at(-1),'cancel');
 calls.slice(0,7).forEach((call,kind)=>{assert.equal(call.image,before);assert.equal(call.after,after);assert.deepEqual(call.options,{kind,signal,random,clock,log:undefined});});
});
test('missing WebGL and rendering failures remain visible; invalid source kinds cannot start a transition',async()=>{
 await assert.rejects(new BattleTransitionView({}).run({},()=>({})),/WebGL/);
 const failure=new Error('GPU render failed'),view=new BattleTransitionView({renderer:{run(){throw failure;}}});
 await assert.rejects(view.run({},()=>({}),{kind:1}),error=>error===failure);
 await assert.rejects(view.run({},()=>({}),{kind:7}),/类型无效/);
});
