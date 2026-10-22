// Cross-file contracts shared by the exporter and extension regression tests.
import {validateContentRegistration,requireRegisteredRoles,registeredRoles,sourceHash} from './content_registry.mjs';
import {validateEncounterData} from './encounters.mjs';
import {validateForestAIData} from './forest_ai.mjs';
import {validateForestRewards} from './battle_rewards.mjs';
import {validateForestReactionsData} from './battle_reactions.mjs';
import {validateForestStatusData} from './battle_status.mjs';
import {validateChapterStory,chapterRestChoices} from './chapter.mjs';
import {validateChapterAnimation} from './chapter_animation.mjs';
import {validateBattleViewMetadata} from '../battle_view.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(`内容依赖：${message}`);};

export function validateStoryBindings(content,story,resources){
  validateChapterStory(story);
  for(const [id,binding]of Object.entries(content.maps)){
    const table=story.maps[id];
    need(table||![...binding.triggers,...binding.objects,...binding.rests,...binding.routes].length,`${id} 缺少剧情表`);
    for(const triggerId of binding.triggers){
      const trigger=resources.trigger_regions[id]?.find(row=>row.id===triggerId);
      need(trigger&&table.records.some(record=>record.id===trigger.field_26_raw),`${id} 触发器 ${triggerId} 缺少对白入口`);
    }
    for(const row of binding.objects){
      const object=table.objects.find(object=>object.index===row.index),raw=object?.raw_hex;
      need(typeof raw==='string'&&raw.length===0x112*2,`${id} 物件 ${row.index} 缺少来源`);
      const b=Uint8Array.from(raw.match(/../g),part=>parseInt(part,16)),recordId=new DataView(b.buffer).getUint32(0xf6,true);
      need(b[0xcf]===3&&b[0x109]===0&&table.records.some(record=>record.id===recordId),`${id} 物件处理器与原记录不符`);
      const animation=resources.object_animations[id]?.find(item=>item.object_index_zero_based===row.index);
      const source=resources.interactive_objects[id]?.find(item=>item.object_index_zero_based===row.index)?.source;
      need(animation?.frames.length&&source?.raw_hex===raw&&source.sha256===object.source.sha256,`${id} 物件 ${row.index} 缺少动作或来源不一致`);
    }
    for(const rest of binding.rests){
      const descriptor=table.descriptors.find(row=>row.id===rest.descriptor_id),record=table.records.find(row=>row.id===rest.record_id);
      need(descriptor?.state_raw===2&&descriptor.field_26_raw===rest.record_id&&descriptor.field_2a_raw===0&&descriptor.field_2e_raw===1,`${id} 休息入口与原描述不同`);
      const choices=chapterRestChoices(record,rest);
      for(const choice of choices)need(choice.recordId===0||table.records.some(row=>row.id===choice.recordId),`${id} 选择跳转缺失`);
      for(const recordId of rest.restore_records){
        const target=table.records.find(row=>row.id===recordId);
        need(target?.mutation_type===2&&target.mutation_index===0&&target.mutation_bit===0&&choices.some(row=>row.recordId===recordId),`${id} 休息恢复记录未支持`);
      }
    }
    for(const route of binding.routes)need(table.records.some(row=>row.id===route.record_id),`${id} 出口剧情缺失`);
  }
  for(const [id,source]of Object.entries(content.programs)){
    const program=story.programs[id];
    need(program&&program.source.path===source.path&&program.source.sha256===source.sha256&&story.source_hashes[source.path]===source.sha256,`演出 ${id} 来源不一致`);
    need(content.maps[program.expected?.control_map],`演出 ${id} 地图未登记`);
    validateChapterAnimation(program,content);
  }
  return true;
}

