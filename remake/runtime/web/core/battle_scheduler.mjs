// Fresh native mode0 scalar scheduler. Animation/command adapters
// remain explicit policies; this module does not claim the full native AI.
import {clearCommandDefense} from './battle_commands.mjs';
const clone=structuredClone;
const fail=(ok,message)=>{if(!ok)throw new Error(message);};
const raw=(actor,address)=>{const n=actor.raw_by_address?.[address];fail(Number.isInteger(n),'充能原属性缺失');return n|0;};
const status=(actor,address)=>{const n=actor.status_by_address?.[address];fail(Number.isInteger(n),'充能原状态缺失');return n|0;};
export function validateScheduler(data){
  fail(data?.schema==='seventh-seal-battle-scheduler'&&data.version===1&&data.mode_raw===0,'行动调度版本不兼容');
  const debug=data.configuration?.mode==='debug';
  fail(data.tick_interval_ms===20&&data.initial_gauge===0&&data.initial_delay===0,'行动调度与原规则不符');
  fail(debug?Number.isInteger(data.average_speed_factor)&&data.average_speed_factor>=1&&data.average_speed_factor<=10000:data.average_speed_factor===200,'充能阈值系数无效');
  fail(data.default_preparation_delay===undefined||(Number.isInteger(data.default_preparation_delay)&&data.default_preparation_delay>=1&&data.default_preparation_delay<=1000000&&(debug||data.default_preparation_delay===800)),'默认技能准备量无效');
  fail(data.initial_side_priority===0&&data.policy&&Object.values(data.evidence??{}).length===7&&Object.values(data.evidence).every(s=>/^ev_[a-f0-9]{64}$/.test(s)),'行动调度证据缺失');
  for(const id of ['001','011','012','013'])fail(/^([a-f0-9]{2}){1053}$/.test(data.idle_skills?.[id]?.fixed_raw_hex),'原待机属性缺失');
  return data;
}
export function initializeScheduler(actors,data,sidePriority=0,now=0){
  validateScheduler(data);fail(sidePriority===0||sidePriority===1,'行动阵营优先状态无效');
  // 0x50AC80 sums header current speed, before skill/status/equipment bonuses.
  const threshold=Math.imul(Math.trunc(actors.reduce((sum,a)=>(sum+raw(a,'0x0524a729'))|0,0)/actors.length),data.average_speed_factor);
  fail(threshold>0,'原充能阈值不可用');
  for(const actor of actors){
    fail(raw(actor,'0x0524a729')>0&&raw(actor,'0x0524a72d')>=raw(actor,'0x0524a729'),'当前充能属性范围未支持');
    actor.charge={gauge:0,delay:0,recovery:0,recovery_ticks:0};actor.status_flags_raw=0;actor.reaction_busy_raw=0;
    // 0x519A80 zeroes the allocated actor block: F68E starts at queue index0.
    // Idle preserves it; 0x51C640 explicitly clears it after a normal hit.
    actor.native_active=false;actor.current_target_id=actors[0].id;actor.reaction_special_gate_raw=0;actor.native_z_raw=0;
    setIdleSkill(actor,data,now);
  }
  return {mode:'native-forest',threshold,tick_interval_ms:20,ticks:0,elapsed_ms:0,side_priority:sidePriority,pending:null,active_actor_id:null,...(data.default_preparation_delay&&data.default_preparation_delay!==800?{default_preparation_delay:data.default_preparation_delay}:{})};
}
// The source idle skill can contain multiple records with different hit
// classes (50E980 copies the current record +24 to actor 524A633).
// Use one pose for rendering and settlement; never freeze the first record.
export function idlePoseAt(segments,elapsed){
  fail(Array.isArray(segments)&&segments.length>0&&Number.isFinite(elapsed),'待机动作时钟无效');
  const duration=segments.reduce((sum,s)=>sum+s.frames.length*s.interval_raw,0);
  fail(duration>0&&Number.isFinite(duration),'原待机动作时长无效');
  let at=Math.max(0,elapsed)%duration;
  for(const segment of segments){
    const length=segment.frames.length*segment.interval_raw;
    if(at<length){
      const raw=segment.raw_hex;
      fail(typeof raw==='string'&&/^(?:[a-f0-9]{2}){176}$/i.test(raw),'原待机动作记录缺失');
      return {chr_record_index:segment.chr_record_index,action_index:segment.action_index,
        action_frame:segment.frames[Math.floor(at/segment.interval_raw)],
        class_raw:parseInt(raw.slice(0x24*2,0x24*2+2),16),action_mask_raw:parseInt(raw.slice(0x78*2,0x78*2+2),16)};
    }
    at-=length;
  }
}
export function advanceIdleSkill(actor,data,now){
  const idle=data.idle_skills[actor.resource_id??actor.id];
  if(!idle?.segments)return;
  if(actor.current_skill?.id!==idle.id||actor.hp.current===0||actor.state_raw>=4||actor.native_active||actor.immune_raw||actor.reaction_busy_raw||actor.defense_half_raw){delete actor.idle_pose;return;}
  actor.idle_pose=idlePoseAt(idle.segments,now-actor.idle_started_at);
  actor.class_raw=actor.idle_pose.class_raw;actor.action_mask_raw=actor.idle_pose.action_mask_raw;
}
export function setIdleSkill(actor,data,now=0){
  const idle=data.idle_skills[actor.resource_id??actor.id];fail(idle,'参战角色原待机属性缺失');
  actor.current_skill=clone(idle);actor.class_raw=idle.class_raw;actor.action_mask_raw=idle.action_mask_raw;
  actor.idle_started_at=now;delete actor.idle_pose;
  advanceIdleSkill(actor,data,now);
}
export function chargeActor(actor,rng){
  const c=actor.charge;fail(c,'行动槽未初始化');
  if(actor.hp.current===0||actor.immune_raw||actor.state_raw>7||actor.state_raw===7)return 0;
  const bytes=Uint8Array.from(actor.current_skill.fixed_raw_hex.match(/../g),x=>parseInt(x,16)),view=new DataView(bytes.buffer);
  const type=view.getInt8(0),min=(type===4||type===7)?view.getInt32(0xe3,true):raw(actor,'0x0524a729');
  const max=(type===4||type===7)?view.getInt32(0xe7,true):raw(actor,'0x0524a72d');
  let speed;
  if(!min||!max)speed=80;
  else {speed=min;if(min!==max){const n=rng();fail(Number.isInteger(n)&&n>=0&&n<=32767,'充能随机值无效');speed=(speed+n%(max-min))|0;}}
  speed=(speed+status(actor,'0x0521f56d'))|0;
  fail(speed>0,'当前样本未接非正充能速度');
  // Fresh forest slice has no cast-reaction override @521F692. Retain the
  // recovery arithmetic and exact strict debt comparison from 0x502F30.
  if(actor.state_raw>=4)return speed;
  c.recovery_ticks=(c.recovery_ticks>>>0)>0?(c.recovery_ticks-1)|0:0;
  if(c.recovery){if((c.recovery>>>0)>(speed>>1>>>0))c.recovery=(c.recovery-(speed>>1))|0;else{c.recovery=0;c.recovery_ticks=0;}}
  if(c.delay===0)c.gauge=(c.gauge+speed)|0;
  else if(c.delay<speed){c.gauge=(c.gauge+speed-c.delay)|0;c.delay=0;}
  else c.delay=(c.delay-speed)|0;
  return speed;
}
// Input readiness and automatic dispatch use the same native eligibility gate.
// A ready player can choose a command before it has a pending skill.
export function isActorReady(actor,scheduler){
  const c=actor?.charge,flags=actor?.status_flags_raw??0;
  return Boolean(c&&actor.hp.current>0&&actor.state_raw<4&&!actor.immune_raw&&!actor.reaction_inhibit_raw&&!c.recovery&&!c.delay&&!(flags&0x1e1)&&c.gauge>=scheduler.threshold);
}
export function selectReady(actors,scheduler,{enemy_passive=false}={}){
  const candidates=[];let selected=null,best=-999999;
  for(let i=0;i<actors.length;i++){
    const a=actors[i],c=a.charge;
    // Skill-test targets retain their clock but have no proactive command.
    // Keep the original actor positions for native candidate-side arbitration.
    if(enemy_passive&&a.side==='enemy')continue;
    // A full player gauge enables command entry. Automatic dispatch still
    // requires that player's own confirmed command, never another member's.
    if(!isActorReady(a,scheduler))continue;
    if(a.side==='player'){
      clearCommandDefense(a);
      if(!scheduler.pending||scheduler.pending.actor_id&&scheduler.pending.actor_id!==a.id)continue;
    }
    candidates.push(i);if(c.gauge>best){selected=i;best=c.gauge;}
  }
  const priorityBefore=scheduler.side_priority;
  if(candidates.length>1){
    best=-999999;
    candidates.forEach((index,position)=>{
      // Source 0x503A14/32 uses candidate POSITION for the side test, but
      // 0x503A4B uses candidate INDEX for its gauge. Preserve both accesses.
      const side=actors[position].side_raw;
      if((priorityBefore===0?side!==0:side===0)&&actors[index].charge.gauge>best){selected=index;best=actors[index].charge.gauge;}
    });
    scheduler.side_priority=priorityBefore===0?1:0;
  }
  return {actor_id:selected===null?null:actors[selected].id,candidates:candidates.map(i=>actors[i].id),priority_before:priorityBefore,priority_after:scheduler.side_priority};
}
export function dispatchCharge(actor,skill,scheduler){
  const skillList=Array.isArray(skill)?skill:[skill],rawDelays=skillList.map(s=>{const bytes=Uint8Array.from(s.fixed_raw_hex.match(/../g),x=>parseInt(x,16)),view=new DataView(bytes.buffer);return view.getInt32(0x2e,true);});
  fail(rawDelays.every(n=>n>=0),'负值技能准备量尚未接入');const rawDelay=rawDelays[0],effectiveDelay=rawDelays.reduce((sum,n)=>(sum+(n||scheduler.default_preparation_delay||800))|0,0);
  const before=clone(actor.charge);
  // 0x501CC0 resets gauge and adds skill debt (zero becomes800), THEN
  // 0x503F38/FB3 subtracts threshold. Overshoot is not retained for this path.
  actor.charge.gauge=(-scheduler.threshold)|0;actor.charge.delay=(actor.charge.delay+effectiveDelay)|0;
  scheduler.active_actor_id=actor.id;
  return {before,after:clone(actor.charge),skill_delay_raw:rawDelay,skill_delays_raw:rawDelays,effective_delay:effectiveDelay};
}
export function dispatchItemCharge(actor,scheduler){
  const before=clone(actor.charge);
  // 0x50E7A0 zeroes the item user's gauge; the item branch at 0x503F38
  // subtracts threshold without 0x501CC0's skill preparation debt.
  actor.charge.gauge=(-scheduler.threshold)|0;scheduler.active_actor_id=actor.id;
  return {before,after:clone(actor.charge),effective_delay:0,command_kind:'item'};
}
