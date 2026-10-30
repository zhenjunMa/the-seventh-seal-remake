// 552642 mode3 -> 550F12, with the fresh zeroed particle records from550975.
// Pixels retain the source scanner's local columns; rendering uses the shared
// source-particle surface and a local visual RNG, separate from combat draws.
export class AppearanceParticles {
  constructor({pixels,anchor={x:0,y:0},random,screenWidth=640}){
    Object.assign(this,{source:pixels,anchor,random,screenWidth});this.reset();
  }
  reset(){
    const {source,anchor,random,screenWidth}=this;
    this.particles=source.map(pixel=>({...pixel,life:random()%30+5,age:0,target_y:(-anchor.y)|0}));
    const columns=Array.from({length:screenWidth},(_,x)=>{
      const speed=(random()&7)+4,offset=(random()&0x6f)+40;
      return x&1?{speed:-speed,offset}:{speed,offset:-offset};
    });
    for(const p of this.particles){const column=columns[(p.x+anchor.x)%screenWidth];p.speed=column.speed;p.y+=column.offset;}
    this.calls=0;this.visible=[];
  }
  step(){
    let active=false;this.visible=[];
    for(const p of this.particles){
      const incoming=p.age<p.life;
      // Native RGB16 background subtraction uses the existing additive Canvas
      // adapter. Completed color records are copied normally, not faded out.
      this.visible.push({x:p.x,y:p.y,rgb:incoming?p.rgb:[0,0,0],original:incoming?null:{x:p.x,y:p.y,rgb:p.rgb}});
      active||=incoming;p.age++;p.y+=p.speed;
      if(p.speed>0){if(p.y>p.target_y)p.y=p.target_y;else active=true;}
      else if(p.y<p.target_y)p.y=p.target_y;else active=true;
    }
    this.calls++;return active;
  }
}
