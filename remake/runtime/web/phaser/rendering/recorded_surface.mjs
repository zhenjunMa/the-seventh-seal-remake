// A small retained drawing list, not a raster canvas. Logical UI coordinates
// are replayed into Phaser objects; only glyph generation uses CPU bitmaps.
const fields=['globalAlpha','globalCompositeOperation','fillStyle','strokeStyle','lineWidth','font','textAlign','textBaseline'];
export class RecordedSurface {
  constructor(canvas,onChange=()=>{}){this.canvas=canvas;this.onChange=onChange;this.commands=[];this.revision=0;this.reset();}
  reset(){this.matrix=[1,0,0,1,0,0];this.clipRect={x:0,y:0,width:this.canvas.width,height:this.canvas.height};this.stack=[];this.path=[];
    Object.assign(this,{globalAlpha:1,globalCompositeOperation:'source-over',fillStyle:'#000',strokeStyle:'#000',lineWidth:1,font:'12px sans-serif',textAlign:'left',textBaseline:'alphabetic'});}
  save(){this.stack.push({matrix:[...this.matrix],clipRect:{...this.clipRect},...Object.fromEntries(fields.map(k=>[k,this[k]]))});}
  restore(){const state=this.stack.pop();if(state)Object.assign(this,state);}
  setTransform(a,b,c,d,e,f){if(b||c)throw new Error('界面绘制仅支持平移和缩放');this.matrix=[a,b,c,d,e,f];}
  resetTransform(){this.setTransform(1,0,0,1,0,0);}
  translate(x,y){this.matrix[4]+=x*this.matrix[0];this.matrix[5]+=y*this.matrix[3];}
  scale(x,y){this.matrix[0]*=x;this.matrix[3]*=y;}
  rectangle(x,y,width,height){const m=this.matrix;return {x:x*m[0]+m[4],y:y*m[3]+m[5],width:width*m[0],height:height*m[3]};}
  clearRect(x,y,width,height){
    if(x>0||y>0||x+width<this.canvas.width||y+height<this.canvas.height)throw new Error('界面必须完整重绘，不能局部清除绘制列表');
    this.commands.length=0;this.changed();
  }
  changed(){this.revision++;this.onChange();}
  push(command){this.commands.push({...command,alpha:this.globalAlpha,blend:this.globalCompositeOperation,clip:{...this.clipRect}});this.changed();}
  drawImage(source,...args){
    let sx=0,sy=0,sw=source.width,sh=source.height,dx,dy,dw=sw,dh=sh;
    if(args.length===2)[dx,dy]=args;else if(args.length===4)[dx,dy,dw,dh]=args;
    else if(args.length===8)[sx,sy,sw,sh,dx,dy,dw,dh]=args;else throw new Error('界面图片坐标无效');
    this.push({kind:'image',source,sx,sy,sw,sh,...this.rectangle(dx,dy,dw,dh)});
  }
  fillRect(x,y,w,h){this.push({kind:'fill',style:this.fillStyle,...this.rectangle(x,y,w,h)});}
  strokeRect(x,y,w,h){this.push({kind:'stroke',style:this.strokeStyle,lineWidth:this.lineWidth*this.matrix[0],...this.rectangle(x,y,w,h)});}
  fillText(value,x,y,maxWidth){this.push({kind:'text',value:String(value),font:this.font,style:this.fillStyle,align:this.textAlign,baseline:this.textBaseline,maxWidth,...this.rectangle(x,y,0,0)});}
  beginPath(){this.path=[];}
  rect(x,y,w,h){this.path.push(this.rectangle(x,y,w,h));}
  clip(){for(const r of this.path){const c=this.clipRect,x=Math.max(c.x,r.x),y=Math.max(c.y,r.y);this.clipRect={x,y,width:Math.max(0,Math.min(c.x+c.width,r.x+r.width)-x),height:Math.max(0,Math.min(c.y+c.height,r.y+r.height)-y)};}}
  paint(target,{sx=0,sy=0,sw=this.canvas.width,sh=this.canvas.height,x=0,y=0,width=sw,height=sh}={}){
    if(!sw||!sh)return;const ax=width/sw,ay=height/sh,alpha=target.globalAlpha??1,inheritedBlend=target.globalCompositeOperation;
    target.save();target.translate(x,y);target.scale(ax,ay);target.translate(-sx,-sy);
    target.beginPath();target.rect(sx,sy,sw,sh);target.clip();
    for(const c of this.commands){target.save();target.beginPath();target.rect(c.clip.x,c.clip.y,c.clip.width,c.clip.height);target.clip();
      target.globalAlpha=alpha*c.alpha;target.globalCompositeOperation=inheritedBlend==='lighter'?'lighter':c.blend;
      if(c.kind==='image')target.drawImage(c.source,c.sx,c.sy,c.sw,c.sh,c.x,c.y,c.width,c.height);
      else if(c.kind==='fill'){target.fillStyle=c.style;target.fillRect(c.x,c.y,c.width,c.height);}
      else if(c.kind==='stroke'){target.strokeStyle=c.style;target.lineWidth=c.lineWidth;target.strokeRect(c.x,c.y,c.width,c.height);}
      else{target.fillStyle=c.style;target.font=c.font;target.textAlign=c.align;target.textBaseline=c.baseline;target.fillText(c.value,c.x,c.y,c.maxWidth);}
      target.restore();
    }
    target.restore();
  }
}

let compositor=null;
export function installInterfaceCompositor(value){compositor=value;}
export function drawingContext(canvas,{embedded=false}={}){
  // Standalone source comparison tools and headless component fixtures do not
  // start the production renderer. They may still rasterize an auxiliary image.
  if(!compositor)return canvas.getContext('2d');
  if(!canvas.gpuSurface)canvas.gpuSurface=new RecordedSurface(canvas,()=>compositor?.invalidate());
  compositor.register(canvas,{embedded});
  return canvas.gpuSurface;
}
export function registerGlyph(canvas){
  canvas.gpuRasterRevision=(canvas.gpuRasterRevision??0)+1;
  compositor?.register(canvas,{glyph:true});compositor?.invalidate();
}
