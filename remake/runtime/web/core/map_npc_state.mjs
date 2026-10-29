// 478C80 -> 4B2960 restores the current map's complete 0x4C5 actor table.
// Retain the pose fields used by the remake, without caching other maps.
import {isNativeMapId} from './native_map_identity.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(`地图人物存档：${message}`);};

export function validateMapNpcState(state){
  need(state&&Object.keys(state).sort().join(',')==='actors,map_id'&&isNativeMapId(state.map_id),'地图字段无效');
  need(Array.isArray(state.actors)&&state.actors.length<=255,'人物表无效');
  const slots=new Set();
  for(const row of state.actors){
    need(row&&Object.keys(row).sort().join(',')==='action,direction,frame,hidden,slot,x,y'
      &&Number.isInteger(row.slot)&&row.slot>=10&&row.slot<=264&&!slots.has(row.slot),'人物槽无效');slots.add(row.slot);
    need(Number.isFinite(row.x)&&Number.isFinite(row.y)&&Number.isInteger(row.direction)&&row.direction>=0&&row.direction<8
      &&typeof row.hidden==='boolean'&&Number.isInteger(row.action)&&row.action>=0&&row.action<=127
      &&Number.isInteger(row.frame)&&row.frame>=0&&row.frame<=65535,'人物姿态无效');
  }
}

export function captureMapNpcState(draft,mapId,npcs){
  draft.map_npc_state={map_id:mapId,actors:npcs.filter(npc=>Number.isInteger(npc.slot_zero_based)&&npc.slot_zero_based>=10)
    .map(npc=>({slot:npc.slot_zero_based,x:npc.x,y:npc.y,direction:npc.motion?.direction??npc.direction,
      hidden:Boolean(npc.hidden),action:npc.motion?.action??npc.action??npc.stage_action??0,
      frame:npc.motion?.frame??npc.frame??npc.stage_frame??0}))};
}

export function restoreMapNpcState(npcs,world,mapId){
  if(world.map_npc_state?.map_id!==mapId)return npcs;
  const saved=new Map(world.map_npc_state.actors.map(row=>[row.slot,row]));
  for(const npc of npcs){
    const row=saved.get(npc.slot_zero_based);if(!row)continue;
    Object.assign(npc,{x:row.x,y:row.y,direction:row.direction,hidden:row.hidden,stage_action:row.action,stage_frame:row.frame});
  }
  return npcs;
}
