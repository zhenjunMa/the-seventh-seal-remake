/** Enemy disappearance, derived from GAME.exe 553332..555259 and callbacks.
 * Native particles advance per render, separately from the 220ms state clock.
 * We use a fixed 60Hz presentation cadence, and a local visual RNG: neither
 * browser refresh rate nor particle draws may alter the combat RNG stream.
 * Evidence: runtime/evidence/enemy_death_20261028/native_particles.json.
 */
import {AppearanceParticles} from './appearance_particles.mjs';
export const DEATH_PARTICLE_TIMING=Object.freeze({
  render_ms:1000/60,hard_elapsed_raw:30,
  // First render with no live pixels, including the final empty render.
  max_render_calls:Object.freeze({1:35,2:30,3:30,4:29,5:30,6:21,7:31}),
});

export function deathVisualRandom(seed){
  let state=2166136261;
  for(const char of String(seed))state=Math.imul(state^char.charCodeAt(0),16777619)>>>0;
  return ()=>{state=(Math.imul(state,214013)+2531011)>>>0;return (state>>>16)&32767;};
}

// Keep the RGB565 component arithmetic: blackening additive particles are
// materially different from making the whole sprite translucent.
export function deathParticleColor(rgb,age,mode){
  const r=rgb[0]>>3,g=rgb[1]>>2,b=rgb[2]>>3;
  const component=(value,max)=>Math.max(0,Math.min(max,value-age*(mode===6?2:1)));
  return [Math.round(component(r,31)*255/31),Math.round(component(g,63)*255/63),Math.round(component(b,31)*255/31)];
}

export class DeathParticles {
  constructor({mode,pixels,anchor={x:0,y:0},random=deathVisualRandom(mode),screenWidth=640}){
    if(!DEATH_PARTICLE_TIMING.max_render_calls[mode]||!Array.isArray(pixels))throw new TypeError('Enemy disappearance source invalid');
    this.mode=mode;this.source=pixels;this.anchor=anchor;this.random=random;this.screenWidth=screenWidth;
    this.reset();
  }
  reset(){
    const {mode,source,anchor,random}=this;
    this.particles=source.map(pixel=>{
      const x=pixel.x,y=pixel.y,vx=x-anchor.x,vy=y-anchor.y;
      const life=mode===1?random()%25+10:mode===4?28:mode===6?20:mode===7?30:random()%30;
      const speed=mode===1?((Math.min(Math.abs(vx),Math.abs(vy))>>2)+1+random())&3:mode===3?(random()&3)+1:0;
      return {...pixel,x,y,ox:x,oy:y,vx,vy,life,speed,age:0};
    });
    if(mode===1||mode===3){
      // 553036: the first unassigned pixel shares its speed with all nearby
      // unassigned pixels (Chebyshev radius2/3). Buckets avoid the native O(n²).
      const radius=mode===1?2:3,buckets=new Map(),key=(x,y)=>`${x},${y}`;
      for(const p of this.particles){const k=key(Math.floor(p.x/(radius+1)),Math.floor(p.y/(radius+1)));if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(p);}
      for(const p of this.particles)if(!p.assigned){
        p.assigned=true;const bx=Math.floor(p.x/(radius+1)),by=Math.floor(p.y/(radius+1));
        for(let y=by-1;y<=by+1;y++)for(let x=bx-1;x<=bx+1;x++)for(const q of buckets.get(key(x,y))??[])
          if(!q.assigned&&Math.abs(p.x-q.x)<=radius&&Math.abs(p.y-q.y)<=radius){q.speed=p.speed;q.assigned=true;}
      }
    }
    if(mode===2||mode===5){
      const columns=Array.from({length:this.screenWidth},(_,x)=>(mode===5&&x%2===0?1:-1)*((random()&3)+2));
      for(const p of this.particles)p.speed=columns[((p.x%this.screenWidth)+this.screenWidth)%this.screenWidth];
    }
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const p of source){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}
    this.cx=source.length?(minX+maxX)>>1:0;
    this.cy=source.length?(minY+maxY)>>1:0;
    this.angle=0;this.calls=0;this.visible=[];
  }
  step(){
    const {mode}=this;this.visible=[];
    for(const p of this.particles){
      if(p.age<p.life){
        this.visible.push({x:p.x,y:p.y,rgb:deathParticleColor(p.rgb,p.age,mode),original:mode===4?{x:p.ox,y:p.oy,rgb:p.rgb}:null});
        if(mode===7){p.vx=p.x-this.cx;p.vy=p.y-this.cy;}
      }
      p.age++;
      if(mode===1){
        if(Math.abs(p.vx)>Math.abs(p.vy)){
          p.x+=(p.vx>0?1:-1)*p.speed;
          if(p.vx)p.y+=(p.vy>0?1:-1)*Math.abs(Math.trunc(p.speed*p.vy/p.vx));
        }else{
          p.y+=(p.vy>0?1:-1)*p.speed;
          if(p.vy)p.x+=(p.vx>0?1:-1)*Math.abs(Math.trunc(p.speed*p.vx/p.vy));
        }
      }else if(mode===2||mode===5)p.y+=p.speed;
      else if(mode===3)p.y=p.y<this.anchor.y?p.y+p.speed:this.anchor.y;
      else if(mode===4)p.y-=5;
      else if(mode===6){p.x+=p.ox<this.cx?-1:1;p.y+=p.oy<this.cy?-1:1;}
      else if(mode===7){
        const a=this.angle*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
        p.x=Math.trunc(p.vx*c-p.vy*s+this.cx);p.y=Math.trunc(p.vx*s+p.vy*c+this.cy);
      }
    }
    if(mode===7){this.cy-=3;this.angle=(this.angle+2)%360;}
    this.calls++;return this.visible.length>0;
  }
}

