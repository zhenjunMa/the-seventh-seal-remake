import {drawingContext} from './phaser/rendering/recorded_surface.mjs';

// 425000 kind1 uses Map_Object_Name.DGP, a 40ms visit, 10px travel,
// forty hold visits and COLORREF 0x0A2735. Notices share exploration time.
export class RewardNoticeView {
  constructor({root,resource,textRenderer,clock,log}){
    Object.assign(this,{root,resource,textRenderer,clock,log});
    this.canvas=root.querySelector('canvas');this.context=drawingContext(this.canvas);
    this.label=root.querySelector('p');this.ink=document.createElement('canvas');this.queue=[];
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(root.parentElement);
  }
  resize(){
    const box=this.root.parentElement.getBoundingClientRect();
    this.canvas.style.transform=`translate(-50%,-50%) scale(${Math.min(box.width/640,box.height/480)})`;
  }
  show(names){
    this.queue.push(...names);
    if(this.frameTask)return;
    this.root.hidden=false;this.resize();this.next(this.clock.time);
  }
  next(now){
    const text=this.queue.shift();
    if(text===undefined){this.close();return;}
    this.started=now;this.text=text;this.label.textContent=`获得 ${text}`;
    this.bounds=this.textRenderer.paint(this.ink,text,{font:'simsun20_text',foreground:'#35270a',shadow:'#000000',
      shadowOffsets:[],maxWidth:this.resource.width-10,maxLines:1,boxHeight:this.resource.height-3,align:'center',verticalAlign:'center'});
    this.log?.({type:'chest-reward-notice',text});this.draw(now);
  }
  draw(now){
    const {context:c,resource:r}=this,ticks=Math.floor((now-this.started)/40),travel=Math.ceil(r.width/10);
    const exit=Math.max(0,ticks-travel-40),offset=ticks<travel?r.width-Math.min(r.width,ticks*10):Math.min(r.width,exit*10);
    c.clearRect(0,0,640,480);
    if(exit>=travel){this.next(now);return;}
    const x=640-r.width+offset,y=480-r.height;
    c.globalAlpha=Math.min(1,ticks*12/128,exit?Math.max(0,1-exit*12/128):1);
    c.drawImage(r.bitmaps[0],x,y);
    c.drawImage(this.ink,x+5+this.bounds.offsetX,y+2+this.bounds.offsetY);
    c.globalAlpha=1;
    this.frameTask=this.clock.requestFrame(time=>{this.frameTask=null;this.draw(time);});
  }
  close(){
    this.frameTask?.cancel();this.frameTask=null;this.queue.length=0;this.root.hidden=true;
    this.context.clearRect(0,0,640,480);this.label.textContent='';
  }
}
