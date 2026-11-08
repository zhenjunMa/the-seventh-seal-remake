// Source stage composition and horizontal perspective; animation time remains adapted.
import {drawBattleImage} from './core/battle/battle_resources.mjs';
import {runtimeContent} from './core/content/content_registry.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(`森林战斗背景：${message}`);};
export function validateForestStage(stage,content=runtimeContent){
  const entry=content.stages[stage?.stage_id];
  need(entry&&stage.schema===entry.schema&&stage.version===1,'版本无效或场景未登记');
  const prefix=entry.asset_prefix;
  const c=stage.default_composition;
  need(c?.viewport.width===640&&c.viewport.height===480&&c.camera.x===0&&c.camera.y===0,'当前只支持原默认镜头');
  need(Array.isArray(stage.layers)&&stage.layers.length>=2&&new Set(stage.layers.map(l=>l.id)).size===stage.layers.length,'图层无效');
  for(const layer of stage.layers){
    need(Array.isArray(layer.frames)&&layer.frames.length===layer.source.frame_count,'帧表无效');
    for(const frame of layer.frames)for(const f of [frame,...frame.intrinsic?[frame.intrinsic]:[]])need(f.path.startsWith(prefix)&&/^[A-Za-z0-9_./-]+\.png$/.test(f.path)&&!f.path.split('/').includes('..')&&/^[a-f0-9]{64}$/.test(f.sha256),'图片来源无效');
    if(layer.animation)need(layer.animation.frames.length>0&&layer.animation.frames.every(i=>Number.isInteger(i)&&i>=0&&i<layer.frames.length)&&layer.animation.interval_raw>0,'动画帧无效');
  }
  for(const r of [c.sky,c.ground,...c.scene_objects])need(stage.layers.some(l=>l.id===r.layer_id)&&[r.source_rect,r.destination_rect].every(rect=>Array.isArray(rect)&&rect.length===4&&rect.every(Number.isFinite)),'构图范围无效');
  return stage;
}
export function forestStageAssets(stage){return stage.layers.flatMap(l=>l.frames.flatMap(f=>[f,...f.intrinsic?[f.intrinsic]:[]].map(asset=>({...asset,path:'/'+asset.path,width:l.source.width,height:l.source.height}))));}
export function battleStageCameraOffset(stage,cameraX,depth){
  const ground=stage.layers.find(layer=>layer.id===stage.default_composition.ground.layer_id);
  // 513FC0: camera X * actor/scenery ground Y, arithmetic half, divided by
  // half the ground height. Preserve the view's fractional movement between poses.
  return Math.floor(cameraX*depth/2)/(ground.source.height>>1);
}
export function drawForestStageLayer(ctx,stage,images,row,frame=row.frame??0,colorFade=null){
  const layer=stage.layers.find(l=>l.id===row.layer_id),asset=layer.frames[frame],scale=540/480,offset=(960-640*scale)/2;
  const [x,y,w,h]=row.destination_rect,[sx,sy,sw,sh]=row.source_rect;
  const left=Math.max(0,x),top=Math.max(0,y),width=Math.min(640,x+w)-left,height=Math.min(480,y+h)-top;
  if(width<=0||height<=0)return;
  ctx.save();
  // Native5158E0 uses one unit on perspective ground;52B2FD receives twice
  // that amount for sky and ordinary scenery. Additive auxiliary pixels follow.
  ctx.nativeColorSubtract=colorFade?colorFade.mask*512+colorFade.value*(row.layer_id===stage.default_composition.ground.layer_id?1:2):0;
  drawBattleImage(ctx,images.get('/'+asset.path),sx+(left-x)*sw/w,sy+(top-y)*sh/h,width*sw/w,height*sh/h,
    offset+left*scale,top*scale,width*scale,height*scale);
  if(asset.intrinsic){
    ctx.save();ctx.nativeColorSubtract=0;ctx.globalCompositeOperation='lighter';
    drawBattleImage(ctx,images.get('/'+asset.intrinsic.path),sx+(left-x)*sw/w,sy+(top-y)*sh/h,width*sw/w,height*sh/h,
      offset+left*scale,top*scale,width*scale,height*scale);
    ctx.restore();
  }
  ctx.restore();
}
function drawForestStageGround(ctx,stage,images,cameraX,colorFade){
  const ground=stage.default_composition.ground;
  if(!cameraX){drawForestStageLayer(ctx,stage,images,ground,undefined,colorFade);return;}
  const layer=stage.layers.find(layer=>layer.id===ground.layer_id);
  const [sx,sy,sw,sh]=ground.source_rect,[x,y,w,h]=ground.destination_rect,halfHeight=layer.source.height>>1;
  // 5145D0's scanline table is indexed from the bottom of the source image.
  // Keep every row inside the image: the native +30 camera margin must not
  // become an out-of-image Canvas/atlas sample at either side of the stage.
  const sourceX=row=>Math.max(0,Math.min(layer.source.width-sw,sx+Math.trunc(cameraX*((sy+row+1)>>1)/halfHeight)));
  for(let row=0;row<sh;){
    const left=sourceX(row);let end=row+1;
    while(end<sh&&sourceX(end)===left)end++;
    drawForestStageLayer(ctx,stage,images,{...ground,source_rect:[left,sy+row,sw,end-row],
      destination_rect:[x,y+row*h/sh,w,(end-row)*h/sh]},undefined,colorFade);
    row=end;
  }
}
export function drawForestStageBackground(ctx,stage,images,now,colorFade=null,cameraX=0){
  const sky=stage.layers.find(l=>l.id===stage.default_composition.sky.layer_id),frames=sky.animation?.frames;
  const initial=stage.default_composition.sky.initial_frame??0;
  const frame=frames?frames[(initial+Math.floor(now/sky.animation.interval_raw))%frames.length]:initial;
  drawForestStageLayer(ctx,stage,images,stage.default_composition.sky,frame,colorFade);
  drawForestStageGround(ctx,stage,images,cameraX,colorFade);
  // SCN objects here are scenery textures, not combat actors. Finish the
  // background pass before any monster or party sprite, regardless of its Y.
  const scenery=[...stage.default_composition.scene_objects].sort((a,b)=>(a.sort_category??0)-(b.sort_category??0)||(a.sort_y??0)-(b.sort_y??0));
  for(const row of scenery){
    const layer=stage.layers.find(l=>l.id===row.layer_id),animation=layer.animation;
    const frame=animation?animation.frames[((row.frame??0)+Math.floor(now/animation.interval_raw))%animation.frames.length]:row.frame;
    const fixedX=layer.scn.flags_raw_31_36?.[2]??parseInt(layer.scn.raw_hex.slice(0x33*2,0x34*2),16);
    const offset=cameraX&&!fixedX?battleStageCameraOffset(stage,cameraX,layer.scn.position_raw.y):0;
    drawForestStageLayer(ctx,stage,images,offset?{...row,destination_rect:[row.destination_rect[0]-offset,...row.destination_rect.slice(1)]}:row,frame,colorFade);
  }
}
