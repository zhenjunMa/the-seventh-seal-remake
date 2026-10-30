// 512B50 mode4 ->51E410 ->51D5B0's X-only entry path. Native points
// are eight pixels apart and retain the exact final saved position.
export function nativeEntryPath({origin_x,x},at){
  const points=[];for(let point=x;point<origin_x;point+=8)points.push(point);points.push(origin_x);
  return {origin:origin_x,points,cursor:0,from:x-origin_x,to:x-origin_x,at,interval:1};
}
export function advanceNativeEntryPath(path,step,at,interval){
  path.from=path.to;path.at=at;path.interval=interval;
  path.cursor=Math.min(path.points.length-1,path.cursor+step);
  path.to=path.points[path.cursor]-path.origin;
  return path.cursor===path.points.length-1;
}
// Preserve the battle renderer's existing between-frame interpolation adapter;
// every source-frame endpoint still uses the recovered discrete native point.
export const nativeEntryOffset=(path,now)=>path.from+(path.to-path.from)*Math.min(1,Math.max(0,now-path.at)/path.interval);