/** Rasterize only this actor's occupied main-layer pixels, then upload one
 * small changing texture. Intrinsic light is not a second particle source.
 * Source sampling uses the remake's nearest-neighbour scale/anchor contract.
 */
export function createDeathParticleSurface({rgba,width,height,anchor,mode,seed,appearance=false}){
  const pixels=[];
  const originX=Math.round(anchor.x),originY=Math.round(anchor.y);
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4;if(!rgba[i+3])continue;
    const px=x-originX,py=y-originY;
    pixels.push({x:px,y:py,rgb:[rgba[i],rgba[i+1],rgba[i+2]]});
    left=Math.min(left,px);top=Math.min(top,py);right=Math.max(right,px);bottom=Math.max(bottom,py);
  }
  const effect=appearance?new AppearanceParticles({pixels,anchor:{x:originX,y:originY},random:deathVisualRandom(seed)})
    :new DeathParticles({mode,pixels,random:deathVisualRandom(seed)});
  if(!pixels.length){effect.draw=()=>{};return effect;}
  if(appearance){top=Math.min(top,-originY);bottom=Math.max(bottom,-originY);}
  // At most35 calls: translation<=175; spin stays within the source radius.
  const pad=Math.ceil(Math.max(192,Math.hypot(right-left,bottom-top)));
  left=Math.floor(left)-pad;top=Math.floor(top)-pad;
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(right-left)+pad+1;canvas.height=Math.ceil(bottom-top)+pad+1;
  const ctx=canvas.getContext('2d'),frame=ctx.createImageData(canvas.width,canvas.height),data=frame.data;
  const base=mode===4||appearance?document.createElement('canvas'):null;
  if(base){base.width=canvas.width;base.height=canvas.height;base.battleParticleRevision=0;}
  const baseCtx=base?.getContext('2d'),baseFrame=baseCtx?.createImageData(canvas.width,canvas.height);
  canvas.battleParticleRevision=0;
  effect.draw=(target,x,y)=>{
    data.fill(0);baseFrame?.data.fill(0);
    const put=(p,destination,additive)=>{
      const px=Math.trunc(p.x-left),py=Math.trunc(p.y-top);if(px<0||py<0||px>=canvas.width||py>=canvas.height)return;
      const i=(py*canvas.width+px)*4;
      for(let k=0;k<3;k++)destination[i+k]=additive?Math.min(255,destination[i+k]+p.rgb[k]):p.rgb[k];
      destination[i+3]=255;
    };
    for(const p of effect.visible){if(p.original)put(p.original,baseFrame.data,false);put(p,data,true);}
    ctx.putImageData(frame,0,0);canvas.battleParticleRevision++;
    target.save();target.globalAlpha=1;
    if(base){baseCtx.putImageData(baseFrame,0,0);base.battleParticleRevision++;target.globalCompositeOperation='source-over';target.drawImage(base,x+left,y+top);}
    target.globalCompositeOperation='lighter';
    target.drawImage(canvas,x+left,y+top);target.restore();
  };
  return effect;
}

// 220ms updates only the source elapsed counter. Native elapsed0 repeatedly
// initializes the particles; once it advances, ~20..35 render calls finish.
export class DeathParticlePlayback {
  constructor({mode,clock_ms,started,effect=null}){Object.assign(this,{mode,clock_ms,started,effect,tick:-1,calls:0,elapsed:0,done:false});}
  advance(now){
    if(this.done)return false;
    const target=Math.floor(Math.max(0,now-this.started)/DEATH_PARTICLE_TIMING.render_ms+1e-7);
    for(;this.tick<target&&!this.done;){
      const at=this.started+(++this.tick)*DEATH_PARTICLE_TIMING.render_ms;
      this.elapsed=Math.floor((at-this.started+1e-7)/this.clock_ms);
      if(this.elapsed===0){this.calls=0;this.effect?.reset();}
      this.calls++;
      const active=this.effect?this.effect.step():this.calls<DEATH_PARTICLE_TIMING.max_render_calls[this.mode];
      this.done=!active||this.elapsed>=DEATH_PARTICLE_TIMING.hard_elapsed_raw;
    }
    return !this.done;
  }
}
