import {BATTLE_FLASH_COVER_MS,BATTLE_TRANSITION_MS,battleTransitionTimeline} from '../../battle_transition_view.mjs';

const fragment=`precision highp float;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform float frame;
uniform float kind;
uniform float battleReady;
uniform float battleReveal;
varying vec2 outTexCoord;
void main(){
  vec2 uv=outTexCoord;
  vec2 imageUV=vec2(uv.x,1.0-uv.y);
  vec4 black=vec4(0.0,0.0,0.0,1.0);
  vec4 before=texture2D(iChannel0,imageUV),after=battleReady>0.5?mix(black,texture2D(iChannel1,imageUV),kind<2.0?1.0:battleReveal):black;
  if(kind<2.0){
    float step=frame<32.0?frame+1.0:frame-31.0;
    vec3 change=step*vec3(16.0,8.0,16.0)/255.0;
    gl_FragColor=vec4(frame<32.0?min(before.rgb+change,vec3(1.0)):max(after.rgb,vec3(1.0)-change),1.0);
  }else{
    float row=floor((1.0-uv.y)*480.0);
    float value=floor(texture2D(iChannel2,vec2(0.5,(row+0.5)/480.0)).r*255.0+0.5);
    if(kind<6.0)gl_FragColor=frame>=value?after:before;
    else{vec2 source=vec2(uv.x-value*(frame+1.0)/640.0,imageUV.y);gl_FragColor=source.x<0.0?after:texture2D(iChannel0,source);}
  }
}`;

function fragments(scene,key){
  const Phaser=globalThis.Phaser,sprite=scene.add.sprite(0,0,key).setOrigin(0);
  sprite.parts=[];sprite.progress=0;
  sprite.renderWebGL=function(renderer,src,camera,parentMatrix){
    camera.addToRenderList(src);const pipeline=renderer.pipelines.setMulti(),matrix=Phaser.GameObjects.GetCalcMatrix(src,camera,parentMatrix).calc;
    const frame=src.frame,tint=Phaser.Renderer.WebGL.Utils.getTintAppendFloatAlpha;
    // Graphics may already have opened a batch with __WHITE. batchQuad only
    // binds its texture when the batch is empty, so bind the snapshot explicitly.
    const unit=pipeline.setTexture2D(frame.glTexture);
    for(const p of src.parts){
      const alpha=p.alpha-(p.life?src.progress/p.life:0);if(alpha<=0)continue;
      const x=p.dx+p.stepX*src.progress,y=p.dy+p.stepY*src.progress;
      const q=matrix.setQuad(x,y,x+p.w,y+p.h),color=tint(0xffffff,alpha*camera.alpha);
      const u0=frame.u0+(frame.u1-frame.u0)*p.x/640,u1=frame.u0+(frame.u1-frame.u0)*(p.x+p.w)/640;
      const v0=frame.v0+(frame.v1-frame.v0)*p.y/480,v1=frame.v0+(frame.v1-frame.v0)*(p.y+p.h)/480;
      pipeline.batchQuad(src,...q,u0,v0,u1,v1,color,color,color,color,0,frame.glTexture,unit);
    }
  };return sprite;
}

export function transitionScene(Phaser,runtime){
  return class TransitionScene extends Phaser.Scene{
    constructor(){super({key:'transition',active:true});}
    create(){runtime.configureCamera(this.cameras.main);this.sys.setVisible(false);runtime.transitions=new GpuBattleTransition(this,runtime);}
  };
}

