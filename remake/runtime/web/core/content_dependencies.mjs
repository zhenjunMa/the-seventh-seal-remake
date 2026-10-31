// Cross-file contracts shared by the exporter and extension regression tests.
import {validateContentRegistration,requireRegisteredRoles,registeredRoles,sourceHash} from './content_registry.mjs';
import {validateEncounterData} from './encounters.mjs';
import {validateForestAIData} from './forest_ai.mjs';
import {validateForestRewards} from './battle_rewards.mjs';
import {validateForestReactionsData,nativeReactionTargetAvailability} from './battle_reactions.mjs';
import {validateForestStatusData,validateNativeSkillStatus} from './battle_status.mjs';
import {validateNativeEffectBinding} from './combat_rules.mjs';
import {nativeSupportSkillSupported} from './battle_support.mjs';
import {validateChapterStory,chapterRestChoices} from './chapter.mjs';
import {validateChapterAnimation} from './chapter_animation.mjs';
import {validateBattleViewMetadata} from '../battle_view.mjs';
import {nativeKeyedChest,nativeScriptedChest,nativeChestAnimation} from './native_map_chests.mjs';
import {supplementalPartyCommands} from './party_skill_corrections.mjs';
import {compileNativeTriggerFlow} from './story_flow_compiler.mjs';
import {nativeAnmObjectTarget} from './native_anm_commands.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(`内容依赖：${message}`);};

export function validateEnemyReactionClosure(ai,reactions,content){
  for(const [enemyId,role]of Object.entries(ai.roles))for(const index of role.learned_indices){
    const skill=role.skills[index];
    // Hostile source skills may select any currently admitted player. Party
    // composition at a particular development checkpoint is not a capability
    // restriction on the original AI's learned skill list.
    if(parseInt(skill.fixed_raw_hex.slice(0x25*2,0x25*2+2),16)===1)continue;
    for(const playerId of registeredRoles('player',content)){
      const support=nativeReactionTargetAvailability({skill,target:{resource_id:playerId},data:reactions});
      need(support.available,`敌人 ${enemyId}／技能索引${index} → 玩家 ${playerId} 的原反应尚未恢复：${support.reason}`);
    }
  }
}

