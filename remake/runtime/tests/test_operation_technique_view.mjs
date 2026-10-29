import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {OperationTechniqueView} from '../web/operation_technique_view.mjs';
import {changeTechniqueSlot,techniqueSlots,createTechniqueCombination,deleteTechniqueCombination} from '../web/core/menu_techniques.mjs';
import {WorldStore} from '../web/core/world.mjs';

const load=name=>JSON.parse(readFileSync(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const manifest=load('operation_menu'),source=load('party_skills'),supplement=load('operation_techniques');
const initial=JSON.parse(JSON.parse(readFileSync(new URL('../evidence/chapter_systems_home_save.json',import.meta.url),'utf8')).payload);

// Model focus between mouse down/up: a removed control cannot receive the
// completing click. Pixel/layout acceptance remains a real browser check.
class Node{
  constructor(doc,tag='div'){Object.assign(this,{ownerDocument:doc,tagName:tag.toUpperCase(),children:[],style:{},dataset:{},attrs:{},hidden:false,disabled:false,className:''});this.classList={add:(name)=>this.className+=' '+name,toggle(){}};}
  get childNodes(){return this.children;}
  append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
  prepend(node){node.remove();node.parentNode=this;this.children.unshift(node);}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.parentNode=null;}
  replaceChildren(...nodes){for(const node of [...this.children])node.remove();this.append(...nodes);}
  setAttribute(key,value){this.attrs[key]=String(value);}
  getAttribute(key){return this.attrs[key]??null;}
  matches(selector){if(selector.startsWith('.'))return this.className.split(' ').includes(selector.slice(1));const match=selector.match(/^(\w+)?\[data-([\w-]+)(?:="([^"]*)")?\]$/);if(match){const key=match[2].replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return (!match[1]||this.tagName===match[1].toUpperCase())&&this.dataset[key]!==undefined&&(match[3]===undefined||this.dataset[key]===match[3]);}return this.tagName===selector.toUpperCase();}
  querySelectorAll(selector){const found=[];const visit=node=>{for(const child of node.children){if(child.matches(selector))found.push(child);visit(child);}};visit(this);return found;}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  contains(node){return node===this||this.children.some(child=>child.contains(node));}
  closest(selector){return this.matches(selector)?this:this.parentNode?.closest(selector)??null;}
  focus(){if(this.ownerDocument.activeElement===this)return;this.ownerDocument.activeElement?.onblur?.();this.ownerDocument.activeElement=this;this.onfocus?.();}
  click(){if(!this.disabled)this.onclick?.();}
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const doc={activeElement:null,createElement(tag){return new Node(this,tag);}};globalThis.document=doc;const root=new Node(doc),world=new WorldStore(structuredClone(initial));
  const view=new OperationTechniqueView({root,manifest,supplement,onSetSlot:request=>{changeTechniqueSlot(world,source,request);view.world=world.snapshot();},onDeleteCombination:request=>{deleteTechniqueCombination(world,source,request);view.world=world.snapshot();}});
  view.render(world.snapshot(),source,source,{rows:[],capacity:7});view.page({section:'edit',roleId:'001',layer:'content'});return {view,world,root,doc};
}
test('mouse focus preserves the seventh shortcut control and completing click commits its preview',async()=>{
  const {view,world,root}=fixture();view.action='set';view.category=1;view.stage='candidates';view.confirmEntry(view.candidateEntries()[0]);
  const button=view.element.querySelector('[data-technique-key="slot-6"]');button.focus();assert.equal(root.contains(button),true);assert.equal(view.element.querySelector('[data-technique-key="slot-6"]'),button);
  button.click();await settle();assert.equal(techniqueSlots(world.value,source,'001')[6].index_one_based,38);assert.equal(view.stage,'candidates');
});
test('switching technique headers keeps a mouse target attached until the click enters its roster',()=>{
  const {view,root,doc}=fixture();view.page({section:'use',layer:'sub'});const button=view.element.querySelector('[data-technique-key="header-edit"]');button.focus();assert.equal(root.contains(button),true);assert.equal(doc.activeElement,button);button.click();assert.equal(view.section,'edit');assert.equal(view.stage,'roster');assert.equal(view.mode,'content');
});
test('deleting the final combination restores keyboard focus so Escape can return to categories',async()=>{
  const {view,world,doc,root}=fixture();createTechniqueCombination(world,source,{roleId:'001',indices:[37],nameCodes:[1],icon:0,capacity:7});view.world=world.snapshot();view.action='delete';view.category=0;view.stage='candidates';view.paint();view.focus('content');view.confirmEntry(view.candidateEntries()[0]);await settle();assert.equal(doc.activeElement,root);assert.equal(view.escape(),false);assert.equal(view.stage,'categories');assert.equal(view.element.contains(doc.activeElement),true);
});
test('use and compose rows preserve the native text inset and each row bitmap origin through focus changes',()=>{
  for(const menuId of ['game002_1','game002_1b']){
    const {view}=fixture();view.element.replaceChildren();view.stage='candidates';view.action='set';view.category=1;const entry=view.candidateEntries()[0];
    view.paintList(Array.from({length:6},(_,index)=>({...entry,index,name:'skill '+index})),menuId);
    const rows=view.element.querySelectorAll('.technique-row');
    for(const [index,row]of rows.entries()){
      row.focus();const widget=manifest.menus.find(menu=>menu.id===menuId).widgets[index+3],highlight=row.querySelector('img[data-highlight]');
      assert.equal(row._labelNode.style.top,'5px');assert.equal(highlight.style.top,`${widget.draw_point_raw.y-widget.rect.top}px`);assert.equal(row.querySelector('[data-row-icon]').style.top,'5px');
      assert.equal(rows.filter(button=>button.querySelector('img[data-highlight]')).length,1);
    }
  }
});
test('direct technique rows use the source19px layout and focus colors while combinations retain the TextOut7px inset',()=>{
  const {view}=fixture(),paints=[];
  view.textRenderer={supports:()=>true,paint:(canvas,text,options)=>{paints.push({text,options});canvas._options=options;return {offsetX:-1,offsetY:-1};}};
  view.element.replaceChildren();view.stage='candidates';view.action='set';view.category=1;const entry=view.candidateEntries()[0];
  view.paintList([entry,{...entry,index:entry.index+1}], 'game002_1');
  let rows=view.element.querySelectorAll('.technique-row');rows[0].focus();
  const first=rows[0]._labelNode.querySelector('canvas')._options,second=rows[1]._labelNode.querySelector('canvas')._options;
  assert.equal(first.layout,'mnu');assert.equal(first.advanceOverride,19);assert.equal(first.lineHeight,19);assert.equal(first.maxWidth,250);
  assert.equal(rows[0]._labelNode.style.pointerEvents,'none');assert.equal(rows[0]._labelNode.style.top,'5px');assert.equal(first.foreground,'#ffff00');assert.equal(first.shadow,'#4f4f00');
  assert.equal(second.foreground,'#ffffff');assert.equal(second.shadow,'#000000');
  view.element.replaceChildren();view.preview=null;view.paintList([{name:'火',index:0,type:1,source:null,slot:{icon:0,color:1}}],'game002_1');
  rows=view.element.querySelectorAll('.technique-row');assert.equal(rows[0]._labelNode.style.top,'7px');
  assert.equal(rows[0]._labelNode.querySelector('canvas')._options.layout,undefined);assert.equal(rows[0]._labelNode.style.color,'#ffffff');
  rows[0].focus();assert.equal(rows[0]._labelNode.style.color,'#ffff00');assert.ok(paints.length);
});
test('list repaint preserves both row icons and a single selected strip after moving to another skill',()=>{
  const {view}=fixture();view.action='set';view.category=1;view.stage='candidates';view.paint();view.focus('content');view.key('ArrowDown');view.paint();
  const rows=view.element.querySelectorAll('.technique-row');assert.equal(rows.length,2);
  assert.equal(rows.filter(row=>row.querySelector('img[data-highlight]')).length,1);
  for(const row of rows){assert.ok(row.querySelector('[data-row-icon]'));assert.equal(row.querySelectorAll('[data-row-level]').length,row._entry.slot.color>0?1:0);assert.equal(row.querySelectorAll('[data-row-attribute]').length,Array.from({length:5},(_,n)=>Boolean(row._entry.source.type_flags_u32_0x32&(1<<(8+n)))).filter(Boolean).length);assert.equal(row.querySelectorAll('[data-row-experience]').length,1);}
});
test('skill rows read source level, feature bits and experience digits at native positions without writing progress',()=>{
  const {view,world}=fixture(),before=JSON.stringify(world.value),base=view.candidateEntries()[0];
  const skill=(flags,units,experience,required)=>{const source=structuredClone(base.source),bytes=Uint8Array.from(source.fixed_raw_hex.match(/../g),n=>parseInt(n,16)),v=new DataView(bytes.buffer);v.setUint32(0x32,flags,true);v.setUint32(0x36,units,true);v.setInt32(0x2f7,required,true);v.setInt32(0x2fb,experience,true);source.fixed_raw_hex=Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');return source;};
  view.element.replaceChildren();view.stage='candidates';
  view.paintList([{...base,source:skill(0x1f11,3,304,800),slot:{...base.slot,icon:1}},
    {...base,index:99,source:skill(0x101,1,0,800)},
    {...base,index:100,source:skill(0x201,1,800,800)},
    {...base,index:101,source:skill(1,1,0,0)}], 'game002_1b');
  const rows=view.element.querySelectorAll('.technique-row'),level=rows[0].querySelector('[data-row-level]');
  assert.equal(level.src,supplement.icons.magic_ball1_num.frames[9]);assert.equal(level.style.left,'22px');assert.equal(level.style.top,'17px');
  assert.deepEqual(rows[0].querySelectorAll('[data-row-attribute]').map(n=>[n.dataset.rowAttribute,n.style.left,n.style.top]),[0,1,2,3,4].map(n=>[String(n),(204+n*24)+'px','5px']));
  assert.equal(rows[0].querySelector('[data-row-experience]').dataset.rowExperience,'38');assert.equal(rows[0].querySelector('[data-row-experience]').style.left,'339px');
  assert.equal(rows[0].querySelector('[data-row-experience]').querySelector('span').style.backgroundColor,'rgb(63,176,96)');
  assert.equal(rows[1].querySelector('[data-row-experience]').querySelector('span').style.backgroundColor,'rgb(0,128,0)');
  assert.equal(rows[2].querySelector('[data-row-experience]').querySelector('span').style.backgroundColor,'rgb(1,127,255)');
  assert.deepEqual(rows[0].querySelectorAll('[data-row-experience-digit]').map(n=>[n.dataset.rowExperienceDigit,n.style.left,n.style.top]),[['10','364px','15px'],['8','357px','15px'],['3','350px','15px']]);
  assert.deepEqual(rows[1].querySelectorAll('[data-row-experience-digit]').map(n=>n.dataset.rowExperienceDigit),['10','0']);
  assert.deepEqual(rows[2].querySelectorAll('[data-row-experience-digit]').map(n=>n.dataset.rowExperienceDigit),['10','0','0','1']);
  assert.deepEqual(rows[2].querySelectorAll('[data-row-attribute]').map(n=>n.dataset.rowAttribute),['1']);assert.equal(rows[3].querySelector('[data-row-experience]'),null);
  rows[0].focus();rows[1].focus();
  assert.equal(rows[0].querySelectorAll('[data-row-attribute]').length,5);assert.equal(rows[0]._labelNode.style.color,'#ffffff');assert.equal(rows[1]._labelNode.style.color,'#ffff00');assert.equal(JSON.stringify(world.value),before);
});
test('combination rows share source colored numeric overlays and command rows do not gain skill metadata',()=>{
  const {view}=fixture();view.element.replaceChildren();view.stage='candidates';
  view.paintList([{name:'火',index:0,type:1,source:null,record:{total_units:4},slot:{icon:12,color:4}},
    {name:'防御',index:2,type:2,source:null,slot:{icon:2,color:0}}],'game002_1a');
  const rows=view.element.querySelectorAll('.technique-row');assert.equal(rows[0].querySelector('[data-row-level]').src,supplement.icons.magic_ball1_num.frames[10]);
  assert.equal(rows[0].querySelector('[data-row-experience]'),null);assert.equal(rows[1].querySelector('[data-row-level]'),null);assert.equal(rows[1].querySelector('[data-row-attribute]'),null);
});
test('source composition capacity locks excess ornamental holes and enters naming at capacity, independently of crystal sockets',()=>{
  const items=load('items');
  for(const [roleId,itemId,capacity,sockets,indices]of [['001','1',3,4,[21,22,23]],['002','10',4,3,[19,20,21,22]]]){
    const bytes=Uint8Array.from(items.definitions[itemId].raw_hex.match(/../g),n=>parseInt(n,16)),definition=new DataView(bytes.buffer);
    assert.equal(definition.getUint32(0x146,true),capacity);assert.equal(definition.getUint8(0x155),sockets);
    const {view,world}=fixture(),before=JSON.stringify(world.value);view.roleId=roleId;view.capacity=capacity;view.action='compose';view.category=2;view.stage='candidates';view.paint();
    const locks=view.element.querySelectorAll('[data-composition-locked]');assert.equal(locks.length,7-capacity);
    assert.deepEqual(locks.map(image=>image.dataset.compositionLocked),Array.from({length:7-capacity},(_,n)=>String(n+2).padStart(3,'0')));
    assert.ok(locks.every(image=>image.src===supplement.icons.char_ball.frames[7]));
    for(const [n,index]of indices.entries()){view.confirmEntry(view.candidateEntries().find(row=>row.index===index));assert.equal(view.stage,n===capacity-1?'name-editor':'candidates');}
    assert.equal(JSON.stringify(world.value),before);
  }
});
test('category focus uses the original complete bright label and preserves the selected category across X/Z and Escape',()=>{
  const {view,world}=fixture(),before=JSON.stringify(world.value);view.action='compose';view.category=1;view.stage='categories';view.paint();view.focusCategory();
  const categories=manifest.menus.find(menu=>menu.id==='game002b');
  assert.equal(view.element.querySelector('[data-technique-key="category-1"]').querySelector('img').src,categories.widgets[2].selected_images[0]);
  const general=view.element.querySelector('[data-technique-key="category-2"]');general.focus();
  assert.equal(general.querySelector('img').src,categories.widgets[3].selected_images[0]);assert.equal(view.element.querySelector('[data-technique-key="category-1"]').querySelector('img'),null);
  general.click();view.composition=[21];assert.equal(view.key('x'),true);assert.equal(view.category,3);assert.deepEqual(view.composition,[21]);
  assert.ok(view.element.querySelectorAll('img').some(image=>image.src===view.asset('game002_1d')));
  view.key('z');assert.equal(view.category,2);view.composition=[];view.escape();
  assert.equal(view.stage,'categories');assert.equal(document.activeElement.dataset.techniqueKey,'category-2');assert.equal(document.activeElement.querySelector('img').src,categories.widgets[3].selected_images[0]);
  assert.equal(JSON.stringify(world.value),before);
});
test('Escape in name entry switches to operations and back to the retained character without canceling the draft',()=>{
  const {view,world}=fixture(),before=JSON.stringify(world.value);view.action='compose';view.composition=[21];view.beginName();
  const character=view.element.querySelector('[data-technique-key="char-37"]');character.focus();character.click();assert.deepEqual(view.nameCodes,[38]);
  view.escape();assert.equal(view.stage,'name-editor');assert.equal(document.activeElement.dataset.techniqueKey,'name-PROV');assert.deepEqual(view.nameCodes,[38]);assert.deepEqual(view.composition,[21]);
  view.escape();assert.equal(view.stage,'name-editor');assert.equal(document.activeElement.dataset.techniqueKey,'char-37');assert.deepEqual(view.nameCodes,[38]);
  view.element.querySelector('[data-technique-key="name-CANCEL"]').click();assert.equal(view.stage,'candidates');assert.deepEqual(view.nameCodes,[]);assert.deepEqual(view.composition,[]);assert.equal(JSON.stringify(world.value),before);
});

test('all five naming operations show the original bright gold frame exclusively and clear it on returning to characters',()=>{
  const {view,world}=fixture(),before=JSON.stringify(world.value);view.action='compose';view.composition=[21];view.beginName();
  const menu=manifest.menus.find(m=>m.id==='game002_2a');
  for(const name of ['PROV','NEXT','DEL','CANCEL','OK']){
    const button=view.element.querySelector('[data-technique-key="name-'+name+'"]'),widget=menu.widgets.find(w=>w.name===name);
    button.focus();const operations=view.element.querySelectorAll('button').filter(n=>n.dataset.techniqueKey?.startsWith('name-'));
    assert.deepEqual(operations.filter(n=>n.querySelector('img')),[button]);
    assert.equal(button.querySelector('img').src,widget.active_images[0]);
    assert.notEqual(button.querySelector('img').src,widget.active_images.at(-1));
    assert.equal(button.querySelector('img').style.left,`${widget.draw_point_raw.x-widget.rect.left}px`);
    assert.equal(button.querySelector('img').style.top,`${widget.draw_point_raw.y-widget.rect.top}px`);
    view.paint();assert.equal(view.element.querySelector('[data-technique-key="name-'+name+'"]')?.querySelector('img')?.src,widget.active_images[0]);
  }
  view.escape();assert.equal(document.activeElement.dataset.techniqueKey,'char-0');
  assert.ok(view.element.querySelectorAll('button').filter(n=>n.dataset.techniqueKey?.startsWith('name-')).every(n=>!n.querySelector('img')));
  assert.equal(JSON.stringify(world.value),before);
});
test('seven-slot setting renders exactly one original gold ring which moves without replacing mouse targets and cancels without a write',()=>{
  const {view,world,root}=fixture(),before=JSON.stringify(world.value);view.action='set';view.category=1;view.stage='candidates';view.confirmEntry(view.candidateEntries()[0]);
  const shortcuts=supplement.menus.find(menu=>menu.id==='game002d'),origin=supplement.origins.shortcuts;
  for(const index of [0,6,4,2]){
    const button=view.element.querySelector('[data-technique-key="slot-'+index+'"]');button.focus();const rings=view.element.querySelectorAll('[data-shortcut-cursor]'),rect=shortcuts.widgets[index+1].rect;
    assert.equal(rings.length,1);assert.equal(rings[0].src,supplement.icons.board_bright.frames[0]);assert.equal(rings[0].style.left,`${origin.x+rect.left-13}px`);assert.equal(rings[0].style.top,`${origin.y+rect.top-13}px`);assert.equal(root.contains(button),true);
  }
  view.escape();assert.equal(view.element.querySelector('[data-shortcut-cursor]'),null);assert.equal(JSON.stringify(world.value),before);
});

test('setting wheel arrows follow the seven-slot layout, stop at edges and only move the pending cursor',()=>{
  const {view,world,doc}=fixture(),before=JSON.stringify(world.value);
  view.action='set';view.category=1;view.stage='candidates';view.confirmEntry(view.candidateEntries()[0]);
  const keys=['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
  const expected=[[0,6,1,5],[0,2,1,6],[1,3,2,3],[6,3,2,4],[5,3,3,4],[0,4,6,5],[0,3,1,5]];
  for(let slot=0;slot<7;slot++)for(let direction=0;direction<keys.length;direction++){
    view.element.querySelector('[data-technique-key="slot-'+slot+'"]').focus();
    assert.equal(view.key(keys[direction]),true);
    assert.equal(view.slotIndex,expected[slot][direction],`slot ${slot} ${keys[direction]}`);
    assert.equal(doc.activeElement.dataset.techniqueKey,'slot-'+expected[slot][direction]);
    assert.equal(view.element.querySelectorAll('[data-shortcut-cursor]').length,1);
    assert.equal(view.stage,'slot-confirm');assert.ok(view.pending);
  }
  view.element.querySelector('[data-technique-key="slot-5"]').focus();
  for(let count=0;count<12;count++)view.key('ArrowLeft',count>0);
  assert.equal(view.slotIndex,1);assert.equal(doc.activeElement.dataset.techniqueKey,'slot-1');
  view.escape();assert.equal(view.stage,'candidates');assert.equal(JSON.stringify(world.value),before);
});

test('the setting wheel belongs to the active setting flow and disappears on returning to actions or another header',()=>{
  const {view,world,doc}=fixture(),before=JSON.stringify(world.value);
  view.action='set';view.stage='categories';view.paint();view.focusCategory();
  assert.equal(view.element.querySelectorAll('[data-shortcut-board]').length,1);
  view.escape();assert.equal(view.stage,'actions');assert.equal(view.action,'set');
  assert.equal(doc.activeElement.dataset.techniqueKey,'action-set');assert.equal(view.element.querySelector('[data-shortcut-board]'),null);
  view.stage='categories';view.paint();view.chooseSection('edit',true);
  assert.equal(view.stage,'roster');assert.equal(view.element.querySelector('[data-shortcut-board]'),null);
  view.page({section:'use',roleId:'001',layer:'content'});
  assert.equal(view.element.querySelectorAll('[data-shortcut-board]').length,1);
  assert.equal(JSON.stringify(world.value),before);
});

test('replacement commits once, resets frame zero, adds source light at the selected slot and stops after all nine120ms frames',async()=>{
  const {view,world}=fixture(),before=techniqueSlots(world.value,source,'001'),revision=world.value.revision;
  const original=view.onSetSlot;let calls=0;view.onSetSlot=request=>{calls++;return original(request);};
  view.action='set';view.category=1;view.stage='candidates';view.confirmEntry(view.candidateEntries()[0]);
  view.commitSlot(6);view.commitSlot(6);await settle();
  assert.equal(calls,1);assert.equal(world.value.revision,revision+1);assert.deepEqual(techniqueSlots(world.value,source,'001').slice(0,6),before.slice(0,6));
  assert.equal(view.stage,'candidates');assert.equal(view.pending,null);assert.equal(view.element.querySelector('[data-shortcut-cursor]'),null);
  const bank=supplement.icons.board_brightB,rect=supplement.menus.find(m=>m.id==='game002d').widgets[7].rect,origin=supplement.origins.shortcuts;
  let effect=view.element.querySelector('[data-shortcut-replacement]');assert.equal(effect.src,bank.frames[0]);
  assert.equal(effect.style.left,`${origin.x+rect.left-23}px`);assert.equal(effect.style.top,`${origin.y+rect.top-23}px`);
  assert.equal(effect.style.width,'70px');assert.equal(effect.style.height,'70px');assert.equal(effect.style.mixBlendMode,'plus-lighter');
  // Integer synthetic time keeps exact120ms boundaries independent of the
  // real performance.now fractional phase and floating-point subtraction.
  const start=view.replacement.lastTick=Math.trunc(view.replacement.lastTick);view.tick(start+119);assert.equal(effect.dataset.frame,'0');
  view.key('ArrowDown');assert.ok(view.replacement);assert.equal(view.element.querySelectorAll('[data-shortcut-replacement]').length,1);
  for(let frame=1;frame<9;frame++){view.tick(start+frame*120);effect=view.element.querySelector('[data-shortcut-replacement]');assert.equal(effect.src,bank.frames[frame]);assert.equal(effect.dataset.frame,String(frame));}
  view.tick(start+1080);assert.equal(view.replacement,null);assert.equal(view.element.querySelector('[data-shortcut-replacement]'),null);
  assert.equal(world.value.revision,revision+1);assert.equal(view.element.querySelectorAll('[data-shortcut-board]').length,1);
});

test('Escape and hiding clear replacement effects, and a canceled queued confirmation cannot write or repaint later',async()=>{
  const {view,world}=fixture(),before=JSON.stringify(world.value);
  view.action='set';view.category=1;view.stage='candidates';view.confirmEntry(view.candidateEntries()[0]);
  view.commitSlot(0);view.hide();await settle();assert.equal(JSON.stringify(world.value),before);
  assert.equal(view.element.querySelector('[data-shortcut-cursor]'),null);assert.equal(view.replacement,null);
  view.page({section:'edit',roleId:'001',layer:'content'});view.action='set';view.category=1;view.stage='candidates';view.paint();
  view.startShortcutReplacement(0);view.escape();assert.equal(view.stage,'categories');assert.equal(view.element.querySelector('[data-shortcut-replacement]'),null);
  view.escape();assert.equal(view.element.querySelector('[data-shortcut-board]'),null);
  view.stage='candidates';view.paint();view.startShortcutReplacement(2);const start=view.replacement.lastTick;
  view.hide();view.tick(start+1000);assert.equal(view.element.querySelector('[data-shortcut-replacement]'),null);assert.equal(view.replacement,null);
  assert.equal(JSON.stringify(world.value),before);
});

test('a rejected slot update keeps its pending confirmation and does not play a successful replacement',async()=>{
  const {view,world}=fixture(),before=JSON.stringify(world.value);let message;
  view.onSetSlot=()=>{throw new Error('rejected');};view.onMessage=text=>{message=text;};
  view.action='set';view.category=1;view.stage='candidates';view.confirmEntry(view.candidateEntries()[0]);
  view.commitSlot(0);await settle();assert.equal(message,'rejected');assert.equal(view.slotCommit,null);
  assert.equal(view.stage,'slot-confirm');assert.ok(view.pending);assert.equal(view.replacement,null);
  assert.equal(view.element.querySelector('[data-shortcut-replacement]'),null);assert.ok(view.element.querySelector('[data-shortcut-cursor]'));
  assert.equal(JSON.stringify(world.value),before);
});
