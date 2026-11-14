import {mapActorPosition} from '../exploration/movement.mjs';

export function mapViewport({x,y,zoom=1},margin=0){
  const left=x-320/zoom-margin,right=x+320/zoom+margin;
  const top=y-240/zoom-margin,bottom=y+240/zoom+margin;
  return ({x,y,width,height})=>x<right&&y<bottom&&x+width>left&&y+height>top;
}

// Ground contact in full sprite-frame pixels, measured from each playable
// role's idle frames. A single point per role keeps the pose stable as gait
// and facing change. Exploration collision already uses this world position.
const playerGroundAnchors = {
  '001': {x:80,y:134},
  '002': {x:82,y:145},
  '003': {x:87,y:143},
  '004': {x:98,y:152},
  '005': {x:86,y:136},
  '006': {x:80,y:144},
};

// Shared source geometry for the live Phaser scene and read-only save previews.
// Producing entries never advances animation, RNG, or persistent world state.
export function mapPresentation({scene,world,role,action,view,
  objectBitmap=(_scene,obj)=>obj.bitmap,objectPreview=null,openingQueue=null,time=performance.now()}) {
  if(!scene)return [];
  const opening=openingQueue!==null,at=world.location;
  const queue=scene.objects.filter(obj=>opening||world.object_states[`${scene.data.id}:${obj.index}`]?.visible!==false)
    .map(obj=>{
      const bitmap=objectBitmap(scene,obj);
      if(bitmap===null)return null;
      const previewing=objectPreview?.mapId===scene.data.id&&objectPreview.objectIndex===obj.index;
      const motion=previewing?objectPreview.motion:bitmap===obj.bitmap?obj.motion:null;
      const pose=motion
        ?{image:motion.main,light:motion.intrinsic,shadow:motion.shadow,sx:motion.frame*motion.width,sy:0,width:motion.width,height:motion.height,x:obj.draw_x,y:obj.draw_y}
        :{image:bitmap,x:obj.draw_x,y:obj.draw_y};
      return {key:`object:${obj.index}`,layer:obj.layer??0,sort_y:obj.sort_y??0,pose};
    }).filter(Boolean);
  for(const [npcIndex,npc]of (opening?[]:scene.npcs).entries()){
    const motion=npc.motion,actorRole=motion?.role,actorAction=actorRole?.actions.find(a=>a.index===motion.action);
    const position=mapActorPosition(npc);
    const bitmap=actorAction?.bitmap??npc.bitmap;
    if(!bitmap||npc.hidden||npc.route_hidden_ticks>0||npc.native_layer!==undefined&&scene.data.native_layer!==undefined&&npc.native_layer!==scene.data.native_layer
      ||!(npc.event?.conditions??[]).every(c=>world.flags[c.index]===c.value))continue;
    const resource=actorAction?.bitmap?{frame_width:actorRole.frame_width,frame_height:actorRole.frame_height,
      anchor_x:actorRole.anchor.x,anchor_y:actorRole.anchor.y}:npc.resource;
    const frame=actorAction?.bitmap?motion.frame:Math.floor(time/(resource.interval_ms??180))%resource.frames_per_direction;
    queue.push({key:`npc:${npc.id??npc.slot_zero_based??npcIndex}`,character:true,layer:npc.layer??2,sort_y:position.y+32,
      pose:{image:bitmap,light:actorAction?.intrinsic_bitmap,
        shadow:actorAction?.bitmap?actorAction.shadow_bitmap:npc.shadow_bitmap,
        shadow_geometry:actorAction?.bitmap?actorAction.shadow_geometry:resource.shadow_geometry,
        sx:frame*resource.frame_width,sy:position.direction*resource.frame_height,
        width:resource.frame_width,height:resource.frame_height,x:position.x+16-resource.anchor_x,y:position.y-resource.anchor_y}});
  }
  if(opening)queue.push(...openingQueue);
  else {
    const ground=playerGroundAnchors[role.id];
    const offset=ground?{x:-ground.x,y:-ground.y}:
      role.map_draw_offset??{x:16-(role.anchor?.x??role.anchor_raw?.[0]??0),y:-(role.anchor?.y??role.anchor_raw?.[1]??0)};
    queue.push({key:'leader',character:true,layer:scene.data.role_layer_preview??2,sort_y:at.y+32,
      pose:{image:action.bitmap,light:action.intrinsic_bitmap,shadow:action.shadow_bitmap,shadow_geometry:action.shadow_geometry,
        sx:(view.frame??0)*role.frame_width,sy:at.direction*role.frame_height,
        width:role.frame_width,height:role.frame_height,x:at.x+offset.x,y:at.y+offset.y,
        body_offset:view.collisionFeedback??null}});
  }
  return queue.sort((a,b)=>(a.layer??0)-(b.layer??0)||(a.sort_y??0)-(b.sort_y??0));
}
