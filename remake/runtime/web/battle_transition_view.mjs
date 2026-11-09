// Original logical frame counts and delay directions. The production view
// delegates drawing to WebGL; it never reads or rasterizes a scene image.
export function battleTransitionFrame(kind,frame){
  const count=[16,64,16,16,20,30,20][kind];
  return {count,delay:kind===0||kind===2?Math.max(0,90-frame*6):kind===3?90+frame*6:kind===4?30:40};
}
export const BATTLE_TRANSITION_MS=1000;
export const BATTLE_FLASH_COVER_MS=650;

// Preserve the source poses and relative cadence on a shared entry timeline.
export function battleTransitionTimeline(kind){
  const {count}=battleTransitionFrame(kind,0);
  const times=[0];
  for(let frame=1;frame<count;frame++)times.push(times.at(-1)+battleTransitionFrame(kind,frame-1).delay);
  const duration=times.at(-1);
  return times.map(time=>time/duration*BATTLE_TRANSITION_MS);
}
export class BattleTransitionView {
  constructor({renderer,log,random=Math.random,clock}={}){Object.assign(this,{renderer,log,random,clock});}
  capture(source){if(!this.renderer)throw new Error('WebGL 转场后端尚未准备');return this.renderer.capture(source);}
  async run(before,paintBattle,{kind=Math.floor(this.random()*7),signal,onCovered,startedAt}={}){
    if(!Number.isInteger(kind)||kind<0||kind>6)throw new Error('入战转场类型无效');
    if(!this.renderer)throw new Error('WebGL 转场后端尚未准备');
    return this.renderer.run(before,paintBattle,{kind,signal,onCovered,startedAt,random:this.random,clock:this.clock,log:this.log});
  }
  cancel(){this.renderer?.cancel();}
}
