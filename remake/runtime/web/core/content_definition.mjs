// Author only admission choices. Identity, hashes and native story fields come
// from the retained source catalogs; the resolved runtime table is generated.
const copy=structuredClone;
const need=(ok,message)=>{if(!ok)throw new Error(`内容定义：${message}`);};
const keys=(row,allowed,label)=>need(row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).every(key=>allowed.includes(key)),`${label} 包含重复来源或未知字段`);
export function resolveContentDefinition(definition,{seed,forest,story,maps}){
  need(definition?.schema==='seventh-seal-runtime-content'&&definition.version===2,'编辑格式版本无效');
  keys(definition,['schema','version','roles','battle_rosters','stages','programs','maps'],'根');
  need(Array.isArray(definition.programs)&&new Set(definition.programs).size===definition.programs.length,'演出登记重复或无效');
  const roles={};
  for(const [id,row]of Object.entries(definition.roles)){
    keys(row,['side','battle_skills','field_skills','primary_skill','presentation'],`角色 ${id}`);
    const source=row.side==='player'?seed.source.role_definitions[id]:forest.actors[id]?.source;
    need(source?.path===`Fight_Role/${id}.CHR`&&/^[a-f0-9]{64}$/.test(source.sha256??''),`角色 ${id} 缺少原始定义`);
    const skills=rows=>(rows??[]).map(binding=>{
      keys(binding,['index','id','handler'],`技能 ${id}`);
      return {...copy(binding),id:binding.id??`${id}_${binding.index}`};
    });
    roles[id]={side:row.side,source:{path:source.path,sha256:source.sha256},
      ...(row.side==='player'?{native_slot:Number(id)-1,battle_skills:skills(row.battle_skills),field_skills:skills(row.field_skills),primary_skill:row.primary_skill}:{}),
      ...(row.presentation?{presentation:copy(row.presentation)}:{})};
  }
  const battle_rosters=Object.fromEntries(Object.entries(definition.battle_rosters).map(([id,rows])=>[id,rows.flatMap(value=>
    value==='$players'?Object.keys(roles).filter(id=>roles[id].side==='player'):
    value==='$enemies'?Object.keys(roles).filter(id=>roles[id].side==='enemy'):[value])]));
  const programs=Object.fromEntries(definition.programs.map(id=>{
    const source=story.programs[id]?.source;need(source,`演出 ${id} 缺少来源`);return [id,copy(source)];
  }));
  const resolvedMaps={};
  for(const [id,row]of Object.entries(definition.maps)){
    keys(row,['triggers','objects','rests','routes','export'],`地图 ${id}`);
    if(row.export){
      keys(row.export,['assets','story'],`地图导出 ${id}`);
      need(row.export.assets===undefined||['chapter','existing'].includes(row.export.assets),`地图 ${id} 素材导出器无效`);
      need(row.export.story===undefined||typeof row.export.story==='boolean',`地图 ${id} 剧情导出选择无效`);
    }
    const table=story.maps[id],map=maps[id];need(map?.id===id,`地图 ${id} 缺少来源`);
    const rests=(row.rests??[]).map(rest=>{
      keys(rest,['descriptor_id'],`休息 ${id}`);
      const descriptor=table?.descriptors.find(item=>item.id===rest.descriptor_id),record=table?.records.find(item=>item.id===descriptor?.field_26_raw);
      need(descriptor?.state_raw===2&&record?.raw_hex?.length===0x66f*2,`休息 ${id} 缺少已支持的选择记录`);
      const raw=Uint8Array.from(record.raw_hex.match(/../g),part=>parseInt(part,16)),view=new DataView(raw.buffer),choices=[];
      for(let index=0;index<3;index++){
        const offset=0x537+index*104,bytes=raw.slice(offset,offset+100),end=bytes.indexOf(0);
        const text=new TextDecoder('gbk',{fatal:true}).decode(end<0?bytes:bytes.slice(0,end)),record_id=view.getUint32(offset+100,true);
        if(text)choices.push({index,text,record_id});else need(record_id===0,'空选择包含目标');
      }
      const restore_records=choices.filter(choice=>table.records.some(target=>target.id===choice.record_id&&target.mutation_type===2&&target.mutation_index===0&&target.mutation_bit===0)).map(choice=>choice.record_id);
      need(restore_records.length>0,`休息 ${id} 缺少恢复分支`);
      return {descriptor_id:rest.descriptor_id,record_id:record.id,restore_records,choices};
    });
    const flag_index=table?.map_flag_index??map.map_flag_index??map.flag_index;
    resolvedMaps[id]={path:`data/maps/${id.toLowerCase()}.json`,triggers:copy(row.triggers??[]),objects:copy(row.objects??[]),rests,routes:copy(row.routes??[]),
      ...(flag_index===undefined?{}:{flag_index})};
  }
  return {schema:definition.schema,version:1,party_limit:4,roles,battle_rosters,stages:copy(definition.stages),programs,maps:resolvedMaps};
}
