import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {OperationMenuView} from '../web/operation_menu_view.mjs';
import {createMenuController} from '../web/controllers/menu.mjs';

const load=name=>JSON.parse(readFileSync(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const manifest=load('operation_menu'),supplement=load('operation_techniques'),source=load('party_skills');

// Event/focus ownership only. Browser rendering and native training rules are
// separate checks; hiding a parent makes all its controls unavailable here.
class Node{
  constructor(doc,tag='div'){
    Object.assign(this,{ownerDocument:doc,tagName:tag.toUpperCase(),children:[],attrs:{},dataset:{},style:{setProperty(k,v){this[k]=v;}},hidden:false,disabled:false,className:''});
    this.classList={add:(...names)=>{this.className=[...new Set([...this.className.split(/\s+/),...names])].filter(Boolean).join(' ');},remove:(...names)=>{this.className=this.className.split(/\s+/).filter(name=>!names.includes(name)).join(' ');},contains:name=>this.className.split(/\s+/).includes(name),toggle:(name,on)=>{if(on??!this.classList.contains(name))this.classList.add(name);else this.classList.remove(name);}};
  }
  append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
  prepend(...nodes){for(const node of [...nodes].reverse()){node.remove();node.parentNode=this;this.children.unshift(node);}}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;}
  replaceChildren(...nodes){for(const child of [...this.children])child.remove();this.append(...nodes);}
  contains(node){return this===node||this.children.some(child=>child.contains(node));}
  get childNodes(){return this.children;}
  get firstChild(){return this.children[0];}
  set textContent(value){this._text=String(value);this.replaceChildren();}
  get textContent(){return this._text??this.children.map(child=>child.textContent).join('');}
  setAttribute(key,value){this.attrs[key]=String(value);if(key==='id')this.id=String(value);if(key==='class')this.className=String(value);}
  getAttribute(key){return this.attrs[key]??null;}
  addEventListener(){}
  matches(selector){
    if(selector.startsWith('#'))return this.id===selector.slice(1);
    if(selector.startsWith('.'))return this.classList.contains(selector.slice(1));
    const match=selector.match(/^(\w+)?\[data-([\w-]+)(?:="([^"]*)")?\]$/);
    if(match){const key=match[2].replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return (!match[1]||this.tagName===match[1].toUpperCase())&&this.dataset[key]!==undefined&&(match[3]===undefined||this.dataset[key]===match[3]);}
    return this.tagName===selector.toUpperCase();
  }
  querySelectorAll(selector){const found=[];const visit=node=>{for(const child of node.children){if(selector.split(',').some(s=>child.matches(s.trim())))found.push(child);visit(child);}};visit(this);return found;}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  closest(selector){return this.matches(selector)?this:this.parentNode?.closest(selector)??null;}
  getClientRects(){for(let node=this;node;node=node.parentNode)if(node.hidden)return [];return this.parentNode?[{}]:[];}
  getBoundingClientRect(){return {left:0,top:0,width:640,height:480};}
  focus(){if(!this.getClientRects().length||this.disabled||this.ownerDocument.activeElement===this)return;const previous=this.ownerDocument.activeElement;this.ownerDocument.activeElement=this;previous?.onblur?.();this.onfocus?.();}
  click(){if(this.getClientRects().length&&!this.disabled)return this.onclick?.();}
}

function fixture(startup=()=>{}){
  const doc={createElement(tag){return new Node(this,tag);},activeElement:null};doc.body=new Node(doc,'body');doc.activeElement=doc.body;
  globalThis.document=doc;globalThis.MutationObserver=class{observe(){}};globalThis.ResizeObserver=class{observe(){}};globalThis.Image=class{};
  const stack=[doc.body],html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  for(const [,closing,tag,attrs]of html.matchAll(/<(\/?)([a-z][a-z0-9]*)([^>]*)>/gi)){
    if(closing){if(stack.length>1)stack.pop();continue;}
    const node=doc.createElement(tag);for(const [,key,value]of attrs.matchAll(/([\w-]+)="([^"]*)"/g))node.setAttribute(key,value);node.hidden=/\bhidden(?:\s|$)/.test(attrs);stack.at(-1).append(node);if(!['img','input','br','hr','meta','link'].includes(tag.toLowerCase()))stack.push(node);
  }
  const $=id=>doc.body.querySelector('#'+id),root=$('partyMenu'),battle=new Node(doc,'div'),canvas=new Node(doc,'canvas'),calls=[],messages=[],world={party:[{id:'001',name:'凯'}],revision:17};
  doc.body.append(battle,canvas);root.hidden=false;let controller;
  const view=new OperationMenuView({manifest,root,techniquesSupplement:supplement,onPage(){},onTechniqueTest:request=>startup({request,controller,state,view,root,battle,doc,calls}),onTechniqueMessage:(message,error)=>messages.push({message,error})});
  view.page('skills');view.techniques.render(world,source,source,{rows:[],capacity:3});view.techniques.focus('sub',2);
  const context={combat:false,phase:'map',page:'skills',configured:{marker:'retained-config'},selectedRole:'001'};
  const state={operationMenu:view,menuContext:context,world:{value:world},keys:new Set(['ArrowLeft']),scenes:{phase:'party-menu',setPhase(value){this.phase=value;}},audio:{playCue(name){calls.push(['cue',name]);}},menuFeedback:{closing(){calls.push(['closing']);}}};
  controller=createMenuController({state,actions:{},$,canvas,ctx:{}});
  return {doc,root,battle,view,state,controller,context,calls,messages,world};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('test header dispatches one whole-party request and leaves battle focus after startup resolves',async()=>{
  let resolveStart,ticket;const gate=new Promise(resolve=>{resolveStart=resolve;});
  const ui=fixture(({request,controller,state,battle,calls})=>{calls.push(['test',request]);ticket=controller.beginTechniqueTestMenu();state.scenes.setPhase('battle');battle.focus();return gate;});
  const {view,state,root,doc,battle,controller,context,world,calls}=ui,before=JSON.stringify(world),header=doc.activeElement;
  header.click();header.click();await settle();
  assert.deepEqual(calls,[['test',{}]]);assert.equal(state.menuContext,null);assert.equal(root.hidden,true);assert.equal(state.keys.size,0);assert.equal(doc.activeElement,battle);assert.ok(Object.isFrozen(ticket));assert.deepEqual(Object.keys(ticket),[]);
  let repaints=0;const originalPaint=view.techniques.paint.bind(view.techniques);view.techniques.paint=()=>{repaints++;return originalPaint();};
  resolveStart();await view.techniques.testPending;
  assert.equal(repaints,0);assert.equal(doc.activeElement,battle);assert.equal(view.techniques.section,'test');assert.equal(view.techniques.roleId,null);assert.equal(JSON.stringify(world),before);
  state.keys.add('Enter');assert.equal(controller.resumeTechniqueTestMenu(ticket),true);
  assert.equal(state.menuContext,context);assert.equal(state.scenes.phase,'party-menu');assert.equal(root.hidden,false);assert.equal(doc.activeElement,header);assert.equal(doc.activeElement.dataset.techniqueKey,'header-test');assert.equal(state.keys.size,0);assert.equal(repaints,0);
  assert.equal(view.current,'skills');assert.equal(view.techniques.mode,'sub');assert.equal(view.techniques.stage,'roster');assert.equal(JSON.stringify(world),before);assert.equal(controller.resumeTechniqueTestMenu(ticket),false);
  assert.equal(view.escape(),false);assert.equal(view.mode,'main');
});

test('loading failure restores the same menu and reports the error without inventing a selected skill',async()=>{
  let attempts=0;
  const ui=fixture(async({request,controller,state,battle})=>{assert.deepEqual(request,{});attempts++;const ticket=controller.beginTechniqueTestMenu();state.scenes.setPhase('battle-loading');battle.focus();try{throw new Error('测试素材缺失');}catch(error){controller.resumeTechniqueTestMenu(ticket);throw error;}});
  const header=ui.doc.activeElement;header.click();await ui.view.techniques.testPending;
  assert.equal(ui.state.menuContext,ui.context);assert.equal(ui.root.hidden,false);assert.equal(ui.doc.activeElement,header);assert.equal(ui.state.scenes.phase,'party-menu');assert.deepEqual(ui.messages,[{message:'测试素材缺失',error:true}]);
  header.click();await ui.view.techniques.testPending;assert.equal(attempts,2);assert.equal(ui.calls.length,0);
});

test('opaque tickets reject forged, duplicate and stale resumes while preserving a later test',()=>{
  const {state,controller,root}=fixture(),ticket=controller.beginTechniqueTestMenu();
  assert.equal(controller.resumeTechniqueTestMenu({}),false);assert.equal(state.menuContext,null);assert.equal(root.hidden,true);assert.throws(()=>controller.beginTechniqueTestMenu(),/正在进行/);
  assert.equal(controller.resumeTechniqueTestMenu(ticket),true);const later=controller.beginTechniqueTestMenu();
  assert.equal(controller.resumeTechniqueTestMenu(ticket),false);assert.equal(state.menuContext,null);assert.equal(controller.resumeTechniqueTestMenu(later),true);assert.equal(controller.resumeTechniqueTestMenu(later),false);
});

test('resume finds the same header after DOM replacement and does not rerun its selection callback',()=>{
  const {state,controller,view,doc,battle}=fixture(),old=doc.activeElement,ticket=controller.beginTechniqueTestMenu();battle.focus();old.remove();view.techniques.paint();
  const replacement=view.techniques.element.querySelector('[data-technique-key="header-test"]');let selections=0;view.techniques.onSection=()=>selections++;
  assert.notEqual(replacement,old);assert.equal(controller.resumeTechniqueTestMenu(ticket),true);assert.equal(doc.activeElement,replacement);assert.equal(selections,0);assert.equal(state.menuContext.page,'skills');
});

test('only the field technique page can release menu input ownership',()=>{
  const {state,controller,context,root}=fixture();
  for(const invalid of [{...context,combat:true},{...context,page:'items'},null]){state.menuContext=invalid;assert.throws(()=>controller.beginTechniqueTestMenu(),/技巧测试进入/);assert.equal(state.menuContext,invalid);assert.equal(root.hidden,false);}
  state.menuContext=context;state.scenes.phase='map';assert.throws(()=>controller.beginTechniqueTestMenu(),/技巧测试进入/);
  state.scenes.phase='party-menu';const ticket=controller.beginTechniqueTestMenu(),other={combat:false,page:'system'};state.menuContext=other;
  assert.equal(controller.resumeTechniqueTestMenu(ticket),false);assert.equal(state.menuContext,other);state.menuContext=null;assert.equal(controller.resumeTechniqueTestMenu(ticket),true);
});
