// Shared surface only. Each original mini-game owns its native hit map and
// transient animation; the controller owns money, RNG and reward transactions.
import {setImageSource} from './core/ui/image_dom.mjs';

export const nativeRectContains=([x,y],[left,top,right,bottom])=>x>left&&x<right&&y>top&&y<bottom;
export const nativeNamedFrame=(frames,name)=>frames.find(row=>row.source_name?.toLowerCase()===name.toLowerCase());

export class NativeCasinoFrame{
  constructor({root,title,cursor,isSuspended=()=>false,onDown=()=>{},onMove=()=>{},onUp=()=>{},onFrame=()=>{}}){
    Object.assign(this,{root,isSuspended});this.disposed=false;this.pointer=[0,0];this.pointerVisible=false;
    root.classList.add('native-casino-panel');root.hidden=false;
    this.frame=document.createElement('section');this.frame.className='native-casino-frame';
    this.frame.tabIndex=-1;this.frame.setAttribute('role','dialog');this.frame.setAttribute('aria-label',title);
    this.frame.setAttribute('aria-modal','true');root.append(this.frame);
    if(cursor){this.cursorManifest=cursor;this.cursor=this.image(cursor.image,0,0);this.cursor.className='native-casino-cursor';this.cursor.hidden=true;}
    this.listeners=new AbortController();const options={signal:this.listeners.signal};
    this.frame.addEventListener('pointermove',event=>{this.track(event);if(!isSuspended())onMove([...this.pointer],event);},options);
    this.frame.addEventListener('pointerleave',()=>{this.pointerVisible=false;this.paintPointer();},options);
    this.frame.addEventListener('pointerdown',event=>{
      if(isSuspended())return;event.preventDefault();this.frame.focus({preventScroll:true});this.track(event);
      onDown([...this.pointer],event);
    },options);
    this.frame.addEventListener('contextmenu',event=>event.preventDefault(),options);
    window.addEventListener('pointerup',event=>{if(!this.disposed)onUp([...this.pointer],event);},options);
    window.addEventListener('blur',()=>onUp([...this.pointer],{button:0,cancelled:true}),options);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)onUp([...this.pointer],{button:0,cancelled:true});},options);
    this.resize=new ResizeObserver(()=>this.fit());this.resize.observe(root);this.fit();this.frame.focus({preventScroll:true});
    let previous;
    const draw=time=>{
      if(this.disposed)return;const delta=previous===undefined?0:Math.max(0,time-previous);previous=time;
      if(!isSuspended())onFrame(delta>250?0:delta,time);
      this.animation=requestAnimationFrame(draw);
    };
    this.animation=requestAnimationFrame(draw);
  }
  fit(){if(!this.disposed)this.frame.style.transform=`translate(-50%,-50%) scale(${Math.min(this.root.clientWidth/640,this.root.clientHeight/480)})`;}
  image(path,x,y,parent=this.frame){
    const image=document.createElement('img');image.alt='';image.draggable=false;
    Object.assign(image.style,{left:`${x}px`,top:`${y}px`});if(path)setImageSource(image,path);parent.append(image);return image;
  }
  control(name,[left,top,right,bottom]){
    const button=document.createElement('button');button.type='button';button.tabIndex=-1;button.className='native-casino-control';
    button.setAttribute('aria-label',name);
    Object.assign(button.style,{left:`${left+1}px`,top:`${top+1}px`,width:`${right-left-2}px`,height:`${bottom-top-2}px`});
    this.frame.append(button);return button;
  }
  number(value,frames,x,y,{pad=0,gap=0,advance=null,align='left'}={}){
    const node=document.createElement('span');node.className='native-casino-number';
    const text=String(Math.max(0,Math.trunc(Number(value)||0))).padStart(pad,'0');
    node.setAttribute('role','img');node.setAttribute('aria-label',text);
    const rows=[...text].map(char=>nativeNamedFrame(frames,char+'.bmp')??frames[Number(char)]);
    const width=advance===null?rows.reduce((sum,row)=>sum+row.width+gap,0)-gap:(rows.length-1)*advance+rows.at(-1).width;
    Object.assign(node.style,{left:`${x-(align==='right'?width:align==='center'?Math.floor(width/2):0)}px`,top:`${y}px`,width:`${width}px`,height:`${Math.max(...rows.map(row=>row.height))}px`});
    let left=0;for(const row of rows){this.image(row.image,left,0,node);left+=advance??row.width+gap;}
    this.frame.append(node);return node;
  }
  setPointer(point,visible=true){this.pointer=[...point];this.pointerVisible=visible;this.paintPointer();}
  track(event){const rect=this.frame.getBoundingClientRect();this.setPointer([(event.clientX-rect.left)*640/rect.width,(event.clientY-rect.top)*480/rect.height]);}
  paintPointer(){if(!this.cursor)return;this.cursor.hidden=!this.pointerVisible;this.cursor.style.left=`${this.pointer[0]-this.cursorManifest.hotspot.x}px`;this.cursor.style.top=`${this.pointer[1]-this.cursorManifest.hotspot.y}px`;}
  dispose(){if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.animation);this.listeners.abort();this.resize.disconnect();this.root.replaceChildren();this.root.hidden=true;}
}
