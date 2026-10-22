import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {OperationMenuView} from '../web/operation_menu_view.mjs';
import {operationStatus} from '../web/core/operation_menu.mjs';
import {createMenuController} from '../web/controllers/menu.mjs';
import {WorldStore} from '../web/core/world.mjs';
import {createMenuSettings} from '../web/core/menu_settings.mjs';

const load = name => JSON.parse(readFileSync(new URL(`../web/data/${name}.json`,import.meta.url)));
const manifest=load('operation_menu'), supplement=load('operation_techniques'), attributes=load('party_combat'), items=load('items');
const world=JSON.parse(JSON.parse(readFileSync(new URL('../evidence/chapter_systems_home_save.json',import.meta.url))).payload);
const statuses=world.party.map(role=>operationStatus(world,attributes,items,role.id));

// Headless event/ownership model: checks navigation, not browser raster output.
class Node {
  constructor(doc,tag='div'){Object.assign(this,{ownerDocument:doc,tagName:tag.toUpperCase(),children:[],attrs:{},dataset:{},style:{setProperty(k,v){this[k]=v;}},hidden:false,disabled:false,scrollTop:0});this.className='';this.classList={add:(...names)=>{this.className=[...new Set([...this.className.split(/\s+/),...names])].filter(Boolean).join(' ');},remove:(...names)=>{this.className=this.className.split(/\s+/).filter(n=>!names.includes(n)).join(' ');},contains:name=>this.className.split(/\s+/).includes(name),toggle:(name,on)=>{if(on??!this.classList.contains(name))this.classList.add(name);else this.classList.remove(name);}};}
  append(...nodes){for(const node of nodes){node.parentNode?.removeChild(node);node.parentNode=this;this.children.push(node);}}
  prepend(...nodes){for(const node of [...nodes].reverse()){node.parentNode?.removeChild(node);node.parentNode=this;this.children.unshift(node);}}
  appendChild(node){this.append(node);return node;}
  removeChild(node){this.children=this.children.filter(child=>child!==node);node.parentNode=null;}
  replaceChildren(...nodes){if(this.children.some(child=>child.contains(this.ownerDocument.activeElement)))this.ownerDocument.activeElement=this.ownerDocument.body;for(const child of this.children)child.parentNode=null;this.children=[];this.append(...nodes);}
  remove(){if(this.contains(this.ownerDocument.activeElement))this.ownerDocument.activeElement=this.ownerDocument.body;this.parentNode?.removeChild(this);}
  contains(node){return this===node||this.children.some(child=>child.contains(node));}
  set textContent(text){this._text=String(text);this.replaceChildren();}
  get textContent(){return this._text??this.children.map(child=>child.textContent).join('');}
  get firstChild(){return this.children[0];}
  get childNodes(){return this.children;}
  setAttribute(key,value){this.attrs[key]=String(value);if(key==='id')this.id=String(value);if(key==='class')this.className=String(value);}
  getAttribute(key){return this.attrs[key]??null;}
  addEventListener(){}
  matches(selector){
    if(selector.startsWith('#'))return this.id===selector.slice(1);
    if(selector.startsWith('.'))return this.classList.contains(selector.slice(1));
    const attr=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if(attr){const actual=attr[1].startsWith('data-')?this.dataset[attr[1].slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]:this.attrs[attr[1]];return attr[2]===undefined?actual!==undefined:actual===attr[2];}
    return this.tagName===selector.toUpperCase();
  }
  querySelectorAll(selector){const selectors=selector.split(',');const all=[];const walk=node=>{for(const child of node.children){if(selectors.some(s=>child.matches(s.trim())))all.push(child);walk(child);}};walk(this);return all;}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  getClientRects(){for(let n=this;n;n=n.parentNode)if(n.hidden)return[];return this.parentNode?[{}]:[];}
  getBoundingClientRect(){return{left:0,top:0,width:640,height:480};}
  focus(){if(this.hidden||this.disabled||this.ownerDocument.activeElement===this)return;const previous=this.ownerDocument.activeElement;this.ownerDocument.activeElement=this;previous?.onblur?.();this.onfocus?.();}
  click(){if(!this.disabled)this.onclick?.();}
}

