import {BattleSurface} from '../rendering/battle_surface.mjs';
import {ActionClock} from '../components/action_clock.mjs';

export function battleScene(Phaser,runtime){
  return class BattleScene extends Phaser.Scene {
    constructor(){super({key:'battle',active:true});}
    create(){
      this.clock=new ActionClock();this.skipDelta=true;
      this.surface=new BattleSurface(this);this.cameras.main.setBackgroundColor('#000000');
      const resetDelta=()=>{this.skipDelta=true;};
      this.events.on('wake',resetDelta);this.events.on('resume',resetDelta);
      const dispose=()=>{
        this.events.off('shutdown',dispose);this.events.off('destroy',dispose);
        this.events.off('wake',resetDelta);this.events.off('resume',resetDelta);
        this.clock.destroy();this.surface.destroy();
      };
      this.events.once('shutdown',dispose);this.events.once('destroy',dispose);
    }
    update(_now,delta){runtime.updateScene('battle',this,delta);}
  };
}
