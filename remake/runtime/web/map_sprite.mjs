// Native map draw emits the main raster followed by the same physical frame's
// indexed light contribution. Both share their source rectangle and anchor.
export function drawMapSprite(ctx,main,intrinsic,sx,sy,width,height,x,y) {
  ctx.drawImage(main,sx,sy,width,height,x,y,width,height);
  if(intrinsic){
    ctx.save();ctx.globalCompositeOperation='lighter';
    ctx.drawImage(intrinsic,sx,sy,width,height,x,y,width,height);ctx.restore();
  }
}
