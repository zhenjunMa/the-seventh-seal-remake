// Four active players and up to four admitted enemies; source TLK retains six slots.
import {initializeScheduler,chargeActor,isActorReady,selectReady,dispatchCharge,dispatchItemCharge,setIdleSkill,advanceIdleSkill,pendingCommands,commandForActor} from './battle_scheduler.mjs';
import {planForestEnemyAction,selectNativeTarget} from './forest_ai.mjs';
import {composeNativeSequence,directSequence} from './skill_sequence.mjs';
import {createRewardLedger,collectEnemyDefeat,recordNativeContact,resetNativeChain,planVictoryRewards} from './battle_rewards.mjs';
import {applyContactReaction,finalizeNativeDeath,initializeNativeEntry,selectNativeEscapeAnimation,selectNativeRevivalAnimation,selectNativeNormalReaction,selectNativeAfterSourceReaction,nativeReactionTargetAvailability} from './battle_reactions.mjs';
import {initializeNativeStatuses,clearNativeStatuses,applyNativeSkillStatus,tickNativeStatuses} from './battle_status.mjs';
import {consumeInventoryItem,restoreActorWithItem,usableItems,itemTargetEligible} from './items.mjs';
import {dispatchDefend,resolveNativeEscape,dispatchEscapeFailure,dispatchEscapeSuccess} from './battle_commands.mjs';
import {applyNativeRevival,revivalTargetEligibility} from './battle_revival.mjs';
import {applyNativeSupport,supportTargetEligibility} from './battle_support.mjs';
import {skillGrowthSource,recordNativeSkillPractice} from './battle_skill_growth.mjs';
import {requiredSkillLevel} from './battle_skill_access.mjs';
import {nativeEffectContextForTarget} from './combat_rules.mjs';
import {nativeVerticalState,createNativeVertical,advanceNativeVertical,verticalActorPatch} from './battle_vertical.mjs';
import {battleActorPositions} from './battle_layout.mjs';
const copy = value => structuredClone(value);
// 41BFB0 can request category4 death at rawHP0 while linked equipment keeps
// effective/display HP positive. 4FFE90 and 519DD0 advance death through5/7;
// 4FFA30 excludes the completed category7 actor, regardless of that HP bonus.
const fallenActor = actor => actor.hp.current===0||[4,5,7].includes(actor.state_raw);
// 41B3C0 gates ordinary single-target medicines by category and immunity,
// without testing equipment-adjusted HP. Source mode3 revival is separate.
function requireValue(value, message) { if (!value) throw new Error(message); }
function resource(value, label) { requireValue(Number.isInteger(value) && value >= 0 && value <= 0x7fffffff, `${label}无效`); return value; }
function actorShape(actor) {
  requireValue(actor && typeof actor.id === 'string' && typeof actor.name === 'string', '战斗角色无效');
  requireValue(['player','enemy'].includes(actor.side), '战斗阵营无效');
  for (const key of ['hp','mp']) {
    requireValue(actor[key] && typeof actor[key] === 'object', `战斗${key}缺失`);
    resource(actor[key].current, key); resource(actor[key].maximum, key);
  }
}
// Native 0x427470 blocks learned type2 commands when status flag bit1 is set.
// Older lifecycle fixtures without a fixed CHR record contain no such command.
function silenced(actor,skill) {
  const type=typeof skill?.fixed_raw_hex==='string'?parseInt(skill.fixed_raw_hex.slice(0x32*2,0x32*2+2),16)&15:0;
  return type===2&&Boolean((actor?.status_flags_raw??0)&2);
}

