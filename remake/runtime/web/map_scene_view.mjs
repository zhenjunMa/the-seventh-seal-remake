// Shared exploration drawing for the live scene and save thumbnails. Drawing
// consumes a world snapshot; it never installs a scene or advances world state.
// Exploration and ANM use the same logical plane as dialogue and menus.
// view.zoom is relative to that plane, independent of window/fullscreen size.
import {drawMapSprite} from './map_sprite.mjs';
import {mapPresentation} from './core/map_presentation.mjs';
export function drawGameScene(ctx,options) {
  const {width,height}=options,scale=Math.min(width/640,height/480);
  ctx.clearRect(0,0,width,height);ctx.fillStyle='#000';ctx.fillRect(0,0,width,height);
  ctx.save();ctx.translate((width-640*scale)/2,(height-480*scale)/2);ctx.scale(scale,scale);
  ctx.beginPath();ctx.rect(0,0,640,480);ctx.clip();
  drawMapScene(ctx,{...options,width:640,height:480});
  ctx.restore();
}
export function drawOpeningScene(ctx,options) {
  drawGameScene(ctx,{...options,view:{...options.view,zoom:1},nearest:null,collision:null});
}
export function drawMapScene(ctx,{scene,world,role,action,view,width,height,objectBitmap=(_scene,obj)=>obj.bitmap,
  openingQueue=null,collision=null,nearest=null,time=performance.now()}) {
  ctx.clearRect(0,0,width,height);ctx.fillStyle='#0e191b';ctx.fillRect(0,0,width,height);
  if(!scene)return;
  ctx.save();ctx.translate(width/2,height/2);ctx.scale(view.zoom,view.zoom);ctx.translate(-view.x,-view.y);ctx.drawImage(scene.bitmap,0,0);
  collision?.();
  for(const entry of mapPresentation({scene,world,role,action,view,objectBitmap,openingQueue,time})){
    if(entry.draw){entry.draw(ctx);continue;}
    const p=entry.pose;
    if(p.width===undefined)ctx.drawImage(p.image,p.x,p.y);
    else drawMapSprite(ctx,p.image,p.light,p.sx??0,p.sy??0,p.width,p.height,p.x,p.y,p.shadow,p.shadow_geometry,p.body_offset);
  }
  if(nearest){ctx.strokeStyle='#edd19b';ctx.lineWidth=1/view.zoom;ctx.beginPath();ctx.ellipse(nearest.x+16,nearest.y+6,19,6,0,0,Math.PI*2);ctx.stroke();}
  ctx.restore();
}
