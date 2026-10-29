import {particleColumns} from './core/opening_presentation.mjs';

// 552437 alpha reveal, 550A28 falling pixels, 553A45 rising pixels,
// 553332 dispersal (ANM41 mode0). The latter keeps source per-pixel rays,
// 10..34 tick lifetimes, neighbouring speed groups and the 30-tick cutoff.
// Source motion/counts are retained; Canvas RGBA and seeded columns approximate
// native RGB565/additive destination reads and process-global rand().
export class ActorEffectView {
  constructor(actor,kind) {
    const role=actor.role,action=role.actions.find(a=>a.index===actor.action);
    this.width=role.frame_width;this.height=role.frame_height;this.kind=kind;
    this.offsetX=kind==='scatter'?160:0;
    this.canvas=document.createElement('canvas');this.canvas.width=this.width+this.offsetX*2;this.canvas.height=this.height+160;
    this.context=this.canvas.getContext('2d');
    const source=document.createElement('canvas');source.width=this.width;source.height=this.height;
    const ctx=source.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(action.bitmap,actor.frame*this.width,actor.direction*this.height,this.width,this.height,0,0,this.width,this.height);
    this.pixels=ctx.getImageData(0,0,this.width,this.height).data;
    this.output=this.context.createImageData(this.canvas.width,this.canvas.height);
    this.columns=particleColumns(this.width);this.lastTick=-1;
    if(kind==='scatter'){
      let seed=13;const random=()=>{seed=(Math.imul(seed,214013)+2531011)>>>0;return (seed>>>16)&32767;};
      this.particles=[];const coordinates=new Map();
      for(let y=0;y<this.height;y++)for(let x=0;x<this.width;x++){
        const at=(y*this.width+x)*4;if(!this.pixels[at+3])continue;
        const dx=x-(this.width>>1)-role.anchor.x,dy=y-this.height-role.anchor.y-32;
        const particle={x,y,at,dx,dy,life:random()%25+10,speed:((Math.min(Math.abs(dx),Math.abs(dy))>>2)+1+random())&3};
        this.particles.push(particle);coordinates.set(y*this.width+x,particle);
      }
      for(const particle of this.particles){
        if(particle.grouped)continue;particle.grouped=true;
        for(let y=Math.max(0,particle.y-2);y<=Math.min(this.height-1,particle.y+2);y++)
          for(let x=Math.max(0,particle.x-2);x<=Math.min(this.width-1,particle.x+2);x++){
            const other=coordinates.get(y*this.width+x);
            if(other&&!other.grouped){other.grouped=true;other.speed=particle.speed;}
          }
      }
    }
    this.update(0);
  }
  update(tick) {
    if(tick===this.lastTick)return;this.lastTick=tick;
    const data=this.output.data;data.fill(0);
    if(this.kind==='scatter'){
      for(const p of this.particles){
        if(tick>29||tick>=p.life)continue;
        let dx=0,dy=0;
        if(Math.abs(p.dx)>Math.abs(p.dy)){dx=Math.sign(p.dx)*p.speed;dy=p.dx===0?0:Math.sign(p.dy)*Math.abs(Math.trunc(p.speed*p.dy/p.dx));}
        else{dy=Math.sign(p.dy)*p.speed;dx=p.dy===0?0:Math.sign(p.dx)*Math.abs(Math.trunc(p.speed*p.dx/p.dy));}
        const x=p.x+this.offsetX+dx*tick,y=p.y+160+dy*tick;
        if(x<0||x>=this.canvas.width||y<0||y>=this.canvas.height)continue;
        const out=(y*this.canvas.width+x)*4;
        for(let color=0;color<3;color++)data[out+color]=Math.min(255,data[out+color]+Math.max(0,this.pixels[p.at+color]-tick*(color===1?4:8)));
        data[out+3]=this.pixels[p.at+3];
      }
      this.context.putImageData(this.output,0,0);return;
    }
    for(let y=0;y<this.height;y++)for(let x=0;x<this.width;x++){
      const at=(y*this.width+x)*4;if(!this.pixels[at+3])continue;
      const column=this.columns[x],rise=this.kind==='rise';
      const targetY=y+160+(rise?column.riseSpeed*tick:Math.min(0,-column.fallOffset+column.fallSpeed*tick));
      if(targetY<0||targetY>=this.canvas.height)continue;
      const out=(targetY*this.width+x)*4;
      data[out]=Math.max(0,this.pixels[at]-(rise?tick*8:0));
      data[out+1]=Math.max(0,this.pixels[at+1]-(rise?tick*4:0));
      data[out+2]=Math.max(0,this.pixels[at+2]-(rise?tick*8:0));
      data[out+3]=this.pixels[at+3];
    }
    this.context.putImageData(this.output,0,0);
  }
  draw(ctx,x,y) {
    if(['rise','scatter'].includes(this.kind))ctx.globalCompositeOperation='lighter';
    ctx.drawImage(this.canvas,x-this.offsetX,y-160);
  }
}
