import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SaveMenuView} from '../web/save_menu_view.mjs';
import {MANUAL_SAVE_SLOTS} from '../web/core/save_slots.mjs';

const manifest=JSON.parse(readFileSync(new URL('../web/data/save_menu.json',import.meta.url)));
const emptyEntries=()=>[...MANUAL_SAVE_SLOTS,'quick'].map(slot=>({slot,envelope:null,error:null}));
const envelope=(slot='00')=>({sha256:`saved-${slot}`,saved_at:'2026-10-23T00:00:00Z',payload:JSON.stringify({party:[{name:'英格妮'}],location:{map_id:'M70010'}})});
const deferred=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve:()=>resolve()};};

async function setup({onConfirm=async()=>{},getPreview}={}){
  const draws=[],logs=[],styles=new Map(),listeners=new Map();
  const buttons={children:[],replaceChildren(){this.children=[];},append(button){this.children.push(button);}};
  const message={textContent:''};
  const ctx={clearRect(){},drawImage:(...args)=>draws.push(args),fillText(){}};
  const root={hidden:true,dataset:{},style:{setProperty:(name,value)=>styles.set(name,value)},querySelector:selector=>selector==='canvas'?{getContext:()=>ctx}:selector==='.save-menu-buttons'?buttons:message,
    getBoundingClientRect:()=>({width:960,height:720}),focus(){this.focused=true;},addEventListener:(name,handler)=>listeners.set(name,handler)};
  globalThis.ResizeObserver=class{observe(){}};
  globalThis.document={createElement:()=>({style:{},dataset:{},attributes:{},setAttribute(name,value){this.attributes[name]=value;}})};
  let closes=0;
  const view=await SaveMenuView.create({manifest,root,image:async path=>({path}),getPreview,onConfirm,onClose(){closes++;view.hide();},log:event=>logs.push(event)});
  return {view,root,buttons,message,draws,logs,styles,listeners,get closes(){return closes;}};
}
const slotButtons=buttons=>buttons.children.filter(button=>button.className==='save-slot');
const button=(buttons,label)=>buttons.children.find(button=>button.attributes['aria-label']===label);

test('opening the source save page writes nothing and saving empty slot 01 submits exactly that row',async()=>{
  const writes=[],entries=emptyEntries(),{view,root,buttons,styles}=await setup({onConfirm:row=>writes.push(row)});
  view.show({mode:'save',summary:{name:'英格妮',money:120}});
  assert.equal(root.hidden,false);assert.equal(root.focused,true);assert.equal(styles.get('--save-menu-scale'),'1.5');assert.deepEqual(writes,[]);
  assert.equal(view.loading,true);await view.confirm();assert.deepEqual(writes,[]);
  view.setEntries(entries);assert.equal(slotButtons(buttons).length,3);
  view.select(1);await view.confirm();
  assert.deepEqual(writes,[entries[1]]);assert.equal(root.dataset.slot,'01');assert.equal(view.active,true);assert.equal(view.pending,false);
});

test('occupied slot 00 requires overwrite confirmation, cancellation writes nothing and acceptance submits once',async()=>{
  const writes=[],entries=emptyEntries();entries[0].envelope=envelope();
  const {view,root,buttons}=await setup({onConfirm:row=>writes.push(row)});view.show();view.setEntries(entries);
  await view.confirm();assert.equal(view.confirming,true);assert.equal(root.dataset.state,'overwrite');assert.deepEqual(writes,[]);
  button(buttons,'取消覆盖存档').onclick();assert.equal(view.confirming,false);assert.equal(root.dataset.state,'list');assert.deepEqual(writes,[]);
  await view.confirm();assert.equal(view.confirming,true);await view.submit();
  assert.deepEqual(writes,[entries[0]]);assert.equal(writes[0].envelope,entries[0].envelope);assert.equal(view.pending,false);
});

test('overwrite keyboard selection can choose cancel with Down and Enter without writing',async()=>{
  const writes=[],entries=emptyEntries();entries[0].envelope=envelope();const {view}=await setup({onConfirm:row=>writes.push(row)});
  view.show();view.setEntries(entries);await view.confirm();view.key('ArrowDown');view.key('Enter');
  assert.equal(view.confirming,false);assert.equal(view.active,true);assert.deepEqual(writes,[]);
});

