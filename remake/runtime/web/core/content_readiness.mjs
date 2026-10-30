// Audit only admitted entrances as build gates. Legacy implicit NPC dialogue is
// inventoried separately so existing bounded content does not gain new promises.
import {chapterChoices,chapterRestChoices,initializeChapterItem} from './chapter.mjs';
import {validateChapterAnimation,validateChapterSetupAnimation} from './chapter_animation.mjs';
import {validateRouteRecord} from './route.mjs';
import {chapterRouteExits,nativeMapTransfer} from './map_connections.mjs';
import {validateNativeStoryCondition} from './native_story_conditions.mjs';
import {validateNativeStoryMutation} from './native_story_mutations.mjs';
import {nativeScriptedBattle} from './scripted_battle.mjs';
import {nativeKeyedChest,nativeChestAnimation} from './native_map_chests.mjs';
import {nativeCombinationConditions} from './native_story_combinations.mjs';
import {readNativeService} from './native_economy.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(message);};
const flagIndex=n=>Number.isInteger(n)&&n>=0&&n<2000;

export function requireLearningRewardReadiness(record,content,roleDefinitions){
  if(record.mutation_type!==14)return null;
  const id=String(record.mutation_index+1).padStart(3,'0'),definition=roleDefinitions?.[id];
  need(definition,`学习奖励角色 ${id} 缺少原技能源定义`);
  const source=definition.skills.find(skill=>skill.id===record.mutation_bit);
  // The native helper has no effect on a missing source ID. A source type0
  // record remains absent from the native menu after its learned bit is set.
  if(!source||!source.has_menu_type&&!hasPartySkillTypeCorrection({...source,actor_id:id}))return source??null;
  const role=content.roles[id],bindings=[...role?.battle_skills??[],...role?.field_skills??[]];
  need(bindings.some(binding=>binding.index===source.index),
    `学习奖励 ${id}／原ID${record.mutation_bit}（索引${source.index}）尚无已接入技能处理器`);
  return source;
}