function fixture({onFilter}={}){
  const doc={createElement(tag){return new Node(this,tag);},activeElement:null};doc.body=new Node(doc,'body');doc.activeElement=doc.body;
  globalThis.document=doc;globalThis.MutationObserver=class{observe(){}};globalThis.ResizeObserver=class{observe(){}};globalThis.Image=class{};
  const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),stack=[doc.body];
  for(const match of html.matchAll(/<(\/?)([a-z][a-z0-9]*)([^>]*)>/gi)){
    const [,close,tag,attributes]=match;
    if(close){if(stack.length>1)stack.pop();continue;}
    const node=doc.createElement(tag);for(const attr of attributes.matchAll(/([\w-]+)="([^"]*)"/g))node.setAttribute(attr[1],attr[2]);node.hidden=/\bhidden(?:\s|$)/.test(attributes);stack.at(-1).append(node);if(!['img','input','br','hr','meta','link'].includes(tag.toLowerCase()))stack.push(node);
  }
  const root=doc.body.querySelector('#partyMenu');root.hidden=false;const calls=[];let view,selectionPage=null;
  const onPage=(page,category)=>{
    calls.push(['page',page,category]);
    if(page==='back-roster')page='roster';else if(page.startsWith('choose-')){selectionPage=page.slice(7);page=selectionPage==='formation'?'formation':'roster';}else if(page==='roster')selectionPage=null;
    view.page(page,{itemCategory:category??view.itemCategory??'items',selectionPage});
  };
  view=new OperationMenuView({manifest,root,techniquesSupplement:supplement,onPage,
    onActor:(id,confirmed)=>{calls.push(['actor',id,confirmed]);view.actorId=id;if(confirmed){onPage(selectionPage??'status');view.mode='content';view.frame.focus();}else if(view.current==='status')view.stats(statuses.find(status=>status.id===id));},
    onItemSelect:id=>{calls.push(['item',id]);view.itemSelectedId=id;},onItemConfirm:()=>calls.push(['confirm']),
    onItemTarget:id=>calls.push(['target',id]),onItemFilter:(type,subtype)=>{calls.push(['filter',type,subtype]);onFilter?.({view,type,subtype});},
    onSystemSetting(){},onSystemExit(){},onSlot(){}});
  view.page('roster');view.roster(statuses,statuses[0].id);view.actorId=statuses[0].id;view.focusInitial();
  return{view,doc,calls,onPage,node:id=>root.querySelector('#'+id)};
}
function renderItems(view,count=13){const rows=Array.from({length:count},(_,i)=>({id:156,instance_id:`crystal:${i}`,name:items.definitions['156'].name,quantity:1}));view.items(rows,rows[0]?.instance_id??'',items.definitions);return rows;}

test('main, header, actor and detail form the native Escape stack and restore the selected actor',()=>{
  const{view,doc,onPage,node}=fixture();assert.equal(doc.activeElement,view.frame);assert.equal(view.mode,'main');
  view.key(' ');assert.equal(view.mode,'sub');assert.equal(doc.activeElement,node('menuStatusPage'));
  view.key(' ');assert.equal(view.mode,'content');assert.equal(view.current,'roster');
  view.focusGroup('content',1);view.key(' ');assert.equal(view.current,'status');assert.equal(view.actorId,statuses[1].id);
  assert.equal(view.escape(),false);assert.equal(view.current,'roster');assert.equal(doc.activeElement.dataset.roleId,statuses[1].id);
  assert.equal(view.escape(),false);assert.equal(doc.activeElement,node('menuStatusPage'));assert.equal(view.mode,'sub');
  assert.equal(view.escape(),false);assert.equal(doc.activeElement,node('menuStatusTab'));assert.equal(view.mode,'main');
  assert.equal(view.escape(),true);
  onPage('choose-equipment');view.mode='content';view.subIndex=2;view.escape();assert.equal(doc.activeElement,node('menuEquipmentPage'));
});

test('returning to the same main category preserves the committed header and avoids resetting submenus',()=>{
  const{view,doc,node,onPage,calls}=fixture();onPage('choose-weapon');view.mode='sub';const before=calls.length;
  view.escape();assert.equal(calls.length,before);assert.equal(view.current,'roster');
  view.key(' ');assert.equal(doc.activeElement,node('menuWeaponPage'));
});

