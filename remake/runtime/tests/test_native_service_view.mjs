import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeServiceView} from '../web/native_service_view.mjs';
import {NativeStatueView,nativeStatueState,moveStatueSlot,rotateStatue,releaseStatueRotation,tickStatue,statueControlAt} from '../web/native_statue_view.mjs';

function service(){
  const view=Object.create(NativeServiceView.prototype),events=[];
  view.root={hidden:false};view.index=0;view.quantity=1;view.isSuspended=()=>false;
  view.state={mode:'buy',allowedModes:['buy','sell'],selected:'a',rows:[{id:'a',name:'a',enabled:true},{id:'b',name:'b',enabled:false}]};
  view.onAction=event=>{events.push(event);if(event.type==='select'){view.state.selected=event.id;view.index=view.state.rows.findIndex(row=>row.id===event.id);}if(event.type==='quantity')view.quantity=event.quantity;};
  view.onClose=()=>events.push({type:'close'});view.paint=()=>{};
  return {view,events};
}

test('buy confirmation requires two presses, cancellation spends nothing and repeats never confirm',()=>{
  const {view,events}=service();view.key('Enter',true);assert.equal(view.confirming,undefined);
  view.key('Enter');assert.equal(view.confirming,true);assert.deepEqual(events,[]);
  view.key('ArrowRight');assert.equal(view.quantity,2);
  view.key('Escape');assert.equal(view.confirming,false);assert.deepEqual(events,[{type:'quantity',quantity:2}]);
  view.key('Enter');view.key('Enter');assert.deepEqual(events.at(-1),{type:'confirm',id:'a',quantity:2});
});

test('disabled products can show details while refusing a transaction and mode navigation uses allowed modes',()=>{
  const {view,events}=service();view.key('ArrowDown');assert.deepEqual(events.at(-1),{type:'select',id:'b'});
  view.key('Enter');assert.equal(view.confirming,undefined);
  view.key('ArrowRight');assert.deepEqual(events.at(-1),{type:'mode',mode:'sell'});
  view.key('Escape');assert.equal(view.active,false);assert.deepEqual(events.at(-1),{type:'close'});
});

test('suspended service input cannot select, confirm, change quantity or close',()=>{
  const {view,events}=service();view.isSuspended=()=>true;
  for(const key of ['Enter','Escape','ArrowDown','ArrowRight'])assert.equal(view.key(key),false);
  assert.deepEqual(events,[]);assert.equal(view.active,true);
});

test('the native all-recipes category is a read-only list',()=>{
  const {view,events}=service();view.state.mode='synthesize';view.state.category='all';
  view.key('Enter');view.confirm();assert.equal(view.confirming,undefined);assert.deepEqual(events,[]);
});

test('native WordDisc keeps its prefills, white-point cursor and render-count animation',()=>{
  const state=nativeStatueState();assert.deepEqual(state.symbols,[15,24,-1,-1,-1,13]);assert.equal(state.selected,1);
  moveStatueSlot(state,1);assert.deepEqual(state.symbols,[15,-1,24,-1,-1,13]);
  moveStatueSlot(state,-1);assert.deepEqual(state.symbols,[15,24,-1,-1,-1,13]);
  for(let i=0;i<51;i++)tickStatue(state,16);
  assert.equal(state.blink,false);assert.equal(state.clueX,-90);
  for(let i=0;i<10;i++)tickStatue(state,16);assert.equal(state.clueX,10);
  rotateStatue(state,1);for(let i=0;i<10;i++)tickStatue(state,16);releaseStatueRotation(state);
  assert.equal(state.target,3);assert.equal(Math.trunc(state.frame),3);
  const reverse=nativeStatueState();rotateStatue(reverse,-1);assert.equal(reverse.target,71);
  tickStatue(reverse,16);releaseStatueRotation(reverse);assert.equal(reverse.target,69);
});

test('native WordDisc hides the clue with Escape, gates main buttons and checks on insertion without an OK button',()=>{
  const events=[],view=Object.create(NativeStatueView.prototype),state=nativeStatueState();
  Object.assign(view,{state,disposed:false,pending:false,isSuspended:()=>false,paint:()=>{},paintPointer:()=>{},
    pointer:[508,386],onSound:()=>{},onSubmit:result=>events.push(result),onClose:()=>events.push('exit')});
  view.activateAt(500,215);assert.deepEqual(events,[]);
  view.key('Escape');assert.equal(state.clueVisible,false);assert.deepEqual(events,[]);
  assert.equal(statueControlAt(482,215),-1);assert.equal(statueControlAt(500,215),0);
  view.activateAt(410,90);assert.equal(state.selected,1); // no slot hit test
  state.symbols=[15,0,10,21,24,13];state.selected=4;state.target=3;
  view.activateAt(508,386);view.activateAt(508,386);
  assert.equal(events.length,1);assert.deepEqual(events[0].symbols,[15,0,10,21,1,13]);assert.equal(view.pending,true);
  events[0].symbols[0]=0;assert.equal(state.symbols[0],15);
  view.resume();view.activateAt(500,215);assert.equal(events.at(-1),'exit');
});