export function validateContentDependencies(content,data){
  validateContentRegistration(content);
  const {catalog,seed,story,resources,party,commands,forest,ai,rewards,reactions,status,encounters,view,itemView,lifecycle,menu}=data;
  requireRegisteredRoles(Object.keys(party.actors),{side:'player',complete:true},content);
  requireRegisteredRoles(Object.keys(forest.actors),{side:'enemy',complete:true},content);
  requireRegisteredRoles(Object.keys(commands.roles),{side:'player',complete:true},content);
  requireRegisteredRoles(itemView.roles.map(row=>row.id),{side:'player',complete:true},content);
  requireRegisteredRoles(lifecycle.roles.map(row=>row.id),{roster:'party-source-group'},content);
  const maps=new Map(catalog.maps.map(row=>[row.id,row.path]));
  need(maps.size===Object.keys(content.maps).length&&Object.entries(content.maps).every(([id,row])=>maps.get(id)===row.path),'地图目录与登记不同');
  const sourceMatches=(id,source,label)=>need(source?.path===content.roles[id].source.path&&source.sha256===content.roles[id].source.sha256,`${id} ${label}来源不一致`);
  for(const id of registeredRoles('player',content)){
    const definition=seed.source.role_definitions[id];
    sourceMatches(id,definition,'新游戏');sourceMatches(id,party.actors[id].source,'属性');sourceMatches(id,commands.roles[id].source,'技能');
    need(content.roles[id].native_slot===Number(id)-1&&party.actors[id].native_role_slot_zero_based===content.roles[id].native_slot,`${id} 原角色槽不一致`);
    need(catalog.roles.some(role=>role.id===id)&&resources.roles[id],`${id} 地图行走资源缺失`);
    need(menu?.actor_panels?.[id]&&menu.standing_actors?.[id]?.frames.length,`${id} 菜单人物条或站立图缺失`);
    const standing=menu.standing_actors[id],idle=view.roles.find(role=>role.id===id)?.idle;
    need(standing.timing_source?.path==='data/party_battle_view.json'&&standing.timing_source.role_id===id&&standing.timing_source.pose==='idle'&&standing.interval_ms===idle?.interval_raw,`${id} 菜单与战斗待机时序不一致，请重新构建menu`);
    need(Object.values(commands.skills).some(skill=>skill.actor_id===id),`${id} 未登记可执行战斗技能`);
    for(const [bindings,skills]of [[content.roles[id].battle_skills,commands.skills],[content.roles[id].field_skills??[],commands.field_skills]])for(const binding of bindings){
      const skill=skills?.[binding.id];need(skill?.actor_id===id&&skill.original_skill_index===binding.index,`${id} 技能 ${binding.id} 缺少已登记的原索引`);
      if(binding.handler==='effect-carrier'){
        need(skill.battle_handler===binding.handler&&skill.effect_context?.effect_source_skill_index===binding.index,`${id} 特效处理器绑定不同`);
        for(const [targetId,target]of Object.entries(ai.roles))need(target.skill_count<=binding.index&&skill.effect_context.effect_target_skill.source_skill_count_by_role[targetId]===target.skill_count,`${id} 特效目标技能槽需要恢复非空记录处理`);
      }
    }
  }
  for(const id of registeredRoles('enemy',content)){
    sourceMatches(id,forest.actors[id].source,'属性');sourceMatches(id,ai.roles[id]?.source,'AI');
    need(forest.skills[`${id}_attack`],`${id} 缺少默认行动`);
  }
  for(const row of lifecycle.roles)need(row.source_chr===content.roles[row.id].source.path&&row.source_chr_sha256===content.roles[row.id].source.sha256,`${row.id} 生命周期来源不一致`);
  // A new source skill may reuse implemented effect handlers, never silently
  // acquire an unknown status just because its owner was registered.
  for(const skill of [...Object.values(commands.skills),...Object.values(ai.roles).flatMap(role=>role.learned_indices.map(index=>role.skills[index]))]){
    need(typeof skill.fixed_raw_hex==='string'&&/^[0-9a-f]{2106}$/.test(skill.fixed_raw_hex),'技能源记录缺失');
    const raw=Uint8Array.from(skill.fixed_raw_hex.match(/../g),part=>parseInt(part,16)),effect=raw.slice(0x16b,0x231);
    need(effect[0xb]===0&&(effect[1]===0||effect[1]===43&&Array.from(effect,b=>b.toString(16).padStart(2,'0')).join('')===status.status43.effect_raw_hex),'技能使用了未实现的状态处理器');
  }
  validateEncounterData(encounters,content);validateForestAIData(ai,content);
  validateForestRewards(rewards,content);validateForestReactionsData(reactions,content);
  validateForestStatusData(status,content);validateBattleViewMetadata(view,content);
  validateStoryBindings(content,story,resources);
  for(const id of Object.keys(content.roles))need(sourceHash(content.roles[id].source.sha256),`${id} 来源指纹缺失`);
  return {roles:Object.keys(content.roles).length,maps:maps.size,programs:Object.keys(content.programs).length};
}