test('Escape clears purple actor panels at each character header and reentry restores exactly one focus',()=>{
  for(const header of ['menuStatusPage','menuEquipmentPage','menuWeaponPage']){
    const{view,doc,node}=fixture();const selected=()=>[...view.rosterButtons].filter(([,button])=>button.classList.contains('selected')).map(([id])=>id);
    node(header).focus();view.key(' ');view.focusGroup('content',1);
    assert.deepEqual(selected(),[statuses[1].id]);
    assert.equal(view.escape(),false);assert.equal(doc.activeElement,node(header));assert.equal(view.actorFocused,false);assert.deepEqual(selected(),[]);
    for(const[id,button]of view.rosterButtons)assert.equal(button.querySelector('img').src,manifest.actor_panels[id].normal);
    view.roster(statuses,statuses[1].id);assert.deepEqual(selected(),[]);
    view.key(' ');assert.deepEqual(selected(),[doc.activeElement.dataset.roleId]);
    view.focusGroup('content',1);assert.deepEqual(selected(),[statuses[1].id]);
    assert.equal(view.rosterButtons.get(statuses[1].id).querySelector('img').src,manifest.actor_panels[statuses[1].id].unfocused);
  }
});

test('actor focus survives returning from detail but clears when a header or main category takes focus',()=>{
  const{view,node}=fixture();node('menuStatusPage').focus();view.key(' ');view.focusGroup('content',1);view.key(' ');view.escape();
  const selected=()=>[...view.rosterButtons].filter(([,button])=>button.classList.contains('selected')).map(([id])=>id);
  assert.deepEqual(selected(),[statuses[1].id]);
  node('menuEquipmentPage').focus();assert.deepEqual(selected(),[]);view.key(' ');assert.equal(selected().length,1);
  node('menuStatusTab').focus();assert.deepEqual(selected(),[]);view.roster(statuses,statuses[1].id);assert.deepEqual(selected(),[]);
  view.focusInitial();assert.deepEqual(selected(),[]);
});

test('moving among character headers clears the old committed highlight and keeps exactly one visible focus',()=>{
  const{view,node,onPage}=fixture();view.subCommitted=true;view.mode='content';onPage('choose-status');view.highlight();
  const lit=()=>view.characterTabs.filter(([id])=>node(id).querySelector('img')&&!node(id).querySelector('img').hidden).map(([id])=>id);
  assert.deepEqual(lit(),['menuStatusPage']);
  for(const[id]of view.characterTabs){node(id).focus();assert.deepEqual(lit(),[id]);}
  // Header focus previews a choice; it does not commit a different detail page.
  assert.equal(node('menuStatusPage').getAttribute('aria-pressed'),'true');
  node('menuEquipmentPage').focus();view.key(' ');assert.deepEqual(lit(),['menuEquipmentPage']);
  assert.equal(node('menuStatusPage').getAttribute('aria-pressed'),'false');
});

test('TECH returning from its header to main and confirming again keeps the current edit section',()=>{
  const{view,doc,onPage}=fixture();onPage('skills');view.techniques.render(world,load('party_skills'),{party_skills:load('party_skills')},{rows:statuses});view.techniques.chooseSection('edit');view.mode='sub';view.mainIndex=2;view.escape();assert.equal(view.mode,'main');view.key(' ');assert.equal(view.techniques.section,'edit');assert.equal(doc.activeElement.dataset.techniqueKey,'header-edit');
});

test('item top-header focus previews the corresponding native body before confirmation',()=>{
  const{view,doc,node,onPage}=fixture();onPage('items');view.focusGroup('sub',2);
  assert.equal(view.mode,'sub');assert.equal(view.itemCategory,'crystals');assert.equal(node('menuCrystalsPage').getAttribute('aria-pressed'),'true');
  renderItems(view);view.key(' ');assert.equal(view.mode,'content');assert.equal(doc.activeElement.dataset.instanceId,'crystal:0');
});

test('native nine-cell PageDown first reaches the edge, then scrolls; PageUp reverses both steps',()=>{
  const{view,doc,node,onPage}=fixture();onPage('items','crystals');renderItems(view);view.focusItem();
  assert.equal(view.itemPageSize,9);view.key('PageDown');assert.equal(doc.activeElement.dataset.instanceId,'crystal:8');assert.equal(node('menuItemList').scrollTop,0);
  view.key('PageDown');assert.equal(doc.activeElement.dataset.instanceId,'crystal:12');assert.equal(node('menuItemList').scrollTop,120);
  view.key('PageDown');assert.equal(doc.activeElement.dataset.instanceId,'crystal:12');
  view.key('PageUp');assert.equal(doc.activeElement.dataset.instanceId,'crystal:4');assert.equal(node('menuItemList').scrollTop,120);
  view.key('PageUp');assert.equal(doc.activeElement.dataset.instanceId,'crystal:0');assert.equal(node('menuItemList').scrollTop,0);
});

