// Registered exit TLK chains share the recovered handlers. Preparation happens
// before applying commands; unsupported records do not partly change the menu.
import {runtimeContent,storyBindings} from './content_registry.mjs';
export function validateRouteRecord(r,map_id,content=runtimeContent){
  if(r.condition_type!==0||!Number.isInteger(r.condition_bit)||r.condition_bit<0||r.condition_bit>32)throw new Error('出口剧情条件未支持');
  const index=r.condition_index||content.maps[map_id]?.flag_index;
  if(r.condition_bit!==0&&(!Number.isInteger(index)||index<0||index>=2000))throw new Error('出口剧情旗标来源缺失');
  if(r.kind===1){
    const binding=storyBindings(map_id,content).routes.find(row=>row.record_id===r.id);
    if(!binding||binding.animation!==r.text_raw)throw new Error('出口动画尚未接入');
    if(binding.requires_flag&&(binding.requires_flag.index!==index||binding.requires_flag.bit!==r.condition_bit))throw new Error('出口前置旗标与原记录不同');
  }else if(r.kind!==0)throw new Error('出口事件类型未支持');
  else if(storyBindings(map_id,content).routes.some(row=>row.record_id===r.id&&row.requires_flag))throw new Error('出口前置旗标需要对应的原 ANM 分支');
  if(r.mutation_type===9){
    if(!Number.isInteger(r.region_byte_raw)||r.region_byte_raw<0||r.region_byte_raw>1)throw new Error('大地图区域未接入');
    if(!Number.isInteger(r.mutation_index)||r.mutation_index<0||r.mutation_index>2||!Number.isInteger(r.mutation_bit)||r.mutation_bit<0||r.mutation_bit>=7)throw new Error('大地图状态命令未支持');
  }else if(r.mutation_type!==0||r.mutation_bit!==0)throw new Error('出口事件变更未支持');
  return index;
}
export function planRouteExit(world,map_id,record_id,data,content=runtimeContent){
  const table=data?.[map_id];if(!table||!/^M\d{5}$/.test(map_id))throw new Error('出口剧情尚未接入');
  const records=new Map(table.records.map(r=>[r.id,r])),commands=[],visited=new Set();let id=record_id;
  while(id){
    if(visited.has(id)||visited.size>20)throw new Error('出口剧情链循环');visited.add(id);
    const r=records.get(id);if(!r)throw new Error(`出口剧情记录${id}尚未接入`);
    const index=validateRouteRecord(r,map_id,content);
    const passed=r.condition_bit!==0&&Boolean(world.flags[index]&(1<<(r.condition_bit-1)));
    if(r.kind===1){
      const binding=storyBindings(map_id,content).routes.find(row=>row.record_id===r.id);
      if(!binding||binding.animation!==r.text_raw)throw new Error('出口动画尚未接入');
      if(!passed){const line=records.get(binding.denial_record_id),speaker=world.source.role_definitions?.[binding.speaker_role_id]?.name??world.party.find(role=>role.id===binding.speaker_role_id)?.name;
        if(!line||!speaker)throw new Error('出口拒绝对白来源缺失');
        return {commands:[],denied:{speaker,text:line.text_raw,source:table.source,offset:line.offset},source:table.source};}
    }else if(r.kind!==0)throw new Error('出口事件类型未支持');
    if(r.mutation_type===9){
      commands.push({mode:r.mutation_index,area:r.region_byte_raw,destination:r.mutation_bit});
    }else if(r.mutation_type!==0||r.mutation_bit!==0)throw new Error('出口事件变更未支持');
    id=passed?r.if_true:r.next;
  }
  if(!commands.some(c=>c.mode===0))throw new Error('出口未产生大地图入口');
  return {commands,source:table.source};
}
