// Bounded party / up-to-four-enemy lifecycle. Native rules are injected.
import {initializeScheduler,chargeActor,isActorReady,selectReady,dispatchCharge,dispatchItemCharge,setIdleSkill} from './battle_scheduler.mjs';
import {planForestEnemyAction,selectNativeTarget} from './forest_ai.mjs';
import {composeNativeSequence,directSequence} from './skill_sequence.mjs';
import {createRewardLedger,collectEnemyDefeat,recordNativeContact,resetNativeChain,planVictoryRewards} from './battle_rewards.mjs';
import {applyContactReaction,finalizeNativeDeath,initializeNativeEntry,selectNativeRevivalAnimation} from './battle_reactions.mjs';
import {initializeNativeStatuses,clearNativeStatuses,applyNativeSkillStatus,tickNativeStatuses} from './battle_status.mjs';
import {consumeInventoryItem,restoreActorWithItem,usableItems} from './items.mjs';
import {dispatchDefend,resolveNativeEscape,dispatchEscapeFailure,dispatchEscapeSuccess} from './battle_commands.mjs';
import {applyNativeRevival,revivalTargetEligibility} from './battle_revival.mjs';
import {skillGrowthSource,recordNativeSkillPractice} from './battle_skill_growth.mjs';
import {requiredSkillLevel} from './battle_skill_access.mjs';
const copy = value => structuredClone(value);
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
  // The frame loop and HUD need only visible state. Full contact records retain
  // raw CHR/status/configuration evidence and grow throughout a long battle.
  presentationSnapshot() {
    const state=this.state;if(!state)return null;
    const {id,phase,round,player_id,enemy_id,error,outcome,scheduler,rewards,test_mode}=state;
    const mode=(state.source.runtime_configuration??state.source.skill_configuration)?.mode;
    return copy({id,phase,round,player_id,enemy_id,error,outcome,scheduler,rewards,test_mode,
      lifecycle_events:state.lifecycle_events??[],pending_outcome:state.pending_outcome??null,
      ready_player_ids:this.readyPlayerIds(),command_available:this.canCommand(),input_busy:Boolean(scheduler?.pending)||this.running&&scheduler?.active_actor_id===player_id,action_busy:this.running,
      source:{runtime_configuration:{mode},player_command_order:state.source.player_command_order},
      actors:state.actors.map(({id,name,side,hp,mp,alive,charge,state_raw,defense_half_raw,party_slot_zero_based,life_epoch})=>({id,name,side,hp,mp,alive,charge,state_raw,party_slot_zero_based,life_epoch,defending:Boolean(defense_half_raw),escaped:state_raw===11})),
      history:state.history.map(({action_id,actor_id,target_id,skill_id,round,result,impact,presentation,command_kind})=>({
        action_id,actor_id,target_id,skill_id,round,impact,presentation,command_kind,
        result:result?{hit:result.hit,damage:result.damage,...(result.success!==undefined?{success:result.success}:{})}:undefined}))});
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
    this.state={id:this.id(),phase:'command',round:1,actors:next,order:[...order],player_id:player.id,player_ids:players.map(a=>a.id),enemy_id:enemy.id,
      enemy_skill_id:enemySkills[enemy.id],enemy_skill_ids:copy(enemySkills),enemy_ids:enemies.map(a=>a.id),action_count:0,source:copy(source),history:[],error:null,outcome:null,test_mode};
    if(this.itemData)this.state.inventory=copy(this.world.value.inventory);
    this.schedulerData=scheduler_data?copy(scheduler_data):null;
    if(this.schedulerData){this.state.scheduler=initializeScheduler(next,this.schedulerData,side_priority);this.state.scheduler.command_stage='closed';this.state.phase='charging';this.chargeClock=this.now();}
    this.actionTask=null;
    this.nativeAiData=enemy_ai_data?copy(enemy_ai_data):null;this.enemySkillTables=enemy_skill_tables?copy(enemy_skill_tables):null;this.completeContacts=complete_contacts;this.rewardData=!test_mode&&reward_data?copy(reward_data):null;this.rewardPlan=null;
    this.skillGrowthData=skill_data?skillGrowthSource(skill_data):null;this.skillPractice={};
    if(complete_contacts)requireValue(this.nativeAiData&&this.enemySkillTables&&typeof this.playSequence==='function','完整技能序列执行器缺失');
    if(this.rewardData)this.state.reward_ledger=createRewardLedger(this.state.id,next);
    this.reactionData=reaction_data;this.statusData=status_data;
    if(this.statusData)for(const actor of next)Object.assign(actor,initializeNativeStatuses(actor,this.statusData));
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
  nativeContext() { return {global_055ee004:this.testMode?1:0}; }
  players() { return this.state.actors.filter(actor=>actor.side==='player'); }
  activePlayers() { return this.players().filter(actor=>actor.hp.current>0&&actor.state_raw!==11); }
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
      actor.state_raw=0;actor.immune_raw=0;actor.native_active=false;setIdleSkill(actor,this.schedulerData);
    }else if(event.kind==='death'){
      actor.native_active=false;
      // 519DD0 turns an ended native id12 into category7. Keep its source
      // death skill as the corpse pose; it must not become an idle live actor.
      if(event.source_id_raw===12)actor.state_raw=7;
    }else if(event.kind==='revive'){
      actor.native_active=false;setIdleSkill(actor,this.schedulerData);
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
    if(!this.state?.scheduler)return this.state?.phase==='command'?this.players().filter(a=>a.hp.current>0).map(a=>a.id):[];
    return this.players().filter(a=>a.id!==this.state.scheduler.active_actor_id&&!this.state.lifecycle_events?.some(e=>e.actor_id===a.id)&&isActorReady(a,this.state.scheduler)).map(a=>a.id);
  }
  targetIdsForSkill(skillId) {
    const skill=this.skills?.[skillId],caster=skill&&this.state&&this.actor(skill.actor_id);if(!caster)return [];
    if(skill.battle_handler==='native-revival')return this.state.actors.filter(actor=>actor.side===caster.side&&actor.hp.current===0&&revivalTargetEligibility(actor,skill).available).map(actor=>actor.id);
    return this.state.actors.filter(actor=>actor.side!==caster.side&&actor.hp.current>0&&actor.state_raw<4&&!actor.escaped).map(actor=>actor.id);
  }
  canCommand(id=this.state?.player_id) {
    const actor=this.state&&this.actor(id),scheduler=this.state?.scheduler;
    if(!scheduler)return Boolean(this.state?.phase==='command'&&!this.running&&actor?.side==='player'&&actor.hp.current>0);
    return Boolean(['command','charging','action'].includes(this.state.phase)&&!this.state.pending_outcome&&!scheduler.pending&&actor?.side==='player'&&actor.id!==scheduler.active_actor_id&&!this.state.lifecycle_events?.some(e=>e.actor_id===id)&&isActorReady(actor,scheduler));
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
    return this.canCommand() && skill?.actor_id===player.id && (!skill.fixed_raw_hex||(player.level??0)>=requiredSkillLevel(skill)) && player.mp.current>=skill.mp_cost&&!silenced(player,skill)&&(skill.battle_handler!=='native-revival'||this.targetIdsForSkill(skillId).length>0);
  }
  items() { return this.itemData&&this.state?.inventory?copy(usableItems(this.state.inventory,this.itemData)):[]; }
  async chooseDefend() { return this.chooseFixedCommand('defend'); }
  async chooseEscape() { return this.chooseFixedCommand('escape'); }
  async chooseFixedCommand(kind) {
    requireValue(['defend','escape'].includes(kind),'固定战斗命令无效');
    requireValue(this.state?.scheduler&&this.canCommand(),'行动槽尚未充满或已有行动指令');this.checkWorld();
    const s=this.state.scheduler,player=this.actor(this.state.player_id);
    s.pending={actor_id:player.id,skill_id:kind,target_id:player.id,command_kind:kind};s.command_stage='closed';
    this.log({type:'battle-command-queued',battle_id:this.state.id,...copy(s.pending),scheduler:copy(s)});this.publish();
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
    requireValue(this.state.round<=100, '当前样本超过100轮，请退出测试');
    const selectedTarget=targetId===null?this.state.actors.find(a=>a.side==='enemy'&&a.hp.current>0):this.actor(targetId);
    requireValue(selectedTarget?.side==='enemy'&&selectedTarget.hp.current>0,'目标已经倒下或不属于敌方');
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
    if(now-this.chargeClock<20)return false;
    try {
      this.checkWorld();this.chargeClock=now;s.ticks++;s.elapsed_ms+=20;
      for(const actor of this.state.actors){chargeActor(actor,this.rng);if(actor.state_raw===4&&this.reactionData&&this.canFinalizeDeath(actor))this.finalizeDeath(actor);}
      if(this.statusData)for(const actor of this.state.actors){if(!actor.native_status_slots.some(s=>s.raw_hex.slice(2,4)!=='00'))continue;const update=tickNativeStatuses({actor,threshold:s.threshold,now:s.elapsed_ms,data:this.statusData});Object.assign(actor,update.actor);if(update.cancel_command&&s.pending?.actor_id===actor.id)s.pending=null;if(update.expired.length)this.log({type:'battle-status-expired',battle_id:this.state.id,actor_id:actor.id,slots:update.expired});}
      this.refreshCommandState();this.publish();
      this.scheduleReady();return true;
    }catch(error){this.interrupt(error);return false;}
  }
  interrupt(error) {
    this.running=false;this.state.phase='interrupted';this.state.error=error.message;
    if(this.state.scheduler){this.state.scheduler.pending=null;this.state.scheduler.active_actor_id=null;this.state.scheduler.command_stage='closed';}
    this.log({type:'battle-interrupted',battle_id:this.state.id,error:error.message});this.publish();
  }
  cancelQueuedCommand(pending,reason,details={}) {
    if(this.state.scheduler.pending===pending)this.state.scheduler.pending=null;
    this.log({type:'battle-command-cancelled',battle_id:this.state.id,...copy(pending),reason,...copy(details)});
  }
  queuedTarget(pending,attacker,skill) {
    const target=this.actor(pending.target_id);
    if(pending.item_instance_id){
      if(target?.side==='player'&&target.hp.current>0&&target.state_raw<4&&!target.immune_raw&&!target.escaped)return target;
      this.cancelQueuedCommand(pending,'item-target-unavailable');return null;
    }
    if(skill?.battle_handler==='native-revival'){
      if(target?.side===attacker.side&&target.hp.current===0&&revivalTargetEligibility(target,skill).available)return target;
      this.cancelQueuedCommand(pending,'revival-target-unavailable');return null;
    }
    if(target&&target.hp.current>0&&target.state_raw<4&&!target.escaped)return target;
    const fixed=skill?.fixed_raw_hex?Uint8Array.from(skill.fixed_raw_hex.match(/../g),x=>parseInt(x,16)):null;
    // The opposite-side fallback is bound to ordinary direct attacks;
    // mode3 revival has its own same-side admission branch above.
    if(target&&target.side!==attacker.side&&target.state_raw>=4&&target.state_raw<8&&fixed){
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
    const s=this.state.scheduler,victory=this.state.actors.filter(a=>a.side==='enemy').every(a=>a.hp.current===0);
    if(this.testMode&&this.state.test_exit_requested&&!this.running){
      s.pending=null;s.command_stage='closed';
      if(this.hasLifecycle()){this.state.pending_outcome='escaped';this.state.phase='charging';return;}
      this.state.pending_outcome=null;this.state.phase='escaped';this.state.outcome='escaped';return;
    }
    if(!this.running&&(!this.activePlayers().length||victory)){
      const outcome=victory?'victory':this.players().some(a=>a.state_raw===11)?'escaped':'defeat';
      if(this.lifecycleEnabled&&(this.hasLifecycle('death')||this.state.actors.some(a=>a.hp.current===0&&a.state_raw===4))){
        this.state.pending_outcome=outcome;this.state.phase='charging';s.pending=null;s.command_stage='closed';return;
      }
      this.state.pending_outcome=null;this.state.phase=outcome;this.state.outcome=outcome;s.pending=null;s.command_stage='closed';
      if(victory&&this.rewardData)this.prepareRewards();return;
    }
    if(this.activePlayers().length&&!victory)this.state.pending_outcome=null;
    if(s.pending&&this.actor(s.pending.actor_id)?.hp.current===0)this.cancelQueuedCommand(s.pending,'actor-fallen');
    if(s.pending?.item_instance_id){const target=this.actor(s.pending.target_id);if(!target||target.hp.current===0||target.state_raw>=4||target.immune_raw||target.escaped)this.cancelQueuedCommand(s.pending,'item-target-unavailable');}
    const ready=this.readyPlayerIds();
    if(!s.pending&&!ready.includes(this.state.player_id))this.state.player_id=ready[0]??this.activePlayers()[0]?.id??this.state.player_id;
    if(!this.running)this.state.phase=ready.length&&!s.pending?'command':'charging';
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
    const player=this.actor(this.state.player_id),s=this.state.scheduler;
    requireValue(this.canCommand(player.id),'角色行动槽尚未充满');
    let skill=this.skills[skillId];
    if(itemCommand){
      const consumed=consumeInventoryItem(this.state.inventory,itemCommand.instance_id,this.itemData);
      const target=this.actor(targetId??player.id);restoreActorWithItem(target,consumed.item,this.itemData);
      skill={id:`item:${consumed.item.id}`,actor_id:player.id,mp_cost:0};
    }
    requireValue(skill?.actor_id===player.id&&player.hp.current>0,'玩家命令无效');
    requireValue(!silenced(player,skill), '沉默状态下不能施放法术');
    requireValue(player.mp.current>=skill.mp_cost,'资源不足，无法施放');
    const revival=skill.battle_handler==='native-revival';
    if(revival)requireValue(this.reactionData&&typeof this.playSequence==='function','复活动作执行器或原动作来源缺失');
    const target=itemCommand?this.actor(targetId??player.id):targetId===null?this.actor(this.targetIdsForSkill(skill.id)[0]):this.actor(targetId);
    requireValue(revival?target&&this.targetIdsForSkill(skill.id).includes(target.id):target?.side===(itemCommand?'player':'enemy')&&target.hp.current>0&&target.state_raw!==11&&!target.escaped,'目标已经倒下、离场或阵营不匹配');
    requireValue(this.testMode||this.state.round<=100,'当前样本超过100次玩家行动，请退出测试');
    s.pending={actor_id:player.id,skill_id:skill.id,target_id:target.id,...(itemCommand?{item_instance_id:itemCommand.instance_id}:{})};s.command_stage='closed';
    this.log({type:'battle-command-queued',battle_id:this.state.id,...copy(s.pending),scheduler:copy(s)});this.publish();
    if(!this.running){const task=this.scheduleReady();if(task)await task;}return this.snapshot();
  }
  async runScheduledReady(firstSelection) {
    const s=this.state.scheduler;let selection=firstSelection;
    try {
      while(this.activePlayers().length&&this.state.actors.some(a=>a.side==='enemy'&&a.hp.current>0)){
        if(!selection.actor_id)break;
        const pending=s.pending,chosenPlayer=this.actor(pending?.actor_id??this.state.player_id),player=chosenPlayer?.hp.current>0&&chosenPlayer.state_raw!==11?chosenPlayer:this.activePlayers()[0],skill=pending?this.skills[pending.skill_id]:null;
        const itemCommand=pending?.item_instance_id?{instance_id:pending.item_instance_id}:null;
        let target=pending?this.actor(pending.target_id):null;const skillId=pending?.skill_id;
        const attacker=this.actor(selection.actor_id);
        if(attacker.side==='player'&&!pending?.command_kind){target=this.queuedTarget(pending,attacker,skill);if(!target)break;}
        // A dispatched command belongs to the active action now. Free the
        // input queue so another ready party member can choose its next action
        // during this animation; completion must preserve that new pending row.
        if(attacker.side==='player'&&s.pending===pending)s.pending=null;
        if(attacker.side==='player'&&pending?.command_kind){
          if(pending.command_kind==='defend')this.performDefend(attacker);else this.performEscape(attacker);
          s.active_actor_id=null;break;
        }
        if(itemCommand&&attacker.id===player.id){
          const consumed=consumeInventoryItem(this.state.inventory,itemCommand.instance_id,this.itemData);
          let result=restoreActorWithItem(target,consumed.item,this.itemData),committed=false;
          const charge=dispatchItemCharge(attacker,s),actionId=`${this.state.id}:${this.state.action_count+1}`;
          this.state.phase='action';this.publish();
          const onUse=()=>{
            if(!committed){this.checkWorld();const before=copy(target);result=restoreActorWithItem(target,consumed.item,this.itemData);Object.assign(target,result.actor);this.state.inventory=consumed.inventory;committed=true;this.state.action_count++;
              const entry={action_id:actionId,actor_id:attacker.id,target_id:target.id,skill_id:skillId,item_id:consumed.item.id,round:this.state.round,impact:true,result:{hit:true,damage:0,changes:result.changes},before,after:copy(target)};
              this.state.history.push(entry);this.log({type:'battle-item-used',battle_id:this.state.id,...copy(entry),name:result.name,charge});this.publish();}
            return {hit:true,damage:0,item_used:true,remainingHp:target.hp.current};
          };
          await this.playItem({action_id:actionId,actor_id:attacker.id,target_id:target.id,item_id:consumed.item.id,name:result.name,skill_id:skillId},{onUse});
          this.checkWorld();requireValue(committed,'道具原动作没有触发使用事件');
          s.active_actor_id=null;setIdleSkill(attacker,this.schedulerData);this.state.round++;break;
        }
        const nativePlan=this.completeContacts?(attacker.side==='player'?{kind:'single',skill_indices:[skill.original_skill_index],target_id:target.id,trace:[]}:planForestEnemyAction({actors:this.state.actors,actor_id:attacker.id,data:this.nativeAiData,rng:this.rng})):null;
        requireValue(!nativePlan||nativePlan.target_id,'原选招未产生可行动目标');
        const selectedList=nativePlan?(attacker.side==='player'?[skill]:nativePlan.skill_indices.map(i=>this.skills[this.enemySkillTables[attacker.id][i]])):[this.skills[attacker.side==='player'?skillId:this.state.enemy_skill_ids[attacker.id]]];
        requireValue(selectedList.length&&selectedList.every(Boolean),'原选招对应技能尚未导出');const selected=selectedList[0];
        const victim=nativePlan?this.actor(nativePlan.target_id):attacker.side==='player'?target:player;
        const revival=selected.battle_handler==='native-revival';
        requireValue(revival?revivalTargetEligibility(victim,selected).available&&victim.hp.current===0:victim.hp.current>0,'预定目标已倒下或不再可复活');
        requireValue(attacker.mp.current>=selected.mp_cost,'当前固定行动资源不足，完整后备选招未接入');
        attacker.current_skill=copy(selected);attacker.class_raw=selected.class_raw;attacker.action_mask_raw=selected.action_mask_raw;
        const plan=nativePlan?(nativePlan.kind==='combination'?composeNativeSequence(this.nativeAiData.roles[attacker.resource_id].skills,nativePlan.skill_indices):directSequence(selected)):revival?directSequence(selected):null;
        if(this.skillGrowthData&&attacker.side==='player')for(const source of selectedList){const practice=recordNativeSkillPractice(this.skillPractice,attacker,source,selectedList.length);this.log({type:'battle-skill-practice',battle_id:this.state.id,...practice});}
        const charge=dispatchCharge(attacker,selectedList,s);this.state.phase='action';if(this.lifecycleEnabled)attacker.native_active=true;
        this.log({type:'battle-scheduled',battle_id:this.state.id,actor_id:attacker.id,skill_id:selected.id,target_id:victim.id,
          ticks:s.ticks,threshold:s.threshold,selection,native_plan:nativePlan?copy(nativePlan):null,charge,gauges:this.state.actors.map(a=>({id:a.id,...copy(a.charge)}))});
        if(this.state.reward_ledger)resetNativeChain(this.state.reward_ledger,attacker.id);
        this.publish();if(plan)await this.performSequence(attacker,victim,selected,plan);else await this.performAction(attacker,victim,selected);this.checkWorld();
        s.active_actor_id=null;if(attacker.hp.current>0){setIdleSkill(attacker,this.schedulerData);attacker.native_active=false;}
        if(this.lifecycleEnabled)for(const actor of this.state.actors)if(actor.hp.current===0&&actor.state_raw===4&&this.canFinalizeDeath(actor))this.finalizeDeath(actor);
        if(attacker.side==='player'){this.state.round++;break;}
        if(s.pending&&this.actor(s.pending.actor_id)?.hp.current===0)s.pending=null;
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
  async performSequence(attacker,target,selected,plan){
    this.checkWorld();if(Object.hasOwn(attacker,'settled_raw'))attacker.settled_raw=0;
    // 0x501AA0 charges a negative source MP delta only outside skill-test.
    if(attacker.side==='player'&&!this.testMode)Object.assign(attacker,this.consumeResources(copy(attacker),selected.mp_cost));
    const actionId=`${this.state.id}:${++this.state.action_count}`,entry={action_id:actionId,actor_id:attacker.id,target_id:target.id,skill_id:selected.id,round:this.state.round,plan:copy(plan),contacts:[],impact:false,result:{hit:true,damage:0},before:copy({attacker,target}),after:null};
    this.state.history.push(entry);this.log({type:'battle-action',battle_id:this.state.id,...copy(entry)});this.publish();
    const seen=new Map(),primaryToken=actionId;let reactionCount=0;
    attacker.native_active=true;attacker.current_target_id=target.id;attacker.native_sequence_token=primaryToken;
    const onRecord=(step,descriptor=null)=>{const actor=descriptor?this.actor(descriptor.actor_id):attacker;if(actor.state_raw>=5)return;
      const source=descriptor?descriptor.skill:plan.kind==='single'?selected:this.nativeAiData.roles[actor.resource_id].skills[step.source_skill_index];
      requireValue(source,'原组合技能属性来源无效');actor.current_skill=copy(source);actor.class_raw=step.class_raw;actor.action_mask_raw=step.action_mask_raw;};
    const end=(actor,token)=>{if(actor.native_sequence_token!==token)return;actor.native_active=false;
      if(actor.hp.current>0)setIdleSkill(actor,this.schedulerData);if(this.state.reward_ledger)resetNativeChain(this.state.reward_ledger,actor.id);};
    const onContact=(step,descriptor=null)=>{
      if(seen.has(step.contact_key))return copy(seen.get(step.contact_key));this.checkWorld();onRecord(step,descriptor);
      const striker=descriptor?this.actor(descriptor.actor_id):attacker,victim=descriptor?this.actor(descriptor.target_id):target;
      const source=copy(striker.current_skill),before=copy({attacker:striker,target:victim??null}),fixed=Uint8Array.from(source.fixed_raw_hex.match(/../g),x=>parseInt(x,16));
      const isRevival=source.battle_handler==='native-revival';
      if(!isRevival)requireValue(!step.effect_contact||source.effect_context?.effect_token===step.effect_token,'法术特效接触来源缺失');
      const targetFixed=victim?Uint8Array.from(victim.current_skill.fixed_raw_hex.match(/../g),x=>parseInt(x,16)):null;
      let result;
      if(isRevival){
        if(!victim||victim.side!==striker.side||victim.hp.current!==0||!revivalTargetEligibility(victim,source).available)
          result={hit:false,damage:0,native_return:-1,mp_cost:source.mp_cost,skipped:'revival-target-unavailable'};
        else{
          const revival=applyNativeRevival({target:victim,skill:source,rng:this.rng,selectAnimation:(actor,{rng})=>selectNativeRevivalAnimation({actor,data:this.reactionData,rng})});
          if(revival.applied){
            Object.assign(victim,revival.actor);victim.alive=victim.hp.current>0;victim.killer_actor_id=null;victim.life_epoch=(victim.life_epoch??0)+1;
            if(this.state.lifecycle_events)this.state.lifecycle_events=this.state.lifecycle_events.filter(e=>e.actor_id!==victim.id);
            if(revival.animation)Object.assign(victim,copy(revival.animation.after));
            if(this.lifecycleEnabled&&revival.animation)this.queueLifecycle(victim,revival.animation);
            else{victim.native_active=false;setIdleSkill(victim,this.schedulerData);}
          }
          result={hit:revival.applied,damage:0,native_return:revival.native_return,mp_cost:source.mp_cost,revived:revival.applied,hp_delta:revival.hp_delta??0,
            ...(!revival.applied?{skipped:revival.reason}:{}),trace:[...copy(revival.animation?.trace??[]),...copy(revival.trace)]};
        }
      }else if(!victim||victim.reaction_busy_raw||victim.immune_raw||targetFixed[0]===19||(victim.status_flags_raw&(1<<9))||new DataView(fixed.buffer).getInt32(0xcb,true)===-1)
        result={hit:false,damage:0,reaction:0,native_return:-1,mp_cost:source.mp_cost,skipped:'native-contact-gate',after_settled_raw:victim?.settled_raw??0};
      else result=this.resolveAction({attacker:copy(striker),target:copy(victim),skill:source,rng:this.rng,context:{round:this.state.round,...(step.effect_contact?copy(source.effect_context):{}),...this.nativeContext()}});
      requireValue(result&&typeof result.hit==='boolean','接触结算无效');resource(result.damage,'接触伤害');
      let reaction=null,status=null,lethal=false;
      if(victim&&!isRevival&&result.native_return!==-1){
        if(this.state.reward_ledger)recordNativeContact(this.state.reward_ledger,{attacker:striker,target:victim,skill:source,hit:result.hit,settledBefore:victim.settled_raw});
        victim.settled_raw=result.after_settled_raw;
        if(this.statusData){status=applyNativeSkillStatus({actor:victim,skill:source,data:this.statusData,rng:this.rng,now:this.state.scheduler.elapsed_ms});Object.assign(victim,status.actor);if(status.cancel_command&&this.state.scheduler.pending?.actor_id===victim.id)this.state.scheduler.pending=null;}
        const applied=this.applyDamage(copy(victim),copy(result),this.nativeContext());actorShape(applied);requireValue(applied.hp.current<=victim.hp.current&&applied.id===victim.id,'完整接触提交改变了目标身份或增加HP');Object.assign(victim,applied);
        lethal=before.target.hp.current>0&&victim.hp.current===0;
        if(lethal&&this.lifecycleEnabled)victim.killer_actor_id=striker.id;
        if(lethal&&victim.charge){victim.charge.gauge=0;victim.charge.delay=0;victim.charge.recovery=0;victim.native_active=false;}
        if(this.reactionData){reaction=applyContactReaction({attacker:striker,target:victim,result,record:step.source,data:this.reactionData,rng:this.rng});
          if(reaction){Object.assign(victim,copy(reaction.after));if(reaction.skill){reaction.token=`${actionId}:reaction:${++reactionCount}`;victim.native_sequence_token=reaction.token;reaction.plan=directSequence(reaction.skill);reaction.plan.allow_no_contacts=true;}}
        }
      }
      const presented={...copy(result),remainingHp:victim?.hp.current??0,death:lethal,killer_frame_factor:lethal?2:1,status:status?{applied:status.applied,reason:status.reason,trace:status.trace}:null,
        reaction_descriptor:reaction?.skill?copy(reaction):null,interrupt_actor_id:lethal||reaction?.skill?victim?.id:null};
      const contact={key:step.contact_key,source:copy(step),result:presented,before,after:copy({attacker:striker,target:victim??null})};seen.set(step.contact_key,presented);entry.contacts.push(contact);entry.result=copy(result);entry.impact=true;entry.presentation=copy(step);entry.after=copy({attacker:striker,target:victim??null});
      this.log({type:'battle-impact',battle_id:this.state.id,action_id:actionId,contact_key:step.contact_key,actor_id:striker.id,target_id:victim?.id??null,skill_id:source.id,source_skill_index:step.source_skill_index,
        effect_token:step.effect_contact?step.effect_token:0,
        hit:result.hit,damage:result.damage,skipped:result.skipped??null,hp_before:before.target?.hp.current??null,hp_after:victim?.hp.current??null,mp_before:before.attacker.mp.current,mp_after:striker.mp.current,trace:copy(result.trace??[]),status:copy(presented.status),reaction:reaction?{kind:reaction.kind,source_skill_index:reaction.source_skill_index,target_id:reaction.target_id,trace:copy(reaction.trace)}:null,presentation:copy(step)});this.publish();return presented;
    };
    await this.playSequence({actor_id:attacker.id,target_id:target.id,skill_id:selected.id,action_id:actionId,plan:copy(plan)},{onContact,onRecord,
      onReactionContact:onContact,onReactionRecord:onRecord,onReactionEnd:(descriptor,completed)=>{if(completed)end(this.actor(descriptor.actor_id),descriptor.token);},onPrimaryEnd:()=>end(attacker,primaryToken)});this.checkWorld();
    requireValue(entry.contacts.length>0,'完整技能结束却没有接触结算');
    for(const actor of this.state.actors)if(actor.hp.current===0&&actor.state_raw===4&&this.canFinalizeDeath(actor))this.finalizeDeath(actor);
    if(this.state.reward_ledger)resetNativeChain(this.state.reward_ledger,attacker.id);
  }
  finalizeDeath(actor){
    if(actor.state_raw!==4||!this.canFinalizeDeath(actor))return;const death=this.reactionData?finalizeNativeDeath({actor,data:this.reactionData,rng:this.rng}):null;
    if(death)Object.assign(actor,copy(death.after));else actor.state_raw=5;
    if(this.statusData)Object.assign(actor,clearNativeStatuses(actor,this.statusData));
    if(this.lifecycleEnabled&&actor.charge)Object.assign(actor.charge,{gauge:0,delay:0,recovery:0,recovery_ticks:0});
    if(this.state.scheduler?.pending?.actor_id===actor.id)this.state.scheduler.pending=null;
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
        this.state.history.push(entry);
        this.log({type:'battle-action',battle_id:this.state.id,...copy(entry)}); this.publish();
        const onImpact=(presentation)=>{
          if(impacted || this.state.phase==='closed')return false;
          this.checkWorld();
          const applied=this.applyDamage(copy(target),copy(result),this.nativeContext()); actorShape(applied);
          requireValue(applied.id===target.id && applied.side===target.side && applied.mp.current===target.mp.current && applied.mp.maximum===target.mp.maximum && applied.hp.maximum===target.hp.maximum, 'HP提交改变了非目标资源');
          requireValue(applied.hp.current<=target.hp.current, '本样本伤害提交不能增加HP');
          Object.assign(target,applied); impacted=true; entry.impact=true;
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
  prepareRewards(){
    if(this.rewardPlan)return this.rewardPlan;this.checkWorld();requireValue(this.state.phase==='victory','尚未胜利，不能规划奖励');
    const candidate=this.world.snapshot();
    if(this.state.inventory)candidate.inventory=copy(this.state.inventory);
    for(const player of this.players()){const resources=this.resourcesForWorld(copy(player)),role=candidate.party.find(a=>a.id===player.id);role.hp.current=resources.hp;role.mp.current=resources.mp;}
    this.rewardPlan=planVictoryRewards({world:candidate,ledger:this.state.reward_ledger,data:this.rewardData,rng:this.rng,actors:this.state.actors,skill_data:this.skillGrowthData,skill_practice:this.skillPractice});
    this.state.rewards=copy(this.rewardPlan.summary);this.log({type:'battle-rewards-planned',battle_id:this.state.id,summary:copy(this.rewardPlan.summary),trace:copy(this.rewardPlan.trace)});return this.rewardPlan;
  }
  finish() {
    if(this.completed)return copy(this.completed);
    requireValue(this.state && !this.running && !this.state.scheduler?.pending && !this.hasLifecycle() && !this.state.pending_outcome && ['charging','command','victory','defeat','escaped','interrupted'].includes(this.state.phase), '战斗行动仍在执行');
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
