import test from 'node:test';
import assert from 'node:assert/strict';
import {OperationSystemView} from '../web/operation_system_view.mjs';

function keyboard(){
  const view=Object.create(OperationSystemView.prototype),changes=[],confirmed=[];
  view.index=0;view.channels=['master','music','effects'];
  view.state={battleCursor:'memory',channels:Object.fromEntries(view.channels.map(k=>[k,{volume:1,muted:false}]))};
  view.rows=Array.from({length:4},(_,index)=>({focus(){view.index=index;},click(){confirmed.push(index);}}));
  view.onSetting=(kind,channel,value)=>{changes.push({kind,channel,value});if(kind==='cursor')view.state.battleCursor=value;else view.state.channels[channel][kind]=value;};
  return {view,changes,confirmed};
}

test('native cursor row uses arrows, confirmation preserves the preference, and row navigation wraps',()=>{
  const {view,changes,confirmed}=keyboard();
  view.key('ArrowUp');assert.equal(view.index,3);
  for(const key of [' ','Enter'])assert.equal(view.key(key,false),true);
  assert.deepEqual(changes,[]);assert.deepEqual(confirmed,[]);assert.equal(view.state.battleCursor,'memory');
  view.key('ArrowLeft');assert.equal(view.state.battleCursor,'initial');
  view.key('ArrowRight');assert.equal(view.state.battleCursor,'memory');
  view.key('ArrowDown');assert.equal(view.index,0);view.key(' ',true);view.key(' ',false);
  assert.deepEqual(confirmed,[0]);
});

test('native volume arrows move four ticks and clamp at both boundaries',()=>{
  const {view}=keyboard();view.key('ArrowRight');assert.equal(view.state.channels.master.volume,1);
  view.key('ArrowLeft');assert.equal(view.state.channels.master.volume,60/64);
  for(let n=0;n<17;n++)view.key('ArrowLeft');assert.equal(view.state.channels.master.volume,0);
  view.key('ArrowRight');assert.equal(view.state.channels.master.volume,4/64);
});
