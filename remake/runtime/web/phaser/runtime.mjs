import {explorationScene} from './scenes/exploration_scene.mjs';
import {battleScene} from './scenes/battle_scene.mjs';
import {ActionClock} from './components/action_clock.mjs';

export class PhaserRuntime {
  static async create(options){const runtime=new PhaserRuntime(options);await runtime.ready;return runtime;}
  constructor({parent,focusTarget,onError=error=>{throw error;}}){
    const Phaser=globalThis.Phaser;
    if(Phaser?.VERSION!=='3.90.0')throw new Error('Phaser 3.90.0 本地运行库未加载，请检查 vendor/phaser');
    this.clock=new ActionClock();this.started=false;this.onError=onError;this.parent=parent;
    this.adapters={};this.phase='boot';this.mode=null;this.pauseReasons=new Set();this.destroyed=false;
    this.listeners=new AbortController();
    const runtime=this;
    class RuntimeScene extends Phaser.Scene {
      constructor(){super({key:'runtime',active:true});}
      update(now,delta){runtime.updateInterface(now,delta);}
    }
    this.ready=new Promise((resolve,reject)=>{
      this.game=new Phaser.Game({
        type:Phaser.CANVAS,parent,width:640,height:480,antialias:false,roundPixels:false,version:'0.8-phaser',
        backgroundColor:'#000000',banner:false,audio:{noAudio:true},
        // The existing input controller owns repeat/focus handling; audio owns
        // native cue selection. Do not install competing keyboard/audio systems.
        input:{keyboard:false,mouse:false,touch:false,gamepad:false},
        scale:{mode:Phaser.Scale.FIT,autoCenter:Phaser.Scale.CENTER_BOTH},
        scene:[RuntimeScene,explorationScene(Phaser,this),battleScene(Phaser,this)],
        callbacks:{postBoot:game=>game.events.once(Phaser.Core.Events.POST_STEP,()=>{
          try{
            this.exploration=game.scene.getScene('exploration');this.battle=game.scene.getScene('battle');
            this.canvas=game.canvas;this.canvas.setAttribute('aria-label','第七封印游戏画面');
            const options={signal:this.listeners.signal};
            this.canvas.addEventListener('pointerdown',()=>focusTarget?.focus({preventScroll:true}),options);
            this.canvas.addEventListener('wheel',event=>{
              event.preventDefault();focusTarget?.dispatchEvent(new WheelEvent('wheel',{deltaY:event.deltaY,cancelable:true}));
            },{...options,passive:false});
            document.addEventListener('visibilitychange',()=>{
              if(document.hidden)this.pause('visibility');else this.resume('visibility');
            },options);
            if(document.hidden)this.pause('visibility');
            this.syncScenes();resolve(this);
          }catch(error){reject(error);}
        })}
      });
    });
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(parent);
  }
  start(adapters){
    this.adapters=adapters;this.started=true;this.skipDelta=true;
    this.setPhase(adapters.phase??'map');
  }
  get paused(){return this.pauseReasons.size>0;}
  fail(error){this.pause('error');this.onError(error);}
  updateInterface(now,delta){
    if(!this.started||this.paused)return;
    try{
      this.clock.advance(this.skipDelta?0:delta);this.skipDelta=false;
      this.adapters.interface?.(now,delta);
    }catch(error){this.fail(error);}
  }
  updateScene(key,scene,delta){
    if(!this.started||this.paused)return;
    try{
      const elapsed=scene.skipDelta?0:Math.max(0,delta);scene.skipDelta=false;
      scene.clock.advance(elapsed);this.adapters[key]?.(scene.clock.time,elapsed);
    }catch(error){this.fail(error);}
  }
  setPhase(phase){
    if(this.destroyed)return;
    this.phase=phase;
    if(phase.startsWith('battle-')){
      if(phase!=='battle-loading')this.mode='battle';
    }else if(['map','event','opening','loading','save-io','party-menu','world-map','inspect'].includes(phase))this.mode='exploration';
    else this.mode=null;
    this.syncScenes();
  }
  setMode(mode){
    if(!['exploration','battle',null].includes(mode))throw new Error('未知的 Phaser 场景');
    this.mode=mode;this.syncScenes();
  }
  syncScenes(){
    if(!this.exploration||!this.battle)return;
    for(const key of ['exploration','battle']){
      const scene=this[key],sys=scene.sys;
      if(key!==this.mode){
        // Phaser 3.90 only sleeps running scenes. Resume synchronously first;
        // no update step runs between resume and sleep.
        if(sys.isPaused())sys.resume();
        if(!sys.isSleeping())sys.sleep();
        continue;
      }
      const active=!this.paused&&(key==='exploration'?['map','event','opening'].includes(this.phase)
        :this.phase.startsWith('battle-')&&!['battle-loading','battle-interrupted'].includes(this.phase));
      if(sys.isSleeping())sys.wake();
      if(active){if(sys.isPaused())sys.resume();}
      else if(!sys.isPaused())sys.pause();
      sys.setVisible(true);
    }
    this.parent.dataset.scene=this.mode??'none';
  }
  pause(reason='manual'){
    if(this.destroyed)return;
    const alreadyPaused=this.paused;this.pauseReasons.add(reason);this.syncScenes();
    if(!alreadyPaused)this.adapters.suspend?.();
  }
  resume(reason='manual'){
    if(this.destroyed||!this.pauseReasons.delete(reason)||this.paused)return;
    this.skipDelta=true;this.syncScenes();this.adapters.resume?.();
  }
  presentMap(options){this.exploration.present(options);}
  resize(){this.game?.scale?.refresh();}
  // Render current display lists without advancing the game clock or world.
  // Used for synchronous transition captures; normal frames render in Phaser.
  flush(){const renderer=this.game.renderer;renderer.preRender();this.game.scene.render(renderer);renderer.postRender();}
  capture(source,target){
    const previous=this.mode;
    try{
      this.setMode(source);this.flush();
      const context=target.getContext('2d'),scale=Math.min(target.width/640,target.height/480);
      context.setTransform(1,0,0,1,0,0);context.clearRect(0,0,target.width,target.height);
      context.fillStyle='#000000';context.fillRect(0,0,target.width,target.height);
      context.drawImage(this.canvas,(target.width-640*scale)/2,(target.height-480*scale)/2,640*scale,480*scale);
      return target;
    }finally{this.setMode(previous);}
  }
  snapshot(){return {version:this.game.config.gameVersion,phaser:globalThis.Phaser.VERSION,renderer:'CANVAS',scene:this.mode,
    phase:this.phase,paused:this.paused,
    scenes:Object.fromEntries(['exploration','battle'].map(key=>[key,{active:this[key].sys.isActive(),visible:this[key].sys.isVisible(),sleeping:this[key].sys.isSleeping(),paused:this[key].sys.isPaused(),time:this[key].clock.time}])),
    mapActors:this.exploration.actors.size,battleObjects:Object.fromEntries(Object.entries(this.battle.surface.pools).map(([key,pool])=>[key,pool.length]))};}
  destroy(){
    if(this.destroyed)return;
    this.destroyed=true;this.started=false;this.listeners.abort();
    this.clock.destroy();this.exploration?.clock.destroy();this.battle?.clock.destroy();
    this.resizeObserver.disconnect();this.game.destroy(true);this.adapters={};
  }
}
