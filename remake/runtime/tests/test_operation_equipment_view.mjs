import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPartyActors} from '../web/core/party_attributes.mjs';
import {OperationEquipmentView,operationEquipmentPreview} from '../web/operation_equipment_view.mjs';
const load=name=>JSON.parse(readFileSync(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const manifest=load('operation_menu'),items=load('items'),attributes=load('party_combat');
const world=JSON.parse(JSON.parse(readFileSync(new URL('../evidence/chapter_systems_home_save.json',import.meta.url),'utf8')).payload);

// Only the DOM operations used by the view are needed here. Browser rendering
// and source-pixel comparison are covered by the integrated browser acceptance.
class Node{
  constructor(doc,tag='div'){this.ownerDocument=doc;this.tagName=tag.toUpperCase();this.children=[];this.style={};this.dataset={};this.hidden=false;this.disabled=false;this.attrs={};this.classList={toggle(){}};}
  append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
  appendChild(node){this.append(node);return node;}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  querySelector(selector){const id=selector.slice(1);const find=node=>node.id===id?node:node.children.map(find).find(Boolean);return find(this)??null;}
  setAttribute(key,value){this.attrs[key]=String(value);}
  addEventListener(){}
  focus(){if(this.ownerDocument.activeElement===this)return;this.ownerDocument.activeElement=this;this.onfocus?.();}
  click(){if(!this.disabled)this.onclick?.();}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);}
}
function viewFixture(){
  const doc={createElement(tag){return new Node(this,tag);},activeElement:null};globalThis.document=doc;const root=new Node(doc),section=new Node(doc);section.id='menuEquipmentSection';root.append(section);const callbacks=[];
  const view=new OperationEquipmentView({manifest,root,onSlot:(id,confirm)=>callbacks.push(['slot',id,confirm]),onSelect:id=>callbacks.push(['select',id]),onConfirm:id=>callbacks.push(['confirm',id]),onUnequip:id=>callbacks.push(['unequip',id])});return{view,root,callbacks};
}
const instance=(id,key)=>({id,instance_id:key,name:items.definitions[String(id)].name,quantity:1});

test('native equipment preview reads current resources, minima and visual element order without mutating world',()=>{
  const before=JSON.stringify(world),actor=createPartyActors(world,attributes,{},items)[0],actorBefore=JSON.stringify(actor),preview=operationEquipmentPreview(actor,null,items.definitions['51']);
  assert.deepEqual(preview[0],[{before:285,after:335},{before:0,after:0},{before:50,after:50},{before:0,after:0},{before:0,after:0},{before:0,after:0}]);
  assert.deepEqual(preview[1],[{before:6,after:7},{before:81,after:81},{before:42,after:52},{before:2,after:2}]);
  assert.equal(preview[2][0].before,55);assert.equal(preview[2][0].after,64);
  assert.equal(JSON.stringify(actor),actorBefore);assert.equal(JSON.stringify(world),before);assert.equal(operationEquipmentPreview(actor,null,null),null);
});

test('only five ornament slots accept input; original blank tail commits unequip and retains picker',()=>{
  const{view,callbacks}=viewFixture();view.render({slots:items.slots,rows:[{slot_id:'head',item_id:51}],definitions:items.definitions,candidates:[],slotId:'head',roleId:'001'});
  assert.equal(view.slotButtons.size,6);assert.equal(view.controls().length,5);assert.equal(view.slotButtons.get('weapon').disabled,true);assert.equal(view.openPicker(),true);assert.equal(view.controls().length,1);
  assert.equal(view.selectedId,'');view.key(' ',false);assert.deepEqual(callbacks.filter(row=>row[0]==='unequip'),[['unequip','head']]);assert.equal(view.pickerOpen,true);assert.equal(view.escape(),true);assert.equal(view.pickerOpen,false);assert.equal(view.root.ownerDocument.activeElement,view.slotButtons.get('head'));
});

test('native candidates keep grey ineligible entries focusable, confirm only eligible and scroll eight visible rows',()=>{
  const{view,callbacks}=viewFixture(),candidates=Array.from({length:10},(_,i)=>({...instance(60,'head:'+i),available:i!==0}));view.render({slots:items.slots,rows:[],definitions:items.definitions,candidates,slotId:'head',selectedId:'head:0',roleId:'001'});view.openPicker();
  assert.equal(view.controls().length,8);assert.equal(view.rowButtons[0].dataset.available,'false');view.key(' ',false);assert.equal(callbacks.some(row=>row[0]==='confirm'),false);
  view.key('PageDown');assert.equal(view.selectedId,'head:7');assert.equal(view.offset,0);view.key(' ',true);assert.equal(callbacks.some(row=>row[0]==='confirm'),false);view.key(' ',false);assert.deepEqual(callbacks.filter(row=>row[0]==='confirm'),[['confirm','head:7']]);assert.equal(view.pickerOpen,true);
  view.key('ArrowRight');assert.equal(view.detailsIndex,1);view.key('ArrowLeft');assert.equal(view.detailsIndex,0);view.key('ArrowDown');view.key('ArrowDown');view.key('ArrowDown');assert.equal(view.selectedId,'');view.key(' ',false);assert.equal(callbacks.some(row=>row[0]==='unequip'),false);
});

test('actor refresh keeps same-slot DOM focus and source highlight without requiring another focus event',()=>{
  const{view}=viewFixture(),data={slots:items.slots,rows:[],definitions:items.definitions,candidates:[],slotId:'ring',roleId:'001'};view.render(data);const button=view.slotButtons.get('ring');button.focus();assert.equal(button.attrs['aria-pressed'],'true');view.render({...data,roleId:'002'});assert.equal(view.slotButtons.get('ring'),button);button.focus();assert.equal(view.slotFocused,true);assert.equal(button.attrs['aria-pressed'],'true');assert.equal(button._icon.hidden,false);
});

test('picker Page keys first reach edges, preserve eight-row tail windows, and pointer arrows scroll a whole window',()=>{
  const{view}=viewFixture(),candidates=Array.from({length:20},(_,i)=>instance(60,'head:'+i));view.render({slots:items.slots,rows:[],definitions:items.definitions,candidates,slotId:'head',roleId:'001'});view.openPicker();view.key('PageDown');assert.deepEqual([view.selectedIndex,view.offset],[7,0]);view.key('PageDown');assert.deepEqual([view.selectedIndex,view.offset],[15,8]);view.key('PageDown');assert.deepEqual([view.selectedIndex,view.offset],[20,13]);assert.equal(view.controls().length,8);view.key('PageUp');assert.deepEqual([view.selectedIndex,view.offset],[13,13]);view.key('PageUp');assert.deepEqual([view.selectedIndex,view.offset],[5,5]);view.key('PageUp');assert.deepEqual([view.selectedIndex,view.offset],[0,0]);view.scrollButtons[1].click();assert.deepEqual([view.selectedIndex,view.offset],[8,8]);
});

test('mouse focus still selects original active icon for a grey equipment candidate and cannot commit it',()=>{
  const{view,callbacks}=viewFixture(),candidates=[{...instance(60,'grey'),available:false},instance(60,'allowed')];view.render({slots:items.slots,rows:[],definitions:items.definitions,candidates,slotId:'head',roleId:'001'});view.openPicker();view.key('ArrowDown');const grey=view.candidateButtons.get('grey');assert.equal(grey._icon.src,'assets/menu/item_row_icons/frame_005.png');grey.click();assert.equal(grey._icon.src,'assets/menu/item_row_icons/frame_100.png');assert.equal(grey._name.style.color,'#505050');assert.equal(callbacks.some(row=>row[0]==='confirm'),false);
});
