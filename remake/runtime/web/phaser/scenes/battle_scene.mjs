import {BattleSurface} from '../rendering/battle_surface.mjs';

export function battleScene(Phaser,onBegin){
  return class BattleScene extends Phaser.Scene {
    constructor(){super({key:'battle',active:true});}
    create(){
      this.surface=new BattleSurface(this,onBegin);this.cameras.main.setBackgroundColor('#000000');
      this.events.once('shutdown',()=>this.surface.destroy());
    }
  };
}