export class GpuBattleTransition {
  constructor(scene,runtime){Object.assign(this,{scene,runtime,epoch:0,active:false});
    const shader=new globalThis.Phaser.Display.BaseShader('seal-transition',fragment,undefined,{frame:{type:'1f',value:0},kind:{type:'1f',value:1},battleReady:{type:'1f',value:0},battleReveal:{type:'1f',value:0}});
    this.shader=scene.add.shader(shader,320,240,640,480,['__WHITE','__WHITE','__WHITE']).setDepth(1).setVisible(false);
  }
  bindChannel(index,key){
    // Shader defaults to REPEAT, which makes the 1x480 row table incomplete
    // in WebGL1. Keep its exact byte values with clamped nearest sampling.
    // Use fresh options: setSampler2DBuffer adds snapshot dimensions in place;
    // carrying them into __WHITE would resize and clear the shared texture.
    this.shader.setSampler2D(`iChannel${index}`,key,index,{
      repeat:false,wrapS:'clamp_to_edge',wrapT:'clamp_to_edge',minFilter:'nearest',magFilter:'nearest',
    });
  }
  clearShader(){this.shader.setVisible(false);for(let index=0;index<3;index++)this.bindChannel(index,'__WHITE');}
  capture(source){if(!source?.gpuTexture)throw new Error('入战转场需要 GPU 场景纹理');return source;}
  async run(before,paintBattle,{kind,random=Math.random,clock=this.runtime.transitionClock,log,signal,onCovered,startedAt=performance.now()}={}){
    if(!Number.isInteger(kind)||kind<0||kind>6)throw new Error('入战转场类型无效');
    this.cancel();const epoch=++this.epoch,scene=this.scene,objects=[],textures=[],controller=new AbortController();let after,backing,prepared=false;
    this.controller=controller;
    const abort=()=>controller.abort(signal.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const check=()=>{controller.signal.throwIfAborted();if(epoch!==this.epoch)throw new Error('入战转场已取消');};
    const presented=()=>{if(epoch===this.epoch&&!controller.signal.aborted)log?.({type:'battle-transition-first-frame',kind,elapsed_ms:performance.now()-startedAt,renderer:'WEBGL'});};
    this.active=true;
    try{
      check();this.capture(before);
      // Begin with the map over black. The prepared battlefield replaces this
      // backing while the same transition continues, without exposing a loader.
      objects.push(scene.add.rectangle(0,0,640,480,0x000000).setOrigin(0));
      let effect,tiles=[];
      if([0,2,3].includes(kind)){
        // Keep the burst light enough to present on the first browser frame.
        const size=8;
        for(let y=0;y<480;y+=size)for(let x=0;x<640;x+=size){
          const rx=x-320,ry=y-240,speed=((Math.min(Math.abs(rx),Math.abs(ry))>>1)+10+Math.floor(random()*0x8000))&0x5f,largest=Math.max(1,Math.abs(rx),Math.abs(ry));
          tiles.push({x,y,dx:x,dy:y,w:size,h:size,alpha:1,speed:(Math.floor(random()*0x8000)+10)&0x5f,life:5+Math.floor(random()*10),vx:kind===2?rx/largest*speed:rx>>2,vy:kind===2?ry/largest*speed:ry>>2});
        }
        effect=fragments(scene,before.key);effect.parts=tiles;effect.setDepth(1);
      }else if(kind===4){effect=fragments(scene,before.key);effect.setDepth(1);tiles=[[0,0,-1,-1],[320,0,1,-1],[0,240,-1,1],[320,240,1,1]].map(([x,y,vx,vy])=>({x,y,vx,vy,w:320,h:240,alpha:1}));effect.parts=tiles;}
      else{
        const bytes=new Uint8Array(480*4),speeds=Array.from({length:480},(_,y)=>30+(Math.floor(random()*0x8000)&((y%20)+1)));
        const onset=new Uint8Array(480).fill(255);
        if(kind===5)for(let step=0;step<30;step++)for(let y=0;y<480;y++)if(onset[y]===255&&Math.floor(random()*10)===8)onset[y]=step;
        for(let y=0;y<480;y++){bytes[y*4]=kind===6?speeds[y]:onset[y];bytes[y*4+3]=255;}
        const rowKey=`seal:transition-rows:${epoch}`;scene.textures.addUint8Array(rowKey,bytes,1,480).setFilter(1);textures.push(rowKey);
        effect=this.shader.setVisible(true).setUniform('kind.value',kind).setUniform('battleReady.value',0).setUniform('battleReveal.value',0);
        this.bindChannel(0,before.key);this.bindChannel(1,'__WHITE');this.bindChannel(2,rowKey);
      }
      if(effect!==this.shader)objects.push(effect);
      const paint=frame=>{
        if([0,2,3].includes(kind)){const angle=(frame+1)*Math.PI/18,cos=Math.cos(angle),sin=Math.sin(angle);
          for(const tile of tiles){tile.alpha=Math.max(0,1-frame/tile.life);if(frame>=tile.life)continue;
            if(frame===0){tile.stepX=kind===0?0:tile.vx;tile.stepY=kind===0?tile.speed:tile.vy;}
            tile.dx+=tile.stepX;tile.dy+=tile.stepY;
            if(kind===3){tile.stepX=Math.round(tile.vx*cos-tile.vy*sin);tile.stepY=Math.round(tile.vx*sin+tile.vy*cos);}
          }}
        else if(kind===4)for(const p of tiles){p.stepX=p.vx*10;p.stepY=p.vy*10;p.dx=p.x+p.stepX*(frame+1);p.dy=p.y+p.stepY*(frame+1);}
        else effect.setUniform('frame.value',frame);
        this.frame=frame;
      };
      paint(0);scene.sys.setVisible(true);
      this.runtime.game?.events.once('postrender',presented);
      onCovered?.();
      log?.({type:'battle-transition-start',kind,authority:'GAME.exe 0x430850; WebGL',renderer:'WEBGL'});
      const start=clock.time,timeline=battleTransitionTimeline(kind),last=timeline.length-1;
      let frame=0,readyAt,preparationStarted=false,presentationFrames=0;
      await new Promise((resolve,reject)=>{
        const schedule=()=>{this.pending=clock.requestFrame(now=>{try{
          check();
          // Let the covering frame render before preparing the battlefield
          // alongside the rest of the transition.
          if(!preparationStarted&&++presentationFrames>=2){
            preparationStarted=true;
            log?.({type:'battle-transition-preparation-start',kind,elapsed_ms:performance.now()-startedAt,renderer:'WEBGL'});
            Promise.resolve().then(()=>{check();return paintBattle(controller.signal);}).then(snapshot=>{
              try{check();}catch(error){snapshot?.destroy?.();throw error;}
              after=snapshot;this.capture(after);
              backing=scene.add.image(0,0,after.key).setOrigin(0).setDisplaySize(640,480).setAlpha(0);
              objects.push(backing);
              if(effect===this.shader){this.bindChannel(1,after.key);effect.setUniform('battleReady.value',1);}
              prepared=true;
            }).catch(reject);
          }
          const elapsed=now-start;
          if(prepared&&readyAt===undefined)readyAt=elapsed;
          const revealAt=Math.max(BATTLE_FLASH_COVER_MS,readyAt??Infinity);
          const revealDuration=Math.max(80,BATTLE_TRANSITION_MS-revealAt);
          const revealed=Math.max(0,Math.min(1,(elapsed-revealAt)/revealDuration));
          if(kind===1){
            const pose=elapsed<revealAt?31*Math.min(1,elapsed/BATTLE_FLASH_COVER_MS)
              :32+(last-32)*revealed;
            frame=Math.floor(pose);paint(pose);
          }else{
            // Apply intermediate tile movement even if the display missed a frame.
            while(frame<last&&timeline[frame+1]<=elapsed)paint(++frame);
            const progress=frame===last?0:(elapsed-timeline[frame])/(timeline[frame+1]-timeline[frame]);
            if(effect!==this.shader)effect.progress=progress;
            else if(kind===6)effect.setUniform('frame.value',frame+progress);
            backing?.setAlpha(revealed);
            if(effect===this.shader)effect.setUniform('battleReveal.value',revealed);
          }
          if(prepared&&frame===last&&revealed===1){
            resolve();
          }else schedule();
        }catch(error){reject(error);}},{signal:controller.signal,onCancel:reject});};schedule();
      });
      check();log?.({type:'battle-transition-complete',kind,frames:frame+1,elapsed_ms:performance.now()-startedAt,
        ready_ms:readyAt,overrun_ms:Math.max(0,clock.time-start-BATTLE_TRANSITION_MS),renderer:'WEBGL'});
    }finally{
      this.runtime.game?.events.off('postrender',presented);
      controller.abort(new Error('入战转场已结束'));signal?.removeEventListener('abort',abort);
      if(epoch===this.epoch)this.clearShader();
      for(const object of objects)object.destroy();for(const key of textures)scene.textures.remove(key);
      before?.destroy?.();after?.destroy?.();
      if(epoch===this.epoch){scene.sys.setVisible(false);this.active=false;this.pending=null;this.controller=null;}
    }
  }
  cancel(){this.epoch++;this.controller?.abort(new Error('入战转场已取消'));this.controller=null;this.pending?.cancel(new Error('入战转场已取消'));this.pending=null;this.clearShader();this.scene.sys.setVisible(false);this.active=false;}
}