export class BattleController {
  constructor({world, resolveAction, applyDamage, playAction, resourcesForWorld = actor => ({hp:actor.hp.current, mp:actor.mp.current}),
    consumeResources = (actor,cost)=>({...actor,mp:{...actor.mp,current:actor.mp.current-cost}}),
    notify = null, log = () => {}, id = () => crypto.randomUUID(), now = () => performance.now(),
    waitTick = () => new Promise(resolve=>setTimeout(resolve,20)),playSequence=null,itemData=null,playItem=async(_event,{onUse})=>{onUse();}}) {
    Object.assign(this, {world, resolveAction, applyDamage, playAction,playSequence, resourcesForWorld, consumeResources, notify, log, id,now,waitTick,itemData,playItem});
    this.state = null; this.running = false; this.completed = null; this.actionTask = null;
  }
  snapshot() { return this.state ? copy(this.state) : null; }
  // Frame/HUD snapshots never traverse action history. Contact summaries are
  // maintained when actions settle; snapshot() retains the full diagnostic log.
  presentationSnapshot() {
    const state=this.state;if(!state)return null;
    const {id,phase,round,player_id,enemy_id,error,outcome,scheduler,rewards,test_mode}=state;
    const mode=(state.source.runtime_configuration??state.source.skill_configuration)?.mode;
    return copy({id,phase,round,player_id,enemy_id,error,outcome,scheduler,rewards,test_mode,
      lifecycle_events:state.lifecycle_events??[],pending_outcome:state.pending_outcome??null,
      ready_player_ids:this.readyPlayerIds(),command_available:this.canCommand(),input_busy:Boolean(commandForActor(scheduler,player_id))||this.running&&scheduler?.active_actor_id===player_id,action_busy:this.running,
      source:{runtime_configuration:{mode},player_command_order:state.source.player_command_order},
      actors:state.actors.map(({id,name,side,hp,mp,alive,charge,state_raw,defense_half_raw,party_slot_zero_based,life_epoch,idle_pose,native_active,native_x_raw,native_z_raw,native_vertical_render_z_raw})=>({id,name,side,hp,mp,alive,charge,state_raw,party_slot_zero_based,life_epoch,idle_pose,native_active,native_x_raw,native_z_raw,native_vertical_render_z_raw,defending:Boolean(defense_half_raw),escaped:state_raw===11})),
      impact_count:this.impactSummary?.count??0,
      last_impact:this.impactSummary?.last?{actor_id:this.impactSummary.last.actor_id,
        source_frame:this.impactSummary.last.presentation?.source_frame}:null});
  }
  recordImpact(entry,historyIndex) {
    const summary=this.impactSummary??={count:0,last:null,index:-1};
    if(!entry.impact)summary.count++;
    entry.impact=true;
    // Count each impacted action once, and retain history order even when an
    // older detached carrier contacts after a more recently appended action.
    if(historyIndex>=summary.index){summary.index=historyIndex;summary.last=entry;}
  }
  publish() { if(this.notify)this.notify(this.presentationSnapshot()); }
  checkWorld() { requireValue(this.world.value.revision === this.expectedRevision, '战斗期间世界状态已变化，当前结果不能覆盖新进度'); }
  start({actors, skills, order, enemy_skill_id, enemy_skill_ids=null, rng, source,scheduler_data=null,side_priority=0,enemy_ai_data=null,enemy_skill_tables=null,complete_contacts=false,reward_data=null,reaction_data=null,status_data=null,lifecycle_enabled=false,test_mode=false,skill_data=null}) {
    requireValue(!this.running && (!this.state || this.state.phase === 'closed'), '当前战斗尚未结束');
    requireValue(!lifecycle_enabled||scheduler_data&&reaction_data,'战斗生命周期需要原调度与动作来源');
    requireValue(typeof test_mode==='boolean'&&(!test_mode||scheduler_data),'技巧测试需要原行动调度');
    requireValue(Array.isArray(actors) && actors.length >= 2 && actors.length <= 8, '参战人数超出当前支持范围');
    const next = copy(actors); next.forEach(actorShape);
    const players=next.filter(actor=>actor.side==='player');
    requireValue(players.length>=1&&players.length<=4&&next.length-players.length>=1&&next.length-players.length<=4, '战斗阵营不匹配');
    requireValue(players.length===1||scheduler_data, '多人战斗需要行动槽调度');
    requireValue(new Set(next.map(actor=>actor.id)).size===next.length, '战斗角色标识重复');
    const player=players.find(actor=>actor.hp.current>0), enemy=next.find(actor=>actor.side==='enemy');
    requireValue(player&&next.filter(actor=>actor.side==='enemy').every(actor=>actor.hp.current>0), '参战角色已经倒下，没有可行动的队伍');
    requireValue(players.every(player=>this.world.value.party.some(actor=>actor.id===player.id)), '参战角色不在当前队伍中');
    requireValue(Array.isArray(order) && order.length===next.length && new Set(order).size===next.length && order.every(id=>next.some(actor=>actor.id===id)), '行动顺序无效');
    requireValue(skills && typeof skills==='object' && Object.keys(skills).length>0, '战斗命令缺失');
    for(const [id,skill] of Object.entries(skills)) {
      requireValue(skill && skill.id===id && typeof skill.actor_id==='string' && next.some(actor=>actor.id===skill.actor_id), '战斗技能标识无效');
      resource(skill.mp_cost, '行动消耗');
      requireValue(skill.source && Array.isArray(skill.evidence) && skill.evidence.length>0, '行动来源缺失');
    }
    const enemies=next.filter(actor=>actor.side==='enemy'),enemySkills=enemy_skill_ids??{[enemy.id]:enemy_skill_id};
    requireValue(Object.keys(enemySkills).length===enemies.length&&enemies.every(actor=>skills[enemySkills[actor.id]]?.actor_id===actor.id), '敌方行动不匹配');
    requireValue(typeof rng==='function' && source, '随机或战斗样本来源缺失');
    this.skills=copy(skills); this.rng=rng; this.expectedRevision=this.world.value.revision; this.completed=null;this.testMode=test_mode;
    this.impactSummary={count:0,last:null,index:-1};
    this.state={id:this.id(),phase:'command',round:1,actors:next,order:[...order],player_id:player.id,player_ids:players.map(a=>a.id),enemy_id:enemy.id,
      enemy_skill_id:enemySkills[enemy.id],enemy_skill_ids:copy(enemySkills),enemy_ids:enemies.map(a=>a.id),action_count:0,source:copy(source),history:[],error:null,outcome:null,test_mode};
    if(this.itemData)this.state.inventory=copy(this.world.value.inventory);
    this.schedulerData=scheduler_data?copy(scheduler_data):null;
    if(this.schedulerData){this.chargeClock=this.now();this.state.scheduler=initializeScheduler(next,this.schedulerData,side_priority,this.chargeClock);this.state.scheduler.command_stage='closed';this.state.phase='charging';}
    this.actionTask=null;this.activeItemInstanceId=null;this.pendingCarriers=new Set();this.verticalClocks=new Map();this.pendingSourceEnds=new Set();this.lockedOutcome=null;
    const positions=battleActorPositions(next);
    for(const actor of next){
      actor.native_z_raw??=0;
      // The player homes are 5181D0's source slots. Enemy layout currently
      // uses the declared placement adapter; both start at their own home.
      actor.native_x_raw=actor.native_home_x_raw=positions[actor.id][0]-320;
      actor.native_y_raw=actor.native_home_y_raw=positions[actor.id][1]-80;
    }
    this.nativeAiData=enemy_ai_data?copy(enemy_ai_data):null;this.enemySkillTables=enemy_skill_tables?copy(enemy_skill_tables):null;this.completeContacts=complete_contacts;this.rewardData=!test_mode&&reward_data?copy(reward_data):null;this.rewardPlan=null;
    this.skillGrowthData=skill_data?skillGrowthSource(skill_data):null;this.skillPractice={};
    if(complete_contacts)requireValue(this.nativeAiData&&this.enemySkillTables&&typeof this.playSequence==='function','完整技能序列执行器缺失');
    if(this.rewardData)this.state.reward_ledger=createRewardLedger(this.state.id,next);
    this.reactionData=reaction_data;this.statusData=status_data;
    if(this.statusData)for(const actor of next)Object.assign(actor,initializeNativeStatuses(actor,this.statusData,undefined,this.rng));
    this.lifecycleEnabled=Boolean(lifecycle_enabled);this.lifecycleSequence=0;
    if(this.lifecycleEnabled){
      this.state.lifecycle_events=[];
      for(const actor of next){actor.life_epoch=0;actor.killer_actor_id=null;}
      for(const actor of next){
        if(actor.hp.current===0){
          // A saved KO actor has no saved animation cursor. Replay its source
          // death once per new battle to establish the original corpse pose;
          // it never enters category10 or receives entry immunity.
          actor.state_raw=4;actor.native_active=false;this.finalizeDeath(actor);continue;
        }
        const entry=initializeNativeEntry({actor,data:this.reactionData,rng:this.rng});
        if(entry){Object.assign(actor,copy(entry.after));this.queueLifecycle(actor,entry);}
      }
    }
    this.log({type:'battle-start',battle_id:this.state.id,world_revision:this.expectedRevision,source:this.state.source});
    this.publish(); return this.snapshot();
  }
  actor(id) { return this.state.actors.find(actor=>actor.id===id); }
  beginNativeVertical(actorId,record,at){
    const actor=this.actor(actorId);requireValue(actor&&Number.isFinite(at),'原高度动作角色或时钟缺失');
    const state=createNativeVertical({actor,record});requireValue(!state.camera_request,'原高度动作的镜头分支尚未接入');
    Object.assign(actor,verticalActorPatch(state,actor));this.verticalClocks.set(actorId,{at,state});return copy(state);
  }
  nativeVerticalFor(actorId){return nativeVerticalState(this.actor(actorId));}
  beginNativeAppearance(actorId,raw){
    requireValue(typeof raw==='string'&&/^[0-9a-f]{352}$/i.test(raw),'原入场动作记录缺失');
    const b=Uint8Array.from(raw.match(/../g),x=>parseInt(x,16)),actor=this.actor(actorId),view=new DataView(b.buffer);
    requireValue(actor&&b[0]===1&&view.getUint32(1,true)===7&&[0,1,3,5,6,7].includes(b[0x47]),'原入场动作模式尚未接入');
    let mode=b[0x47],draw=null;
    // 5130D0 command7 draws only when its source mode is zero, at this
    // source cursor after entry selection; presentation never owns RNG.
    if(mode===0){draw=this.rng();requireValue(Number.isInteger(draw)&&draw>=0&&draw<=32767,'原入场随机值无效');mode=[1,5,7][draw%3];}
    actor.native_appearance_mode_raw=mode;actor.native_after_raw={...actor.native_after_raw,'0x0521f666':mode,'0x0521f66e':0,'0x0521a7b1':60};
    this.log({type:'battle-native-appearance',actor_id:actorId,source_mode_raw:b[0x47],mode_raw:mode,rng_raw:draw});return {mode,clock_raw:60};
  }
  completeNativeAppearance(actorId){
    const actor=this.actor(actorId);requireValue(actor,'原入场动作角色缺失');
    // 51661E clears these fields only after the appearance renderer returns0.
    actor.native_appearance_mode_raw=0;actor.immune_raw=0;
    actor.native_after_raw={...actor.native_after_raw,'0x0521f666':0,'0x0521f5f5':0,'0x0521a7b1':0};
  }
  nextNativeVerticalAt(){
    let due=Infinity;
    for(const [id,clock]of this.verticalClocks){const state=nativeVerticalState(this.actor(id));if(state.active)due=Math.min(due,clock.at+20-(clock.state.tick_remainder_ms??0));}
    return due;
  }
  advanceNativeVerticals(at){
    for(const [id,clock]of this.verticalClocks){
      if(at<clock.at)continue;
      const actor=this.actor(id),state=nativeVerticalState(actor);state.tick_remainder_ms=clock.state.tick_remainder_ms??0;
      const next=advanceNativeVertical(state,at-clock.at);Object.assign(actor,verticalActorPatch(next,actor));clock.state=next;clock.at=at;
    }
  }
  nativeSourceRecord(actorId,raw){
    const b=Uint8Array.from(raw.match(/../g),x=>parseInt(x,16)),actor=this.actor(actorId);
    requireValue(b.length===176&&actor,'原动作记录缺失');actor.class_raw=b[0x24];actor.action_mask_raw=b[0x78];
  }
  nativeSourceHooks(){return {
    onFinalizeDeath:({actor:candidate})=>{const actor=this.actor(candidate.id);Object.assign(actor,copy(candidate));if(this.canFinalizeDeath(actor))this.finalizeDeath(actor);return {actor:copy(actor)};},
    onDispatch:({actor:candidate})=>{
      const actor=this.actor(candidate.id);Object.assign(actor,copy(candidate));
      const pending=commandForActor(this.state.scheduler,actor.id);if(pending)this.cancelQueuedCommand(pending,'native-recovery-command6');
      actor.native_after_raw={...actor.native_after_raw,'0x0521a7c7':0,'0x0521a779':0,'0x0521a77a':0,'0x0521a7c6':0,'0x0521a7c8':0};
      return {actor:copy(actor)};
    }};
  }
  completeNativeSource(actor,at=this.now()){
    const descriptor=selectNativeAfterSourceReaction({actor:copy(actor),data:this.reactionData,rng:this.rng,threshold:this.state.scheduler?.threshold,...this.nativeSourceHooks()});
    const raw={...actor.native_after_raw,...descriptor.after.native_after_raw};Object.assign(actor,copy(descriptor.after));actor.native_after_raw=raw;
    for(const effect of descriptor.effects??[]){
      if(effect.kind==='clear-native-chain'&&this.state.reward_ledger&&resetNativeChain(this.state.reward_ledger,actor.id)){
        actor.settled_raw=0;actor.native_after_raw['0x0521f69d']=0;
      }
      if(effect.kind==='release-active-owner'&&this.state.scheduler?.active_actor_id===actor.id)this.state.scheduler.active_actor_id=null;
    }
    this.pendingSourceEnds??=new Set();
    if(!descriptor.skill&&actor.native_active&&['source-end-status-gate','source-end-death'].includes(descriptor.reason))this.pendingSourceEnds.add(actor.id);else this.pendingSourceEnds.delete(actor.id);
    if(descriptor.skill&&descriptor.kind==='response'){
      actor.native_sequence_token=`${this.state.id}:after-source:${actor.id}:${++this.lifecycleSequence}`;
      if(this.lifecycleEnabled){this.state.lifecycle_events=this.state.lifecycle_events.filter(event=>event.actor_id!==actor.id);this.queueLifecycle(actor,{...descriptor,kind:'response'});}
    }else if(descriptor.kind==='idle'&&actor.hp.current>0){setIdleSkill(actor,this.schedulerData,at);}
    this.log({type:'battle-source-completed',battle_id:this.state.id,actor_id:actor.id,descriptor:copy(descriptor)});
    return descriptor;
  }
  nativeContext() { return {global_055ee004:this.testMode?1:0}; }
  players() { return this.state.actors.filter(actor=>actor.side==='player'); }
  activePlayers() { return this.players().filter(actor=>!fallenActor(actor)&&actor.state_raw!==11); }
  queueLifecycle(actor,descriptor) {
    const event={token:`${this.state.id}:lifecycle:${++this.lifecycleSequence}`,actor_id:actor.id,life_epoch:actor.life_epoch??0,kind:descriptor.kind,
      source_skill_index:descriptor.source_skill_index??null,source_id_raw:descriptor.skill?.original_id_raw??null,
      fade_increment_raw:descriptor.fade_increment_raw??null,hold_final_frame:descriptor.kind==='death'&&actor.side==='player'};
    event.fade_mode_raw=descriptor.fade_mode_raw??descriptor.fade_increment_raw??null;
    this.state.lifecycle_events.push(event);
    this.log({type:'battle-lifecycle-queued',battle_id:this.state.id,event:copy(event),descriptor:copy(descriptor)});return event;
  }
  hasLifecycle(kind=null) { return Boolean(this.state?.lifecycle_events?.some(event=>kind===null||event.kind===kind)); }
  ackLifecycle({token,actor_id,life_epoch}) {
    if(!this.lifecycleEnabled||!this.state||this.state.phase==='closed')return false;
    const index=this.state.lifecycle_events.findIndex(event=>event.token===token&&event.actor_id===actor_id&&event.life_epoch===life_epoch),actor=this.actor(actor_id);
    if(index<0||!actor||actor.life_epoch!==life_epoch)return false;
    const event=this.state.lifecycle_events[index];this.state.lifecycle_events.splice(index,1);
    if(event.kind==='entry'){
      actor.state_raw=0;actor.immune_raw=0;actor.native_active=false;setIdleSkill(actor,this.schedulerData,this.now());
      if(!this.hasLifecycle('entry'))this.chargeClock=this.now();
    }else if(event.kind==='death'){
      actor.native_active=false;
      // 519DD0 turns an ended native id12 into category7. Keep its source
      // death skill as the corpse pose; it must not become an idle live actor.
      if(event.source_id_raw===12)actor.state_raw=7;
    }else if(event.kind==='revive'||event.kind==='response'){
      this.completeNativeSource(actor,this.now());
    }else if(event.kind==='escape'){
      actor.native_active=false;
    }
    this.log({type:'battle-lifecycle-completed',battle_id:this.state.id,event:copy(event)});
    this.refreshCommandState();this.publish();return true;
  }
  canFinalizeDeath(actor) {
    if(!this.lifecycleEnabled)return true;
    const killer=actor.killer_actor_id?this.actor(actor.killer_actor_id):null;
    return actor.native_z_raw===0&&(!killer||!killer.native_active);
  }
  readyPlayerIds() {
    if(this.hasLifecycle('entry'))return [];
    if(!this.state?.scheduler)return this.state?.phase==='command'?this.players().filter(a=>a.hp.current>0).map(a=>a.id):[];
    return this.players().filter(a=>a.id!==this.state.scheduler.active_actor_id&&!this.state.lifecycle_events?.some(e=>e.actor_id===a.id)&&isActorReady(a,this.state.scheduler)).map(a=>a.id);
  }
  commandSkills(skill) { return skill?.battle_handler==='combination'?skill.component_skill_ids.map(id=>this.skills[id]):skill?[skill]:[]; }
  sequenceSkill(actor,index) {
    if(actor.side==='enemy')return this.nativeAiData?.roles[actor.resource_id]?.skills[index];
    return Object.values(this.skills??{}).find(skill=>skill.actor_id===actor.id&&skill.original_skill_index===index)
      ??this.skillGrowthData?.roles[actor.resource_id??actor.id]?.skills[index]
      ??(this.schedulerData?.idle_skills[actor.resource_id??actor.id]?.original_skill_index===index?this.schedulerData.idle_skills[actor.resource_id??actor.id]:null);
  }
  reactionTargetAvailability(skill,target) {
    if(skill?.battle_handler==='combination'){
      for(const member of this.commandSkills(skill)){
        if(!member)return {available:false,reason:skill.unavailable_reason||'组合中的招式当前不可用。'};
        const result=this.reactionTargetAvailability(member,target);if(!result.available)return result;
      }
      return {available:true};
    }
    return nativeReactionTargetAvailability({skill,target,data:this.reactionData});
  }
  skillUnavailableReason(skillId) {
    const skill=this.skills?.[skillId],caster=skill&&this.state&&this.actor(skill.actor_id);
    if(skill?.unavailable_reason)return skill.unavailable_reason;
    if(skill?.battle_handler==='combination'&&caster){
      if(!this.completeContacts||typeof this.playSequence!=='function')return '当前战斗缺少组合动作执行器。';
      const members=this.commandSkills(skill);
      if(!members.length||members.some(member=>!member||member.actor_id!==caster.id))return '组合中的招式当前不可用。';
      if(members.some(member=>(caster.level??0)<requiredSkillLevel(member)))return '角色等级不足，无法使用此组合。';
      if(members.some(member=>silenced(caster,member)))return '沉默状态下不能施放包含法术的组合。';
      if(caster.mp.current<skill.mp_cost)return `MP不足，需要 ${skill.mp_cost}。`;
    }
    if(!caster||!this.reactionData)return '';
    const targets=this.state.actors.filter(actor=>actor.side!==caster.side&&actor.hp.current>0&&actor.state_raw<4&&!actor.escaped);
    const results=targets.map(target=>this.reactionTargetAvailability(skill,target));
    return results.length&&results.every(result=>!result.available)?results[0].reason:'';
  }
  targetIdsForSkill(skillId) {
    const skill=this.skills?.[skillId],caster=skill&&this.state&&this.actor(skill.actor_id);if(!caster)return [];
    if(skill.battle_handler==='combination'){
      const members=this.commandSkills(skill);if(!members.length||members.some(member=>!member))return [];
      return this.targetIdsForSkill(members[0].id).filter(id=>members.every(member=>this.targetIdsForSkill(member.id).includes(id)));
    }
    if(skill.battle_handler==='native-support')return this.state.actors.filter(actor=>actor.side===caster.side&&supportTargetEligibility(actor,skill).available).map(actor=>actor.id);
    if(skill.battle_handler==='native-revival')return this.state.actors.filter(actor=>actor.side===caster.side&&revivalTargetEligibility(actor,skill).available).map(actor=>actor.id);
    return this.state.actors.filter(actor=>actor.side!==caster.side&&actor.hp.current>0&&actor.state_raw<4&&!actor.escaped&&this.reactionTargetAvailability(skill,actor).available).map(actor=>actor.id);
  }
  canCommand(id=this.state?.player_id) {
    if(this.hasLifecycle('entry'))return false;
    const actor=this.state&&this.actor(id),scheduler=this.state?.scheduler;
    if(!scheduler)return Boolean(this.state?.phase==='command'&&!this.running&&actor?.side==='player'&&actor.hp.current>0);
    return Boolean(['command','charging','action'].includes(this.state.phase)&&!this.state.pending_outcome&&!commandForActor(scheduler,id)&&actor?.side==='player'&&actor.id!==scheduler.active_actor_id&&!this.state.lifecycle_events?.some(e=>e.actor_id===id)&&isActorReady(actor,scheduler));
  }
  setCommandStage(stage='closed') {
    requireValue(typeof stage==='string'&&stage.length>0&&stage.length<=64,'战斗命令层无效');
    if(this.state?.scheduler&&this.state.scheduler.command_stage!==stage)this.state.scheduler.command_stage=stage;
  }
  selectPlayer(id) {
    requireValue(this.state&&['command','charging','action'].includes(this.state.phase),'当前战斗不能切换角色');this.checkWorld();
    const actor=this.actor(id);requireValue(actor?.side==='player'&&actor.hp.current>0,'角色已经倒下或不属于队伍');
    requireValue(this.canCommand(id),'角色行动槽尚未充满');
    this.state.player_id=id;this.publish();return this.snapshot();
  }
  canChoose(skillId) {
    const skill=this.skills?.[skillId], player=this.state && this.actor(this.state.player_id);
    return !this.skillUnavailableReason(skillId) && this.canCommand() && skill?.actor_id===player.id && (!skill.fixed_raw_hex||(player.level??0)>=requiredSkillLevel(skill)) && player.mp.current>=skill.mp_cost&&!silenced(player,skill)&&(!['native-revival','native-support','combination'].includes(skill.battle_handler)||this.targetIdsForSkill(skillId).length>0);
  }
  reservedItems(instanceId){return pendingCommands(this.state?.scheduler).filter(command=>command.item_instance_id===instanceId).length+(this.activeItemInstanceId===instanceId?1:0);}
  items() { return this.itemData&&this.state?.inventory?copy(usableItems(this.state.inventory,this.itemData)).map(item=>({...item,quantity:item.quantity-this.reservedItems(item.instance_id)})).filter(item=>item.quantity>0):[]; }
  itemTargetAvailable(actor,instanceId,caster=this.actor(this.state.player_id)){
    const item=this.state.inventory.find(item=>item.instance_id===instanceId),definition=this.itemData.definitions[String(item?.id)];
    return Boolean(definition?.effect&&definition.runtime_enabled!==false&&definition.use_in_battle!==false&&itemTargetEligible(actor,definition,caster));
  }
  itemTargetIds(instanceId){
    if(!this.itemData||!usableItems(this.state?.inventory??[],this.itemData).some(item=>item.instance_id===instanceId))return [];
    return this.state.actors.filter(actor=>this.itemTargetAvailable(actor,instanceId)).map(actor=>actor.id);
  }
  queueCommand(command){
    const s=this.state.scheduler;
    if(s.pending)(s.queued_commands??=[]).push(command);else s.pending=command;
    s.command_stage='closed';this.refreshCommandState();
    this.log({type:'battle-command-queued',battle_id:this.state.id,...copy(command),scheduler:copy(s)});this.publish();
  }
  removeCommand(command){
    const s=this.state.scheduler,remaining=pendingCommands(s).filter(row=>row!==command);
    s.pending=remaining.shift()??null;s.queued_commands=remaining;
  }
  clearCommands(){const s=this.state.scheduler;s.pending=null;s.queued_commands=[];}
  async chooseDefend() { return this.chooseFixedCommand('defend'); }
  async chooseEscape() { return this.chooseFixedCommand('escape'); }
  async chooseFixedCommand(kind) {
    requireValue(['defend','escape'].includes(kind),'固定战斗命令无效');
    requireValue(this.state?.scheduler&&this.canCommand(),'行动槽尚未充满或已有行动指令');this.checkWorld();
    const player=this.actor(this.state.player_id);
    this.queueCommand({actor_id:player.id,skill_id:kind,target_id:player.id,command_kind:kind});
    if(!this.running){const task=this.scheduleReady();if(task)await task;}
    return this.snapshot();
  }
  performDefend(player) {
    const before=copy(player),descriptor=dispatchDefend(player,this.state.scheduler);
    const entry={action_id:`${this.state.id}:${++this.state.action_count}`,actor_id:player.id,target_id:player.id,skill_id:'defend',command_kind:'defend',round:this.state.round,
      impact:false,result:{hit:true,damage:0},presentation:{command_kind:'defend',animation_type_raw:descriptor.animation_type_raw},before:{attacker:before},after:{attacker:copy(player)}};
    this.state.history.push(entry);this.state.round++;
    this.log({type:'battle-defend',battle_id:this.state.id,...copy(entry),descriptor});
    return descriptor;
  }
  performEscape(player) {
    const before=copy(player);
    const resolution=resolveNativeEscape({actor:player,actors:this.state.actors,rng:this.rng,...this.nativeContext()});
    const descriptor=resolution.success?dispatchEscapeSuccess(player):dispatchEscapeFailure(player);
    if(resolution.success&&this.lifecycleEnabled){
      const animation=selectNativeEscapeAnimation({actor:player,data:this.reactionData,rng:this.rng});
      Object.assign(player,copy(animation.after));
      this.state.lifecycle_events=this.state.lifecycle_events.filter(event=>event.actor_id!==player.id);
      this.queueLifecycle(player,animation);
    }
    // The requested skill-test session ends on its first escape confirmation;
    // ordinary encounters retain the source per-actor escape lifecycle.
    if(this.testMode&&resolution.success)this.state.test_exit_requested=true;
    const entry={action_id:`${this.state.id}:${++this.state.action_count}`,actor_id:player.id,target_id:player.id,skill_id:'escape',command_kind:'escape',round:this.state.round,
      impact:false,result:{hit:true,damage:0,success:resolution.success},presentation:{command_kind:'escape',success:resolution.success,...(descriptor.animation_type_raw?{animation_type_raw:descriptor.animation_type_raw}:{})},before:{attacker:before},after:{attacker:copy(player)}};
    this.state.history.push(entry);this.state.round++;
    this.log({type:'battle-escape',battle_id:this.state.id,...copy(entry),descriptor,resolution});
    return descriptor;
  }
  async chooseItem(instanceId,targetId=null) {
    requireValue(this.itemData&&this.state?.scheduler,'当前战斗不支持使用药品');
    return this.chooseScheduled(null,targetId,{instance_id:instanceId});
  }
  async choose(skillId,targetId=null) {
    if(this.state?.scheduler)return this.chooseScheduled(skillId,targetId);
    requireValue(this.state?.phase==='command' && !this.running, '行动完成后才能选择下一命令');
    this.checkWorld();
    const player=this.actor(this.state.player_id), skill=this.skills[skillId];
    requireValue(skill?.actor_id===player.id, '本轮命令尚未接入');
    requireValue(!silenced(player,skill), '沉默状态下不能施放法术');
    requireValue(player.mp.current>=skill.mp_cost, '资源不足，无法施放');
    const selectedTarget=targetId===null?this.state.actors.find(a=>a.side==='enemy'&&a.hp.current>0):this.actor(targetId);
    requireValue(selectedTarget?.side==='enemy'&&selectedTarget.hp.current>0,'目标已经倒下或不属于敌方');
    const targetSupport=this.reactionTargetAvailability(skill,selectedTarget);requireValue(targetSupport.available,targetSupport.reason);
    // Both chosen skills participate in the native effective-defense calculation.
    for(const actor of this.state.actors){
      const current=this.skills[actor.id===player.id?skillId:this.state.enemy_skill_ids[actor.id]];actor.current_skill=copy(current);
      if(Object.hasOwn(current,'class_raw'))actor.class_raw=current.class_raw;
      if(Object.hasOwn(current,'action_mask_raw'))actor.action_mask_raw=current.action_mask_raw;
    }
    this.running=true; this.state.phase='action'; this.publish();
    try {
      for(const actorId of this.state.order) {
        if(player.hp.current===0||this.state.actors.filter(a=>a.side==='enemy').every(a=>a.hp.current===0)) break;
        const attacker=this.actor(actorId);if(attacker.hp.current===0)continue;
        const target=attacker.side==='player'?selectedTarget:player;
        const selected=this.skills[actorId===player.id?skillId:this.state.enemy_skill_ids[actorId]];
        await this.performAction(attacker,target,selected);
      }
      const victory=this.state.actors.filter(a=>a.side==='enemy').every(a=>a.hp.current===0);
      if(player.hp.current===0||victory){this.state.phase=victory?'victory':'defeat';this.state.outcome=this.state.phase;}
      else{this.state.round++;this.state.phase='command';}
      this.running=false; this.publish(); return this.snapshot();
    } catch(error) {
      this.running=false; this.state.phase='interrupted'; this.state.error=error.message;
      this.log({type:'battle-interrupted',battle_id:this.state.id,error:error.message}); this.publish();throw error;
    }
  }
  advanceClock(now=this.now()) {
    const s=this.state?.scheduler;
    if(!s||!['command','charging','action'].includes(this.state.phase))return false;
    try {
      requireValue(Number.isFinite(now),'战斗时钟无效');let advanced=false;
      // Entry is a shared presentation phase. Early finishers can idle, but
      // nobody charges, ticks statuses or acts until every entry has ended.
      if(this.hasLifecycle('entry')){
        this.checkWorld();this.chargeClock=now;
        for(const actor of this.state.actors)advanceIdleSkill(actor,this.schedulerData,now);
        return false;
      }
      // Keep the sub-tick remainder and replay every elapsed source step.
      // Charging, status effects and arbitration must not depend on render FPS.
      while(now-this.chargeClock>=20&&this.state.scheduler===s&&['command','charging','action'].includes(this.state.phase)){
        this.checkWorld();this.chargeClock+=20;s.ticks++;s.elapsed_ms+=20;advanced=true;
        for(const actor of this.state.actors)advanceIdleSkill(actor,this.schedulerData,this.chargeClock);
        for(const actor of this.state.actors){chargeActor(actor,this.rng);if(actor.state_raw===4&&this.reactionData&&this.canFinalizeDeath(actor))this.finalizeDeath(actor);}
        if(this.statusData)for(const actor of this.state.actors){
          if(!actor.native_status_slots.some(slot=>slot.raw_hex.slice(2,4)!=='00'))continue;
          const update=tickNativeStatuses({actor,threshold:s.threshold,now:s.elapsed_ms,data:this.statusData,rng:this.rng,...this.nativeContext(),
            onPeriodicEffect:({actor:pulsed,effect,damageResult,reaction_requested})=>{
              if(damageResult.death_requested){Object.assign(actor,copy(pulsed));if(this.canFinalizeDeath(actor))this.finalizeDeath(actor);return {actor:copy(actor),trace:[]};}
              if(!reaction_requested||!this.reactionData)return {actor:pulsed,trace:[]};
              const response=selectNativeNormalReaction({actor:pulsed,ident:effect.reaction_argument_raw,data:this.reactionData,rng:this.rng});
              return response?{actor:{...pulsed,...copy(response.after),native_sequence_token:`${this.state.id}:status:${actor.id}:${s.elapsed_ms}`},trace:response.trace,descriptor:response}:{actor:pulsed,trace:[]};
            }});
          Object.assign(actor,update.actor);
          for(const response of update.periodic_reactions??[])if(this.lifecycleEnabled&&response.skill){
            this.state.lifecycle_events=this.state.lifecycle_events.filter(event=>event.actor_id!==actor.id);
            this.queueLifecycle(actor,{...response,kind:'response'});
          }
          if(update.cancel_command){const command=commandForActor(s,actor.id);if(command)this.cancelQueuedCommand(command,'actor-status');}
          if(update.expired.length)this.log({type:'battle-status-expired',battle_id:this.state.id,actor_id:actor.id,slots:update.expired});
        }
        for(const actorId of [...this.pendingSourceEnds])this.completeNativeSource(this.actor(actorId),this.chargeClock);
        this.refreshCommandState();this.publish();this.scheduleReady();
      }
      // Poses still follow the exact scene time, including frames without a
      // charge tick. A synchronous action hook may already have advanced time.
      for(const actor of this.state.actors)advanceIdleSkill(actor,this.schedulerData,Math.max(now,this.chargeClock));
      return advanced;
    }catch(error){this.interrupt(error);return false;}
  }
  interrupt(error) {
    this.running=false;this.activeItemInstanceId=null;this.state.phase='interrupted';this.state.error=error.message;
    if(this.state.scheduler){this.clearCommands();this.state.scheduler.active_actor_id=null;this.state.scheduler.command_stage='closed';}
    this.log({type:'battle-interrupted',battle_id:this.state.id,error:error.message});this.publish();
  }
  cancelQueuedCommand(pending,reason,details={}) {
    this.removeCommand(pending);
    this.log({type:'battle-command-cancelled',battle_id:this.state.id,...copy(pending),reason,...copy(details)});
  }
  queuedTarget(pending,attacker,skill) {
    const target=this.actor(pending.target_id);
    if(pending.item_instance_id){
      if(this.itemTargetAvailable(target,pending.item_instance_id,attacker))return target;
      this.cancelQueuedCommand(pending,'item-target-unavailable');return null;
    }
    if(skill?.battle_handler==='native-support'){
      if(target?.side===attacker.side&&supportTargetEligibility(target,skill).available)return target;
      this.cancelQueuedCommand(pending,'support-target-unavailable');return null;
    }
    if(skill?.battle_handler==='native-revival'){
      if(target?.side===attacker.side&&revivalTargetEligibility(target,skill).available)return target;
      this.cancelQueuedCommand(pending,'revival-target-unavailable');return null;
    }
    if(target&&target.hp.current>0&&target.state_raw<4&&!target.escaped){
      const support=this.reactionTargetAvailability(skill,target);if(support.available)return target;
      this.cancelQueuedCommand(pending,'target-reaction-unavailable',{reason:support.reason});return null;
    }
    const targetSkill=skill?.battle_handler==='combination'?this.commandSkills(skill)[0]:skill;
    const fixed=targetSkill?.fixed_raw_hex?Uint8Array.from(targetSkill.fixed_raw_hex.match(/../g),x=>parseInt(x,16)):null;
    // The opposite-side fallback is bound to ordinary direct attacks;
    // mode3 revival has its own same-side admission branch above.
    if(target&&target.side!==attacker.side&&target.state_raw>=4&&target.state_raw<8&&fixed){
      if(this.state.actors.some(actor=>actor.side!==attacker.side&&actor.hp.current>0&&actor.state_raw<4&&!this.reactionTargetAvailability(skill,actor).available)){
        this.cancelQueuedCommand(pending,'target-reaction-unavailable');return null;
      }
      const selection=selectNativeTarget({actors:this.state.actors,actor_id:attacker.id,target_side_raw:fixed[0x25],rng:this.rng});
      if(selection.target_id){
        const previous=pending.target_id;pending.target_id=selection.target_id;
        this.log({type:'battle-command-retargeted',battle_id:this.state.id,actor_id:attacker.id,skill_id:skill.id,from_target_id:previous,target_id:selection.target_id,
          selection:copy(selection),source:{dispatch:'0x5036d0',target_selection:'0x5014c0',evidence:'ev_55d05492277d5e8c3d2808a6eb533c56ee8a4d6f4ba1a7f5bbf3dbec1196a2d7'}});
        return this.actor(selection.target_id);
      }
      this.cancelQueuedCommand(pending,'no-native-target',{selection});return null;
    }
    this.cancelQueuedCommand(pending,'target-unavailable');return null;
  }
  refreshCommandState() {
    if(!this.state?.scheduler||!['command','charging','action'].includes(this.state.phase))return;
    const s=this.state.scheduler,victory=this.lockedOutcome?this.lockedOutcome==='victory':this.state.actors.filter(a=>a.side==='enemy').every(fallenActor);
    if(this.testMode&&this.state.test_exit_requested&&!this.running){
      this.clearCommands();s.command_stage='closed';
      if(this.hasLifecycle()||this.pendingCarriers.size){this.state.pending_outcome='escaped';this.state.phase='charging';return;}
      this.state.pending_outcome=null;this.state.phase='escaped';this.state.outcome='escaped';return;
    }
    if(!this.running&&(this.lockedOutcome||!this.activePlayers().length||victory)){
      const outcome=this.lockedOutcome??(victory?'victory':this.players().some(a=>a.state_raw===11)?'escaped':'defeat');
      if(!this.lockedOutcome&&this.lifecycleEnabled&&(this.hasLifecycle('death')||this.hasLifecycle('escape')||this.state.actors.some(a=>a.state_raw===4))){
        this.state.pending_outcome=outcome;this.state.phase='charging';this.clearCommands();s.command_stage='closed';return;
      }
      if(!this.lockedOutcome){
        // 4FFA30 locks EDFFC and marks living winners state9 before 50D1C0
        // rolls rewards. 50D1C0 does not clear independent carriers; their
        // remaining visual lifetime must not delay those reward RNG draws.
        this.lockedOutcome=outcome;
        if(victory){for(const actor of this.players())if(actor.hp.current>0&&actor.state_raw<4)actor.state_raw=9;if(this.rewardData)this.prepareRewards();}
      }
      if(this.pendingCarriers.size){this.state.pending_outcome=outcome;this.state.phase='charging';this.clearCommands();s.command_stage='closed';return;}
      this.state.pending_outcome=null;this.state.phase=outcome;this.state.outcome=outcome;this.clearCommands();s.command_stage='closed';
      if(victory&&this.rewardData)this.prepareRewards();return;
    }
    if(this.activePlayers().length&&!victory)this.state.pending_outcome=null;
    for(const command of pendingCommands(s)){
      if(this.actor(command.actor_id)?.hp.current===0){this.cancelQueuedCommand(command,'actor-fallen');continue;}
      if(command.item_instance_id){const target=this.actor(command.target_id);if(!this.itemTargetAvailable(target,command.item_instance_id,this.actor(command.actor_id)))this.cancelQueuedCommand(command,'item-target-unavailable');}
    }
    const ready=this.readyPlayerIds().filter(id=>this.canCommand(id));
    if(!ready.includes(this.state.player_id)&&ready.length)this.state.player_id=ready[0];
    else if(!this.activePlayers().some(a=>a.id===this.state.player_id))this.state.player_id=this.activePlayers()[0]?.id??this.state.player_id;
    if(!this.running)this.state.phase=ready.length?'command':'charging';
  }
  scheduleReady() {
    if(this.running||!this.state?.scheduler||this.state.pending_outcome||this.hasLifecycle('entry')||!['command','charging'].includes(this.state.phase))return this.actionTask;
    const selection=selectReady(this.state.actors,this.state.scheduler,{enemy_passive:this.testMode});
    if(!selection.actor_id)return null;
    this.running=true;this.state.phase='action';
    const task=this.runScheduledReady(selection);this.actionTask=task;
    // Frame-driven enemy actions have no awaiting input handler. Retain their
    // failure as an interrupted battle, while explicit choose() still rejects.
    task.catch(()=>{}).finally(()=>{if(this.actionTask===task)this.actionTask=null;});
    return task;
  }
  async chooseScheduled(skillId,targetId=null,itemCommand=null) {
    requireValue(this.state&&['command','charging','action'].includes(this.state.phase),'当前战斗不能选择命令');this.checkWorld();
    const player=this.actor(this.state.player_id);
    requireValue(this.canCommand(player.id),'角色行动槽尚未充满');
    let skill=this.skills[skillId];
    if(itemCommand){
      const consumed=consumeInventoryItem(this.state.inventory,itemCommand.instance_id,this.itemData);
      requireValue(consumed.item.quantity>this.reservedItems(itemCommand.instance_id),'道具已被其他角色的待执行指令占用');
      requireValue(this.itemTargetAvailable(this.actor(targetId??player.id),itemCommand.instance_id,player),'道具目标不可用');
      skill={id:`item:${consumed.item.id}`,actor_id:player.id,mp_cost:0};
    }
    requireValue(skill?.actor_id===player.id&&player.hp.current>0,'玩家命令无效');
    if(skill.battle_handler==='combination')requireValue(this.canChoose(skill.id),this.skillUnavailableReason(skill.id)||'组合中的招式或目标当前不可用。');
    requireValue(!silenced(player,skill), '沉默状态下不能施放法术');
    requireValue(player.mp.current>=skill.mp_cost,'资源不足，无法施放');
    const revival=skill.battle_handler==='native-revival',support=skill.battle_handler==='native-support';
    if(support)requireValue(this.statusData&&typeof this.playSequence==='function','辅助动作执行器或原状态来源缺失');
    if(revival)requireValue(this.reactionData&&typeof this.playSequence==='function','复活动作执行器或原动作来源缺失');
    const target=itemCommand?this.actor(targetId??player.id):targetId===null?this.actor(this.targetIdsForSkill(skill.id)[0]):this.actor(targetId);
    requireValue(itemCommand?this.itemTargetAvailable(target,itemCommand.instance_id,player):revival||support?target&&this.targetIdsForSkill(skill.id).includes(target.id):target?.side==='enemy'&&target.hp.current>0&&target.state_raw!==11&&!target.escaped,'目标已经倒下、离场或阵营不匹配');
    if(!itemCommand){const support=this.reactionTargetAvailability(skill,target);requireValue(support.available,support.reason);}
    this.queueCommand({actor_id:player.id,skill_id:skill.id,target_id:target.id,...(itemCommand?{item_instance_id:itemCommand.instance_id}:{})});
    if(!this.running){const task=this.scheduleReady();if(task)await task;}return this.snapshot();
  }
  async runScheduledReady(firstSelection) {
    const s=this.state.scheduler;let selection=firstSelection;
    try {
      while(this.activePlayers().length&&this.state.actors.some(a=>a.side==='enemy'&&!fallenActor(a))){
        if(!selection.actor_id)break;
        const attacker=this.actor(selection.actor_id),pending=attacker.side==='player'?commandForActor(s,attacker.id):s.pending,chosenPlayer=this.actor(pending?.actor_id??this.state.player_id),player=chosenPlayer&&!fallenActor(chosenPlayer)&&chosenPlayer.state_raw!==11?chosenPlayer:this.activePlayers()[0],skill=pending?this.skills[pending.skill_id]:null;
        const itemCommand=pending?.item_instance_id?{instance_id:pending.item_instance_id}:null;
        let target=pending?this.actor(pending.target_id):null;const skillId=pending?.skill_id;
        if(attacker.side==='player'&&!pending?.command_kind){target=this.queuedTarget(pending,attacker,skill);if(!target)break;}
        // A dispatched command belongs to the active action now. Free the
        // input queue so another ready party member can choose its next action
        // during this animation; completion must preserve that new pending row.
        if(attacker.side==='player')this.removeCommand(pending);
        if(attacker.side==='player'&&pending?.command_kind){
          if(pending.command_kind==='defend')this.performDefend(attacker);else this.performEscape(attacker);
          s.active_actor_id=null;break;
        }
        if(itemCommand&&attacker.id===player.id){
          const consumed=consumeInventoryItem(this.state.inventory,itemCommand.instance_id,this.itemData);
          this.activeItemInstanceId=itemCommand.instance_id;
          let result={name:this.itemData.definitions[String(consumed.item.id)].name},committed=false;
          const charge=dispatchItemCharge(attacker,s),actionId=`${this.state.id}:${this.state.action_count+1}`;
          this.state.phase='action';this.publish();
          const onUse=()=>{
            if(!committed){
              this.checkWorld();const before=copy(target);
              // A carrier/status may have invalidated the target since dispatch.
              // Native41B3C0 then skips both5058D0 and the consumption branch.
              result=this.itemTargetAvailable(target,itemCommand.instance_id,attacker)?restoreActorWithItem(target,consumed.item,this.itemData,{statusData:this.statusData,caster:attacker,rng:this.rng,
                selectAnimation:(actor,{rng})=>selectNativeRevivalAnimation({actor,data:this.reactionData,rng})})
                :{actor:copy(target),name:result.name,changes:{},applied:false,native_return:0,effect_requested:false,cancel_command:false,trace:[]};
              if(result.applied){if(result.revived)this.commitRevival(target,result);else Object.assign(target,result.actor);this.state.inventory=consumed.inventory;}
              if(result.cancel_command){const command=commandForActor(s,target.id);if(command)this.cancelQueuedCommand(command,'actor-status');}
              committed=true;this.activeItemInstanceId=null;this.state.action_count++;
              const entry={action_id:actionId,actor_id:attacker.id,target_id:target.id,skill_id:skillId,item_id:consumed.item.id,round:this.state.round,impact:false,
                result:{hit:true,damage:0,changes:result.changes,native_return:result.native_return,item_used:result.applied,item_effect:result.effect_requested,trace:result.trace},before,after:copy(target)};
              const historyIndex=this.state.history.push(entry)-1;this.recordImpact(entry,historyIndex);
              this.log({type:'battle-item-used',battle_id:this.state.id,...copy(entry),name:result.name,charge});this.publish();}
            return {hit:true,damage:0,item_used:result.applied,item_effect:result.effect_requested,native_return:result.native_return,
              ...(!result.effect_requested?{skipped:'item-target-unavailable'}:{}),revived:Boolean(result.revived),remainingHp:target.hp.current};
          };
          await this.playItem({action_id:actionId,actor_id:attacker.id,target_id:target.id,item_id:consumed.item.id,name:result.name,skill_id:skillId},{onUse});
          this.checkWorld();requireValue(committed,'道具原动作没有触发使用事件');
          s.active_actor_id=null;setIdleSkill(attacker,this.schedulerData,this.now());this.state.round++;break;
        }
        const playerSkills=attacker.side==='player'?this.commandSkills(skill):null;
        if(playerSkills&&(playerSkills.some(member=>!member||silenced(attacker,member)||member.fixed_raw_hex&&(attacker.level??0)<requiredSkillLevel(member))||attacker.mp.current<skill.mp_cost)){
          this.cancelQueuedCommand(pending,'skill-no-longer-available');break;
        }
        const nativePlan=this.completeContacts?(attacker.side==='player'?{kind:skill.battle_handler==='combination'?'combination':'single',skill_indices:playerSkills.map(member=>member.original_skill_index),target_id:target.id,trace:[]}:planForestEnemyAction({actors:this.state.actors,actor_id:attacker.id,data:this.nativeAiData,rng:this.rng})):null;
        requireValue(!nativePlan||nativePlan.target_id,'原选招未产生可行动目标');
        const selectedList=nativePlan?(attacker.side==='player'?playerSkills:nativePlan.skill_indices.map(i=>this.skills[this.enemySkillTables[attacker.id][i]])):[this.skills[attacker.side==='player'?skillId:this.state.enemy_skill_ids[attacker.id]]];
        requireValue(selectedList.length&&selectedList.every(Boolean),'原选招对应技能尚未导出');const selected=selectedList[0];
        const victim=nativePlan?this.actor(nativePlan.target_id):attacker.side==='player'?target:player;
        const revival=selected.battle_handler==='native-revival',support=selected.battle_handler==='native-support';
        requireValue(revival?revivalTargetEligibility(victim,selected).available:support?supportTargetEligibility(victim,selected).available:victim.hp.current>0,'预定目标已倒下或不再可复活');
        requireValue(attacker.mp.current>=selected.mp_cost,'当前固定行动资源不足，完整后备选招未接入');
        attacker.current_skill=copy(selected);attacker.class_raw=selected.class_raw;attacker.action_mask_raw=selected.action_mask_raw;
        const plan=nativePlan?(nativePlan.kind==='combination'?composeNativeSequence(attacker.side==='player'?selectedList:this.nativeAiData.roles[attacker.resource_id].skills,nativePlan.skill_indices):directSequence(selected)):revival||support?directSequence(selected):null;
        if(this.skillGrowthData&&attacker.side==='player')for(const source of selectedList){const practice=recordNativeSkillPractice(this.skillPractice,attacker,source,selectedList.length);this.log({type:'battle-skill-practice',battle_id:this.state.id,...practice});}
        const charge=dispatchCharge(attacker,selectedList,s);this.state.phase='action';if(this.lifecycleEnabled)attacker.native_active=true;
        this.log({type:'battle-scheduled',battle_id:this.state.id,actor_id:attacker.id,skill_id:selected.id,target_id:victim.id,
          ticks:s.ticks,threshold:s.threshold,selection,native_plan:nativePlan?copy(nativePlan):null,charge,gauges:this.state.actors.map(a=>({id:a.id,...copy(a.charge)}))});
        if(this.state.reward_ledger)resetNativeChain(this.state.reward_ledger,attacker.id);
        this.publish();if(plan)await this.performSequence(attacker,victim,selected,plan,{command:attacker.side==='player'?skill:selected,members:selectedList});else await this.performAction(attacker,victim,selected);this.checkWorld();
        s.active_actor_id=null;if(attacker.hp.current>0&&!this.state.lifecycle_events?.some(event=>event.actor_id===attacker.id)&&!attacker.native_active){
          if(attacker.current_skill?.id!==this.schedulerData.idle_skills[attacker.resource_id??attacker.id].id)setIdleSkill(attacker,this.schedulerData,this.now());}
        if(this.lifecycleEnabled)for(const actor of this.state.actors)if(actor.state_raw===4&&this.canFinalizeDeath(actor))this.finalizeDeath(actor);
        if(attacker.side==='player'){this.state.round++;break;}
        // Return control after each completed action. The next frame performs
        // the next arbitration, leaving input a boundary to confirm a ready
        // player's command instead of draining an unbounded enemy action chain.
        break;
      }
      this.running=false;this.refreshCommandState();this.publish();return this.snapshot();
    }catch(error){
      this.interrupt(error);throw error;
    }
  }
  async performSequence(attacker,target,selected,plan,{command=selected,members=[selected]}={}){
    this.checkWorld();const support=this.reactionTargetAvailability(selected,target);requireValue(support.available,support.reason);
    if(Object.hasOwn(attacker,'settled_raw'))attacker.settled_raw=0;
    // 0x501AA0 charges a negative source MP delta only outside skill-test.
    if(attacker.side==='player'&&!this.testMode)Object.assign(attacker,this.consumeResources(copy(attacker),members.reduce((sum,member)=>sum+member.mp_cost,0)));
    const actionId=`${this.state.id}:${++this.state.action_count}`,entry={action_id:actionId,actor_id:attacker.id,target_id:target.id,skill_id:command.id,round:this.state.round,plan:copy(plan),contacts:[],impact:false,result:{hit:true,damage:0},before:copy({attacker,target}),after:null};
    const historyIndex=this.state.history.push(entry)-1;this.log({type:'battle-action',battle_id:this.state.id,...copy(entry)});this.publish();
    const seen=new Map(),controlsSeen=new Set(),primaryToken=actionId;let reactionCount=0;
    attacker.native_active=true;attacker.current_target_id=target.id;attacker.native_sequence_token=primaryToken;
    const onRecord=(step,descriptor=null)=>{const actor=descriptor?this.actor(descriptor.actor_id):attacker;if(actor.state_raw>=5)return;
      const source=descriptor?descriptor.skill:plan.kind==='single'?selected:this.sequenceSkill(actor,step.source_skill_index);
      requireValue(source,'原组合技能属性来源无效');actor.current_skill=copy(source);actor.class_raw=step.class_raw;actor.action_mask_raw=step.action_mask_raw;
      if(step.visibility){
        const key=`${actor.id}:${step.plan_record_index}:${step.visibility_end?'end':'begin'}`;
        if(!controlsSeen.has(key)){controlsSeen.add(key);
          if(step.visibility_end){actor.immune_raw=Number(step.visibility.kind==='disappear');actor.native_visibility={...copy(step.visibility),complete:true};}
          else actor.native_visibility={...copy(step.visibility),complete:false};
          this.log({type:'battle-native-visibility',battle_id:this.state.id,actor_id:actor.id,source_record_index:step.plan_record_index,end:Boolean(step.visibility_end),...copy(step.visibility)});
        }
      }
    };
    const end=(actor,token,now=this.now())=>{if(actor.native_sequence_token!==token)return;
      if(this.reactionData&&this.schedulerData)this.completeNativeSource(actor,now);else{actor.native_active=false;if(actor.hp.current>0)setIdleSkill(actor,this.schedulerData,now);}
      if(this.state.reward_ledger)resetNativeChain(this.state.reward_ledger,actor.id);};
    const onContact=(step,descriptor=null)=>{
      if(seen.has(step.contact_key))return copy(seen.get(step.contact_key));this.checkWorld();if(!step.independent_carrier)onRecord(step,descriptor);
      // A slow RAF can replay several contacts. Each sees the idle record at
      // its own source presentation time, not the last rendered frame.
      for(const actor of this.state.actors)advanceIdleSkill(actor,this.schedulerData,step.presentation_time_ms??this.now());
      const striker=descriptor?this.actor(descriptor.actor_id):attacker,victim=step.target_id?this.actor(step.target_id):descriptor?this.actor(descriptor.target_id):target;
      // 5055D0 retains the source index in each carrier. A later owner idle,
      // reaction or command never changes an already allocated effect's skill
      // and its contact must not restore the owner's previous CHR record.
      const source=copy(step.independent_carrier?(descriptor?descriptor.skill:plan.kind==='single'?selected:this.sequenceSkill(striker,step.source_skill_index)):striker.current_skill),before=copy({attacker:striker,target:victim??null}),fixed=Uint8Array.from(source.fixed_raw_hex.match(/../g),x=>parseInt(x,16));
      const isRevival=source.battle_handler==='native-revival',isSupport=source.battle_handler==='native-support';
      if(!isRevival&&!isSupport)requireValue(!step.effect_contact||source.effect_context?.effect_token===step.effect_token,'法术特效接触来源缺失');
      const targetFixed=victim?Uint8Array.from(victim.current_skill.fixed_raw_hex.match(/../g),x=>parseInt(x,16)):null;
      let result;
      if(isSupport){
        if(!victim||victim.side!==striker.side||!supportTargetEligibility(victim,source).available)result={hit:false,damage:0,native_return:-1,mp_cost:source.mp_cost,skipped:'support-target-unavailable'};
        else{
          const support=applyNativeSupport({target:victim,skill:source,rng:this.rng,statusData:this.statusData});
          if(support.applied)Object.assign(victim,support.actor);
          if(support.cancel_command){const pending=commandForActor(this.state.scheduler,victim.id);if(pending)this.cancelQueuedCommand(pending,'actor-status');}
          result={hit:support.applied,damage:0,native_return:support.native_return,mp_cost:source.mp_cost,supported:support.applied,hp_delta:support.hp_delta??0,mp_delta:support.mp_delta??0,cleared_statuses:support.cleared_statuses??false,trace:copy(support.trace??[])};
        }
      }else if(isRevival){
        if(!victim||victim.side!==striker.side||!revivalTargetEligibility(victim,source).available)
          result={hit:false,damage:0,native_return:-1,mp_cost:source.mp_cost,skipped:'revival-target-unavailable'};
        else{
          const revival=applyNativeRevival({target:victim,skill:source,rng:this.rng,selectAnimation:(actor,{rng})=>selectNativeRevivalAnimation({actor,data:this.reactionData,rng})});
          if(revival.applied)this.commitRevival(victim,revival);
          result={hit:revival.applied,damage:0,native_return:revival.native_return,mp_cost:source.mp_cost,revived:revival.applied,hp_delta:revival.hp_delta??0,
            ...(!revival.applied?{skipped:revival.reason}:{}),trace:[...copy(revival.animation?.trace??[]),...copy(revival.trace)]};
        }
      }else if(!victim||victim.reaction_busy_raw||victim.immune_raw||targetFixed[0]===19||(victim.status_flags_raw&(1<<9))||
        step.effect_contact&&({1:1,2:2,3:4}[victim.class_raw]&step.action_mask_raw)||new DataView(fixed.buffer).getInt32(0xcb,true)===-1)
        result={hit:false,damage:0,reaction:0,native_return:-1,mp_cost:source.mp_cost,skipped:'native-contact-gate',after_settled_raw:victim?.settled_raw??0};
      else result=this.resolveAction({attacker:copy(striker),target:copy(victim),skill:source,rng:this.rng,context:{round:this.state.round,...(step.effect_contact?nativeEffectContextForTarget(source,victim,this.reactionData?.roles):{}),...this.nativeContext()}});
      requireValue(result&&typeof result.hit==='boolean','接触结算无效');resource(result.damage,'接触伤害');
      let reaction=null,status=null,lethal=false;
      if(victim&&!isRevival&&!isSupport&&result.native_return!==-1){
        if(this.state.reward_ledger)recordNativeContact(this.state.reward_ledger,{attacker:striker,target:victim,skill:source,hit:result.hit,settledBefore:victim.settled_raw});
        victim.settled_raw=result.after_settled_raw;
        if(this.statusData){status=applyNativeSkillStatus({actor:victim,skill:source,data:this.statusData,rng:this.rng,now:this.state.scheduler.elapsed_ms});Object.assign(victim,status.actor);if(status.cancel_command){const command=commandForActor(this.state.scheduler,victim.id);if(command)this.cancelQueuedCommand(command,'actor-status');}}
        const applied=this.applyDamage(copy(victim),copy(result),this.nativeContext());actorShape(applied);requireValue(applied.hp.current<=victim.hp.current&&applied.id===victim.id,'完整接触提交改变了目标身份或增加HP');Object.assign(victim,applied);
        lethal=before.target.hp.current>0&&victim.hp.current===0;
        if(lethal&&this.lifecycleEnabled)victim.killer_actor_id=striker.id;
        if(lethal&&victim.charge){victim.charge.gauge=0;victim.charge.delay=0;victim.charge.recovery=0;victim.native_active=false;}
        if(this.reactionData){reaction=applyContactReaction({attacker:striker,target:victim,result,record:step.source,data:this.reactionData,rng:this.rng,threshold:this.state.scheduler?.threshold,...this.nativeSourceHooks()});
          if(reaction){Object.assign(victim,copy(reaction.after));if(reaction.skill){reaction.token=`${actionId}:reaction:${++reactionCount}`;victim.native_sequence_token=reaction.token;reaction.plan=directSequence(reaction.skill);reaction.plan.allow_no_contacts=true;}}
        }
      }
      const presented={...copy(result),remainingHp:victim?.hp.current??0,death:lethal,killer_frame_factor:lethal?2:1,status:status?{applied:status.applied,reason:status.reason,trace:status.trace}:null,
        reaction_descriptor:reaction?.skill?copy(reaction):null,interrupt_actor_id:lethal||reaction?.skill?victim?.id:null};
      const contact={key:step.contact_key,source:copy(step),result:presented,before,after:copy({attacker:striker,target:victim??null})};seen.set(step.contact_key,presented);entry.contacts.push(contact);entry.result=copy(result);this.recordImpact(entry,historyIndex);entry.presentation=copy(step);entry.after=copy({attacker:striker,target:victim??null});
      this.log({type:'battle-impact',battle_id:this.state.id,action_id:actionId,contact_key:step.contact_key,actor_id:striker.id,target_id:victim?.id??null,skill_id:source.id,source_skill_index:step.source_skill_index,
        effect_token:step.effect_contact?step.effect_token:0,
        hit:result.hit,damage:result.damage,skipped:result.skipped??null,hp_before:before.target?.hp.current??null,hp_after:victim?.hp.current??null,mp_before:before.attacker.mp.current,mp_after:striker.mp.current,trace:copy(result.trace??[]),status:copy(presented.status),reaction:reaction?{kind:reaction.kind,source_skill_index:reaction.source_skill_index,target_id:reaction.target_id,trace:copy(reaction.trace)}:null,presentation:copy(step)});this.publish();return presented;
    };
    const contactTargets=step=>{
      if(step.carrier_target_ids)return step.carrier_target_ids;
      const source=plan.kind==='single'?selected:this.sequenceSkill(attacker,step.source_skill_index),fixed=Uint8Array.from(source.fixed_raw_hex.match(/../g),x=>parseInt(x,16));
      if(!fixed[0x24])return [target.id];
      return this.state.actors.filter(actor=>fixed[0x25]?actor.side_raw===attacker.side_raw:actor.side_raw!==attacker.side_raw).map(actor=>actor.id);
    };
    const onSourceContact=(step,descriptor=null)=>{
      if(descriptor)return onContact(step,descriptor);
      const ids=contactTargets(step);if(ids.length===1)return {target_id:ids[0],...onContact({...step,target_id:ids[0]})};
      const results=ids.map(id=>({target_id:id,...onContact({...step,target_id:id,contact_key:`${step.contact_key}:${id}`})}));
      const primary=results.find(row=>row.target_id===target.id)??results[0];
      return {...(primary??{hit:false,damage:0,skipped:'no-native-carrier-target',remainingHp:0}),group_results:results};
    };
    const playback=await this.playSequence({actor_id:attacker.id,target_id:target.id,skill_id:command.id,action_id:actionId,plan:copy(plan)},{onContact:onSourceContact,onRecord,
      onCarrierTargets:(step,descriptor=null)=>{
        const caster=descriptor?this.actor(descriptor.actor_id):attacker,primary=descriptor?this.actor(descriptor.target_id):target;
        const source=descriptor?descriptor.skill:plan.kind==='single'?selected:this.sequenceSkill(caster,step.source_skill_index);
        const fixed=Uint8Array.from(source.fixed_raw_hex.match(/../g),x=>parseInt(x,16));
        const group=Boolean(fixed[0x24]&&!step.full_screen_effect),revival=fixed[0x176]===3||fixed[0x23c]===3;
        const ids=group?this.state.actors.filter(actor=>{
          if(actor.immune_raw)return false;
          if(fixed[0x25])return actor.side_raw===caster.side_raw&&(revival?actor.state_raw>=4&&actor.state_raw<=7:actor.state_raw<4);
          return actor.side_raw!==caster.side_raw&&!actor.escaped&&parseInt(actor.current_skill.fixed_raw_hex.slice(0,2),16)!==19;
        }).map(actor=>actor.id):primary&&!primary.immune_raw?[primary.id]:[];
        if(!ids.length)entry.empty_carrier_allocation=true;
        return {target_ids:ids,group};
      },
      onCarrierStart:({carrier_id})=>{this.pendingCarriers.add(`${actionId}:${carrier_id}`);},
      onCarrierEnd:({carrier_id})=>{this.pendingCarriers.delete(`${actionId}:${carrier_id}`);this.refreshCommandState();this.publish();},
      onDetachedError:error=>this.interrupt(error),
      onReactionContact:onContact,onReactionRecord:onRecord,onReactionEnd:(descriptor,completed,now)=>{if(completed)end(this.actor(descriptor.actor_id),descriptor.token,now);},onPrimaryEnd:now=>end(attacker,primaryToken,now)});this.checkWorld();
    requireValue(entry.contacts.length>0||entry.empty_carrier_allocation||playback?.interrupted||playback?.carriers_pending,'完整技能结束却没有接触结算');
    for(const actor of this.state.actors)if(actor.state_raw===4&&this.canFinalizeDeath(actor))this.finalizeDeath(actor);
    if(this.state.reward_ledger)resetNativeChain(this.state.reward_ledger,attacker.id);
  }
  finalizeDeath(actor){
    if(actor.state_raw!==4||!this.canFinalizeDeath(actor))return;const death=this.reactionData?finalizeNativeDeath({actor,data:this.reactionData,rng:this.rng}):null;
    if(death)Object.assign(actor,copy(death.after));else actor.state_raw=5;
    if(this.statusData)Object.assign(actor,clearNativeStatuses(actor,this.statusData));
    if(this.lifecycleEnabled&&actor.charge)Object.assign(actor.charge,{gauge:0,delay:0,recovery:0,recovery_ticks:0});
    const command=commandForActor(this.state.scheduler,actor.id);if(command)this.cancelQueuedCommand(command,'actor-fallen');
    if(this.state.reward_ledger&&actor.side==='enemy')collectEnemyDefeat(this.state.reward_ledger,actor,{data:this.rewardData});
    if(this.lifecycleEnabled&&death){
      this.state.lifecycle_events=this.state.lifecycle_events.filter(e=>e.actor_id!==actor.id);this.queueLifecycle(actor,death);
    }
    this.log({type:'battle-death-finalized',battle_id:this.state.id,actor_id:actor.id,death:copy(death)});
  }
  async performAction(attacker,target,selected) {
        // This sample does not silently substitute an unverified enemy fallback.
        requireValue(attacker.mp.current>=selected.mp_cost, `${attacker.name}资源不足，固定行动没有可用后备规则`);
        // Native scheduler 0x503BD8 clears the selected actor's reaction gate.
        if(Object.hasOwn(attacker,'settled_raw'))attacker.settled_raw=0;
        this.checkWorld();
        const result=this.resolveAction({attacker:copy(attacker),target:copy(target),skill:copy(selected),rng:this.rng,context:{round:this.state.round,...this.nativeContext()}});
        requireValue(result && typeof result.hit==='boolean', '结算没有明确命中结果');
        resource(result.damage, '结算伤害');
        requireValue(result.mp_cost===selected.mp_cost, '行动消耗与样本来源不一致');
        requireValue(result.hit || result.damage===0, '未命中行动不能提交伤害');
        const before=copy({attacker,target}),cost=this.testMode?0:result.mp_cost,consumed=this.testMode?copy(attacker):this.consumeResources(copy(attacker),cost);actorShape(consumed);
        requireValue(consumed.id===attacker.id&&consumed.side===attacker.side&&consumed.mp.current===attacker.mp.current-cost&&consumed.mp.maximum===attacker.mp.maximum&&consumed.hp.current===attacker.hp.current&&consumed.hp.maximum===attacker.hp.maximum,'消耗提交改变了非行动资源');
        Object.assign(attacker,consumed);
        const actionId=`${this.state.id}:${++this.state.action_count}`;
        let impacted=false;
        const entry={action_id:actionId,actor_id:attacker.id,target_id:target.id,skill_id:selected.id,round:this.state.round,
          result:copy(result),before,impact:false,after:null};
        const historyIndex=this.state.history.push(entry)-1;
        this.log({type:'battle-action',battle_id:this.state.id,...copy(entry)}); this.publish();
        const onImpact=(presentation)=>{
          if(impacted || this.state.phase==='closed')return false;
          this.checkWorld();
          const applied=this.applyDamage(copy(target),copy(result),this.nativeContext()); actorShape(applied);
          requireValue(applied.id===target.id && applied.side===target.side && applied.mp.current===target.mp.current && applied.mp.maximum===target.mp.maximum && applied.hp.maximum===target.hp.maximum, 'HP提交改变了非目标资源');
          requireValue(applied.hp.current<=target.hp.current, '本样本伤害提交不能增加HP');
          Object.assign(target,applied); impacted=true; this.recordImpact(entry,historyIndex);
          if(this.lifecycleEnabled&&before.target.hp.current>0&&target.hp.current===0){
            target.killer_actor_id=attacker.id;
            if(target.charge)Object.assign(target.charge,{gauge:0,delay:0,recovery:0,recovery_ticks:0});
          }
          if(presentation)entry.presentation=copy(presentation);
          entry.after=copy({attacker,target});
          this.log({type:'battle-impact',battle_id:this.state.id,action_id:actionId,actor_id:attacker.id,target_id:target.id,
            hit:result.hit,damage:result.damage,hp_before:before.target.hp.current,hp_after:target.hp.current,
            mp_before:before.attacker.mp.current,mp_after:attacker.mp.current,trace:result.trace??[],presentation:entry.presentation??null});
          this.publish(); return true;
        };
        await this.playAction({...copy(result),actor_id:attacker.id,target_id:target.id,skill_id:selected.id,
          action_id:actionId,remainingHp:this.testMode?target.hp.current:Math.max(0,target.hp.current-result.damage),death:!this.testMode&&result.hit&&result.damage>=target.hp.current},{onImpact});
        this.checkWorld(); requireValue(impacted,'表现结束却没有执行结算事件，战斗已暂停');
  }
  commitRevival(actor,result){
    Object.assign(actor,result.actor);actor.alive=actor.hp.current>0;actor.killer_actor_id=null;actor.life_epoch=(actor.life_epoch??0)+1;
    if(this.state.lifecycle_events)this.state.lifecycle_events=this.state.lifecycle_events.filter(event=>event.actor_id!==actor.id);
    if(result.animation)Object.assign(actor,copy(result.animation.after));
    if(this.lifecycleEnabled&&result.animation)this.queueLifecycle(actor,result.animation);
    else{actor.native_active=false;setIdleSkill(actor,this.schedulerData,this.now());}
  }
  prepareRewards(){
    if(this.rewardPlan)return this.rewardPlan;this.checkWorld();requireValue(this.state.phase==='victory'||this.lockedOutcome==='victory','尚未胜利，不能规划奖励');
    const candidate=this.world.snapshot();
    if(this.state.inventory)candidate.inventory=copy(this.state.inventory);
    for(const player of this.players()){const resources=this.resourcesForWorld(copy(player)),role=candidate.party.find(a=>a.id===player.id);role.hp.current=resources.hp;role.mp.current=resources.mp;}
    this.rewardPlan=planVictoryRewards({world:candidate,ledger:this.state.reward_ledger,data:this.rewardData,rng:this.rng,actors:this.state.actors,skill_data:this.skillGrowthData,skill_practice:this.skillPractice});
    this.state.rewards=copy(this.rewardPlan.summary);this.log({type:'battle-rewards-planned',battle_id:this.state.id,summary:copy(this.rewardPlan.summary),trace:copy(this.rewardPlan.trace)});return this.rewardPlan;
  }
  finish() {
    if(this.completed)return copy(this.completed);
    requireValue(this.state && !this.running && !this.pendingCarriers.size && !this.state.scheduler?.pending && !this.hasLifecycle() && !this.state.pending_outcome && ['charging','command','victory','defeat','escaped','interrupted'].includes(this.state.phase), '战斗行动仍在执行');
    this.checkWorld();
    const resourcesByActor=Object.fromEntries(this.players().map(player=>[player.id,this.resourcesForWorld(copy(player))])),resources=resourcesByActor[this.state.player_id];
    // Native raw HP may be negative after linked-equipment HP is exhausted.
    // The world preserves DWORD bits; presentation uses the adapter's effective HP.
    for(const row of Object.values(resourcesByActor))for(const key of ['hp','mp'])requireValue(Number.isInteger(row[key])&&row[key]>=0&&row[key]<=0xffffffff,`回写${key}无效`);
    const before=this.world.snapshot();
    const rewards=this.rewardData&&this.state.outcome==='victory'?this.prepareRewards():null;
    // Skill-test owns a private world in the browser controller. Return actual
    // resource / inventory changes for its caller's transaction; this is an
    // ownership boundary, not a native consumable or resource rollback rule.
    if(!this.testMode&&(rewards?.applied||this.state.inventory&&JSON.stringify(this.state.inventory)!==JSON.stringify(before.inventory)||this.players().some(player=>{const persistent=before.party.find(actor=>actor.id===player.id),row=resourcesByActor[player.id];return persistent.hp.current!==row.hp||persistent.mp.current!==row.mp;}))) {
      this.world.transact(next=>{for(const [id,row]of Object.entries(resourcesByActor)){const actor=next.party.find(actor=>actor.id===id);actor.hp.current=row.hp;actor.mp.current=row.mp;}
        if(this.state.inventory)next.inventory=copy(this.state.inventory);
        if(rewards?.applied){Object.assign(next,copy(rewards.world_patch));next.reward_records??=[];requireValue(!next.reward_records.some(r=>r.battle_id===this.state.id),'奖励已经提交');next.reward_records.push(copy(rewards.reward_record));}});
    }
    this.expectedRevision=this.world.value.revision;
    this.completed={battle_id:this.state.id,outcome:this.state.outcome??(this.state.phase==='interrupted'?'interrupted':'aborted'),
      rounds:this.state.round,actions:this.state.action_count,world_revision:this.expectedRevision,resources,resources_by_actor:copy(resourcesByActor),
      rewards_applied:Boolean(rewards?.applied),rewards:copy(rewards?.summary??null),source:this.state.source,...(this.testMode?{test_mode:true}:{} )};
    if(this.statusData)for(const actor of this.state.actors)Object.assign(actor,clearNativeStatuses(actor,this.statusData));
    this.state.phase='closed';this.log({type:this.testMode?'battle-test-finished':'battle-world-commit',...copy(this.completed)});this.publish();return copy(this.completed);
  }
}