test('item arrows keep every focused row visible, clamp at list boundaries and use display order',()=>{
  const{view,doc,node,onPage}=fixture();onPage('items','crystals');const rows=renderItems(view);view.focusItem();
  for(let n=0;n<12;n++)view.key('ArrowDown');assert.equal(doc.activeElement.dataset.instanceId,'crystal:12');assert.equal(node('menuItemList').scrollTop,120);
  view.key('ArrowDown');assert.equal(doc.activeElement.dataset.instanceId,'crystal:12');
  const reversed=[...rows].reverse();view.items(reversed,'crystal:12',items.definitions);view.focusItem('crystal:12');view.key('ArrowDown');assert.equal(doc.activeElement.dataset.instanceId,'crystal:11');
});

test('item left/right cycles the native filters rather than unrelated row buttons',()=>{
  const{view,calls,onPage}=fixture();onPage('items');renderItems(view);view.focusItem();view.key('ArrowLeft');assert.deepEqual(calls.filter(row=>row[0]==='filter').at(-1),['filter',5,2]);view.key('ArrowRight');assert.deepEqual(calls.filter(row=>row[0]==='filter').at(-1),['filter',5,1]);
});

test('armor catalog uses all five source filter hit rectangles and keeps the selected image after list focus',()=>{
  const{view,onPage}=fixture();onPage('items','equipment');renderItems(view);view.focusItem();
  assert.equal(view.equipmentFilters.length,5);assert.ok(view.filters.every(button=>button.hidden));
  const widgets=manifest.menus.find(menu=>menu.id==='game003_2').widgets;
  for(const [index,button]of view.equipmentFilters.entries()){
    const widget=widgets.find(row=>row.name===String(index+1).padStart(2,'0'));
    assert.equal(button.hidden,false);assert.equal(button.style.left,widget.rect.left+'px');assert.equal(button.style.top,widget.rect.top+'px');assert.equal(button.style.width,'40px');assert.equal(button.style.height,'40px');
  }
  view.setItemFilter(2,4);view.focusItem();const selected=view.equipmentFilters[3],image=selected.querySelector('img');
  assert.equal(selected.getAttribute('aria-pressed'),'true');assert.equal(image.hidden,false);assert.equal(image.src,widgets.find(row=>row.name==='04').selected_images.at(-1));assert.equal(image.style.left,'-2px');assert.equal(image.style.top,'1px');
  assert.ok(view.equipmentFilters.filter(button=>button!==selected).every(button=>!button.querySelector('img')||button.querySelector('img').hidden));
});

test('armor left/right wraps five categories and resets selection and scrolling before each rebuilt list',()=>{
  const{view,doc,node,calls,onPage}=fixture({onFilter:({view})=>renderItems(view)});onPage('items','equipment');renderItems(view);view.focusItem('crystal:11');node('menuItem').value='crystal:11';
  view.key('ArrowLeft');assert.deepEqual(calls.filter(row=>row[0]==='filter').at(-1),['filter',2,5]);assert.equal(view.itemFilterIndex,4);assert.equal(node('menuItem').value,'');assert.equal(node('menuItemList').scrollTop,0);assert.equal(doc.activeElement.dataset.instanceId,'crystal:0');
  view.key('ArrowRight');assert.deepEqual(calls.filter(row=>row[0]==='filter').at(-1),['filter',2,1]);assert.equal(view.itemFilterIndex,0);
  view.focusItem('crystal:12');view.equipmentFilters[2].click();assert.deepEqual(calls.filter(row=>row[0]==='filter').at(-1),['filter',2,3]);assert.equal(node('menuItemList').scrollTop,0);assert.equal(doc.activeElement.dataset.instanceId,'crystal:0');assert.equal(view.equipmentFilters[2].getAttribute('aria-pressed'),'true');
});

