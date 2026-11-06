// Original WordDisc: GAME.exe4D9BF0/4DA0F0/4DAB20, 640x480.
// These transient dial/input states never hold world progress or rewards.
import {setImageSource} from './core/ui/image_dom.mjs';

export const STATUE_CONTROLS=Object.freeze([
  {id:'exit',name:'退出石像',center:[500,215],bounds:[482,198,518,232]},
  {id:'next',name:'下一个输入位',center:[527,253],bounds:[509,236,545,270]},
  {id:'previous',name:'上一个输入位',center:[537,299],bounds:[519,282,555,316]},
  {id:'clear',name:'清除当前输入位',center:[532,343],bounds:[514,326,550,360]},
  {id:'insert',name:'输入当前符号',center:[508,386],bounds:[490,369,526,403]},
  {id:'plus',name:'向前转动符盘',center:[463,405],bounds:[445,388,481,422]},
  {id:'minus',name:'向后转动符盘',center:[415,410],bounds:[397,393,433,427]},
]);
const inside=(x,y,[left,top,right,bottom])=>x>left&&x<right&&y>top&&y<bottom;
export const statueControlAt=(x,y)=>STATUE_CONTROLS.findIndex(row=>inside(x,y,row.bounds));
const f32step=Math.fround(0.2);
export const nativeStatueState=()=>({symbols:[15,24,-1,-1,-1,13],selected:1,frame:0,target:0,
  direction:0,held:false,heldMs:0,clueVisible:true,clueX:-600,blink:true,blinkCount:0,keyboardIndex:4});

export function moveStatueSlot(state,step){
  if(state.symbols[state.selected]===24)state.symbols[state.selected]=-1;
  state.selected=Math.max(0,Math.min(5,state.selected+step));
  if(state.symbols[state.selected]===-1)state.symbols[state.selected]=24;
}
export function rotateStatue(state,direction){
  state.target+=direction*3;
  if(state.target>=72)state.target=0;
  if(state.target<0)state.target=71;
  state.direction=direction;state.held=true;state.heldMs=0;
}
function stepDisc(state){
  state.frame=Math.fround(state.frame+state.direction*f32step);
  if(state.frame>=72)state.frame=0;
  if(state.frame<0)state.frame=71;
}
export function releaseStatueRotation(state){
  state.held=false;state.heldMs=0;
  if(state.direction){
    let remaining=400;
    while(Math.trunc(state.frame)%3!==0&&remaining-->0)stepDisc(state);
    state.target=Math.trunc(state.frame);state.direction=0;
  }
}
export function tickStatue(state,elapsed){
  if(++state.blinkCount>50){state.blink=!state.blink;state.blinkCount=0;}
  state.clueX=state.clueVisible?Math.min(10,state.clueX+10):Math.max(-600,state.clueX-10);
  if(state.held)state.heldMs+=Math.max(0,elapsed);
  const continuous=state.held&&state.heldMs>500&&state.direction!==0;
  if(state.direction&&(continuous||Math.trunc(state.frame)!==state.target))stepDisc(state);
  if(continuous)state.target=Math.trunc(state.frame);
  return {continuous};
}

