// Connections derive from DAT descriptors and markers, never substitute coordinates.
import {runtimeContent,storyBindings} from '../content/content_registry.mjs';
import {nativeMapIdFromFilename} from './native_map_identity.mjs';
import {bytes,view} from '../content/native_bytes.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(`地图接入：${message}`);};


// 4A80E0/4A81D0 ignore state0 with an empty filename, or state2 target zero.
// Only the verified 0x42 descriptor format qualifies; terrain is never changed.
export function nativeEmptyEventCells(movement,table){
  const cells=new Set();
  for(const descriptor of table?.descriptors??[]){
    if(descriptor.record_bytes!==0x42)continue;
    const emptyMap=descriptor.state_raw===0&&descriptor.filename_raw==='';
    const emptyTlk=descriptor.state_raw===2&&descriptor.field_26_raw===0;
    if(!emptyMap&&!emptyTlk)continue;
    const source=descriptor.source;
    need(source?.path?.toLowerCase()===movement.source?.toLowerCase()
      &&source.sha256===movement.source_sha256&&source.sha256===table.map_source?.sha256,
      '空事件地图来源不一致');
    const raw=bytes(descriptor.raw_hex,0x42,'空事件描述符');
    need(raw[0]===descriptor.state_raw&&(emptyMap?raw[0x11]===0:view(raw).getUint32(0x26,true)===0),
      '空事件原目标不一致');
    for(const cell of descriptor.cells??[]){
      need(Number.isInteger(cell.x)&&Number.isInteger(cell.y)&&cell.x>=0&&cell.y>=0
        &&cell.x<movement.width&&cell.y<movement.height
        &&cell.offset===0x172+(cell.y*movement.width+cell.x)*64
        &&movement.triggers.some(trigger=>trigger.id===descriptor.id&&trigger.x===cell.x&&trigger.y===cell.y),
        '空事件原触发格不一致');
      cells.add(`${cell.x},${cell.y}`);
    }
  }
  return cells;
}

// 4A81D0 keeps descriptor+2A as the placement sort code. A kind2 TLK
// replaces the entry marker with record+2F before 4A5110 scans it.
// 4A5110 normalizes a zero marker to marker1 and placement sort2.
export function nativeMapTransfer(table,record,{triggerId,triggerRecordId,npcSlot,objectIndex,sortCode=1}={},content=runtimeContent){
  need(record?.kind===2&&record.condition_type===0&&record.condition_bit===0,'地图跳转记录类型或条件未恢复');
  const mapId=nativeMapIdFromFilename(record.text_raw);need(mapId,'地图跳转文件名无效');
  const descriptor=table?.descriptors?.find(row=>row.id===triggerId);
  need(content.maps[mapId],'地图跳转目标尚未登记');
  need(Number.isInteger(record.if_true)&&record.if_true>=0&&record.if_true<=255,'地图跳转原入口标记无效');
  if(npcSlot!==undefined){
    need(storyBindings(table.id,content).npcs?.includes(npcSlot)&&table.index_nonzero?.some(row=>row.slot===npcSlot),'地图跳转缺少原NPC交互上下文');
  }else if(objectIndex!==undefined){
    const binding=storyBindings(table.id,content).objects.find(row=>row.index===objectIndex),
      object=table.objects?.find(row=>row.index===objectIndex);
    // 4137C0 dispatches the CF3/CF4 +F6 through the same TLK interpreter;
    // kind2 inherits the current placement sort for either explicit object.
    need(object?.interaction_record_raw_f6>0&&(
      binding?.handler==='tlk-object'&&object.behavior_raw_cf===1
      ||binding?.handler==='stationary-chest'&&[3,4].includes(object.behavior_raw_cf)),
      '地图跳转缺少原物件交互上下文');
  }else{
    need(descriptor?.state_raw===2&&descriptor.field_26_raw===triggerRecordId
      &&storyBindings(table.id,content).triggers.includes(triggerId),'地图跳转缺少当前原触发器上下文');
    sortCode=descriptor.field_2a_raw;
  }
  need(Number.isInteger(sortCode)&&sortCode>=0&&sortCode<=8,'地图跳转原排序无效');
  return {map_id:mapId,entry_marker:record.if_true||1,sort_code:record.if_true===0?2:sortCode,
    source:{record:record.source??table.source,...(npcSlot!==undefined?{npc_slot:npcSlot}:objectIndex!==undefined?{object_index:objectIndex}:{descriptor:descriptor.source??descriptor})}};
}

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

// ANM loads can carry coordinates across map variants. When those coordinates
// are outside the destination's usable ground, seed the scene at its source
// marker. Later ANM placement and movement still control the final position.
export function chapterAnimationEntry(scene,location,story,sortCode=1){
  const id=scene.data.id;
  if(location.map_id===id||!scene.movement||scene.movement.validEntry(location.x,location.y))return location;
  if(!story.maps[id]?.entry_markers?.[1]?.length)return location;
  const entry=worldMapEntry(scene,{map_id:id,entry_marker:1,sort_code:sortCode},story);
  return scene.movement.validEntry(entry.x,entry.y)?entry:location;
}