test('an empty armor category clears card and INFO while retaining its filter focus and Escape layer',()=>{
  const{view,doc,node,onPage}=fixture({onFilter:({view})=>view.items([],'',items.definitions)});onPage('items','equipment');renderItems(view);view.focusItem('crystal:10');node('menuMessage').textContent='旧物品说明';node('menuItemCard').hidden=false;
  view.equipmentFilters[4].click();assert.equal(view.itemRows().length,0);assert.equal(node('menuItemCard').hidden,true);assert.equal(node('menuMessage').textContent,'');assert.equal(doc.activeElement,view.equipmentFilters[4]);assert.equal(view.mode,'content');assert.equal(view.equipmentFilters[4].getAttribute('aria-pressed'),'true');
  view.escape();assert.equal(view.mode,'sub');assert.equal(doc.activeElement,node('menuInventoryEquipmentPage'));
});

test('crystal catalog has no bottom filter, ignores horizontal keys and does not dispatch item use on confirmation',()=>{
  const{view,doc,calls,onPage}=fixture();onPage('items','crystals');renderItems(view);view.focusItem('crystal:5');const active=doc.activeElement;
  assert.equal(view.currentItemFilters().length,0);assert.ok([...view.filters,...view.equipmentFilters].every(button=>button.hidden));
  assert.equal(view.key('ArrowLeft'),true);assert.equal(view.key('ArrowRight'),true);assert.equal(doc.activeElement,active);assert.equal(calls.filter(row=>row[0]==='filter').length,0);
  view.key(' ');assert.equal(calls.filter(row=>row[0]==='confirm').length,0);assert.equal(doc.activeElement,active);
  onPage('items','equipment');renderItems(view);view.focusItem();view.key('Enter');assert.equal(calls.filter(row=>row[0]==='confirm').length,0);
  onPage('items','items');renderItems(view);view.focusItem();view.key(' ');assert.equal(calls.filter(row=>row[0]==='confirm').length,1);
});

test('Escape from a target picker restores the exact source item and its visible row',()=>{
  const{view,doc,node,onPage}=fixture();onPage('items','crystals');renderItems(view);view.focusItem('crystal:11');view.itemTargets(statuses,statuses[1].id);
  assert.equal(node('menuItemTargets').hidden,false);view.escape();assert.equal(node('menuItemTargets').hidden,true);assert.equal(doc.activeElement.dataset.instanceId,'crystal:11');assert.equal(node('menuItemList').scrollTop,90);
});

test('consuming the focused item does not leave focus on a removed DOM node',()=>{
  const{view,doc,onPage}=fixture();onPage('items','crystals');const rows=renderItems(view);view.focusItem('crystal:10');view.items(rows.filter(row=>row.instance_id!=='crystal:10'),'crystal:11',items.definitions);assert.equal(doc.activeElement.dataset.instanceId,'crystal:11');assert.equal(view.mode,'content');
});

test('STATUS X/Z wraps active actors while keeping the detail layer and raw progress untouched',()=>{
  const{view,doc,onPage}=fixture();const before=JSON.stringify(world);onPage('status');view.mode='content';view.frame.focus();
  assert.equal(view.key('x'),true);assert.equal(view.actorId,statuses[1].id);assert.equal(view.current,'status');assert.equal(doc.activeElement,view.frame);
  view.key('X');assert.equal(view.actorId,statuses[0].id);view.key('z');assert.equal(view.actorId,statuses[1].id);assert.equal(JSON.stringify(world),before);
});

test('equipment X/Z restores the same ornament slot and does not cycle actors inside its picker',()=>{
  const{view,calls,onPage}=fixture();onPage('equipment');view.mode='content';view.equipmentView.slotId='head';view.equipmentView.slotButtons.set('head',new Node(view.root.ownerDocument,'button'));view.equipmentView.paintSlots=()=>calls.push(['paint-slot']);view.equipmentView.infoWorn=()=>calls.push(['slot-info']);
  assert.equal(view.key('x'),true);assert.equal(view.actorId,statuses[1].id);assert.equal(view.equipmentView.slotId,'head');assert.equal(view.equipmentView.slotFocused,true);
  view.equipmentView.picker.hidden=false;const count=calls.filter(row=>row[0]==='actor').length;view.key('z');assert.equal(calls.filter(row=>row[0]==='actor').length,count);
});

test('opening clears the previous focus layers and starts at the source main STATUS focus',()=>{
  const{view,doc}=fixture();view.mode='content';view.mainIndex=3;view.subIndex=2;view.actorFocused=true;view.itemOffset=4;view.focusInitial();assert.equal(view.mode,'main');assert.equal(view.mainIndex,0);assert.equal(view.subIndex,0);assert.equal(view.actorFocused,false);assert.equal(doc.activeElement,view.frame);
});

