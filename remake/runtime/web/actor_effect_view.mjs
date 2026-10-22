import {particleColumns} from './core/opening_presentation.mjs';

// 552437 alpha reveal, 550A28 falling pixels, 553A45 rising pixels.
// Source motion/counts are retained; Canvas RGBA and seeded columns approximate
// native RGB565/additive destination reads and process-global rand().
export class ActorEffectView {
  constructor(actor,kind) {
    const role=actor.role,action=role.actions.find(a=>a.index===actor.action);
    this.width=role.frame_width;this.height=role.frame_height;this.kind=kind;
    this.canvas=document.createElement('canvas');this.canvas.width=this.width;this.canvas.height=this.height+160;
    this.context=this.canvas.getContext('2d');
    const source=document.createElement('canvas');source.width=this.width;source.height=this.height;
    const ctx=source.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(action.bitmap,actor.frame*this.width,actor.direction*this.height,this.width,this.height,0,0,this.width,this.height);
    this.pixels=ctx.getImageData(0,0,this.width,this.height).data;
    this.output=this.context.createImageData(this.canvas.width,this.canvas.height);
    this.columns=particleColumns(this.width);this.lastTick=-1;
    this.update(0);
  }
  update(tick) {
    if(tick===this.lastTick)return;this.lastTick=tick;
    const data=this.output.data;data.fill(0);
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
    if(this.kind==='rise')ctx.globalCompositeOperation='lighter';
    ctx.drawImage(this.canvas,x,y-160);
  }
}
