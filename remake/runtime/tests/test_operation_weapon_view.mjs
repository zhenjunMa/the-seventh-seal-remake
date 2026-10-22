import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {OperationWeaponView} from '../web/operation_weapon_view.mjs';
import {createPartyActors} from '../web/core/party_attributes.mjs';
import {operationWeaponDetails} from '../web/core/operation_menu.mjs';
const load=name=>JSON.parse(readFileSync(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const manifest=load('operation_menu'),items=load('items'),attributes=load('party_combat');
const world=JSON.parse(JSON.parse(readFileSync(new URL('../evidence/chapter_systems_home_save.json',import.meta.url),'utf8')).payload);
class Node{
  constructor(doc,tag='div'){this.ownerDocument=doc;this.tagName=tag.toUpperCase();this.children=[];this.style={};this.dataset={};this.hidden=false;this.disabled=false;this.attrs={};}
  append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
  appendChild(node){this.append(node);return node;}
  replaceChildren(...nodes){for(const node of this.children)node.parentNode=null;this.children=[];this.append(...nodes);}
  querySelector(selector){const id=selector.slice(1);const find=node=>node.id===id?node:node.children.map(find).find(Boolean);return find(this)??null;}
  setAttribute(key,value){this.attrs[key]=String(value);}
  getAttribute(key){return this.attrs[key]??this[key]??null;}
  addEventListener(){}
  focus(){if(this.disabled||this.hidden||this.ownerDocument.activeElement===this)return;this.ownerDocument.activeElement=this;this.onfocus?.();}
  click(){if(!this.disabled&&!this.hidden)this.onclick?.();}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);}
}
function fixture(textRenderer=null){
  const doc={createElement(tag){return new Node(this,tag);},activeElement:null};globalThis.document=doc;const root=new Node(doc),section=new Node(doc);section.id='menuWeaponSection';root.append(section);for(const [id,tag]of [['menuWeaponActor','p'],['menuWeaponName','p'],['menuWeaponStats','dl'],['menuWeaponSockets','div'],['menuWeaponCard','img']]){const node=new Node(doc,tag);node.id=id;section.append(node);}
  const callbacks=[];const view=new OperationWeaponView({manifest,root,textRenderer,onSocket:(index,confirm)=>callbacks.push(['socket',index,confirm]),onSelect:id=>callbacks.push(['select',id]),onConfirm:(id,index)=>callbacks.push(['confirm',id,index]),onUnequip:index=>callbacks.push(['unequip',index]),onActorChange:direction=>callbacks.push(['actor',direction])});const details=operationWeaponDetails(world,attributes,items,'001'),actor=createPartyActors(world,attributes,{},items)[0];return{view,root,callbacks,data:{...details,definitions:items.definitions,actor}};
}
const item=(id,key,quantity=1)=>({id,instance_id:key,name:items.definitions[String(id)].name,quantity});

test('weapon sockets preserve source hit/draw geometry, weapon card and fixed-image right-end attribute clipping',()=>{
  const{view,data}=fixture();view.render(data);assert.deepEqual([view.section.style.left,view.section.style.top],['10px','50px']);assert.deepEqual([view.socketButtons.get(0).style.left,view.socketButtons.get(0).style.top],['35px','96px']);assert.equal(view.socketButtons.get(1)._background.style.left,'-1px');assert.equal(view.socketButtons.get(1)._icon.style.left,'12px');assert.deepEqual([view.socketButtons.get(5)._icon.style.left,view.socketButtons.get(5)._icon.style.top],['12px','3px']);
  assert.deepEqual([view.picker.style.left,view.picker.style.top],['170px','88px']);assert.deepEqual([view.details.style.left,view.details.style.top],['2px','188px']);assert.deepEqual([view.card.style.left,view.card.style.top,view.card.style.width,view.card.style.height],['228px','91px','175px','265px']);assert.equal(view.card.src,'assets/menu/cards/_arms/frame_000.png');
  const firstBar=view.stats.children[1];assert.deepEqual([firstBar.style.left,firstBar.style.top,firstBar.style.width],['242px','10px','8px']);assert.deepEqual([firstBar.children[0].style.width,firstBar.children[0].style.right,firstBar.children[0].style.objectFit],['auto','0','none']);
});

test('only original open sockets accept input and unknown retained socket state remains read-only',()=>{
  const{view,data}=fixture();view.render(data);assert.equal(view.socketButtons.size,6);assert.equal(view.controls().length,4);assert.equal(view.socketButtons.get(4).disabled,true);assert.equal(view.socketButtons.get(4).hidden,true);assert.equal(view.socketButtons.get(5).hidden,true);assert.equal(view.socketButtons.get(0).hidden,false);view.socketButtons.get(0).focus();view.key('ArrowDown');assert.equal(view.socketIndex,3);view.key('ArrowRight');assert.equal(view.socketIndex,0);
  view.render({...data,sockets:null});assert.equal(view.controls().length,0);assert.equal(view.openPicker(),false);view.render({...data,weapon:null,socketCount:0,sockets:[]});assert.equal(view.controls().length,0);assert.equal(view.card.hidden,true);
});