test('MNU fields request the measured native layout and dynamic text keeps its own TextOut layout',()=>{
  const{view}=fixture(),seen=[];view.textRenderer={supports:()=>true,paint(canvas,value,options){seen.push(options);return{offsetX:-1,offsetY:-1};}};const node=new Node(view.root.ownerDocument);
  view.number(node,'012','arial23_mnu');view.text(node,'地图',{font:'requested_black19_mnu'});view.text(node,'角色',{font:'simsun20_text'});
  assert.deepEqual(seen.map(options=>options.layout),['mnu','mnu',undefined]);
});

test('source MNU integration uses each actual field color and alignment instead of one shared shadow',()=>{
  const{view}=fixture(),seen=[];view.textRenderer={supports:()=>true,paint(canvas,value,options){seen.push(options);return{offsetX:0,offsetY:0};}};const node=new Node(view.root.ownerDocument);
  view.mnuText(node,'00000100','game001','GOLD');assert.equal(seen.at(-1).shadow,'#3e3e00');assert.equal(seen.at(-1).foreground,'#ffff00');
  view.mnuText(node,'57','game001a_2','text01');assert.equal(seen.at(-1).shadow,'#454545');assert.equal(seen.at(-1).font,'arial23_mnu');
  view.mnuText(node,'42','game001a','text07');assert.equal(seen.at(-1).shadow,'#4b4b4b');assert.equal(seen.at(-1).font,'arial25_mnu');
});

test('source arrow controls scroll one full window and retain the selected relative row',()=>{
  const{view,doc,node,onPage}=fixture();onPage('items','crystals');renderItems(view);view.focusItem('crystal:2');
  view.itemScrollButtons.get('crystals')[1].click();assert.equal(node('menuItemList').scrollTop,120);assert.equal(doc.activeElement.dataset.instanceId,'crystal:6');
  view.itemScrollButtons.get('crystals')[0].click();assert.equal(node('menuItemList').scrollTop,0);assert.equal(doc.activeElement.dataset.instanceId,'crystal:2');
});

test('connected item categories take their list rectangles directly from each native nine-row resource',()=>{
  const{view,node,onPage}=fixture();onPage('items');renderItems(view);assert.equal(node('menuItemList').style.top,'28px');
  onPage('items','crystals');renderItems(view);assert.equal(node('menuItemList').style.top,'29px');assert.equal(node('menuItemList').style.height,'265px');
});

test('Control return is limited to the source-backed formation detail and clears its pending selection',()=>{
  const{view,doc,node,onPage}=fixture();onPage('formation');view.mode='content';view.formation.firstIndex=1;assert.equal(view.key('Control'),false);assert.equal(view.formation.firstIndex,1);assert.equal(view.key('Control',false,{standaloneControl:true}),true);assert.equal(view.formation.firstIndex,null);assert.equal(view.mode,'sub');assert.equal(doc.activeElement,node('menuFormationPage'));
  onPage('status');view.mode='content';assert.equal(view.key('Control',false,{standaloneControl:true}),false);
});

function controllerFixture(preference='memory'){
  const ui=fixture(),sourceSkills=load('party_skills'),itemData=structuredClone(items),listed=[];itemData.runtime_configuration={differences:[]};
  const node=id=>id==='partyMenu'?ui.view.root:ui.doc.body.querySelector('#'+id);
  const operationMenu={manifest,itemFocused:true,itemOrder:[],itemButtons:new Map(),stats(){},roster(){},text(){},mnuText(){},equipment(){},weapon(){},equipmentView:{render(){}},system:{render(){}},items(rows){listed.push(rows.map(row=>row.instance_id));this.itemOrder=rows.map(row=>row.instance_id);},focusInitial(){this.mode='main';},page(page){this.current=page;},suspend(){}};
  const configured={items:itemData,party_skills:sourceSkills,audit:{mode:'original'}};
  const state={world:new WorldStore(world),partyCombat:attributes,partySkills:sourceSkills,itemData,operationMenu,
    menuContext:{combat:false,page:'items',itemCategory:'crystals',configured},menuSettings:createMenuSettings({battleCursor:preference}),
    audio:{playCue(){},snapshot(){return{channels:{}};}},keys:new Set(),selectedRole:statuses[0].id,
    scenes:{phase:'map',setPhase(phase){this.phase=phase;}}};
  const actions={option:(id,label,disabled=false)=>{const option=new Node(ui.doc,'option');option.value=id;option.textContent=label;option.disabled=disabled;return option;},readConfiguredData:async()=>configured,buildHud(){},log(){},status(){}};
  ui.node('menuActor').value=statuses[0].id;ui.node('menuSlot').value='head';ui.node('menuSkill').value='';ui.node('menuSkillTarget').value=statuses[0].id;
  const controller=createMenuController({state,actions,$:node,canvas:new Node(ui.doc,'canvas'),ctx:{}});
  return{...ui,node,state,actions,configured,listed,controller};
}
const crystal=(id,key)=>({id,instance_id:key,name:items.definitions[String(id)].name,quantity:1,source_raw_hex:items.definitions[String(id)].initialized_raw_hex.slice(0,8)+'01000000'+items.definitions[String(id)].initialized_raw_hex.slice(16)});

