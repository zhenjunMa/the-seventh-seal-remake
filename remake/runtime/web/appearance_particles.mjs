// 552642 modes2/3 -> 550A28/550F12, with fresh zeroed records from550975.
// mode2: ev_307536a38945e5375b8ab1c0ea0dc56959b696bb033065aa1622ec9f6f7c0b3a.
// Pixels retain the source scanner's local columns; rendering uses the shared
// source-particle surface and a local visual RNG, separate from combat draws.
export class AppearanceParticles {
  constructor({pixels,anchor={x:0,y:0},random,screenWidth=640,mode=3}){
    Object.assign(this,{source:pixels,anchor,random,screenWidth,mode});this.reset();
  }
  reset(){
    const {source,anchor,random,screenWidth,mode}=this;
    this.particles=source.map(pixel=>({...pixel,life:random()%30+5,age:0,target_y:(-anchor.y)|0}));
    const columns=Array.from({length:screenWidth},(_,x)=>{
      const speed=(random()&(mode===2?6:7))+4,offset=(random()&0x6f)+40;
      if(mode===2)return {speed,offset:-offset};
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
