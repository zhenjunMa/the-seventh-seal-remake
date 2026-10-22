// Connections derive from DAT descriptors and markers, never substitute coordinates.
import {runtimeContent,storyBindings} from './content_registry.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(`地图接入：${message}`);};

export function chapterRouteExits(mapId,story,resources,content=runtimeContent){
  return storyBindings(mapId,content).routes.map(binding=>{
    const descriptor=resources.trigger_regions[mapId]?.find(row=>binding.descriptor_id===undefined
      ?row.field_26_raw===binding.record_id:row.id===binding.descriptor_id);
    need(descriptor?.state_raw===2&&descriptor.field_26_raw===binding.record_id&&descriptor.cells?.length,`${mapId} 出口 ${binding.record_id} 缺少原描述`);
    need(!storyBindings(mapId,content).triggers.includes(descriptor.id),`${mapId} 出口 ${descriptor.id} 不能同时登记为普通剧情触发器`);
    need(story.maps[mapId]?.records.some(row=>row.id===binding.record_id),`${mapId} 出口剧情缺失`);
    return {id:descriptor.id,state:'ready',kind:'world-map-event',cells:descriptor.cells,
      record_id:binding.record_id,source:descriptor};
  });
}

export function worldMapEntry(scene,destination,story){
  const table=story.maps[destination.map_id],marker=destination.entry_marker,code=destination.sort_code;
  if(!table){
    const entry=scene.data.route_entry;
    need(entry&&entry.marker===marker&&entry.sort_code===code,`${destination.map_id} 大地图入口尚未接入`);
    return {map_id:destination.map_id,x:entry.x,y:entry.y,direction:entry.direction};
  }
  const cells=(table.entry_markers?.[marker]??[]).slice(0,4);
  need(cells.length>0,`${destination.map_id} 缺少原入口标记 ${marker}`);
  let direction=2;
  if([2,6].includes(code)){cells.sort((a,b)=>b.y-a.y);direction=6+Number(code===6);}
  else if([3,7].includes(code)){cells.sort((a,b)=>a.x-b.x);direction=4+Number(code===7);}
  else if([4,8].includes(code)){cells.sort((a,b)=>b.x-a.x);direction=Number(code===8);}
  else need([0,1,5].includes(code),`${destination.map_id} 入口排序 ${code} 尚未实现`);
  const {x,y}=cells[0];
  need(Number.isInteger(x)&&x>=0&&Number.isInteger(y)&&y>=0,'入口格坐标无效');
  return {map_id:destination.map_id,x:x*16,y:y*16,direction};
}