export function validateStoryBindings(content,story,resources,{registeredMaps=content.maps}={}){
  validateChapterStory(story);
  for(const [id,binding]of Object.entries(content.maps)){
    const table=story.maps[id];
    need(table||!binding.entry_record&&!binding.setup_record&&![...binding.triggers,...binding.objects,...binding.rests,...binding.routes,...(binding.npcs??[])].length,`${id} 缺少剧情表`);
    if(binding.setup_record){
      need(binding.setup_record===table.header_setup_tlk_raw&&table.records.some(row=>row.id===binding.setup_record),`${id} 加载布置与原 DAT 不同`);
      need(table.header_setup_tlk_source?.offset===0x8a&&table.header_setup_tlk_source.sha256===table.map_source.sha256,`${id} 加载布置来源缺失`);
    }
    if(binding.entry_record){
      need(binding.entry_record===table.header_entry_tlk_raw&&table.records.some(row=>row.id===binding.entry_record),`${id} 进入剧情与原 DAT 不同`);
      need(table.header_entry_tlk_source?.offset===0x13a&&table.header_entry_tlk_source.sha256===table.map_source.sha256,`${id} 进入剧情来源缺失`);
    }
    for(const slot of binding.npcs??[])need(resources.npcs_by_map[id]?.some(row=>row.slot_zero_based===slot)&&table.index_nonzero.some(row=>row.slot===slot),`${id} NPC 槽 ${slot} 缺少原对白入口`);
    for(const triggerId of binding.triggers){
      const trigger=resources.trigger_regions[id]?.find(row=>row.id===triggerId);
      const descriptor=table.descriptors.find(row=>row.id===triggerId);
      need(trigger&&descriptor&&trigger.state_raw===descriptor.state_raw,`${id} 触发器 ${triggerId} 缺少原描述符`);
      if(descriptor.state_raw===1){
        const flow=compileNativeTriggerFlow(table,descriptor),name=flow.commands[0].program_id;
        need(trigger.filename_raw===descriptor.filename_raw&&content.programs[name]&&story.programs[name],`${id} 触发器 ${triggerId} 缺少演出入口`);
      }else need(descriptor.state_raw===2&&trigger.field_26_raw===descriptor.field_26_raw
        &&table.records.some(record=>record.id===trigger.field_26_raw),`${id} 触发器 ${triggerId} 缺少对白入口`);
    }
    for(const row of binding.objects){
      const object=table.objects.find(object=>object.index===row.index),raw=object?.raw_hex;
      need(typeof raw==='string'&&raw.length===0x112*2,`${id} 物件 ${row.index} 缺少来源`);
      const b=Uint8Array.from(raw.match(/../g),part=>parseInt(part,16)),recordId=new DataView(b.buffer).getUint32(0xf6,true);
      if(row.handler==='keyed-chest')nativeKeyedChest(object);
      else{
        if(row.handler==='stationary-chest')nativeScriptedChest(object);
        else if(row.handler==='scripted-switch'){
          need(b[0xcf]===9&&recordId>0,`${id} 机关入口与原记录不符`);
          nativeAnmObjectTarget({u32_plus5:0,u32_plus25:row.index+1,byte_plus29:0},id,story);
        }else need(row.handler==='tlk-object'&&b[0xcf]===1&&b[0x109]===0,`${id} 物件处理器与原记录不符`);
        need(table.records.some(record=>record.id===recordId),`${id} 物件剧情入口缺失`);
      }
      const animation=resources.object_animations[id]?.find(item=>item.object_index_zero_based===row.index);
      const source=resources.interactive_objects[id]?.find(item=>item.object_index_zero_based===row.index)?.source;
      need(animation?.frames.length&&source?.raw_hex===raw&&source.sha256===object.source.sha256,`${id} 物件 ${row.index} 缺少动作或来源不一致`);
      if(['stationary-chest','keyed-chest'].includes(row.handler))nativeChestAnimation(animation,b[0xcf]);
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
    need(Array.isArray(program.maps)&&program.maps.length>0&&program.maps.every(mapId=>registeredMaps[mapId]),`演出 ${id} 地图未登记`);
    for(const caller of program.context_sources?.caller_records??[]){
      need(registeredMaps[caller.map_id]&&caller.source?.path?.toLowerCase()===`map/${caller.map_id.toLowerCase()}.tlk`
        &&story.source_hashes[caller.source.path]===caller.source.sha256,`演出 ${id} 调用来源不一致`);
      const table=story.maps[caller.map_id],record=table?.records.find(record=>record.id===caller.record_id);
      if(table)need(record?.kind===1&&record.text_raw.toLowerCase()===`${id}.anm`, `演出 ${id} 调用记录不一致`);
    }
    for(const caller of program.context_sources?.caller_descriptors??[]){
      need(registeredMaps[caller.map_id]&&caller.source?.path?.toLowerCase()===`map/${caller.map_id.toLowerCase()}.dat`
        &&story.source_hashes[caller.source.path]===caller.source.sha256,`演出 ${id} 描述符调用来源不一致`);
      const table=story.maps[caller.map_id],descriptor=table?.descriptors.find(row=>row.id===caller.descriptor_id);
      if(table)need(descriptor?.state_raw===1&&descriptor.filename_raw.toLowerCase()===`${id}.anm`,`演出 ${id} 描述符调用记录不一致`);
    }
    validateChapterAnimation(program,{...content,maps:registeredMaps});
  }
  return true;
}

export function validateContentDependencies(content,data){
  validateContentRegistration(content);
  const {catalog,seed,story,resources,party,commands:sourceCommands,forest,ai,rewards,reactions,status,encounters,view,itemView,lifecycle,menu}=data;
  const commands={...sourceCommands,skills:{...sourceCommands.skills,...supplementalPartyCommands(sourceCommands,content)}};
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
        validateNativeEffectBinding(skill,ai.roles);
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
    validateNativeSkillStatus(skill,status);
    if(skill.battle_handler==='native-support')need(nativeSupportSkillSupported(skill),'辅助技能来源未覆盖已恢复处理器');
    if(skill.battle_handler==='effect-carrier'){
      const owner=Object.entries(content.roles).find(([,role])=>role.source.path===skill.source?.path)?.[1];
      need(owner,'特效技能所有者来源缺失');
      // 501930 reads the victim's source skill table. A player offensive
      // carrier targets enemy tables; a hostile carrier targets player tables.
      const allied=parseInt(skill.fixed_raw_hex.slice(0x25*2,0x25*2+2),16)===1;
      const targetSide=allied?owner.side:owner.side==='player'?'enemy':'player';
      validateNativeEffectBinding(skill,targetSide==='player'?commands.roles:ai.roles);
    }
  }
  validateEncounterData(encounters,content);validateForestAIData(ai,content);
  validateForestRewards(rewards,content);validateForestReactionsData(reactions,content);
  validateEnemyReactionClosure(ai,reactions,content);
  validateForestStatusData(status,content);validateBattleViewMetadata(view,content);
  validateStoryBindings(content,story,resources);
  for(const id of Object.keys(content.roles))need(sourceHash(content.roles[id].source.sha256),`${id} 来源指纹缺失`);
  return {roles:Object.keys(content.roles).length,maps:maps.size,programs:Object.keys(content.programs).length};
}
