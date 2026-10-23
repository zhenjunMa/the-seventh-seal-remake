// Shared source geometry for the live Phaser scene and read-only save previews.
// Producing entries never advances animation, RNG, or persistent world state.
export function mapPresentation({scene,world,role,action,view,
  objectBitmap=(_scene,obj)=>obj.bitmap,openingQueue=null,time=performance.now()}) {
  if(!scene)return [];
  const opening=openingQueue!==null,at=world.location;
  const queue=scene.objects.filter(obj=>opening||world.object_states[`${scene.data.id}:${obj.index}`]?.visible!==false)
    .map(obj=>{
      const bitmap=objectBitmap(scene,obj),motion=obj.motion;
      const pose=motion&&bitmap===obj.bitmap
        ?{image:motion.main,light:motion.intrinsic,sx:motion.frame*motion.width,sy:0,width:motion.width,height:motion.height,x:obj.draw_x,y:obj.draw_y}
        :{image:bitmap,x:obj.draw_x,y:obj.draw_y};
      return {key:`object:${obj.index}`,layer:obj.layer??0,sort_y:obj.sort_y??0,pose};
    });
  for(const [npcIndex,npc]of (opening?[]:scene.npcs).entries()){
    const motion=npc.motion,actorRole=motion?.role,actorAction=actorRole?.actions.find(a=>a.index===motion.action);
    const position=motion?.x===undefined?npc:motion;
    const bitmap=actorAction?.bitmap??npc.bitmap;
    if(!bitmap||npc.hidden||!(npc.event?.conditions??[]).every(c=>world.flags[c.index]===c.value))continue;
    const resource=actorAction?.bitmap?{frame_width:actorRole.frame_width,frame_height:actorRole.frame_height,
      anchor_x:actorRole.anchor.x,anchor_y:actorRole.anchor.y}:npc.resource;
    const frame=actorAction?.bitmap?motion.frame:Math.floor(time/(resource.interval_ms??180))%resource.frames_per_direction;
    queue.push({key:`npc:${npc.id??npc.slot_zero_based??npcIndex}`,layer:npc.layer??2,sort_y:position.y+32,
      pose:{image:bitmap,light:actorAction?.intrinsic_bitmap,
        shadow:actorAction?.bitmap?actorAction.shadow_bitmap:npc.shadow_bitmap,
        shadow_geometry:actorAction?.bitmap?actorAction.shadow_geometry:resource.shadow_geometry,
        sx:frame*resource.frame_width,sy:position.direction*resource.frame_height,
        width:resource.frame_width,height:resource.frame_height,x:position.x+16-resource.anchor_x,y:position.y-resource.anchor_y}});
  }
  if(opening)queue.push(...openingQueue);
  else {
    const offset=role.map_draw_offset??{x:16-(role.anchor?.x??role.anchor_raw?.[0]??0),y:-(role.anchor?.y??role.anchor_raw?.[1]??0)};
    queue.push({key:'leader',layer:scene.data.role_layer_preview??2,sort_y:at.y+32,
      pose:{image:action.bitmap,light:action.intrinsic_bitmap,shadow:action.shadow_bitmap,shadow_geometry:action.shadow_geometry,
        sx:(view.frame??0)*role.frame_width,sy:at.direction*role.frame_height,
        width:role.frame_width,height:role.frame_height,x:at.x+offset.x,y:at.y+offset.y}});
  }
  return queue.sort((a,b)=>(a.layer??0)-(b.layer??0)||(a.sort_y??0)-(b.sort_y??0));
}
