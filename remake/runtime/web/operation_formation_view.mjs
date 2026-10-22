import {operationStandingFrame} from './core/menu_presentation.mjs';

const place=(node,x,y,width,height)=>Object.assign(node.style,{position:'absolute',left:x+'px',top:y+'px',...(width==null?{}:{width:width+'px'}),...(height==null?{}:{height:height+'px'})});

export class OperationFormationView{
  constructor({manifest,root,onExchange,onFocus,onInfo}){
    this.manifest=manifest;this.root=root;this.onExchange=onExchange;this.onFocus=onFocus;this.onInfo=onInfo;this.menu=manifest.menus.find(row=>row.id==='game001a_3');this.slots=Array(4).fill(null);this.actors=[];this.focusIndex=0;this.firstIndex=null;
    this.section=root.querySelector('#menuFormationSection')??document.createElement('section');this.section.id='menuFormationSection';this.section.className='operation-content formation-content';this.section.setAttribute('aria-label','队列');this.section.hidden=true;place(this.section,20,50,this.menu.width,this.menu.height);if(!this.section.parentNode)(root.querySelector('#operationFrame')??root).append(this.section);
    this.sprites=new Map();this.buttons=Array.from({length:4},(_,index)=>{const widget=this.menu.widgets.find(row=>row.name==='CHECK'+(index+1)),r=widget.rect,button=document.createElement('button'),cursor=document.createElement('img');button.type='button';button.className='formation-source-slot';place(button,r.left,r.top,r.right-r.left+1,r.bottom-r.top+1);Object.assign(button.style,{border:'0',margin:'0',padding:'0',background:'none',boxShadow:'none',outline:'none'});cursor.alt='';cursor.className='menu-source';place(cursor,widget.draw_point_raw.x-r.left,widget.draw_point_raw.y-r.top);button.append(cursor);button._cursor=cursor;button._widget=widget;button.onfocus=()=>{this.focusIndex=index;this.paint();this.onFocus?.();};button.onclick=()=>{this.focusIndex=index;this.confirm();};this.section.append(button);return button;});
    this.startedAt=performance.now();
  }
  render({slots,actors=[]}){
    if(!Array.isArray(slots)||slots.length!==4)throw new Error('队列视图需要四个位置');this.slots=[...slots];this.actors=actors;
    for(const [index,id]of slots.entries()){
      if(!id)continue;const standing=this.manifest.standing_actors?.[id];if(!standing)continue;let sprite=this.sprites.get(id);if(!sprite){sprite=document.createElement('img');sprite.alt='';sprite.className='menu-source formation-actor';this.sprites.set(id,sprite);this.section.append(sprite);}const r=this.buttons[index]._widget.rect;place(sprite,r.left+Math.floor((r.right-r.left+1)/2)-standing.anchor[0],r.top-30+(r.bottom-r.top+1)-standing.anchor[1]);
    }
    for(const [id,sprite]of this.sprites)if(!slots.includes(id)){sprite.remove();this.sprites.delete(id);}this.paint();this.tick(performance.now());
  }
  paint(){
    for(const [index,button]of this.buttons.entries()){const id=this.slots[index],actor=this.actors.find(row=>row.id===id),focused=index===this.focusIndex,chosen=index===this.firstIndex;button.setAttribute('aria-label',`${['攻击型','防御型','一般型','一般型'][index]}：${actor?.name??'空位'}`);button.setAttribute('aria-pressed',String(chosen));button._cursor.hidden=!focused&&!chosen;button._cursor.src=chosen?button._widget.selected_images[0]:button._widget.active_images[0];}
    this.onInfo?.('');
  }
  controls(){return this.buttons;}
  confirm(){if(this.firstIndex===null){this.firstIndex=this.focusIndex;this.paint();return;}const first=this.firstIndex,second=this.focusIndex;this.firstIndex=null;this.onExchange?.(first,second);this.paint();}
  key(key,repeat=false){if(key==='Tab')return true;if(key===' '||key==='Enter'){if(!repeat)this.confirm();return true;}const index={ArrowLeft:0,ArrowUp:1,ArrowDown:2,ArrowRight:3}[key];if(index===undefined)return false;this.focusIndex=index;this.buttons[index].focus({preventScroll:true});this.paint();return true;}
  escape(){this.firstIndex=null;this.paint();return false;}
  reset(){this.firstIndex=null;this.focusIndex=0;this.startedAt=performance.now();this.paint();}
  tick(now){if(this.section.hidden||this.root.hidden)return;for(const [id,sprite]of this.sprites){const standing=this.manifest.standing_actors[id],frame=operationStandingFrame(standing,now-this.startedAt);if(sprite.getAttribute('src')!==frame)sprite.src=frame;}}
}
