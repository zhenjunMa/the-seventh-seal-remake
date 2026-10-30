import {mapPresentation} from '../../core/map_presentation.mjs';
import {TextureCache} from '../rendering/texture_cache.mjs';
import {MapActor} from '../actors/map_actor.mjs';
import {ActionClock} from '../components/action_clock.mjs';

export function explorationScene(Phaser,runtime){
  return class ExplorationScene extends Phaser.Scene {
    constructor(){super({key:'exploration',active:true});}
    create(){
      this.clock=new ActionClock();this.skipDelta=true;
      this.texturesAdapter=new TextureCache(this);this.actors=new Map();
      this.background=this.add.container().setDepth(-2);this.backgroundTiles=[];
      this.collision=this.add.graphics().setDepth(-1);this.marker=this.add.graphics();this.sourceScene=null;
      this.cameras.main.setBackgroundColor('#0e191b');
      const resetDelta=()=>{this.skipDelta=true;};
      this.events.on('wake',resetDelta);this.events.on('resume',resetDelta);
      const dispose=()=>{
        this.events.off('shutdown',dispose);this.events.off('destroy',dispose);
        this.events.off('wake',resetDelta);this.events.off('resume',resetDelta);
        this.clock.destroy();this.clearActors();this.texturesAdapter.destroy();this.sourceScene=null;
      };
      this.events.once('shutdown',dispose);this.events.once('destroy',dispose);
    }
    update(_now,delta){runtime.updateScene('exploration',this,delta);}
    clearActors(){for(const actor of this.actors.values())actor.destroy();this.actors.clear();}
    present(options){
      const {scene,view,openingQueue,nearest}=options;if(!scene)return;
      const textures=this.texturesAdapter;textures.begin();
      if(this.sourceScene!==scene){this.clearActors();this.sourceScene=scene;}
      const tiles=textures.tiles(scene.bitmap);
      for(let i=0;i<tiles.length;i++){const tile=tiles[i];let image=this.backgroundTiles[i];
        if(!image){image=this.add.image(0,0,'__WHITE').setOrigin(0);this.background.add(image);this.backgroundTiles.push(image);}
        image.setVisible(true).setPosition(tile.x,tile.y).setTexture(tile.key,tile.frame);}
      for(let i=tiles.length;i<this.backgroundTiles.length;i++)this.backgroundTiles[i].setVisible(false);
      const zoom=options.nativeViewport?1:view.zoom;
      this.cameras.main.setZoom(zoom).setScroll(view.x-320,view.y-240);
      // Phaser zooms around the camera centre, matching the original 640x480 plane.
      const entries=mapPresentation(options),live=new Set();
      for(let index=0;index<entries.length;index++){
        const entry=entries[index],key=entry.key??`opening:${index}`;
        if(!entry.pose)throw new Error(`Phaser 地图显示描述缺失：${key}`);
        live.add(key);let actor=this.actors.get(key);
        if(!actor){actor=new MapActor(this,textures,key);this.actors.set(key,actor);}
        actor.sync(entry,index);
      }
      for(const [key,actor]of this.actors)if(!live.has(key)){actor.destroy();this.actors.delete(key);}
      this.collision.clear();
      if(view.collision)for(let y=0;y<scene.movement.height;y++)for(let x=0;x<scene.movement.width;x++){
        const cell=scene.movement.cell(x,y);this.collision.fillStyle(cell.trigger?0xe6bd68:cell.blocked?0xd14d47:0x78c796,cell.trigger ? 0.333 : cell.blocked ? 0.22 : 0.137);
        this.collision.fillRect(x*16,y*16,16,16);
      }
      this.marker.clear().setDepth(entries.length+1);
      if(nearest&&openingQueue===null)this.marker.lineStyle(1/zoom,0xedd19b).strokeEllipse(nearest.x+16,nearest.y+6,38,12);
      textures.prune();
    }
  };
}
