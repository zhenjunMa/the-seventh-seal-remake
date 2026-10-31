import {drawingContext} from './phaser/rendering/recorded_surface.mjs';

// Native 0x425000 kind0: Map_Area_Name, 24ms visits, 8px travel,
// sixty hold visits, 18px black text at inset (3,3).
export class MapNameNoticeView {
  constructor({root,resource,textRenderer,clock}){
    Object.assign(this,{root,resource,textRenderer,clock});
    this.canvas=root.querySelector('canvas');this.context=drawingContext(this.canvas);
    this.label=root.querySelector('p');this.ink=document.createElement('canvas');
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(root.parentElement);
  }
  resize(){
    const box=this.root.parentElement.getBoundingClientRect();
    this.root.style.setProperty('--map-name-scale',String(Math.min(box.width/640,box.height/480)));
  }
  show(name){
    this.close();this.started=this.clock.time;this.label.textContent=name;
    this.bounds=this.textRenderer.paint(this.ink,name,{font:'map_name18',foreground:'#000000',shadow:null,
      maxWidth:this.resource.width-6,maxLines:1,lineHeight:18,boxHeight:this.resource.height-1,
      layout:'mnu',align:'center',verticalAlign:'center'});
    this.root.hidden=false;this.resize();this.draw(this.started);
  }
  draw(now){
    const {context:c,resource:r}=this,ticks=Math.floor((now-this.started)/24),travel=Math.ceil(r.width/8);
    const exit=Math.max(0,ticks-travel-60);
    c.clearRect(0,0,640,480);
    if(exit>travel){this.close();return;}
    const x=640-Math.min(r.width,ticks*8)+Math.min(r.width,exit*8);
    c.globalAlpha=Math.min(1,ticks*8/128,Math.max(0,1-exit*8/128));
    c.drawImage(r.bitmaps[0],x,0);
    // Native text is drawn separately from the translucent plate.
    c.globalAlpha=1;c.drawImage(this.ink,x+3+this.bounds.offsetX,3+this.bounds.offsetY);
    this.frameTask=this.clock.requestFrame(time=>{this.frameTask=null;this.draw(time);});
  }
  close(){
    this.frameTask?.cancel();this.frameTask=null;this.root.hidden=true;
    this.context.clearRect(0,0,640,480);this.label.textContent='';
  }
}
