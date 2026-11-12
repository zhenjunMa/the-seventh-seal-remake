// One owner advances source records, contacts, reactions and lifecycle events.
// Rendering reads this state; no Canvas, Phaser object or timer is created here.
import {compileNativeSequence} from './skill_sequence.mjs';
import {nativeEntryPath,advanceNativeEntryPath,nativeEntryOffset} from './battle_entry.mjs';
import {battleActorPositions} from './battle_layout.mjs';
import {beginNativeCameraShake,advanceNativeCameraShake,beginNativeColorFade,advanceNativeColorFade,beginNativeCameraPan,advanceNativeCameraPan} from './battle_camera.mjs';
import {BattleLifecyclePlayback} from './battle_lifecycle.mjs';
const clone = structuredClone;
const abortError = reason => Object.assign(new Error(reason || '战斗表现已取消'), {name:'AbortError'});

export class BattlePlayback {
  constructor(ports) {
    this.ports=ports;
    this.run=null;this.detachedRuns=[];this.lifecycle=null;
    this.nativeControl=null;this.nativeControlIsCurrent=null;
    this.lastActorPoses=new Map();this.preparingEntry=false;
    this.entryFrameSounds=[];this.entryFrameControls=[];
    this.cameraShake=null;this.cameraPan=null;this.colorFade=null;
    this.sourceVisitTime=null;this.sourceVisits=new Set();
    this.currentRun=null;this.time=null;
  }
  configure(definition) { Object.assign(this,definition); }
  configureLifecycle(manifest,geometry) {
    this.lifecycle=manifest?new BattleLifecyclePlayback(manifest,{
      ...geometry,
      onControl:step=>{if(this.preparingEntry)this.entryFrameControls.push(step);
        else this.ports.sourceControl(step,step.actor_id,undefined,step.at);},
      nativeBridge:actorId=>this._nativeBridge(actorId),
      onFrame:step=>{if(this.preparingEntry)this.entryFrameSounds.push({...step,sound_inhibited:Boolean(this.nativeControl?.actor(step.actor_id)?.immune_raw)});
        else this.ports.lifecycleFrame(step);},
    }):null;
  }
  advance(snapshot,now) {
    if(!Number.isFinite(now))throw new Error('战斗表现时钟无效');
    this.time=now;
    for(const step of this.entryFrameControls.splice(0))this.ports.sourceControl(step,step.actor_id,undefined,now);
    for(const step of this.entryFrameSounds.splice(0))this.ports.lifecycleFrame(step);
    if(snapshot?.lifecycle_events)for(const active of this._sequenceRuns()){
      active.external_interrupts??=new Set();
      for(const event of snapshot.lifecycle_events){
        if(!['response','death','revive'].includes(event.kind)||active.external_interrupts.has(event.token))continue;
        active.external_interrupts.add(event.token);this._interruptActor(event.actor_id,now);
      }
    }
    this.currentRun=this.ports.isReady()?this._advance(now):null;
    if(this.ports.isReady()&&snapshot?.actors){
      const current=this.nativeControl&&(!this.nativeControlIsCurrent||this.nativeControlIsCurrent())?this.nativeControl.state:null;
      this.lifecycle?.advance(current?.lifecycle_events?{...snapshot,actors:current.actors,lifecycle_events:current.lifecycle_events}:snapshot,this.roster,now);
    }
    if(this.cameraShake)this.cameraShake=advanceNativeCameraShake(this.cameraShake,now);
    if(this.cameraPan)this.cameraPan=advanceNativeCameraPan(this.cameraPan,now);
    if(this.colorFade)this.colorFade=advanceNativeColorFade(this.colorFade,now);
    return this.currentRun;
  }
  _releaseRun(run) {
    if(run&&!run.playback_ended){run.playback_ended=true;run.onPlaybackEnd?.();}
    this.ports.releaseResources(run);
  }
  _queueDamageText(...args) { this.ports.feedback(...args); }
  _role(id) { return this.meta.roles.find(role=>role.id===(this.roster.find(actor=>actor.id===id)?.resource_id??id)); }
  _damaging(result) { return result.hit!==false&&result.hit!=='miss'&&result.hit!=='MISS'&&Number(result.damage)>0; }
  _nativeBridge(actorId,control=this.nativeControl,guard=this.nativeControlIsCurrent){
    const check=()=>{if(!control||this.nativeControl!==control||guard&&!guard())throw abortError('原动作控制器已失效');};
    return {begin:(raw,at)=>{check();return control.beginNativeVertical(actorId,raw,at);},
      target:(targetId,raw,at)=>{check();return control.beginNativeTargetVertical(actorId,targetId,raw,at);},
      appearance:raw=>{check();return control.beginNativeAppearance(actorId,raw);},
      appearanceComplete:()=>{check();control.completeNativeAppearance(actorId);},
      entry:(raw,width)=>{check();return control.beginNativeEntry(actorId,raw,width);},
      entryPoint:x=>{check();control.advanceNativeEntry(actorId,x);},
      state:()=>{check();return control.nativeVerticalFor(actorId);},
      record:raw=>{check();control.nativeSourceRecord(actorId,raw);},
      spriteEnd:pose=>{check();if(!control.finishNativeSpriteRecord(actorId))return false;
        this.lastActorPoses.set(actorId,{action_index:pose.action_index,action_frame:pose.action_frame});return true;},
      advance:at=>{check();if(!this.preparingEntry){
        if(this.sourceVisitTime!==at){this.sourceVisitTime=at;this.sourceVisits=new Set();}
        if(this.sourceVisits.has(actorId))return false;this.sourceVisits.add(actorId);}
        control.advanceNativeVerticals(at,actorId);return true;}};
  }