test('crystal chooser filters materials, preserves inventory order and a blank unload tail, then returns focus to the same socket',()=>{
  const{view,data,callbacks}=fixture(),before=JSON.stringify(world),candidates=[item(157,'second',2),item(210,'material'),item(156,'first',3)];view.render({...data,sockets:[item(156,'socket'),null,null,null],candidates});view.socketButtons.get(0).focus();assert.equal(view.socketButtons.get(0)._icon.hidden,false);view.openPicker();assert.deepEqual(view.candidates.map(row=>row.instance_id),['second','first','']);
  view.key(' ',true);assert.equal(callbacks.some(row=>row[0]==='confirm'),false);view.key(' ',false);assert.deepEqual(callbacks.filter(row=>row[0]==='confirm'),[['confirm','second',0]]);assert.equal(view.pickerOpen,true);view.key('ArrowDown');view.key('ArrowDown');assert.equal(view.selectedId,'');view.key(' ',false);assert.deepEqual(callbacks.filter(row=>row[0]==='unequip'),[['unequip',0]]);assert.equal(view.pickerOpen,true);assert.equal(view.escape(),true);assert.equal(view.root.ownerDocument.activeElement,view.socketButtons.get(0));assert.equal(JSON.stringify(world),before);
});

test('disabled configured crystals remain visible, eight-row paging and empty sockets do not commit an unload',()=>{
  const{view,data,callbacks}=fixture(),candidates=Array.from({length:10},(_,i)=>({...item(156,'ruby:'+i,2),available:i!==0}));view.render({...data,candidates});view.openPicker();assert.equal(view.controls().length,8);assert.equal(view.rowButtons[0].dataset.available,'false');view.key(' ',false);assert.equal(callbacks.some(row=>row[0]==='confirm'),false);view.key('PageDown');assert.equal(view.selectedId,'ruby:7');assert.equal(view.offset,0);view.key('ArrowRight');assert.equal(view.detailsIndex,1);view.key('ArrowLeft');assert.equal(view.detailsIndex,0);view.key('ArrowDown');view.key('ArrowDown');view.key('ArrowDown');view.key(' ',false);assert.equal(callbacks.some(row=>row[0]==='unequip'),false);view.escape();view.key('x');view.key('z');assert.deepEqual(callbacks.filter(row=>row[0]==='actor'),[['actor',1],['actor',-1]]);
});

test('weapon MNU names and stats take source face, alignment and individual COLORREF shadows',()=>{
  const calls=[],renderer={supports:()=>true,paint:(canvas,value,options)=>{calls.push({value,options});return {offsetX:-1,offsetY:-1};}}, {view,data}=fixture(renderer);view.render(data);
  const rows=calls.slice(0,5);assert.deepEqual(rows.map(row=>row.options.font),['requested_black23_mnu','requested_black23_mnu','requested_black19_mnu','requested_black19_mnu','requested_black19_mnu']);assert.deepEqual(rows.map(row=>row.options.shadow),['#2f2f2f','#2e2e2e','#2b2b2b','#2a2a2a','#2b2b2b']);assert.ok(rows.every(row=>row.options.layout==='mnu'));
  view.text(view.weaponName,'123',{font:'simsun18'});assert.equal(calls.at(-1).options.layout,undefined);
});

test('weapon actor refresh retains reset-to-first-hole semantics while recovering same-DOM first-hole highlight',()=>{
  const{view,data}=fixture();view.render(data);const first=view.socketButtons.get(0);first.focus();view.render({...data,status:{...data.status,id:'002'}});first.focus();assert.equal(view.socketIndex,0);assert.equal(view.focused,true);assert.equal(first.attrs['aria-pressed'],'true');view.socketButtons.get(3).focus();view.render({...data,status:{...data.status,id:'001'}});assert.equal(view.socketIndex,0);assert.equal(view.socketButtons.get(3).attrs['aria-pressed'],'false');first.focus();assert.equal(first.attrs['aria-pressed'],'true');
});

test('weapon picker keeps a full eight-row terminal window and Escape returns a non-first socket',()=>{
  const{view,data}=fixture(),candidates=Array.from({length:20},(_,i)=>item(156,'ruby:'+i));view.render({...data,candidates});view.socketButtons.get(3).focus();view.openPicker();view.key('PageDown');assert.deepEqual([view.selectedIndex,view.offset],[7,0]);view.key('PageDown');assert.deepEqual([view.selectedIndex,view.offset],[15,8]);view.key('PageDown');assert.deepEqual([view.selectedIndex,view.offset],[20,13]);assert.equal(view.controls().length,8);view.escape();assert.equal(view.socketIndex,3);assert.equal(view.root.ownerDocument.activeElement,view.socketButtons.get(3));assert.equal(view.socketButtons.get(3).attrs['aria-pressed'],'true');
});
