import {createBattleSample} from './combat_sample.mjs';
import {runtimeContent,requireRegisteredRoles,battleStage} from './core/content_registry.mjs';
const clone=value=>structuredClone(value);
export function createForestSample(world,base,data,group,config,schedulerData=null,aiData=null,rewardData=null,reactionData=null,statusData=null){
  return assembleForestSample(createBattleSample(world,base,config),data,group,schedulerData,aiData,rewardData,reactionData,statusData);
}
export function assembleForestSample(sample,data,group,schedulerData=null,aiData=null,rewardData=null,reactionData=null,statusData=null,content=runtimeContent){
  if(data?.schema!=='seventh-seal-forest-combat'||data.version!==1||!(content.maps[group?.map_id]||group?.kind==='skill-test'&&group.map_id===null)||!Array.isArray(group.members)||group.members.length<1||group.members.length>4)throw new Error('敌组来源未支持');
  requireRegisteredRoles([...new Set(group.members.map(member=>member.id))],{side:'enemy'},content);
  if(group.stage)battleStage(group.stage,content);
  const actors=sample.actors.filter(a=>a.side==='player').map(clone),playerIds=new Set(actors.map(a=>a.id));
  const skills=Object.fromEntries(Object.entries(sample.skills).filter(([,s])=>playerIds.has(s.actor_id)).map(([id,s])=>[id,clone(s)])),enemy_skill_ids={};
  if(!sample.source.party_new_game)for(const [id,skill] of Object.entries(data.player_skills??{}))skills[id]=clone(skill);
  group.members.forEach((member,index)=>{
    const resource=data.actors[member.id],rawSkill=data.skills[member.id+'_attack'];
    if(!resource||!rawSkill)throw new Error('森林角色或行动尚未接入');
    const actor=clone(resource),id=`enemy-${index}`,skill=clone(rawSkill),skillId=`${member.id}_attack_${index}`;
    Object.assign(actor,{id,resource_id:member.id});Object.assign(skill,{id:skillId,actor_id:id});actor.current_skill=clone(skill);
    actors.push(actor);skills[skillId]=skill;enemy_skill_ids[id]=skillId;
  });
  const result={actors,skills,order:actors.map(a=>a.id),enemy_skill_ids,source:{...sample.source,encounter:clone(group),
    scope:'Native forest group, bounded player-first command loop; fixed learned enemy command and first source contact only.',
    order:{...sample.source.order,policy:'controlled player-first enemy-group action loop',actors:actors.map(a=>a.id)},
    enemy_selection:{policy:'fixed learned commands; full AI and multihit not integrated'},limitations:clone(data.limits)}};
  if(sample.skill_data)result.skill_data=sample.skill_data;
  if(schedulerData){
    result.scheduler_data=clone(schedulerData);
    result.source.scope='Native fresh forest gauge/dispatch with live ready-player command input; fixed enemy command and first contact.';
    result.source.order={policy:'native mode0 gauge scheduler',evidence:clone(schedulerData.evidence),preview_policy:clone(schedulerData.policy)};
    result.source.limitations=['One saved player; full 1-4 source-generated enemies. Native scalar charging/dispatch; frame clock and ready-player input. Full enemy selection/combinations, contacts, native visual clocks and rewards deferred.'];
  }
  if(aiData){
    if(!schedulerData)throw new Error('完整森林行动需要原调度');
    result.enemy_ai_data=clone(aiData);result.complete_contacts=true;result.enemy_skill_tables={};
    for(const actor of actors.filter(a=>a.side==='enemy')){
      const role=aiData.roles[actor.resource_id];if(!role)throw new Error('原敌方技能表缺失');const table={};
      for(const index of role.learned_indices){const skill=clone(role.skills[index]),id=`${actor.id}_skill_${index}`;Object.assign(skill,{id,actor_id:actor.id});skills[id]=skill;table[index]=id;}
      result.enemy_skill_tables[actor.id]=table;
    }
    result.source.enemy_selection={policy:'native weighted selection / combination branch / target selection',evidence:clone(aiData.evidence)};
    result.source.scope='Native fresh forest scheduler, enemy skill/target selection and complete source contact sequences; live ready-player input.';
    result.source.limitations=sample.source.party_new_game?['New-game party with source equipment and learned direct attacks; command selection and queued player input continue during other actor animations. Native rendering/OS timing, equipment swapping and other player commands remain pending.']:['One historical player; six learned source forest skills and two exposed player skills. Original renderer/OS timing and opening story remain outside this slice.'];
  }
  if(rewardData){if(!aiData)throw new Error('奖励需要完整森林结算');result.reward_data=clone(rewardData);}
  if(reactionData)result.reaction_data=clone(reactionData);
  if(statusData)result.status_data=clone(statusData);
  return result;
}
