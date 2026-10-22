import {TextureCache} from './texture_cache.mjs';

const properties=['globalAlpha','globalCompositeOperation','fillStyle','strokeStyle','lineWidth','font','textAlign','lineJoin'];
const rgba=value=>{
  let hex=String(value).replace('#','');
  if(hex.length===3||hex.length===4)hex=[...hex].map(c=>c+c).join('');
  if(!/^[a-f\d]{6}([a-f\d]{2})?$/i.test(hex))throw new Error(`未支持的绘制颜色：${value}`);
  return {color:parseInt(hex.slice(0,6),16),alpha:hex.length===8?parseInt(hex.slice(6),16)/255:1};
};
const intersect=(a,b)=>{const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y);
  return {x,y,width:Math.max(0,Math.min(a.x+a.width,b.x+b.width)-x),height:Math.max(0,Math.min(a.y+a.height,b.y+b.height)-y)};};

// A narrow compatibility boundary for the source-backed battle presentation.
// Commands become pooled Phaser Sprites, Graphics and Text, rather than a
// full-frame Canvas upload. Source atlas regions and native clocks stay intact.
export class BattleSurface {
  constructor(scene,onBegin=()=>{}){
    this.scene=scene;this.onBegin=onBegin;this.textures=new TextureCache(scene);
    this.pools={sprite:[],graphics:[],text:[]};this.gradients=new Map();
    this.canvas={width:640,height:480,getContext:()=>this};this.beginFrame();
  }
  beginFrame(){
    this.onBegin();
    this.cursor={sprite:0,graphics:0,text:0};this.order=0;this.stack=[];this.matrix=[1,0,0,1,0,0];
    this.clipRect={x:0,y:0,width:640,height:480};this.path=[];
    Object.assign(this,{globalAlpha:1,globalCompositeOperation:'source-over',fillStyle:'#000000',strokeStyle:'#000000',lineWidth:1,font:'12px sans-serif',textAlign:'left',lineJoin:'miter'});
    for(const pool of Object.values(this.pools))for(const object of pool)object.setVisible(false);
    this.textures.begin();
  }
  endFrame(){this.textures.prune();}
  take(kind){
    const index=this.cursor[kind]++,pool=this.pools[kind];let object=pool[index];
    if(!object){
      object=kind==='sprite'?this.scene.add.sprite(0,0,'__WHITE').setOrigin(0)
        :kind==='graphics'?this.scene.add.graphics():this.scene.add.text(0,0,'');
      pool.push(object);
    }
    object.setVisible(true).setDepth(this.order++).setAlpha(this.globalAlpha)
      .setBlendMode(this.globalCompositeOperation==='lighter'?'ADD':'NORMAL');
    if(kind==='graphics')object.clear();
    return object;
  }
  save(){this.stack.push({matrix:[...this.matrix],clipRect:{...this.clipRect},...Object.fromEntries(properties.map(k=>[k,this[k]]))});}
  restore(){const state=this.stack.pop();if(state)Object.assign(this,state);}
  setTransform(a,b,c,d,e,f){
    if(b!==0||c!==0)throw new Error('战斗适配器仅支持原动作使用的平移和缩放');
    this.matrix=[a,b,c,d,e,f];
  }
  translate(x,y){this.matrix[4]+=x*this.matrix[0];this.matrix[5]+=y*this.matrix[3];}
  scale(x,y){this.matrix[0]*=x;this.matrix[3]*=y;}
  point(x,y){return {x:x*this.matrix[0]+this.matrix[4],y:y*this.matrix[3]+this.matrix[5]};}
  rectangle(x,y,width,height){const p=this.point(x,y);return {...p,width:width*this.matrix[0],height:height*this.matrix[3]};}
  // BattleView clears at the beginning of a frame; beginFrame owns disposal.
  clearRect(){}
  drawImage(source,...args){
    let sx=0,sy=0,sw=source.width,sh=source.height,dx,dy,dw=sw,dh=sh;
    if(args.length===2)[dx,dy]=args;
    else if(args.length===4)[dx,dy,dw,dh]=args;
    else if(args.length===8)[sx,sy,sw,sh,dx,dy,dw,dh]=args;
    else throw new Error('Phaser 图片坐标参数无效');
    const target=this.rectangle(dx,dy,dw,dh),visible=intersect(target,this.clipRect);
    if(sw<=0||sh<=0||visible.width<=0||visible.height<=0)return;
    // Clip both against the source dimensions and the active logical viewport.
    const bounds=intersect({x:sx,y:sy,width:sw,height:sh},{x:0,y:0,width:source.width,height:source.height});
    const area=intersect(visible,{x:target.x+(bounds.x-sx)*target.width/sw,y:target.y+(bounds.y-sy)*target.height/sh,
      width:bounds.width*target.width/sw,height:bounds.height*target.height/sh});
    if(area.width<=0||area.height<=0)return;
    const frame=this.textures.region(source,sx+(area.x-target.x)*sw/target.width,sy+(area.y-target.y)*sh/target.height,
      area.width*sw/target.width,area.height*sh/target.height,`draw:${this.cursor.sprite}`);
    this.take('sprite').setTexture(frame.key,frame.frame).setPosition(area.x,area.y).setDisplaySize(area.width,area.height);
  }
  createLinearGradient(...points){return {points,stops:[],addColorStop(at,color){this.stops.push([at,color]);}};}
  fillRect(x,y,width,height){
    if(typeof this.fillStyle==='object'){
      const style=this.fillStyle,key=JSON.stringify([style,width,height]);let image=this.gradients.get(key);
      if(!image){image=document.createElement('canvas');image.width=Math.ceil(width);image.height=Math.ceil(height);
        const c=image.getContext('2d'),gradient=c.createLinearGradient(...style.points);
        for(const [at,color]of style.stops)gradient.addColorStop(at,color);
        c.fillStyle=gradient;c.fillRect(0,0,width,height);this.gradients.set(key,image);}
      this.drawImage(image,x,y,width,height);return;
    }
    const r=intersect(this.rectangle(x,y,width,height),this.clipRect);if(!r.width||!r.height)return;
    const style=rgba(this.fillStyle);this.take('graphics').fillStyle(style.color,style.alpha).fillRect(r.x,r.y,r.width,r.height);
  }
  beginPath(){this.path=[];}
  rect(x,y,width,height){this.path.push({kind:'rect',...this.rectangle(x,y,width,height)});}
  clip(){for(const r of this.path)if(r.kind==='rect')this.clipRect=intersect(this.clipRect,r);}
  moveTo(x,y){this.path.push({kind:'move',...this.point(x,y)});}
  lineTo(x,y){this.path.push({kind:'line',...this.point(x,y)});}
  ellipse(x,y,rx,ry){this.path.push({kind:'ellipse',...this.point(x,y),width:rx*2*this.matrix[0],height:ry*2*this.matrix[3]});}
  fill(){
    const style=rgba(this.fillStyle),g=this.take('graphics').fillStyle(style.color,style.alpha);
    for(const p of this.path)if(p.kind==='ellipse')g.fillEllipse(p.x,p.y,p.width,p.height);
  }
  stroke(){
    const style=rgba(this.strokeStyle),g=this.take('graphics').lineStyle(this.lineWidth*this.matrix[0],style.color,style.alpha).beginPath();
    for(const p of this.path)if(p.kind==='move')g.moveTo(p.x,p.y);else if(p.kind==='line')g.lineTo(p.x,p.y);
      else if(p.kind==='ellipse')g.strokeEllipse(p.x,p.y,p.width,p.height);
    g.strokePath();
  }
  text(value,x,y,outline){
    const p=this.point(x,y),text=this.take('text');
    text.setStyle({font:this.font,color:outline?'rgba(0,0,0,0)':this.fillStyle,
      stroke:outline?this.strokeStyle:'#000000',strokeThickness:outline?this.lineWidth:0,padding:4});
    text.setText(String(value)).setOrigin(this.textAlign==='center' ? 0.5 : this.textAlign==='right' ? 1 : 0,0)
      .setScale(this.matrix[0],this.matrix[3]);
    const baseline=text.getTextMetrics().ascent+4;
    text.setPosition(p.x,p.y-baseline*this.matrix[3]);
  }
  strokeText(value,x,y){this.text(value,x,y,true);}
  fillText(value,x,y){this.text(value,x,y,false);}
  destroy(){for(const pool of Object.values(this.pools))for(const object of pool)object.destroy();this.textures.destroy();this.gradients.clear();}
}