test('controller keeps original field-item ID ordering and chooses the next surviving row on consumption',()=>{
  const{state,controller,listed,node}=controllerFixture();state.world.value.inventory=[crystal(160,'last'),crystal(156,'first'),crystal(157,'middle')];node('menuItem').value='middle';state.operationMenu.itemOrder=['first','middle','last'];
  controller.refreshPartyMenu();assert.deepEqual(listed.at(-1),['first','middle','last']);
  state.world.value.inventory=state.world.value.inventory.filter(row=>row.instance_id!=='middle');controller.refreshPartyMenu();assert.equal(node('menuItem').value,'last');
});

test('controller armor catalog defaults to subtype one, filters by exact native subtype and sorts IDs',()=>{
  const{state,controller,listed,node}=controllerFixture();state.world.value.inventory=[crystal(43,'head-last'),crystal(3,'necklace'),crystal(2,'head-first'),crystal(4,'ring'),crystal(5,'badge'),crystal(156,'crystal')];
  state.menuContext.itemFilter=[3,1];node('menuItem').value='head-last';controller.showOperationPage('items','equipment');
  assert.deepEqual(state.menuContext.itemFilter,[2,1]);assert.deepEqual(listed.at(-1),['head-first','head-last']);assert.equal(node('menuItem').value,'head-first');
  state.menuContext.itemFilter=[2,2];controller.refreshPartyMenu();assert.deepEqual(listed.at(-1),['necklace']);
  state.menuContext.itemFilter=[2,3];controller.refreshPartyMenu();assert.deepEqual(listed.at(-1),['ring']);
  state.menuContext.itemFilter=[2,4];controller.refreshPartyMenu();assert.deepEqual(listed.at(-1),['badge']);
  state.menuContext.itemFilter=[2,5];controller.refreshPartyMenu();assert.deepEqual(listed.at(-1),[]);assert.equal(node('menuItem').value,'');assert.equal(node('menuItemCard').hidden,true);assert.equal(node('menuItemHint').textContent,'');
  controller.showOperationPage('items','crystals');assert.deepEqual(listed.at(-1),['crystal']);controller.showOperationPage('items','equipment');assert.deepEqual(state.menuContext.itemFilter,[2,1]);assert.deepEqual(listed.at(-1),['head-first','head-last']);
});

test('field menu opening ignores battle cursor preference, falls back from a missing actor and stays on roster',async()=>{
  for(const preference of ['initial','memory']){const{state,controller,node}=controllerFixture(preference);state.menuContext=null;state.selectedRole='missing';await controller.openPartyMenu(false);assert.equal(state.menuContext.page,'roster');assert.equal(state.operationMenu.mode,'main');assert.equal(node('menuActor').value,statuses[0].id);assert.equal(state.menuSettings.snapshot().battleCursor,preference);}
});

test('a pending configuration load cannot reopen a menu after the user cancels it',async()=>{
  const{state,controller,actions,configured,node}=controllerFixture();state.menuContext=null;let resolve;actions.readConfiguredData=()=>new Promise(done=>resolve=done);const open=controller.openPartyMenu(false);controller.closePartyMenu();resolve(configured);await open;assert.equal(state.menuContext,null);assert.equal(node('partyMenu').hidden,true);assert.equal(state.scenes.phase,'map');
});
