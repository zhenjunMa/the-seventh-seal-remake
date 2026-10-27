// Native map draw darkens the destination with its source shadow mask before
// main and indexed light. All share the physical frame and original anchor;
// compact shadow bounds restore their offset inside that original frame.
// Black alpha 128 approximates native RGB565/555 component halving in 8-bit.
export function shadowRectangle(sx,sy,width,height,geometry,scaleX=1,scaleY=1) {
  const crop=geometry??{x:0,y:0,width,height};
  return {sx:sx/width*crop.width,sy:sy/height*crop.height,width:crop.width,height:crop.height,
    x:crop.x*scaleX,y:crop.y*scaleY,displayWidth:crop.width*scaleX,displayHeight:crop.height*scaleY};
}
export function drawMapSprite(ctx,main,intrinsic,sx,sy,width,height,x,y,shadow=null,shadowGeometry=null,bodyOffset=null) {
  if(shadow){const rect=shadowRectangle(sx,sy,width,height,shadowGeometry);
    ctx.drawImage(shadow,rect.sx,rect.sy,rect.width,rect.height,x+rect.x,y+rect.y,rect.displayWidth,rect.displayHeight);}
  const bodyX=x+(bodyOffset?.x??0),bodyY=y+(bodyOffset?.y??0);
  ctx.drawImage(main,sx,sy,width,height,bodyX,bodyY,width,height);
  if(intrinsic){
    ctx.save();ctx.globalCompositeOperation='lighter';
    ctx.drawImage(intrinsic,sx,sy,width,height,bodyX,bodyY,width,height);ctx.restore();
  }
}