  _nativeSourceControl(step,actorId,targetId,at,control=this.nativeControl){
    if(step.command_raw===1)this.cameraShake=beginNativeCameraShake(step.control,at,this.cameraShake);
    if(step.command_raw===2||step.command_raw===6){
      const id=step.control.mode_raw?(targetId===undefined?control?.actor(actorId)?.current_target_id:targetId):actorId,
        actor=control?.actor(id)??this.roster.find(actor=>actor.id===id);
      if(actor){const point=battleActorPositions(this.roster)[id],x=actor.native_x_raw??point[0]-320;
        this.cameraPan=beginNativeCameraPan(x+(actor.side==='player'?128:-128),at,this.cameraPan,
          {immediate:step.command_raw===6,limit:this.stageMeta?.default_composition.camera_limit_x??410});}
    }
    if(step.command_raw===11)this.cameraPan=beginNativeCameraPan(0,at,this.cameraPan,
      {limit:this.stageMeta?.default_composition.camera_limit_x??410});
    if(step.command_raw===0)this.colorFade=beginNativeColorFade(step.control,at,this.colorFade);
    //511C30 starts the shared return-to-normal fade at source command11.
    if(step.command_raw===11&&this.colorFade){this.colorFade=advanceNativeColorFade(this.colorFade,at);
      if(this.colorFade.value){this.colorFade.active=true;if(this.colorFade.step>=0)this.colorFade.step=-8;}}
  }

  playSequence(result,{onContact,onRecord,onReactionContact,onReactionRecord,onReactionEnd,onPrimaryEnd,onAttackEnd,onPlaybackEnd,onFrame,onEffectFrame,onCarrierStart,onCarrierEnd,onCarrierTargets,onDetachedError}={}){
    if(!this.ports.isReady()||this.run)return Promise.reject(new Error('完整技能表现尚未就绪或上一行动未结束'));
    const actor=this.roster.find(a=>a.id===result.actor_id),target=this.roster.find(a=>a.id===result.target_id);
    if(!this.meta.policy.complete_contacts||!actor||!target||typeof onContact!=='function'||typeof onRecord!=='function')return Promise.reject(new Error('完整技能序列或接触回调缺失'));
    let compiled;try{compiled=this.compiledSequences.get(result)??compileNativeSequence(this.meta,actor.resource_id,result.plan,[this.layers,...this.alternateLayers.values()]);}catch(e){return Promise.reject(e);}
    return new Promise((resolve,reject)=>{this.run={sequence:true,native_control:this.nativeControl,native_guard:this.nativeControlIsCurrent,result:clone(result),steps:compiled.steps,segments:compiled.segments,attack_end_step_index:compiled.attack_end_step_index,resolve,reject,onContact,onRecord,onReactionContact,onReactionRecord,onReactionEnd,onPrimaryEnd,onAttackEnd,onPlaybackEnd,onFrame,onEffectFrame,onCarrierStart,onCarrierEnd,onCarrierTargets,onDetachedError,children:[],carriers:[],independent_carriers:compiled.independent_carriers,main_done:false,death_until:0,
      started:null,elapsed:0,cursor:0,visited:-1,next_at:0,record_visited:-1,impact_called:false,impact_done:false,impact_elapsed:null,effects:[],generation:this.generation,
      observations:{draws:0,origin_slot:null,last_slot:null,contact_slot:null,bounds:null,intrinsic_source_frames:[],effect_ids:[],contacts:[],authority:'Actual remake Canvas draws with all source contacts; preview animation clock'}};});
  }


