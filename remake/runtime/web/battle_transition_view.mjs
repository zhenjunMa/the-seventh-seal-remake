// GAME.exe 0x430850 selects seven pixel transitions; no extra movie or DGP.
// Original logical dimensions and directions; Canvas RGBA and RAF timing adapter.
import {battleViewport} from './core/battle_layout.mjs';

export function battleTransitionFrame(kind,frame){
  const count=[16,64,16,16,20,30,20][kind];
  return {count,delay:kind===0||kind===2?Math.max(0,90-frame*6):kind===3?90+frame*6:kind===4?30:40};
}
export class BattleTransitionView {
  constructor({loadingView,log,random=Math.random,clock=null}){Object.assign(this,{loadingView,log,random,clock});this.epoch=0;}
  capture(source){
    const canvas=source.ownerDocument.createElement('canvas');canvas.width=640;canvas.height=480;
    const viewport=battleViewport(source.width,source.height);
    canvas.getContext('2d').drawImage(source,viewport.x,viewport.y,viewport.width,viewport.height,0,0,640,480);return canvas;
  }
  async run(before,paintBattle,{kind=Math.floor(this.random()*7),signal}={}){
    if(!Number.isInteger(kind)||kind<0||kind>6)throw new Error('入战转场类型无效');
    const epoch=++this.epoch,{root,canvas,context:c}=this.loadingView;
    const check=()=>{signal?.throwIfAborted();if(epoch!==this.epoch)throw new Error('入战转场已取消');};
    check();
    const after=paintBattle(),tiles=[];const started=performance.now();
    if([0,2,3].includes(kind))for(let y=0;y<480;y+=4)for(let x=0;x<640;x+=4){
      const rx=x-320,ry=y-240,speed=((Math.min(Math.abs(rx),Math.abs(ry))>>1)+10+Math.floor(this.random()*0x8000))&0x5f;
      const largest=Math.max(1,Math.abs(rx),Math.abs(ry));
      tiles.push({x,y,dx:x,dy:y,speed:(Math.floor(this.random()*0x8000)+10)&0x5f,life:5+Math.floor(this.random()*10),
        vx:kind===2?rx/largest*speed:rx>>2,vy:kind===2?ry/largest*speed:ry>>2});
    }
    const rows=new Uint8Array(480),speeds=Array.from({length:480},(_,y)=>30+(Math.floor(this.random()*0x8000)&((y%20)+1)));
    let pixels;
    if(kind===1)pixels=[before,after].map(image=>{const surface=image.getContext('2d',{willReadFrequently:true});return surface.getImageData(0,0,640,480);});
    const paint=frame=>{
      c.globalAlpha=1;c.globalCompositeOperation='source-over';c.imageSmoothingEnabled=false;c.clearRect(0,0,640,480);c.drawImage(after,0,0);
      if(kind===1){
        const second=frame>=32,step=second?frame-31:frame+1,source=pixels[second?1:0],out=c.createImageData(640,480);
        for(let i=0;i<out.data.length;i+=4){for(let channel=0;channel<3;channel++){const change=step*(channel===1?8:16);
          out.data[i+channel]=second?Math.max(source.data[i+channel],255-change):Math.min(255,source.data[i+channel]+change);
        }out.data[i+3]=255;}
        c.putImageData(out,0,0);
      }else if([0,2,3].includes(kind)){
        const angle=frame*Math.PI/18,cos=Math.cos(angle),sin=Math.sin(angle);
        for(const tile of tiles){
          if(frame>=tile.life)continue;c.globalAlpha=Math.max(0,1-frame/tile.life);
          if(kind===0)tile.dy+=tile.speed;
          else if(kind===2){tile.dx+=tile.vx;tile.dy+=tile.vy;}
          else{tile.dx+=Math.round(tile.vx*cos-tile.vy*sin);tile.dy+=Math.round(tile.vx*sin+tile.vy*cos);}
          c.drawImage(before,tile.x,tile.y,4,4,tile.dx,tile.dy,4,4);
        }
        c.globalAlpha=1;
      }else if(kind===4){
        const offset=(frame+1)*10;
        for(const [x,y,dx,dy]of [[0,0,-1,-1],[320,0,1,-1],[0,240,-1,1],[320,240,1,1]])c.drawImage(before,x,y,320,240,x+dx*offset,y+dy*offset,320,240);
      }else if(kind===5){
        for(let y=0;y<480;y++){if(!rows[y]&&Math.floor(this.random()*10)===8)rows[y]=1;if(!rows[y])c.drawImage(before,0,y,640,1,0,y,640,1);}
      }else for(let y=0;y<480;y++)c.drawImage(before,0,y,640,1,speeds[y]*(frame+1),y,640,1);
      root.dataset.progress=String((frame+1)/battleTransitionFrame(kind,frame).count);
    };
    root.hidden=false;root.dataset.kind='battle-transition';root.dataset.transition=String(kind);this.loadingView.resize();
    try{
      this.log?.({type:'battle-transition-start',kind,authority:'GAME.exe 0x430850; Canvas/RAF adapter'});
      let nextAt=null,frame=0;
      await new Promise((resolve,reject)=>{
        const schedule=callback=>{
          if(this.clock)this.pendingFrame=this.clock.requestFrame(callback,{signal,onCancel:reject});
          else requestAnimationFrame(callback);
        };
        const tick=now=>{try{check();if(nextAt===null||now>=nextAt){paint(frame);nextAt=now+battleTransitionFrame(kind,frame).delay;frame++;}
          if(frame>=battleTransitionFrame(kind,0).count)resolve();else schedule(tick);
        }catch(error){reject(error);}};schedule(tick);
      });
      check();c.globalAlpha=1;c.drawImage(after,0,0);this.log?.({type:'battle-transition-complete',kind,frames:frame,elapsed_ms:performance.now()-started});
    }finally{if(epoch===this.epoch){root.hidden=true;delete root.dataset.kind;delete root.dataset.transition;delete root.dataset.progress;}}
  }
  cancel(){this.epoch++;this.pendingFrame?.cancel(new Error('入战转场已取消'));this.pendingFrame=null;const root=this.loadingView.root;root.hidden=true;delete root.dataset.kind;delete root.dataset.transition;delete root.dataset.progress;}
}
