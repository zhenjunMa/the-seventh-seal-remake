// Shared exploration drawing for the live scene and save thumbnails. Drawing
// consumes a world snapshot; it never installs a scene or advances world state.
// Exploration and ANM use the same logical plane as dialogue and menus.
// view.zoom is relative to that plane, independent of window/fullscreen size.
import {drawMapSprite} from './map_sprite.mjs';
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
  const at=world.location,opening=openingQueue!==null;
  ctx.save();ctx.translate(width/2,height/2);ctx.scale(view.zoom,view.zoom);ctx.translate(-view.x,-view.y);ctx.drawImage(scene.bitmap,0,0);
  collision?.();
  const queue=scene.objects.filter(obj=>opening||world.object_states[`${scene.data.id}:${obj.index}`]?.visible!==false)
    .map(obj=>({...obj,draw:()=>{
      const bitmap=objectBitmap(scene,obj),motion=obj.motion;
      if(motion&&bitmap===obj.bitmap)drawMapSprite(ctx,motion.main,motion.intrinsic,
        motion.frame*motion.width,0,motion.width,motion.height,obj.draw_x,obj.draw_y);
      else ctx.drawImage(bitmap,obj.draw_x,obj.draw_y);
    }}));
  for(const npc of opening?[]:scene.npcs){
    const motion=npc.motion,actorRole=motion?.role,actorAction=actorRole?.actions.find(action=>action.index===motion.action);
    const bitmap=actorAction?.bitmap??npc.bitmap;
    if(!bitmap||npc.hidden||!(npc.event?.conditions??[]).every(condition=>world.flags[condition.index]===condition.value))continue;
    const resource=actorAction?.bitmap?{frame_width:actorRole.frame_width,frame_height:actorRole.frame_height,
      anchor_x:actorRole.anchor.x,anchor_y:actorRole.anchor.y}:npc.resource;
    const frame=actorAction?.bitmap?motion.frame:Math.floor(time/(resource.interval_ms??180))%resource.frames_per_direction;
    queue.push({layer:npc.layer??2,sort_y:npc.y+32,draw:()=>drawMapSprite(ctx,bitmap,actorAction?.intrinsic_bitmap,
      frame*resource.frame_width,npc.direction*resource.frame_height,resource.frame_width,resource.frame_height,
      npc.x+16-resource.anchor_x,npc.y-resource.anchor_y)});
  }
  if(opening)queue.push(...openingQueue.map(entry=>({...entry,draw:()=>entry.draw(ctx)})));
  else queue.push({layer:scene.data.role_layer_preview??2,sort_y:at.y+32,
    draw:()=>ctx.drawImage(action.bitmap,(view.frame??0)*role.frame_width,at.direction*role.frame_height,role.frame_width,role.frame_height,
      at.x+role.map_draw_offset.x,at.y+role.map_draw_offset.y,role.frame_width,role.frame_height)});
  queue.sort((a,b)=>(a.layer??0)-(b.layer??0)||(a.sort_y??0)-(b.sort_y??0));for(const entry of queue)entry.draw();
  if(nearest){ctx.strokeStyle='#edd19b';ctx.lineWidth=1/view.zoom;ctx.beginPath();ctx.ellipse(nearest.x+16,nearest.y+6,19,6,0,0,Math.PI*2);ctx.stroke();}
  ctx.restore();
}