  _fail(run, error) {
    if(this.run===run)this.run=null;
    this.detachedRuns=this.detachedRuns.filter(old=>old!==run);
    if(run.primary_resolved)run.onDetachedError?.(error);else run.reject(error);
    this._releaseRun(run);
  }

  _advance(now) {
    this.sourceVisitTime=now;this.sourceVisits=new Set();
    if(this.detachedRuns.length||this.run?.sequence||this.nativeControl&&(!this.nativeControlIsCurrent||this.nativeControlIsCurrent())&&Number.isFinite(this.nativeControl.nextNativeVerticalAt()))return this._advanceSequenceRuns(now);
    const run = this.run;
    if (!run) return null;
    if (run.started === null) run.started = now;
    run.elapsed = Math.max(run.elapsed, now - run.started);
    const ms = this.meta.policy.frame_ms;
    run.cursor = Math.min(run.steps.length - 1, Math.floor(run.elapsed / ms));
    for (let index = run.visited + 1; index <= run.cursor; index++) {
      const step = run.steps[index];
      for (const effect of step.effects) {
        if (effect.slot === 'target' && !this._damaging(run.result)) continue;
        run.effects.push({...clone(effect), at: index * ms});
      }
      if (step.event && !run.impact_called) {
        run.impact_called = true;
        run.impact_elapsed = index * ms;
        const detail = {actor_id: run.result.actor_id, target_id: run.result.target_id,
          skill_id: run.result.skill_id, source_frame: step.source_frame,
          action_index: step.action_index, logical_frame: step.logical_frame,
          chr_record_index: step.chr_record_index, event: clone(step.event), source: clone(step.source),
          basis: 'original CHR +0x49 logical event position; presentation preview clock'};
        try {
          const pending = run.onImpact(detail);
          if (pending && typeof pending.then === 'function') {
            Promise.resolve(pending).then(() => {if (this.run === run){run.impact_done = true;this._queueDamageText(run,run.result,this.time??now);}}, error => this._fail(run, error));
          } else {run.impact_done = true;this._queueDamageText(run,run.result,now);}
        } catch (error) {this._fail(run, error); return null;}
      }
    }
    run.visited = run.cursor;
    if (this.run !== run) return null;
    if (run.elapsed >= run.steps.length * ms + this.meta.policy.tail_ms && run.impact_done) {
      this.run = null;this._releaseRun(run);
      run.resolve({completed: true, impact_committed: true, actor_id: run.result.actor_id,
        source_frame: run.steps.find(step => step.event).source_frame,observations:clone(run.observations)});
      return null;
    }
    return run;
  }

  _sequenceChannels(run){return [...run.carriers,run,...run.children];}

  _sequenceRuns(){return [...this.detachedRuns,this.run].filter(run=>run?.sequence);}

  _markAttackEnd(run,at){
    if(run.attack_ended)return;
    run.attack_ended=true;run.onAttackEnd?.(run.started+at);
  }

  _releaseAction(run,at){
    if(run.primary_resolved)return;
    run.primary_resolved=true;if(this.run===run)this.run=null;
    if(!this.detachedRuns.includes(run))this.detachedRuns.push(run);
    this._markAttackEnd(run,at);
    run.resolve({completed:true,interrupted:Boolean(run.interrupted),playback_pending:true,carriers_pending:run.carriers.some(c=>!c.done),
      impact_committed:run.observations.contacts.length>0,contact_count:run.observations.contacts.length,observations:clone(run.observations)});
  }

