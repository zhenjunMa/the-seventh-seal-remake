import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {OperationFormationView} from '../web/operation_formation_view.mjs';
import {exchangeFormationSlots} from '../web/core/party_formation.mjs';
const manifest=JSON.parse(readFileSync(new URL('../web/data/operation_menu.json',import.meta.url),'utf8'));
class Node{
  constructor(doc,tag='div'){this.ownerDocument=doc;this.tagName=tag.toUpperCase();this.children=[];this.style={};this.attrs={};this.hidden=false;}
  append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
  querySelector(selector){const id=selector.slice(1),find=node=>node.id===id?node:node.children.map(find).find(Boolean);return find(this)??null;}
  setAttribute(key,value){this.attrs[key]=String(value);}
  getAttribute(key){return this.attrs[key]??this[key]??null;}
  focus(){if(this.ownerDocument.activeElement===this)return;this.ownerDocument.activeElement=this;this.onfocus?.();}
  click(){this.onclick?.();}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);}
}
function fixture(ids=['001','002']){
  const doc={createElement(tag){return new Node(this,tag);},activeElement:null};globalThis.document=doc;const root=new Node(doc),actors=ids.map(id=>({id,name:{'001':'英格妮','002':'凯','003':'娃蒂'}[id]})),exchanges=[];
  const view=new OperationFormationView({manifest,root,onExchange:(first,second)=>{exchanges.push([first,second]);view.render({slots:exchangeFormationSlots(view.slots,actors,first,second),actors});}});view.section.hidden=false;view.render({slots:[...ids,...Array(4-ids.length).fill(null)],actors});return{view,exchanges};
}

test('native cross-direction controls exchange only after two confirmations and can move into an empty slot',()=>{
  const{view,exchanges}=fixture();for(const [key,index]of [['ArrowDown',2],['ArrowLeft',0],['ArrowUp',1],['ArrowRight',3]]){view.key(key);assert.equal(view.focusIndex,index);assert.equal(view.root.ownerDocument.activeElement,view.buttons[index]);}
  view.key('Enter',true);assert.equal(view.firstIndex,null);view.key(' ');assert.equal(view.firstIndex,3);assert.equal(view.buttons[3].attrs['aria-pressed'],'true');view.key('ArrowLeft');view.key('Enter');assert.deepEqual(exchanges,[[3,0]]);assert.deepEqual(view.slots,[null,'002',null,'001']);assert.equal(view.firstIndex,null);assert.equal(view.sprites.size,2);
});

test('Esc clears a pending formation choice without a commit; retained cursor images use source draw offsets',()=>{
  const{view,exchanges}=fixture();view.buttons[3].focus();view.buttons[3].click();assert.equal(view.buttons[3]._cursor.src,'assets/menu/game001a_3/image_004.png');assert.deepEqual([view.buttons[3]._cursor.style.left,view.buttons[3]._cursor.style.top],['-9px','-11px']);assert.equal(view.escape(),false);assert.equal(view.firstIndex,null);assert.equal(exchanges.length,0);assert.equal(view.buttons[3]._cursor.src,'assets/menu/game001a_3/image_001.png');view.reset();assert.equal(view.focusIndex,0);assert.equal(view.buttons[0]._cursor.hidden,false);
});

test('The real formation view advances all three standing sprites at their shared battle-idle speed',()=>{
  const battle=JSON.parse(readFileSync(new URL('../web/data/party_battle_view.json',import.meta.url),'utf8'));
  const {view}=fixture(['001','002','003']);view.startedAt=1000;
  for(const elapsed of [0,39,40,69,70,89,90,119,120,1540,1600,10047]){
    view.tick(1000+elapsed);
    for(const id of ['001','002','003']){
      const standing=manifest.standing_actors[id],idle=battle.roles.find(role=>role.id===id).idle;
      assert.equal(view.sprites.get(id).src,standing.frames[Math.floor(elapsed/idle.interval_raw)%standing.frames.length],`${id} formation sprite at ${elapsed}ms`);
    }
  }
});
