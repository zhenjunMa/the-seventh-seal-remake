import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeServiceView} from '../web/native_service_view.mjs';

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
