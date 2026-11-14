import {mapPresentation,mapViewport,mapPoseBounds} from '../../core/ui/map_presentation.mjs';
import {TextureCache} from '../rendering/texture_cache.mjs';
import {MapActor} from '../actors/map_actor.mjs';
import {ActionClock} from '../components/action_clock.mjs';
import {poseRegions} from '../components/sprite_pose.mjs';

const uploadBudgetMs=4;
const viewportMargin=96;
function viewport({view,nativeViewport},margin=0){
  return mapViewport(nativeViewport?{...view,zoom:1}:view,margin);
}

export function explorationScene(Phaser,runtime){
  return class ExplorationScene extends Phaser.Scene {
    constructor(){super({key:'exploration',active:true});}
    create(){
      this.clock=new ActionClock();this.skipDelta=true;
      this.texturesAdapter=new TextureCache(this);this.actors=new Map();
      this.background=this.add.container().setDepth(-2);this.backgroundTiles=[];
      this.collision=this.add.graphics().setDepth(-1);this.marker=this.add.graphics();this.sourceScene=null;
      this.cameras.main.setBackgroundColor('#0e191b');
      runtime.configureCamera(this.cameras.main);
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
    async prepareViewport(options,{signal,isCurrent=()=>true,preload=false}={}){
      const textures=this.texturesAdapter;
      if(preload&&this.viewportPreparation)return false;
      const prepared=this.viewportPreparation=new Set();
      try{
        const visible=viewport(options);
        const background=textures.tileRegions(options.scene.bitmap).filter(visible);
        signal?.throwIfAborted();
        const poses=mapPresentation(options).filter(({pose})=>visible(mapPoseBounds(pose)));
        const regions=[...background,...poses.flatMap(({pose})=>[...poseRegions(pose)])];
        if(preload)await new Promise((resolve,reject)=>runtime.clock.requestFrame(resolve,{signal,onCancel:reject}));
        const budget=preload?2:uploadBudgetMs;
        let started=performance.now();
        for(const region of regions){
          if(!isCurrent()||this.viewportPreparation!==prepared)return false;
          let source=textures.regionSource(region);
          if(!textures.sources.has(source)){
            if(performance.now()-started>=budget){
              await new Promise((resolve,reject)=>runtime.clock.requestFrame(resolve,{signal,onCancel:reject}));
              if(!isCurrent()||this.viewportPreparation!==prepared)return false;
              started=performance.now();
            }
            // Legacy oversized PNGs need a synchronous canvas copy before upload.
            if(preload&&!source)continue;
            textures.uploadRegion(region);source=textures.regionSource(region);
          }
          prepared.add(source);
        }
        return true;
      }finally{
        if(this.viewportPreparation===prepared)this.viewportPreparation=null;
      }
    }
    present(options){
      const {scene,view,openingQueue,nearest}=options;if(!scene)return;
      const started=performance.now();
      const textures=this.texturesAdapter;textures.begin();
      const changed=this.sourceScene!==scene;
      if(changed){this.clearActors();this.sourceScene=scene;}
      const visible=viewport(options),near=viewport(options,viewportMargin);
      const tiles=textures.tileRegions(scene.bitmap),entries=mapPresentation(options),live=new Set();
      const nearbyTiles=[],nearbyPoses=[];
      let tileCount=0;
      for(const tile of tiles){
        if(!visible(tile)){if(near(tile))nearbyTiles.push(tile);continue;}
        const frame=textures.tileFrame(tile),i=tileCount++;
        let image=this.backgroundTiles[i];
        if(!image){image=this.add.image(0,0,'__WHITE').setOrigin(0);this.background.add(image);this.backgroundTiles.push(image);}
        image.setVisible(true).setPosition(tile.x,tile.y).setTexture(frame.key,frame.frame).setDisplaySize(tile.width,tile.height);
      }
      for(let i=tileCount;i<this.backgroundTiles.length;i++)this.backgroundTiles[i].setVisible(false);
      const zoom=options.nativeViewport?1:view.zoom;
      runtime.configureCamera(this.cameras.main,{x:view.x,y:view.y,zoom});
      // Phaser zooms around the camera centre, matching the original 640x480 plane.
      for(let index=0;index<entries.length;index++){
        const entry=entries[index],key=entry.key??`opening:${index}`;
        if(!entry.pose)throw new Error(`Phaser 地图显示描述缺失：${key}`);
        const bounds=mapPoseBounds(entry.pose);
        if(!visible(bounds)){
          if(near(bounds)){
            nearbyPoses.push(entry.pose);
            const actor=this.actors.get(key);
            if(actor){actor.container.setVisible(false);live.add(key);}
          }
          continue;
        }
        live.add(key);let actor=this.actors.get(key);
        if(!actor){actor=new MapActor(this,textures,key);this.actors.set(key,actor);}
        actor.sync(entry,index);
      }
      for(const [key,actor]of this.actors)if(!live.has(key)){actor.destroy();this.actors.delete(key);}
      this.collision.clear();
      if(view.collision){
        const {cellSize,width,height,rails}=scene.movement;
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){
          const cell=scene.movement.cell(x,y);this.collision.fillStyle(cell.trigger?0xe6bd68:cell.blocked?0xd14d47:0x78c796,cell.trigger ? 0.333 : cell.blocked ? 0.22 : 0.137);
          this.collision.fillRect(x*cellSize,y*cellSize,cellSize,cellSize);
        }
        this.collision.lineStyle(2,0xff765b);
        for(const {from,to} of rails??[])this.collision.lineBetween(from.x,from.y,to.x,to.y);
      }
      this.marker.clear().setDepth(entries.length+1);
      if(nearest&&openingQueue===null)this.marker.lineStyle(1/zoom,0xedd19b).strokeEllipse(nearest.x+16,nearest.y+6,38,12);
      if(this.viewportPreparation){
        for(const source of this.viewportPreparation){
          const entry=textures.sources.get(source);
          if(entry)entry.used=textures.frame;
        }
      }
      if(!changed&&runtime.phase==='map'&&!this.viewportPreparation){
        const candidates=function*(){
          yield* nearbyTiles;
          for(const pose of nearbyPoses)yield* poseRegions(pose);
        };
        for(const region of candidates()){
          if(performance.now()-started>=uploadBudgetMs)break;
          const source=textures.regionSource(region),entry=textures.sources.get(source);
          if(entry)entry.used=textures.frame;
          // Oversized legacy images need synchronous raster cuts. Leave those
          // to visible tiles rather than stall movement for speculative work.
          else if(source)textures.uploadRegion(region);
        }
      }
      textures.prune();
    }
  };
}
