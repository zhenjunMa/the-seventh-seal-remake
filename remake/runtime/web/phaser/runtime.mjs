import {explorationScene} from './scenes/exploration_scene.mjs';
import {battleScene} from './scenes/battle_scene.mjs';
import {ActionClock} from './components/action_clock.mjs';
import {InterfaceCompositor} from './rendering/interface_compositor.mjs';
import {transitionScene} from './rendering/battle_transition.mjs';
import {preparePixelPipeline} from './rendering/pixel_sprite.mjs';
import {characterPipeline,XBR_PIPELINE} from './rendering/xbr_pipeline.mjs';

function savedSmoothing(){try{return localStorage.getItem('seal:actor-smoothing')!=='off';}catch{return true;}}

export class PhaserRuntime {
  static async create(options){const runtime=new PhaserRuntime(options);await runtime.ready;return runtime;}
  constructor({parent,focusTarget,renderScale=null,actorSmoothing,onError=error=>{throw error;}}){
    const Phaser=globalThis.Phaser;
    if(Phaser?.VERSION!=='3.90.0')throw new Error('Phaser 3.90.0 本地运行库未加载，请检查 vendor/phaser');
    this.clock=new ActionClock();this.started=false;this.onError=onError;this.parent=parent;
    this.adapters={};this.phase='boot';this.mode=null;this.pauseReasons=new Set();this.destroyed=false;
    this.listeners=new AbortController();this.snapshots=new Set();this.snapshotSerial=0;
    this.fixedRenderScale=renderScale;this.renderScale=this.preferredRenderScale();this.cameraViews=new Map();
    this.actorSmoothing=actorSmoothing??(new URLSearchParams(location.search).get('xbr')==='0'?false:savedSmoothing());
    const runtime=this;
    class RuntimeScene extends Phaser.Scene {
      constructor(){super({key:'runtime',active:true});}
      update(now,delta){runtime.updateInterface(now,delta);}
    }
    this.ready=new Promise((resolve,reject)=>{
      this.game=new Phaser.Game({
        type:Phaser.WEBGL,parent,width:640*this.renderScale,height:480*this.renderScale,antialias:false,antialiasGL:false,roundPixels:false,version:'0.9-webgl',
        pipeline:{[XBR_PIPELINE]:characterPipeline(Phaser)},defaultPipeline:XBR_PIPELINE,autoMobilePipeline:false,
        backgroundColor:'#000000',banner:false,audio:{noAudio:true},
        // The existing input controller owns repeat/focus handling; audio owns
        // native cue selection. Do not install competing keyboard/audio systems.
        input:{keyboard:false,mouse:false,touch:false,gamepad:false},
        scale:{mode:Phaser.Scale.FIT,autoCenter:Phaser.Scale.CENTER_BOTH},
        scene:[RuntimeScene,explorationScene(Phaser,this),battleScene(Phaser,this),transitionScene(Phaser,this)],
        callbacks:{postBoot:game=>game.events.once(Phaser.Core.Events.POST_STEP,()=>{
          try{
            this.exploration=game.scene.getScene('exploration');this.battle=game.scene.getScene('battle');
            this.canvas=game.canvas;this.canvas.setAttribute('aria-label','第七封印游戏画面');
            game.renderer.pipelines.MULTI_PIPELINE=game.renderer.pipelines.get(XBR_PIPELINE);
            this.setActorSmoothing(this.actorSmoothing);
            preparePixelPipeline(game.renderer);
            game.renderer.on(Phaser.Renderer.Events.LOSE_WEBGL,()=>this.pause('webgl-main'));
            game.renderer.on(Phaser.Renderer.Events.RESTORE_WEBGL,()=>{
              try{for(const snapshot of this.snapshots)snapshot.redraw();this.resume('webgl-main');}catch(error){this.fail(error);}
            });
            const options={signal:this.listeners.signal};
            this.canvas.addEventListener('pointerdown',()=>focusTarget?.focus({preventScroll:true}),options);
            this.canvas.addEventListener('wheel',event=>{
              event.preventDefault();focusTarget?.dispatchEvent(new WheelEvent('wheel',{deltaY:event.deltaY,cancelable:true}));
            },{...options,passive:false});
            document.addEventListener('visibilitychange',()=>{
              if(document.hidden)this.pause('visibility');else this.resume('visibility');
            },options);
            if(document.hidden)this.pause('visibility');
            this.ui=new InterfaceCompositor(this);this.syncScenes();this.ui.ready.then(()=>resolve(this),reject);
          }catch(error){reject(error);}
        })}
      });
    });
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(parent);
    window.addEventListener('resize',()=>this.resize(),{signal:this.listeners.signal});
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
    }else if(['map','event','opening','loading','save-io','save-menu','party-menu','world-map','inspect'].includes(phase))this.mode='exploration';
    else this.mode=null;
    this.syncScenes();
  }
  setMode(mode){
    if(!['exploration','battle',null].includes(mode))throw new Error('未知的 Phaser 场景');
    this.mode=mode;this.syncScenes();
  }
  syncScenes(){
    this.clock.paused=!this.started||this.paused;
    if(!this.exploration||!this.battle)return;
    for(const key of ['exploration','battle']){
      const scene=this[key],sys=scene.sys;
      const active=this.started&&!this.paused&&(key==='exploration'?['map','event','opening'].includes(this.phase)
        :this.phase.startsWith('battle-')&&!['battle-loading','battle-interrupted'].includes(this.phase));
      scene.clock.paused=key!==this.mode||!active;
      if(key!==this.mode){
        // Phaser 3.90 only sleeps running scenes. Resume synchronously first;
        // no update step runs between resume and sleep.
        if(sys.isPaused())sys.resume();
        if(!sys.isSleeping())sys.sleep();
        continue;
      }
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
  preferredRenderScale(){
    if(this.fixedRenderScale!==null)return Math.max(1,Math.min(3,Number(this.fixedRenderScale)||1));
    const size=this.parent.getBoundingClientRect(),fit=Math.min(size.width/640,size.height/480);
    return Math.max(1,Math.min(3,Math.ceil(fit*(globalThis.devicePixelRatio||1)*4)/4));
  }
  configureCamera(camera,{x=320,y=240,zoom=1}={}){
    this.cameraViews.set(camera,{x,y,zoom});
    camera.setZoom(zoom*this.renderScale).setScroll(x-camera.width/2,y-camera.height/2);
  }
  setActorSmoothing(enabled,{persist=false}={}){
    this.actorSmoothing=Boolean(enabled);const pipeline=this.game?.renderer?.pipelines?.get(XBR_PIPELINE);
    if(pipeline){pipeline.flush();pipeline.enabled=this.actorSmoothing;}
    if(persist)try{localStorage.setItem('seal:actor-smoothing',enabled?'on':'off');}catch{/* Session toggle still works. */}
    return this.actorSmoothing;
  }
  resize(){
    const scale=this.preferredRenderScale();
    if(this.game?.isBooted&&scale!==this.renderScale){
      this.renderScale=scale;this.game.scale.setGameSize(640*scale,480*scale);
      for(const [camera,view]of this.cameraViews)this.configureCamera(camera,view);
    }
    this.game?.scale?.refresh();this.ui?.invalidate(true);
  }
  captureTexture(source='exploration'){
    if(!this.transitions.active)for(const previous of [...this.snapshots])previous.destroy();
    const scene=this[source],camera=scene.cameras.main,key=`seal:snapshot:${++this.snapshotSerial}`;
    const texture=scene.textures.addDynamicTexture(key,640*this.renderScale,480*this.renderScale);texture.setFilter(1);
    texture.camera.setScroll(camera.scrollX,camera.scrollY).setZoom(camera.zoom).setRotation(camera.rotation);
    const redraw=()=>{scene.sys.displayList.depthSort();texture.clear();texture.fill(camera.backgroundColor.color,1);texture.draw(scene.children.list.filter(object=>object.willRender(camera)));};redraw();
    const snapshot={gpuTexture:true,key,width:640,height:480,redraw,destroy:()=>{if(this.snapshots.delete(snapshot))scene.textures.remove(key);}};
    this.snapshots.add(snapshot);return snapshot;
  }
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
  snapshot(){return {version:this.game.config.gameVersion,phaser:globalThis.Phaser.VERSION,renderer:'WEBGL',scene:this.mode,interface:this.ui?.snapshot(),
    phase:this.phase,paused:this.paused,renderScale:this.renderScale,actorSmoothing:this.actorSmoothing,
    scenes:Object.fromEntries(['exploration','battle'].map(key=>[key,{active:this[key].sys.isActive(),visible:this[key].sys.isVisible(),sleeping:this[key].sys.isSleeping(),paused:this[key].sys.isPaused(),time:this[key].clock.time}])),
    mapActors:this.exploration.actors.size,battleObjects:Object.fromEntries(Object.entries(this.battle.surface.pools).map(([key,pool])=>[key,pool.length]))};}
  destroy(){
    if(this.destroyed)return;
    this.destroyed=true;this.started=false;this.listeners.abort();
    this.transitions?.cancel();for(const snapshot of [...this.snapshots])snapshot.destroy();this.ui?.destroy();
    this.clock.destroy();this.exploration?.clock.destroy();this.battle?.clock.destroy();
    this.resizeObserver.disconnect();this.game.destroy(true);this.adapters={};this.cameraViews.clear();
  }
}