test('pending writes ignore repeated confirm, submit, keys, stale buttons and close attempts',async()=>{
  const gate=deferred(),writes=[];const {view,buttons}=await setup({onConfirm:async row=>{writes.push(row);await gate.promise;}});
  view.show();view.setEntries(emptyEntries());
  const staleSave=button(buttons,'保存所选栏位');const pending=view.confirm();
  assert.equal(view.pending,true);assert.equal(writes.length,1);
  await view.confirm();await view.submit();view.key('Enter');view.key('Enter',true);view.key('ArrowDown');view.key('Escape');staleSave.onclick();
  assert.equal(writes.length,1);assert.equal(view.selected,0);assert.equal(view.active,true);assert.ok(buttons.children.every(button=>button.disabled));
  gate.resolve();await pending;assert.equal(view.pending,false);assert.equal(view.active,true);
});

test('a failed write leaves the same page and selection available for retry with the error visible',async()=>{
  let writes=0;const {view,root,message,logs}=await setup({onConfirm:async()=>{writes++;throw new Error('磁盘空间不足');}});
  view.show();view.setEntries(emptyEntries());view.select(2);await view.confirm();
  assert.equal(writes,1);assert.equal(view.active,true);assert.equal(root.hidden,false);assert.equal(view.pending,false);assert.equal(view.selected,2);assert.match(message.textContent,/磁盘空间不足/);
  assert.deepEqual(logs,[{type:'save-menu-failed',slot:'02',error:'磁盘空间不足'}]);await view.confirm();assert.equal(writes,2);
});

test('End reaches slot 19 in the three native row rectangles and navigation never exposes a quick-save row',async()=>{
  const {view,buttons}=await setup();view.show();view.setEntries(emptyEntries());view.key('End');
  assert.equal(view.selected,19);assert.equal(view.top,17);assert.deepEqual(slotButtons(buttons).map(row=>row.dataset.slot),['17','18','19']);
  assert.deepEqual(slotButtons(buttons).map(row=>[row.style.left,row.style.top,row.style.width,row.style.height]),[['12px','68px','456px','100px'],['12px','173px','456px','100px'],['12px','278px','456px','100px']]);
  assert.equal(slotButtons(buttons)[2].attributes['aria-current'],'true');view.key('ArrowDown');assert.equal(view.selected,19);
  view.key('Home');assert.equal(view.selected,0);assert.equal(view.top,0);view.key('PageDown');assert.equal(view.selected,3);assert.equal(view.top,1);view.key('PageUp');assert.equal(view.selected,0);assert.equal(view.top,0);
});

test('load ignores empty or damaged slots, loads an occupied slot directly and Esc closes without reading',async()=>{
  const loads=[],entries=emptyEntries();entries[1].envelope=envelope('01');entries[2].error='存档文件损坏';
  const context=await setup({onConfirm:row=>loads.push(row)}),{view,message}=context;
  view.show({mode:'load'});view.setEntries(entries);await view.confirm();assert.deepEqual(loads,[]);assert.match(message.textContent,/栏位 00 为空/);
  view.select(2);await view.confirm();assert.deepEqual(loads,[]);assert.match(message.textContent,/栏位 02 无法读取/);
  view.select(1);await view.confirm();assert.deepEqual(loads,[entries[1]]);assert.equal(view.confirming,false);
  view.key('Escape');assert.equal(context.closes,1);assert.equal(view.active,false);assert.equal(context.root.hidden,true);assert.equal(loads.length,1);
});

test('Escape cancels overwrite first and then closes, while loading and held confirmation cannot submit',async()=>{
  const writes=[],entries=emptyEntries();entries[0].envelope=envelope();const context=await setup({onConfirm:row=>writes.push(row)}),{view}=context;
  view.show();view.key('Enter');view.key('Escape');assert.equal(view.active,true);assert.deepEqual(writes,[]);
  view.setEntries(entries);view.key('Enter',true);assert.equal(view.confirming,false);await view.confirm();view.key('Escape');assert.equal(view.confirming,false);assert.equal(context.closes,0);
  view.key('Escape',true);assert.equal(context.closes,0);view.key('Escape');assert.equal(context.closes,1);assert.deepEqual(writes,[]);
});
