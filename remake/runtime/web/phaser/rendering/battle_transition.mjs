import {battleTransitionFrame} from '../../battle_transition_view.mjs';

const fragment=`precision highp float;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform float frame;
uniform float kind;
varying vec2 outTexCoord;
void main(){
  vec2 uv=outTexCoord;
  vec2 imageUV=vec2(uv.x,1.0-uv.y);
  vec4 before=texture2D(iChannel0,imageUV),after=texture2D(iChannel1,imageUV);
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
  sprite.parts=[];
  sprite.renderWebGL=function(renderer,src,camera,parentMatrix){
    camera.addToRenderList(src);const pipeline=renderer.pipelines.setMulti(),matrix=Phaser.GameObjects.GetCalcMatrix(src,camera,parentMatrix).calc;
    const frame=src.frame,tint=Phaser.Renderer.WebGL.Utils.getTintAppendFloatAlpha;
    for(const p of src.parts){if(p.alpha<=0)continue;const q=matrix.setQuad(p.dx,p.dy,p.dx+p.w,p.dy+p.h),color=tint(0xffffff,p.alpha*camera.alpha);
      const u0=frame.u0+(frame.u1-frame.u0)*p.x/640,u1=frame.u0+(frame.u1-frame.u0)*(p.x+p.w)/640;
      const v0=frame.v0+(frame.v1-frame.v0)*p.y/480,v1=frame.v0+(frame.v1-frame.v0)*(p.y+p.h)/480;
      pipeline.batchQuad(src,...q,u0,v0,u1,v1,color,color,color,color,0,frame.glTexture);
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
    const shader=new globalThis.Phaser.Display.BaseShader('seal-transition',fragment,undefined,{frame:{type:'1f',value:0},kind:{type:'1f',value:1}});
    this.shader=scene.add.shader(shader,320,240,640,480,['__WHITE','__WHITE','__WHITE']).setDepth(1).setVisible(false);
  }
  clearShader(){this.shader.setVisible(false).setChannel0('__WHITE').setChannel1('__WHITE').setChannel2('__WHITE');}
  capture(source){if(!source?.gpuTexture)throw new Error('入战转场需要 GPU 场景纹理');return source;}
  async run(before,paintBattle,{kind,random=Math.random,clock=this.runtime.clock,log,signal}={}){
    if(!Number.isInteger(kind)||kind<0||kind>6)throw new Error('入战转场类型无效');
    this.cancel();const epoch=++this.epoch,scene=this.scene,objects=[],textures=[];let after;
    const check=()=>{signal?.throwIfAborted();if(epoch!==this.epoch)throw new Error('入战转场已取消');};
    this.active=true;
    try{
      check();after=paintBattle();this.capture(before);this.capture(after);
      objects.push(scene.add.image(0,0,after.key).setOrigin(0).setDisplaySize(640,480));
      let effect,tiles=[];
      if([0,2,3].includes(kind)){
        for(let y=0;y<480;y+=4)for(let x=0;x<640;x+=4){
          const rx=x-320,ry=y-240,speed=((Math.min(Math.abs(rx),Math.abs(ry))>>1)+10+Math.floor(random()*0x8000))&0x5f,largest=Math.max(1,Math.abs(rx),Math.abs(ry));
          tiles.push({x,y,dx:x,dy:y,w:4,h:4,alpha:1,speed:(Math.floor(random()*0x8000)+10)&0x5f,life:5+Math.floor(random()*10),vx:kind===2?rx/largest*speed:rx>>2,vy:kind===2?ry/largest*speed:ry>>2});
        }
        effect=fragments(scene,before.key);effect.parts=tiles;
      }else if(kind===4){effect=fragments(scene,before.key);tiles=[[0,0,-1,-1],[320,0,1,-1],[0,240,-1,1],[320,240,1,1]].map(([x,y,vx,vy])=>({x,y,vx,vy,w:320,h:240,alpha:1}));effect.parts=tiles;}
      else{
        const bytes=new Uint8Array(480*4),speeds=Array.from({length:480},(_,y)=>30+(Math.floor(random()*0x8000)&((y%20)+1)));
        const onset=new Uint8Array(480).fill(255);
        if(kind===5)for(let step=0;step<30;step++)for(let y=0;y<480;y++)if(onset[y]===255&&Math.floor(random()*10)===8)onset[y]=step;
        for(let y=0;y<480;y++){bytes[y*4]=kind===6?speeds[y]:onset[y];bytes[y*4+3]=255;}
        const rowKey=`seal:transition-rows:${epoch}`;scene.textures.addUint8Array(rowKey,bytes,1,480).setFilter(1);textures.push(rowKey);
        effect=this.shader.setVisible(true).setChannel0(before.key).setChannel1(after.key).setChannel2(rowKey).setUniform('kind.value',kind);
      }
      if(effect!==this.shader)objects.push(effect);
      const paint=frame=>{
        if([0,2,3].includes(kind)){const angle=frame*Math.PI/18,cos=Math.cos(angle),sin=Math.sin(angle);
          for(const tile of tiles){tile.alpha=Math.max(0,1-frame/tile.life);if(frame>=tile.life)continue;
            if(kind===0)tile.dy+=tile.speed;else if(kind===2){tile.dx+=tile.vx;tile.dy+=tile.vy;}
            else{tile.dx+=Math.round(tile.vx*cos-tile.vy*sin);tile.dy+=Math.round(tile.vx*sin+tile.vy*cos);}}}
        else if(kind===4)for(const p of tiles){p.dx=p.x+p.vx*(frame+1)*10;p.dy=p.y+p.vy*(frame+1)*10;}
        else effect.setUniform('frame.value',frame);
        this.frame=frame;
      };
      paint(0);scene.sys.setVisible(true);
      log?.({type:'battle-transition-start',kind,authority:'GAME.exe 0x430850; WebGL',renderer:'WEBGL'});
      let frame=1,nextAt=clock.time+battleTransitionFrame(kind,0).delay;
      await new Promise((resolve,reject)=>{
        const schedule=()=>{this.pending=clock.requestFrame(now=>{try{check();if(now>=nextAt){paint(frame);nextAt=now+battleTransitionFrame(kind,frame).delay;frame++;}
          if(frame>=battleTransitionFrame(kind,0).count)resolve();else schedule();}catch(error){reject(error);}},{signal,onCancel:reject});};schedule();
      });
      check();log?.({type:'battle-transition-complete',kind,frames:frame,renderer:'WEBGL'});
    }finally{
      if(epoch===this.epoch)this.clearShader();
      for(const object of objects)object.destroy();for(const key of textures)scene.textures.remove(key);
      before?.destroy?.();after?.destroy?.();
      if(epoch===this.epoch){scene.sys.setVisible(false);this.active=false;this.pending=null;}
    }
  }
  cancel(){this.epoch++;this.pending?.cancel(new Error('入战转场已取消'));this.pending=null;this.clearShader();this.scene.sys.setVisible(false);this.active=false;}
}