  _interruptActor(actorId,now){
    for(const owner of this._sequenceRuns()){
      if(!owner.main_done&&owner.result.actor_id===actorId){
        owner.main_done=true;owner.interrupted=true;owner.onPrimaryEnd?.(now,false);
        this._releaseAction(owner,Math.max(0,now-owner.started));
      }
      for(const child of owner.children)if(!child.done&&child.result.actor_id===actorId){child.done=true;owner.onReactionEnd?.(clone(child.descriptor),false,now);}
    }
  }

  _advanceSequenceRuns(now){
    const roots=()=>this._sequenceRuns();
    for(const root of roots()){root.started??=now;root.elapsed=Math.max(root.elapsed,now-root.started);}
    const control=this.nativeControl,valid=control&&(!this.nativeControlIsCurrent||this.nativeControlIsCurrent());
    const visited=this.sourceVisits??=new Set(),owned=new Set([...roots().flatMap(root=>this._sequenceChannels(root).filter(c=>!c.carrier&&!c.done&&!(c===root&&root.main_done)).map(c=>c.result.actor_id)),...this.lifecycle?.channels.keys()??[]]);
    if(valid)for(const [id,clock]of control.verticalClocks)if(!owned.has(id)&&now-clock.at>=20){control.advanceNativeVerticals(now,id);visited.add(id);}
    // Merge every detached carrier with the current action before callbacks.
    // A later command cannot consume RNG ahead of an earlier carrier contact
    // merely because RAF delivered both in one render frame.
    for(let visits=0;visits<30000;visits++){
      if(visits===29999)throw new Error('战斗动作时钟访问超出范围');
      let root=null,at=Infinity,carrierFirst=false;
      for(const candidate of roots())for(const channel of this._sequenceChannels(candidate)){
        if(channel.done||channel===candidate&&candidate.main_done||visited.has(channel.carrier?channel:channel.result.actor_id))continue;
        const due=candidate.started+channel.next_at;
        if(due<at||due===at&&channel.carrier&&!carrierFirst){root=candidate;at=due;carrierFirst=Boolean(channel.carrier);}
      }
      if(!root||at>now)break;
      this._advanceSequence(now,root,1,visited);
    }
    for(const root of roots())this._advanceSequence(now,root,0,visited);
    return this.run??this.detachedRuns[0]??null;
  }

