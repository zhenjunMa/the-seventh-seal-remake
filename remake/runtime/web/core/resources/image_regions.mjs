// Cache geometry only; decoded pixels continue to belong to resource scopes.
const selections=new WeakMap();
// Logical image coordinates remain stable when pixels move to texture pages.
export function imageRegions(image,sx=0,sy=0,sw=image.width,sh=image.height){
  const result=[];
  let regions;
  if(image.packed){
    let bank=selections.get(image);if(!bank){bank=new Map();selections.set(image,bank);}
    const key=`${sx},${sy},${sw},${sh}`;
    regions=bank.get(key);
    if(!regions){
      regions=image.regions.filter(([x,y,w,h])=>x<sx+sw&&x+w>sx&&y<sy+sh&&y+h>sy);
      if(bank.size>=512)bank.delete(bank.keys().next().value);
      bank.set(key,regions);
    }
  }else regions=[[0,0,image.width,image.height,0,0,0]];
  for(const [x,y,w,h,page,px,py,pixelScale=image.pixelScale??1]of regions){
    const left=Math.max(sx,x),top=Math.max(sy,y),right=Math.min(sx+sw,x+w),bottom=Math.min(sy+sh,y+h);
    if(right<=left||bottom<=top)continue;
    const entry=image.packed?image.pool.pages.get(page):null,bitmap=image.packed?entry?.bitmap:image;
    if(!bitmap)throw new Error('图片所需纹理页尚未驻留');
    if(entry)entry.used=image.pool.clock=(image.pool.clock??0)+1;
    result.push({bitmap,x:left,y:top,width:right-left,height:bottom-top,
      sx:px+(left-x)*pixelScale,sy:py+(top-y)*pixelScale,pixelScale});
  }
  return result;
}

export function drawImageRegion(context,image,...args){
  if(!image?.packed){
    const scale=image?.gpuPixelScale??1;
    if(scale>1&&args.length===2)context.drawImage(image,...args,image.width/scale,image.height/scale);
    else context.drawImage(image,...args);
    return;
  }
  let sx=0,sy=0,sw=image.width,sh=image.height,dx,dy,dw=sw,dh=sh;
  if(args.length===2)[dx,dy]=args;
  else if(args.length===4)[dx,dy,dw,dh]=args;
  else if(args.length===8)[sx,sy,sw,sh,dx,dy,dw,dh]=args;
  else throw new Error('图片绘制参数无效');
  if(sw<=0||sh<=0||dw<=0||dh<=0)return;
  for(const p of imageRegions(image,sx,sy,sw,sh))context.drawImage(p.bitmap,p.sx,p.sy,p.width*p.pixelScale,p.height*p.pixelScale,
    dx+(p.x-sx)*dw/sw,dy+(p.y-sy)*dh/sh,p.width*dw/sw,p.height*dh/sh);
}