export class NativeStatueView{
  constructor({root,manifest,statueIndex,isSuspended=()=>false,onSubmit,onClose,onSound=()=>{},onStopSound=()=>{}}){
    if(!manifest?.disc||manifest.disc.length!==72||manifest.symbols?.length!==25||!manifest.questions?.[statueIndex-1])
      throw new Error('神秘石像原素材不完整');
    Object.assign(this,{root,manifest,statueIndex,isSuspended,onSubmit,onClose,onSound,onStopSound});
    this.state=nativeStatueState();this.disposed=false;this.pending=false;
    this.pointer=[508,386];this.pointerVisible=false;
    root.classList.add('native-statue-panel');root.hidden=false;
    this.frameNode=document.createElement('section');this.frameNode.className='native-statue-frame';
    this.frameNode.tabIndex=-1;this.frameNode.setAttribute('role','dialog');
    this.frameNode.setAttribute('aria-label','神秘石像');this.frameNode.setAttribute('aria-modal','true');root.append(this.frameNode);
    const background=manifest.backgrounds.find(row=>row.source_name==='WDBack.bmp');
    this.image(background.image,0,0);
    this.slots=Array.from({length:6},(_,i)=>{
      const slot=document.createElement('span');slot.className='native-statue-slot';slot.setAttribute('role','status');
      Object.assign(slot.style,{left:`${370+40*i}px`,top:'80px'});this.frameNode.append(slot);
      const image=this.image(null,0,0,slot);return {slot,image};
    });
    this.disc=this.image(manifest.disc[0].image,0,0);this.disc.alt='当前古文字 1';
    this.buttons=STATUE_CONTROLS.map(row=>this.control(row.name,row.bounds));
    this.clueButton=this.control('查看古文字提示',[590,450,630,480]);
    this.clue=this.image(manifest.questions[statueIndex-1].image,-600,10);this.clue.alt='石像留下的古文字问题';
    if(manifest.cursor){
      this.cursor=this.image(manifest.cursor.image,0,0);this.cursor.classList.add('native-statue-cursor');
    }
    this.listeners=new AbortController();const options={signal:this.listeners.signal};
    this.frameNode.addEventListener('pointermove',event=>{this.trackPointer(event);this.paintPointer();},options);
    this.frameNode.addEventListener('pointerleave',()=>{this.pointerVisible=false;this.paintPointer();},options);
    this.frameNode.addEventListener('pointerdown',event=>{
      if(this.isSuspended()||this.pending)return;
      event.preventDefault();this.frameNode.focus({preventScroll:true});this.trackPointer(event);
      if(event.button===2)this.toggleClue();
      else if(event.button===0)this.activateAt(...this.pointer);
    },options);
    this.frameNode.addEventListener('contextmenu',event=>event.preventDefault(),options);
    window.addEventListener('pointerup',event=>{if(event.button===0)this.release();},options);
    window.addEventListener('keyup',()=>this.release(),options);
    window.addEventListener('blur',()=>this.release(),options);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.release();},options);
    this.resize=new ResizeObserver(()=>this.fit());this.resize.observe(root);this.fit();this.paint();
    this.frameNode.focus({preventScroll:true});
    let previous;
    const draw=time=>{
      if(this.disposed)return;
      const delta=previous===undefined?0:Math.max(0,time-previous),elapsed=delta>250?0:delta;previous=time;
      if(this.isSuspended()){
        if(!this.suspended)this.onStopSound('roll');this.suspended=true;
      }else if(!this.pending){
        this.suspended=false;
        const {continuous}=tickStatue(this.state,elapsed);
        if(continuous)this.onSound('roll',{singleVoice:true,loop:true});
        this.paint();
      }
      this.animation=requestAnimationFrame(draw);
    };
    this.animation=requestAnimationFrame(draw);
  }
  get active(){return !this.disposed;}
  fit(){this.frameNode.style.transform=`translate(-50%,-50%) scale(${Math.min(this.root.clientWidth/640,this.root.clientHeight/480)})`;}
  image(path,x,y,parent=this.frameNode){
    const image=document.createElement('img');image.alt='';image.draggable=false;
    Object.assign(image.style,{left:`${x}px`,top:`${y}px`});if(path)setImageSource(image,path);parent.append(image);return image;
  }
  control(name,[left,top,right,bottom]){
    const button=document.createElement('button');button.type='button';button.tabIndex=-1;
    button.className='native-statue-control';button.setAttribute('aria-label',name);
    Object.assign(button.style,{left:`${left+1}px`,top:`${top+1}px`,width:`${right-left-2}px`,height:`${bottom-top-2}px`});
    this.frameNode.append(button);return button;
  }
  trackPointer(event){
    const rect=this.frameNode.getBoundingClientRect();
    this.pointer=[(event.clientX-rect.left)*640/rect.width,(event.clientY-rect.top)*480/rect.height];
    this.pointerVisible=true;
  }
  paintPointer(){
    if(!this.cursor)return;
    const {hotspot}=this.manifest.cursor;
    this.cursor.hidden=!this.pointerVisible;
    this.cursor.style.left=`${this.pointer[0]-hotspot.x}px`;this.cursor.style.top=`${this.pointer[1]-hotspot.y}px`;
  }
  paint(){
    const state=this.state;
    this.slots.forEach(({slot,image},i)=>{
      const symbol=state.symbols[i];
      slot.setAttribute('aria-label',`密码第${i+1}位${symbol<0||symbol===24?'，空白':`，古文字 ${symbol+1}`}${state.selected===i?'，当前输入位':''}`);
      image.hidden=symbol<0||i===state.selected&&!state.blink;
      if(symbol>=0)setImageSource(image,this.manifest.symbols[symbol].image);
    });
    const index=Math.trunc(state.frame);setImageSource(this.disc,this.manifest.disc[index].image);
    this.disc.alt=`当前古文字 ${Math.trunc(state.target/3)+1}`;
    this.clue.style.left=`${state.clueX}px`;this.clueButton.setAttribute('aria-pressed',String(state.clueVisible));
    this.paintPointer();
  }
  toggleClue(){this.state.clueVisible=!this.state.clueVisible;this.onSound('page');this.paint();}
  activateAt(x,y){
    if(this.disposed||this.pending||this.isSuspended())return;
    if(inside(x,y,[590,450,630,480])){this.toggleClue();return;}
    if(this.state.clueVisible)return;
    const index=statueControlAt(x,y);if(index<0)return;
    if(index<5)this.onSound('click');else this.onSound('rotateClick');
    if(index===0){this.onClose();return;}
    if(index===1||index===2)moveStatueSlot(this.state,index===1?1:-1);
    else if(index===3)this.state.symbols[this.state.selected]=24;
    else if(index===4){
      this.state.symbols[this.state.selected]=Math.trunc(this.state.target/3);
      this.state.selected=Math.min(5,this.state.selected+1);
      if(this.state.symbols[this.state.selected]===-1)this.state.symbols[this.state.selected]=24;
      if(this.state.symbols.every(symbol=>symbol!==-1)){
        this.pending=true;this.onSubmit({symbols:[...this.state.symbols]});
      }
    }else rotateStatue(this.state,index===5?1:-1);
    if(!this.disposed)this.paint();
  }
  resume(){this.pending=false;}
  release(){
    if(this.disposed)return;
    releaseStatueRotation(this.state);this.onStopSound('roll');this.paint();
  }
  key(key,repeat=false){
    if(this.disposed)return false;
    if(this.isSuspended()||this.pending)return true;
    if(key==='Escape'){if(!repeat)this.toggleClue();return true;}
    if(key==='ArrowUp'||key==='ArrowDown'){
      this.state.keyboardIndex=Math.max(0,Math.min(6,this.state.keyboardIndex+(key==='ArrowUp'?-1:1)));
      this.pointer=[...STATUE_CONTROLS[this.state.keyboardIndex].center];this.pointerVisible=true;this.paintPointer();return true;
    }
    if(key==='Enter'||key===' '){
      if(!repeat){if(this.state.clueVisible)this.toggleClue();else this.activateAt(...this.pointer);}return true;
    }
    // Original WordDisc has no left/right, Tab or text editing command.
    return true;
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.animation);
    this.listeners.abort();this.resize.disconnect();this.onStopSound('roll');this.root.replaceChildren();this.root.hidden=true;
  }
}