  _advanceSequence(now,run=this.run,limit=20000,visited=new Set()){if(run.started===null)run.started=now;run.elapsed=Math.max(run.elapsed,now-run.started);
    const ms=run.frame_ms??this.meta.policy.frame_ms;
    try{
      if(run.native_control&&(this.nativeControl!==run.native_control||run.native_guard&&!run.native_guard()))throw abortError('原行动控制器已失效');
      // Merge parent/reaction frame visits by preview time; a slow RAF preserves
      // contact ordering and cannot collapse an entire counter into one callback.
      let iterations=0;
      while(true){
        if(iterations++>=limit)break;
        const channels=this._sequenceChannels(run);let selected=null,at=Infinity,ending=false;
        // Native 51A240 hands the final source record straight to 51CC00.
        // The old preview tail must not hold a completed actor's last pose.
        for(const channel of channels){if(channel.done||(channel===run&&run.main_done)||visited.has(channel.carrier?channel:channel.result.actor_id))continue;const end=channel.visited+1>=channel.steps.length,due=channel.next_at;if(due<at){selected=channel;at=due;ending=end;}}
        // Use the same absolute deadline as the merged scheduler. Subtracting
        // fractional RAF timestamps can round elapsed just below a due frame.
        if(!selected||run.started+at>now)break;
        // Native 51BB90 stores now when a source frame is due. Resetting at
        // its old deadline would catch up skipped frames and shorten recovery.
        at=now-run.started;const channel=selected,child=Boolean(channel.descriptor),carrier=Boolean(channel.carrier);
        visited.add(carrier?channel:channel.result.actor_id);
        if(!carrier&&run.native_control){
          run.native_control.advanceNativeVerticals(now,channel.result.actor_id);
          const bridge=this._nativeBridge(channel.result.actor_id,run.native_control,run.native_guard);
          if(bridge.state().waiting){channel.next_at=at+20;continue;}channel.vertical_wait=false;
        }
        if(ending){if(carrier)channel.done=true;else if(child){channel.done=true;run.onReactionEnd?.(clone(channel.descriptor),true,run.started+at);}else{run.main_done=true;run.onPrimaryEnd?.(run.started+at);if(Number.isInteger(run.attack_end_step_index))this._releaseAction(run,at);}continue;}
        const i=channel.visited+1,step=channel.steps[i];
        if(channel===run&&Number.isInteger(run.attack_end_step_index)&&i>=run.attack_end_step_index)this._markAttackEnd(run,at);
        if(!carrier)run.onFrame?.({...clone(step),actor_id:channel.result.actor_id,target_id:channel.result.target_id,channel_id:child?channel.channel_id:'main'});
        channel.cursor=i;
        if(!carrier&&(step.plan_record_index!==channel.record_visited||step.visibility_end)){
          if(child)run.onReactionRecord?.({...clone(step),presentation_time_ms:run.started+at},clone(channel.descriptor));else run.onRecord({...clone(step),presentation_time_ms:run.started+at});
          channel.carrier_targets=step.command_raw===4?run.onCarrierTargets?.(clone(step),channel.descriptor?clone(channel.descriptor):null):null;
          channel.record_visited=step.plan_record_index;
          this._nativeSourceControl(step,channel.result.actor_id,channel.result.target_id,run.started+at,run.native_control);
        }
        if(!carrier&&step.command_raw===4&&channel.carrier_targets?.target_ids.length===0){channel.visited=i;channel.next_at=at;continue;}
        let entryVisited=i;
        if(step.entry_raw_hex){
          const bridge=this._nativeBridge(channel.result.actor_id,run.native_control,run.native_guard);
          channel.entry=nativeEntryPath(bridge.entry(step.entry_raw_hex,step.entry_width),at-(channel.at??0));
        }
        if(channel.entry&&step.command_raw===undefined&&channel.segments[step.segment_index].movement_step_raw>0){
          const complete=advanceNativeEntryPath(channel.entry,channel.segments[step.segment_index].movement_step_raw,at-(channel.at??0),step.duration_ms??ms);
          this._nativeBridge(channel.result.actor_id,run.native_control,run.native_guard).entryPoint(channel.entry.origin+channel.entry.to);
          if(complete)entryVisited=channel.steps.findLastIndex(row=>row.plan_record_index===step.plan_record_index);
          else if(channel.steps[i+1]?.plan_record_index!==step.plan_record_index)entryVisited=channel.steps.findIndex(row=>row.plan_record_index===step.plan_record_index)-1;
        }
        if(step.vertical_raw_hex){
          const bridge=this._nativeBridge(channel.result.actor_id,run.native_control,run.native_guard),state=bridge.begin(step.vertical_raw_hex,run.started+at);
          channel.vertical_wait=state.waiting;
        }
        if(step.target_vertical_raw_hex){
          // case10's wait byte belongs to the target, so the acting source
          // advances while the target's existing response waits on its Z.
          const bridge=this._nativeBridge(channel.result.actor_id,run.native_control,run.native_guard);
          const state=bridge.target(channel.result.target_id,step.target_vertical_raw_hex,run.started+at);
          if(state)for(const target of this._sequenceChannels(run))if(!target.carrier&&target.result.actor_id===channel.result.target_id)
            target.vertical_wait=state.waiting;
        }
        if(step.carrier_spawn){
          const source=step.carrier_spawn,id=`carrier-${run.carriers.length}`,firstAt=Math.max(at,source.interval_ms-run.started);
          const carrier={carrier:true,channel_id:id,descriptor:channel.descriptor??null,result:clone(channel.result),steps:clone(source.steps),segments:[],carrier_targets:clone(channel.carrier_targets??null),
            at,next_at:firstAt,elapsed:0,cursor:0,visited:-1,record_visited:-1,effects:[],done:false};
          for(const target_id of carrier.carrier_targets?.group?carrier.carrier_targets.target_ids:[null])carrier.effects.push({asset_id:source.asset_id,slot:target_id?'target':source.slot,...(target_id?{target_id}:{}),unconditional:true,full_screen_effect:step.full_screen_effect,frame_count:source.frames.length,
            source_frames:clone(source.frames),logical_start:source.start,frame_ms:source.interval_ms,at:firstAt-at-source.interval_ms,visited_frame:0});
          run.carriers.push(carrier);run.onCarrierStart?.({carrier_id:id,source:clone(step),actor_id:channel.result.actor_id});
        }
        if(step.carrier_end){channel.done=true;run.onCarrierEnd?.({carrier_id:channel.channel_id,source:clone(step),actor_id:channel.result.actor_id},run.started+at);}
        if(step.visibility)channel.visibility={...clone(step.visibility),started:step.visibility_end?channel.visibility?.started??at:at,complete:Boolean(step.visibility_end)};
        if(step.event){
          const detail={...clone(step),...(channel.carrier_targets?.group?{carrier_target_ids:clone(channel.carrier_targets.target_ids)}:{}),presentation_time_ms:run.started+at,contact_key:`${carrier||child?channel.channel_id:'main'}:${step.plan_record_index}:${step.logical_frame}`,actor_id:channel.result.actor_id,target_id:channel.result.target_id,skill_id:channel.result.skill_id,
            basis:'Original logical CHR contact position; original composition and DGP frame table, preview animation clock'};
          const response=child?run.onReactionContact?.(detail,clone(channel.descriptor)):run.onContact(detail);if(!response||typeof response.then==='function')throw new Error('完整接触结算必须同步返回原结算结果');
          channel.result={...channel.result,skipped:null,group_results:null,...clone(response)};channel.impact_called=true;channel.impact_done=true;channel.impact_elapsed=at-(channel.at??0);
          for(const hit of response.group_results??[response])this._queueDamageText({...channel,result:{...channel.result,target_id:hit.target_id??channel.result.target_id}},hit,now);
          if((response.item_effect??response.item_used)&&run.item_effect_id){const asset=this.meta.effects.find(e=>e.id===run.item_effect_id);if(!asset)throw new Error('药品恢复特效缺失');
            for(const hit of response.group_results??[response])if(hit.item_effect??hit.item_used)channel.effects.push({asset_id:asset.id,slot:'target',...(hit.target_id?{target_id:hit.target_id}:{}),unconditional:true,at:at-(channel.at??0),frame_ms:asset.interval_raw,visited_frame:-1});}
          // Native killer F5F9 doubles the current record interval; entering
          // the next source record clears it. Base65ms remains a preview policy.
          if(response.killer_frame_factor===2&&!step.effect_contact)channel.slow_record=step.plan_record_index;
          if(response.death)run.death_until=Math.max(run.death_until,at+520);
          for(const hit of response.group_results??[response])run.observations.contacts.push({...detail,target_id:hit.target_id??detail.target_id,hit:hit.hit,damage:hit.damage,remainingHp:hit.remainingHp,skipped:hit.skipped??null});
          if(response.interrupt_actor_id)this._interruptActor(response.interrupt_actor_id,run.started+at);
          for(const hit of response.group_results??[response])if(hit.reaction_descriptor){
            const descriptor=clone(hit.reaction_descriptor),role=this._role(descriptor.actor_id),plan=clone(descriptor.plan);plan.allow_no_contacts=true;plan.handler='native-response';
            plan.initial_pose=clone(this.lastActorPoses.get(descriptor.actor_id)??null);
            const compiled=compileNativeSequence(this.meta,role.id,plan,[this.layers,...this.alternateLayers.values()]);
            for(const old of run.children)if(!old.done&&old.result.actor_id===descriptor.actor_id){old.done=true;run.onReactionEnd?.(clone(old.descriptor),false);}
            run.children.push({sequence:true,result:{actor_id:descriptor.actor_id,target_id:descriptor.target_id,skill_id:descriptor.skill.id,plan},descriptor,steps:compiled.steps,segments:compiled.segments,
              channel_id:`reaction-${run.children.length}`,at,next_at:at,elapsed:0,cursor:0,visited:-1,record_visited:-1,impact_called:false,impact_done:false,impact_elapsed:null,effects:[],done:false});
          }
        }
        for(const effect of step.effects){
          const allocation=effect.unconditional&&step.command_raw===4&&channel.carrier_targets?.group;
          const hits=effect.unconditional&&step.command_raw===4?
            allocation?channel.carrier_targets.target_ids.map(target_id=>({target_id})):[channel.result]:
            effect.slot==='target'&&channel.result.group_results?channel.result.group_results:[channel.result];
          for(const hit of hits){if(effect.slot==='target'&&!effect.unconditional&&(!(hit.target_id??channel.result.target_id)||!this._damaging(hit)))continue;
            channel.effects.push({...clone(effect),...(effect.unconditional&&step.command_raw===4?{logical_start:step.logical_frame,visited_frame:0}:{}),...(allocation?{slot:'target'}:{}),...(allocation||effect.slot==='target'?{target_id:hit.target_id??channel.result.target_id}:{}),...(step.duration_ms>0?{frame_ms:step.duration_ms}:{}),at:at-(channel.at??0)});}
        }
        const interval=(step.duration_ms??ms)*(channel.slow_record===step.plan_record_index?2:1);
        channel.frame_started_at=at-(channel.at??0);channel.frame_duration_ms=interval;
        channel.visited=entryVisited;channel.next_at=at+interval;
        // 510900 starts id4's hold on the last sprite. 5130D0 also calls
        // 51A240 immediately for terminal controls, including height waits.
        const heldSprite=!carrier&&step.command_raw===undefined&&entryVisited+1>=channel.steps.length&&run.native_control&&
          this._nativeBridge(channel.result.actor_id,run.native_control,run.native_guard).spriteEnd(step);
        if(heldSprite||step.command_raw!==undefined&&interval===0&&entryVisited+1>=channel.steps.length){
          if(child){channel.done=true;run.onReactionEnd?.(clone(channel.descriptor),true,now);}
          else if(!carrier){run.main_done=true;run.onPrimaryEnd?.(now);if(Number.isInteger(run.attack_end_step_index))this._releaseAction(run,at);}
        }
      }
      for(const c of [...run.children,...run.carriers])c.elapsed=Math.max(0,run.elapsed-c.at);
      for(const channel of this._sequenceChannels(run))for(const [index,effect]of channel.effects.entries()){const asset=this.meta.effects.find(e=>e.id===effect.asset_id),cursor=Math.min((effect.frame_count??asset.frames.length)-1,Math.floor((channel.elapsed-effect.at)/(effect.frame_ms??ms)));
        for(let frame=(effect.visited_frame??-1)+1;frame<=cursor;frame++)run.onEffectFrame?.({asset_id:asset.id,logical_frame:(effect.logical_start??0)+frame,
          actor_id:channel.result.actor_id,target_id:effect.target_id??channel.result.target_id,channel_id:channel.channel_id??'main',effect_index:index});effect.visited_frame=Math.max(effect.visited_frame??-1,cursor);}
      const visualEnd=Math.max(0,...this._sequenceChannels(run).flatMap(c=>c.effects.filter(e=>e.unconditional).map(e=>(c.at??0)+e.at+(e.frame_count??this.meta.effects.find(a=>a.id===e.asset_id).frames.length)*(e.frame_ms??ms))));
      const foregroundDone=run.main_done&&run.children.every(c=>c.done);
      if(foregroundDone&&run.independent_carriers&&!run.primary_resolved)this._releaseAction(run,run.elapsed);
      if(foregroundDone&&run.carriers.every(c=>c.done)&&run.elapsed>=Math.max(run.death_until,visualEnd)){
        if(this.run===run)this.run=null;this.detachedRuns=this.detachedRuns.filter(old=>old!==run);this._releaseRun(run);
        if(!run.primary_resolved)run.resolve({completed:true,interrupted:Boolean(run.interrupted),impact_committed:run.observations.contacts.length>0,contact_count:run.observations.contacts.length,observations:clone(run.observations)});return null;
      }
      return run;
    }catch(error){this._fail(run,error);return null;}
  }

}
