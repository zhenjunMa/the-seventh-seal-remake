// Audit only admitted entrances as build gates. Legacy implicit NPC dialogue is
// inventoried separately so existing bounded content does not gain new promises.
import {chapterRestChoices,initializeChapterItem} from './chapter.mjs';
import {validateChapterAnimation} from './chapter_animation.mjs';
import {validateRouteRecord} from './route.mjs';
import {chapterRouteExits} from './map_connections.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(message);};
const flagIndex=n=>Number.isInteger(n)&&n>=0&&n<2000;

export function inspectContentReadiness(content,story,resources){
  const errors=[],warnings=[],entrances=[];
  for(const [mapId,binding]of Object.entries(content.maps)){
    const table=story.maps[mapId];
    const roots=[];
    if(binding.entry_record)roots.push({kind:'entry',id:binding.entry_record});
    for(const id of binding.triggers){
      const row=resources.trigger_regions[mapId]?.find(row=>row.id===id);
      roots.push({kind:'trigger',id:row?.field_26_raw,label:id});
    }
    for(const row of binding.objects)roots.push({kind:'object',id:table?.objects.find(obj=>obj.index===row.index)?.interaction_record_raw_f6,label:row.index});
    for(const row of binding.rests)roots.push({kind:'rest',id:row.record_id,label:row.descriptor_id,explicit:true});
    for(const row of binding.routes)roots.push({kind:'route',id:row.record_id,label:row.descriptor_id});
    const npcSlots=binding.npcs??(resources.npcs_by_map[mapId]??[]).map(npc=>npc.slot_zero_based);
    for(const slot of new Set(npcSlots)){
      const id=table?.index_nonzero.find(row=>row.slot===slot)?.record;
      if(id||binding.npcs)roots.push({kind:'npc',id,label:slot,advisory:binding.npcs===undefined});
    }
    for(const root of roots){
      const diagnostic=(recordId,message)=>({map_id:mapId,entrance:root.kind,entrance_id:root.label??root.id,record_id:recordId,message});
      const seen=new Set(),programs=new Set(),queue=[{mapId,id:root.id,route:root.kind==='route',explicit:root.explicit}];
      const target=root.advisory?warnings:errors;
      let opensWorldMap=false;
      const add=(id,options={})=>{if(id)queue.push({mapId,id,explicit:root.explicit,...options});};
      try{
        need(Number.isInteger(root.id)&&root.id>0,'缺少原始剧情入口');
        if(root.kind==='entry')need(table.header_entry_tlk_raw===root.id,'进入剧情与 DAT +0x11E 不同');
        if(root.kind==='route')chapterRouteExits(mapId,story,resources,content);
      }catch(error){target.push(diagnostic(root.id,error.message));continue;}
      while(queue.length){
        const item=queue.shift(),key=`${item.mapId}:${item.id}:${Boolean(item.route)}:${Boolean(item.falseOnly)}`;
        if(seen.has(key))continue;seen.add(key);
        const current=story.maps[item.mapId],record=current?.records.find(row=>row.id===item.id);
        try{
          need(seen.size<=1000,'可达剧情超过执行步数上限');
          need(record,`缺少 ${item.mapId}:${item.id} 剧情记录`);
          if(item.route){
            validateRouteRecord(record,item.mapId,content);
            if(record.mutation_type===9&&record.mutation_index===0)opensWorldMap=true;
            if(record.condition_bit)add(record.if_true,{route:true});
            if(record.kind===1){
              const route=binding.routes.find(row=>row.record_id===record.id);
              need(current.records.some(row=>row.id===route.denial_record_id),'出口拒绝对白缺失');
              if(route.requires_flag)add(record.id,{falseOnly:true});
            }else add(record.next,{route:true});
            continue;
          }
          need(record.condition_type===0,`剧情条件 ${record.condition_type} 尚未实现`);
          const bit=record.condition_bit|0,index=record.condition_index||current.map_flag_index;
          need(bit===0||bit>=1&&bit<=32&&flagIndex(index),'剧情旗标条件未支持');
          switch(record.mutation_type){
            case 0:{
              const mutation=record.mutation_bit|0;
              need(mutation===0||mutation>=-32&&mutation<=32&&flagIndex(record.mutation_index||current.map_flag_index),'旗标变更未支持');break;
            }
            case 1:
              need(record.region_byte_raw===0&&record.mutation_index===0&&binding.objects.some(row=>row.index===record.mutation_bit-1&&row.handler==='stationary-chest'),'物件状态变更处理器尚未接入');break;
            case 2:
              need(item.explicit&&record.mutation_index===0&&record.mutation_bit===0&&binding.rests.some(row=>row.restore_records.includes(record.id)),'恢复分支需要已登记的主动休息入口');break;
            case 5:{
              const definition=story.item_definitions?.[record.mutation_bit];
              need(record.mutation_index===0&&definition?.source?.sha256===story.source_hashes[definition.source.path],'道具变更来源或处理器缺失');
              initializeChapterItem(definition);break;
            }
            default:throw new Error(`剧情变更 ${record.mutation_type} 尚未实现`);
          }
          if(bit&&!item.falseOnly)add(record.if_true);
          if(record.kind===0){
            const choiceBytes=record.raw_hex?.slice(0x537*2);
            if(record.style===1&&choiceBytes&&/[^0]/.test(choiceBytes)){
              const rest=binding.rests.find(row=>row.record_id===record.id);
              need(item.explicit&&rest,'选择分支需要已登记的主动入口');
              for(const choice of chapterRestChoices(record,rest))add(choice.recordId);
            }else add(record.next);
          }else if(record.kind===1){
            const name=record.text_raw.replace(/\.anm$/i,'').toLowerCase(),program=story.programs[name];
            need(program&&content.programs[name],`演出 ${name} 尚未登记`);
            validateChapterAnimation(program,content);
            need(program.expected.control_map===item.mapId,`演出 ${name} 跨控制地图尚未支持`);
            if(!programs.has(name)){
              programs.add(name);
              for(const command of program.commands)if(command.opcode===14)add(command.u32_plus5);
            }
            add(record.next);
          }else throw new Error(`对白类型 ${record.kind} 尚未实现`);
        }catch(error){target.push(diagnostic(item.id,error.message));}
      }
      if(root.kind==='route'&&!opensWorldMap)target.push(diagnostic(root.id,'出口可达分支未产生大地图入口命令'));
      entrances.push({map_id:mapId,kind:root.kind,id:root.label??root.id,records:seen.size,advisory:Boolean(root.advisory)});
    }
  }
  return {schema:'seventh-seal-content-readiness',version:1,passed:errors.length===0,entrances,errors,warnings};
}

export function requireContentReadiness(content,story,resources){
  const report=inspectContentReadiness(content,story,resources);
  if(!report.passed)throw new Error('内容能力预检查失败：\n'+report.errors.map(row=>`${row.map_id} ${row.entrance} ${row.entrance_id} → TLK ${row.record_id}: ${row.message}`).join('\n'));
  return report;
}