export function inspectContentReadiness(content,story,resources){
  const errors=[],warnings=[],entrances=[];
  for(const [mapId,binding]of Object.entries(content.maps)){
    const table=story.maps[mapId];
    const roots=[];
    if(binding.entry_record)roots.push({kind:'entry',id:binding.entry_record});
    if(binding.setup_record)roots.push({kind:'setup',id:binding.setup_record});
    for(const id of binding.triggers){
      const row=resources.trigger_regions[mapId]?.find(row=>row.id===id);
      roots.push({kind:'trigger',id:row?.field_26_raw,label:id});
    }
    for(const row of binding.objects)roots.push(row.handler==='keyed-chest'
      ?{kind:'direct-object',id:row.index,label:row.index}
      :{kind:'object',id:table?.objects.find(obj=>obj.index===row.index)?.interaction_record_raw_f6,label:row.index,explicit:row.handler==='tlk-object'});
    for(const row of binding.rests)roots.push({kind:'rest',id:row.record_id,label:row.descriptor_id,explicit:true});
    for(const row of binding.routes)roots.push({kind:'route',id:row.record_id,label:row.descriptor_id});
    const npcSlots=binding.npcs??(resources.npcs_by_map[mapId]??[]).map(npc=>npc.slot_zero_based);
    for(const slot of new Set(npcSlots)){
      const id=table?.index_nonzero.find(row=>row.slot===slot)?.record;
      if(id||binding.npcs)roots.push({kind:'npc',id,label:slot,explicit:true,advisory:binding.npcs===undefined});
    }
    for(const root of roots){
      const diagnostic=(recordId,message)=>({map_id:mapId,entrance:root.kind,entrance_id:root.label??root.id,record_id:recordId,message});
      const seen=new Set(),programs=new Set(),queue=[{mapId,id:root.id,route:root.kind==='route',explicit:root.explicit}];
      const target=root.advisory?warnings:errors;
      let opensWorldMap=false;
      let activeMap=mapId;
      const add=(id,options={})=>{if(id)queue.push({mapId:activeMap,id,explicit:root.explicit,...options});};
      if(root.kind==='direct-object'){
        try{
          const object=table?.objects.find(row=>row.index===root.id),chest=nativeKeyedChest(object);
          need(object.source?.sha256===story.source_hashes[object.source.path],'宝箱原地图来源缺失');
          for(const reward of chest.rewards){
            const definition=story.item_definitions?.[reward.id];
            need(definition?.source?.sha256===story.source_hashes[definition.source.path],'宝箱奖励道具来源缺失');
            initializeChapterItem(definition);
          }
          const animation=resources.object_animations[mapId]?.find(row=>row.object_index_zero_based===root.id);
          need(animation,'宝箱动作资源缺失');nativeChestAnimation(animation,4);
          entrances.push({map_id:mapId,kind:root.kind,id:root.id,records:0,advisory:false});
        }catch(error){target.push(diagnostic(null,error.message));}
        continue;
      }
      try{
        need(Number.isInteger(root.id)&&root.id>0,'缺少原始剧情入口');
        if(root.kind==='entry')need(table.header_entry_tlk_raw===root.id,'进入剧情与 DAT +0x13A 不同');
        if(root.kind==='setup')need(table.header_setup_tlk_raw===root.id,'加载布置与 DAT +0x8A 不同');
        if(root.kind==='route')chapterRouteExits(mapId,story,resources,content);
      }catch(error){target.push(diagnostic(root.id,error.message));continue;}
      while(queue.length){
        const item=queue.shift(),key=`${item.mapId}:${item.id}:${Boolean(item.route)}:${Boolean(item.falseOnly)}`;
        activeMap=item.mapId;
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
          if(record.kind!==4&&record.condition_type!==0)validateNativeStoryCondition(record,current);
          if(record.kind===4)nativeCombinationConditions(record,current);
          if(root.kind==='setup')need(record.condition_type===0&&record.mutation_type===0&&record.mutation_bit===0,'加载入口只能包含布局与旗标判断');
          const bit=record.condition_bit|0,index=record.condition_index||current.map_flag_index;
          if(record.kind!==4&&record.condition_type===0)need(bit===0||bit>=1&&bit<=32&&flagIndex(index),'剧情旗标条件未支持');
          switch(record.mutation_type){
            case 0:{
              const mutation=record.mutation_bit|0;
              need(mutation===0||mutation>=-32&&mutation<=32&&flagIndex(record.mutation_index||current.map_flag_index),'旗标变更未支持');break;
            }
            case 1:
              need(record.region_byte_raw===0&&record.mutation_index===0&&binding.objects.some(row=>row.index===record.mutation_bit-1&&row.handler==='stationary-chest'),'物件状态变更处理器尚未接入');break;
            case 2:
              need(item.explicit&&record.mutation_index===0&&record.mutation_bit===0,'恢复分支需要已登记的主动休息入口');break;
            case 4:
              need(item.explicit&&record.mutation_index===0&&record.mutation_bit===0,'存档分支需要主动交互入口');break;
            case 5:{
              const definition=story.item_definitions?.[record.mutation_bit];
              if(record.mutation_index===0){
                need(definition?.source?.sha256===story.source_hashes[definition.source.path],'道具变更来源或处理器缺失');
                initializeChapterItem(definition);
              }else need(record.mutation_bit>=0&&record.mutation_bit<=416,'移除道具来源编号无效');
              break;
            }
            case 3:case 10:case 11:case 14:case 16:case 17:
              validateNativeStoryMutation(record,{roleDefinitions:story.role_definitions});
              if(record.mutation_type===17&&record.mutation_bit){
                const definition=story.item_definitions?.[record.mutation_bit];
                need(definition?.source?.sha256===story.source_hashes[definition.source.path],'配方产物来源缺失');
                initializeChapterItem(definition,{allowWeapon:true});
              }
              requireLearningRewardReadiness(record,content,story.role_definitions);break;
            case 9:need(record.region_byte_raw>=0&&record.region_byte_raw<2&&record.mutation_index>=0&&record.mutation_index<=2
              &&record.mutation_bit>=0&&record.mutation_bit<7,'大地图状态命令未支持');break;
            default:throw new Error(`剧情变更 ${record.mutation_type} 尚未实现`);
          }
          if((bit||record.condition_type!==0||record.kind===4)&&record.kind!==2&&!item.falseOnly)add(record.if_true);
          if(record.kind===0){
            const choiceBytes=record.raw_hex?.slice(0x537*2);
            if(record.style===1&&choiceBytes&&/[^0]/.test(choiceBytes)){
              const rest=binding.rests.find(row=>row.record_id===record.id);
              need(item.explicit,'选择分支需要已登记的主动入口');
              for(const choice of rest?chapterRestChoices(record,rest):chapterChoices(record))add(choice.recordId);
            }else add(record.next);
          }else if(record.kind===1){
            const name=record.text_raw.replace(/\.anm$/i,'').toLowerCase(),program=story.programs[name];
            need(program&&content.programs[name],`演出 ${name} 尚未登记`);
            validateChapterAnimation(program,content);
            if(root.kind==='setup')validateChapterSetupAnimation(program,item.mapId,content);
            if(!programs.has(name)){
              programs.add(name);
              let controlMap=item.mapId;
              for(const command of program.commands){
                if(command.opcode===10&&command.u32_plus5===0)controlMap=command.filename.replace(/\.dat$/i,'').toUpperCase();
                if(command.opcode===14)add(command.u32_plus5,{mapId:controlMap});
              }
            }
            add(record.next);
          }else if(record.kind===2){
            need(['trigger','npc','object'].includes(root.kind)&&item.mapId===mapId,'地图跳转需要原地形或主动交互上下文');
            const destination=nativeMapTransfer(current,record,root.kind==='npc'?{npcSlot:root.label}:
              root.kind==='object'?{objectIndex:root.label}:
              {triggerId:root.label,triggerRecordId:root.id},content);
            const targetTable=story.maps[destination.map_id];
            need(targetTable?.entry_markers?.[destination.entry_marker]?.length,'目标地图原进入标记缺失');
            const entry=content.maps[destination.map_id].entry_record;
            if(entry)add(entry,{mapId:destination.map_id});
            add(record.next);
          }else if(record.kind===4)add(record.next);
          else if(record.kind===5){nativeScriptedBattle(current,record,content);add(record.next);}
          else if(record.kind===8){
            need(item.explicit,'商店服务需要已登记的主动入口');
            for(const id of readNativeService(record,current).goods){
              const definition=story.item_definitions?.[id];
              need(definition?.source?.sha256===story.source_hashes[definition.source.path],'商店商品来源缺失');
              initializeChapterItem(definition,{allowWeapon:true});
            }
            add(record.next);
          }
          else throw new Error(`对白类型 ${record.kind} 尚未实现`);
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
import {hasPartySkillTypeCorrection} from './party_skill_corrections.mjs';
