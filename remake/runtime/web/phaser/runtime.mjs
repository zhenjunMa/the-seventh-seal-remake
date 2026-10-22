import {explorationScene} from './scenes/exploration_scene.mjs';
import {battleScene} from './scenes/battle_scene.mjs';
import {ActionClock} from './components/action_clock.mjs';

export class PhaserRuntime {
  static async create(options){const runtime=new PhaserRuntime(options);await runtime.ready;return runtime;}
  constructor({parent,focusTarget,onError=error=>{throw error;}}){
    const Phaser=globalThis.Phaser;
    if(Phaser?.VERSION!=='3.90.0')throw new Error('Phaser 3.90.0 本地运行库未加载，请检查 vendor/phaser');
    this.clock=new ActionClock();this.started=false;this.onError=onError;this.parent=parent;this.frame=null;
    const runtime=this;
    class RuntimeScene extends Phaser.Scene {
      constructor(){super({key:'runtime',active:true});}
      update(now){
        if(!runtime.started)return;
        try{runtime.clock.update(now);runtime.frame?.(now);}
        catch(error){runtime.started=false;runtime.onError(error);}
      }
    }
    this.ready=new Promise((resolve,reject)=>{
      this.game=new Phaser.Game({
        type:Phaser.CANVAS,parent,width:640,height:480,antialias:false,roundPixels:false,version:'0.8-phaser',
        backgroundColor:'#000000',banner:false,audio:{noAudio:true},
        // The existing input controller owns repeat/focus handling; audio owns
        // native cue selection. Do not install competing keyboard/audio systems.
        input:{keyboard:false,mouse:false,touch:false,gamepad:false},
        scale:{mode:Phaser.Scale.FIT,autoCenter:Phaser.Scale.CENTER_BOTH},
        scene:[RuntimeScene,explorationScene(Phaser),battleScene(Phaser,()=>{if(runtime.exploration)runtime.setMode('battle');})],
        callbacks:{postBoot:game=>game.events.once(Phaser.Core.Events.POST_STEP,()=>{
          try{
            this.exploration=game.scene.getScene('exploration');this.battle=game.scene.getScene('battle');
            this.canvas=game.canvas;this.canvas.setAttribute('aria-label','第七封印游戏画面');
            this.canvas.addEventListener('pointerdown',()=>focusTarget?.focus({preventScroll:true}));
            this.canvas.addEventListener('wheel',event=>{
              event.preventDefault();focusTarget?.dispatchEvent(new WheelEvent('wheel',{deltaY:event.deltaY,cancelable:true}));
            },{passive:false});
            this.setMode('exploration');resolve(this);
          }catch(error){reject(error);}
        })}
      });
    });
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(parent);
  }
  start(frame){this.frame=frame;this.started=true;}
  setMode(mode){
    this.mode=mode;this.exploration.sys.setVisible(mode==='exploration');this.battle.sys.setVisible(mode==='battle');
    this.parent.dataset.scene=mode;
  }
  presentMap(options){this.setMode('exploration');this.exploration.present(options);}
  resize(){this.game?.scale?.refresh();}
  // Render current display lists without advancing the game clock or world.
  // Used for synchronous transition captures; normal frames render in Phaser.
  flush(){const renderer=this.game.renderer;renderer.preRender();this.game.scene.render(renderer);renderer.postRender();}
  capture(source,target){
    if(source==='exploration')this.setMode('exploration');else this.setMode('battle');
    this.flush();
    const context=target.getContext('2d'),scale=Math.min(target.width/640,target.height/480);
    context.setTransform(1,0,0,1,0,0);context.clearRect(0,0,target.width,target.height);
    context.fillStyle='#000000';context.fillRect(0,0,target.width,target.height);
    context.drawImage(this.canvas,(target.width-640*scale)/2,(target.height-480*scale)/2,640*scale,480*scale);
    return target;
  }
  snapshot(){return {version:this.game.config.gameVersion,phaser:globalThis.Phaser.VERSION,renderer:'CANVAS',scene:this.mode,
    mapActors:this.exploration.actors.size,battleObjects:Object.fromEntries(Object.entries(this.battle.surface.pools).map(([key,pool])=>[key,pool.length]))};}
  destroy(){this.started=false;this.clock.destroy();this.resizeObserver.disconnect();this.game.destroy(true);}
}
