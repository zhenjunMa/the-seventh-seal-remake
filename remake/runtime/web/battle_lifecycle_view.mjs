/** Independent per-actor entry / death / get-up playback.
 * Numeric effects, source selection and RNG belong to the combat controller.
 * 5130D0 cmd7 starts appearance; 51A4F0 waits while F666 is nonzero.
 * Source: ev_6a97d55ce2cda38f5a9cacf245900414d96566b052c7e04fb96bac9a431a6764,
 * ev_e7ebc40b1eb0efaa9d96ff7f3e6fc290955d8807dff0dc831ad32c06ceb45a70.
 */
import {DeathParticlePlayback} from './death_particles.mjs';
const need=(ok,message)=>{if(!ok)throw new TypeError(message);};
const copy=value=>structuredClone(value);
const integer=(value,min=0)=>Number.isInteger(value)&&value>=min;
// A7B1=60 is the appearance update CLOCK, not a proven 60-frame duration.
// 552642 -> 55259B mode1 returns0 once 240-(elapsed<<5)<20: elapsed>=7.
// Mode5 initializes current=minX-y,target255 and adds8 each actual render;
// initialization repeats while source elapsed==0. Completion has no fixed
// elapsed threshold. Pixel geometry is supplied by the owning source renderer.
export const APPEARANCE_ALPHA_ADAPTER=Object.freeze({
  source_clock_ms:60,complete_elapsed_raw:Object.freeze({1:7,3:null,5:null,6:null,7:39}),
  particle_step_raw:8,particle_target_raw:255,
  pixels:'8-bit alpha adapter; original scanline mask not reproduced',
});
// F66A is a disappearance MODE selected by rand()%7+1, despite the legacy
// event field name fade_increment_raw. It is never an opacity speed.
export class BattleLifecyclePlayback {
  constructor(manifest,{appearanceBounds=null,appearanceEffect=null,disappearanceEffect=null,nativeBridge=null,onFrame=null}={}){
    this.onFrame=onFrame;
    this.nativeBridge=nativeBridge;
    this.disappearanceEffect=disappearanceEffect;
    this.appearanceEffect=appearanceEffect;
    need(appearanceBounds===null||typeof appearanceBounds==='function','Lifecycle appearance bounds provider invalid');this.appearanceBounds=appearanceBounds;
    need(Array.isArray(manifest?.roles),'Lifecycle manifest roles missing');this.roles=new Map();
    for(const role of manifest.roles){
      need(typeof role.id==='string'&&!this.roles.has(role.id)&&Array.isArray(role.skills),'Lifecycle role invalid');
      const skills=new Map();for(const skill of role.skills){
        need(integer(skill.chr_skill_index)&&!skills.has(skill.chr_skill_index)&&Array.isArray(skill.timeline),'Lifecycle source skill invalid');
        const timeline=skill.timeline.map(step=>{
          if(step.kind==='sprite')need(['action_index','action_frame','source_frame'].every(key=>integer(step[key]))&&integer(step.interval_raw,1),'Lifecycle source frame invalid');
          else need(step.kind==='command'&&integer(step.command_raw),'Lifecycle source command invalid');return copy(step);
        });
        skills.set(skill.chr_skill_index,{index:skill.chr_skill_index,id:skill.skill_id_raw??skill.original_id_raw,timeline});
      }
      this.roles.set(role.id,{side:role.side,skills,fadeClock:role.death_policy?.enemy_fade_fields?.clock_raw,frame_width:role.frame_width,frame_height:role.frame_height});
    }
    this.reset();
  }
  reset(){this.channels=new Map();this.held=new Map();this.hiddenActors=new Set();this.alphas=new Map();this.epochs=new Map();this.finished=new Set();this.retired=new Set();this.completed=[];this.battleId=null;this.lastNow=null;}
  _key(event){return `${event.actor_id}\0${event.life_epoch}\0${event.token}`;}
  _cancel(actorId){
    const channel=this.channels.get(actorId);if(channel)this.retired.add(this._key(channel.event));
    this.channels.delete(actorId);this.held.delete(actorId);this.hiddenActors.delete(actorId);this.alphas.delete(actorId);
    this.completed=this.completed.filter(row=>row.actor_id!==actorId);
  }
  _start(event,actor,roster,now){
    const roleId=roster?.resource_id??actor.resource_id??actor.id,role=this.roles.get(roleId);
    need(role,'Lifecycle actor resource missing');const index=event.source_skill_index;
    const skill=index===null||index===undefined?null:role.skills.get(index);
    need(index===null||index===undefined||skill,'Exact selected lifecycle source skill missing');
    if(skill&&event.source_id_raw!==null&&event.source_id_raw!==undefined)need(skill.id===event.source_id_raw,'Lifecycle selected source ID differs');
    const channel={event:copy(event),actor_id:actor.id,resource_id:roleId,role,side:roster?.side??actor.side??role.side,skill,cursor:0,pose:null,deadline:now,started:now,appearance:null,blocked:null,mode:'sequence',nativeBridge:this.nativeBridge?.(actor.id)??null,vertical_wait:false,record_visited:-1};
    if(event.kind==='escape'){
      // 50E4B0 reverses the 51D960 eight-pixel path with cursor step -10.
      // The fixed 640px battle plane retains the existing camera adapter.
      const origin=actor.native_x_raw,edge=channel.side==='player'?920:-920;
      need(Number.isFinite(origin),'Escape source position missing');
      channel.escape={distance:Math.abs(edge-origin),direction:Math.sign(edge-origin),cursor:Math.ceil(Math.abs(edge-origin)/8),step:-10,from:0,to:0,at:now,interval:1};
    }
    if(!skill){
      const fadeMode=event.fade_mode_raw??event.fade_increment_raw;
      if(event.kind==='death'&&integer(fadeMode,1)&&fadeMode<=7){
        const clock=event.fade_clock_raw??role.fadeClock;
        if(integer(clock,1)){
          channel.mode='fade';channel.fade_mode_raw=fadeMode;channel.fade_clock_ms=clock;
          const effect=this.disappearanceEffect?.(actor.id,roleId,fadeMode,event)??null;
          channel.particles=new DeathParticlePlayback({mode:fadeMode,clock_ms:clock,started:now,effect});
        }
        else{channel.mode='blocked';channel.blocked='missing-source-fade-clock';}
      }
      else{channel.mode='blocked';channel.blocked='missing-source-lifecycle-presentation';}
    }
    this.channels.set(actor.id,channel);this.alphas.set(actor.id,1);return channel;
  }
  _finish(channel){
    const {event,actor_id}=channel,key=this._key(event);if(this.finished.has(key))return;
    this.finished.add(key);this.channels.delete(actor_id);
    if(event.kind==='death'){
      if(event.hold_final_frame&&channel.side==='player'&&channel.pose)this.held.set(actor_id,{event:copy(event),pose:copy(channel.pose)});
      else if(channel.side==='enemy')this.hiddenActors.add(actor_id);
    }
    if(event.kind==='escape')this.hiddenActors.add(actor_id);
    this.alphas.set(actor_id,this.hiddenActors.has(actor_id)?0:1);
    this.completed.push({token:event.token,actor_id,life_epoch:event.life_epoch});
  }
  _advanceChannel(channel,now){
    if(channel.mode==='blocked')return;
    if(channel.mode==='fade'){
      const active=channel.particles.advance(now);
      channel.fade_elapsed_raw=channel.particles.elapsed;
      if(!active)this._finish(channel);return;
    }
    while(now>=channel.deadline){
      if(channel.vertical_wait){
        need(channel.nativeBridge,'Lifecycle native vertical controller missing');channel.nativeBridge.advance(channel.deadline);
        if(channel.nativeBridge.state().waiting){channel.deadline+=20;continue;}channel.vertical_wait=false;
      }
      if(channel.appearance){
        const appearance=channel.appearance,limit=APPEARANCE_ALPHA_ADAPTER.complete_elapsed_raw[appearance.mode];
        appearance.elapsed_raw=Math.floor(Math.max(0,now-appearance.started)/APPEARANCE_ALPHA_ADAPTER.source_clock_ms);
        if(appearance.mode===3){
          const active=appearance.particles.advance(now);appearance.elapsed_raw=appearance.particles.elapsed;appearance.render_calls=appearance.particles.calls;
          this.alphas.set(channel.actor_id,appearance.particles.effect?.draw?1:Math.min(1,appearance.elapsed_raw/30));
          if(active)return;
          channel.deadline=now;
        }else if(appearance.mode===5||appearance.mode===6){
          if(appearance.render_limit===null){
            let geometry=this.appearanceBounds?.(channel.resource_id,channel.pose?copy(channel.pose):null);
            if(geometry===null||geometry===undefined){
              // Source canvas bounds are a declared conservative adapter when
              // no decoded alpha-pixel bounds are available (e.g. fake canvas).
              need(integer(channel.role.frame_width,1)&&integer(channel.role.frame_height,1),'Lifecycle source canvas dimensions missing');
              geometry={min_x:0,max_x:channel.role.frame_width-1,max_y:channel.role.frame_height-1,empty:false};appearance.geometry_source='source-canvas-conservative-adapter';
            }else appearance.geometry_source='displayed-source-pixel-bounds';
            const maximum=appearance.mode===6?geometry.max_x:geometry.max_y;
            need(typeof geometry.empty==='boolean'&&(geometry.empty||Number.isInteger(geometry.min_x)&&Number.isInteger(maximum)),'Lifecycle source pixel bounds invalid');
            if(!channel.pose&&geometry.pose){
              need(['action_index','action_frame','source_frame'].every(key=>integer(geometry.pose[key])),'Lifecycle source appearance pose invalid');
              channel.pose={action_index:geometry.pose.action_index,action_frame:geometry.pose.action_frame,source_frame:geometry.pose.source_frame};
            }
            // 551F03 mode6 starts current=minX-x; mode5 starts minX-y.
            // Both renderer loops advance +8 and use the same strict bound.
            appearance.render_limit=geometry.empty?1:Math.max(1,Math.ceil((255+maximum-geometry.min_x)/8));
          }
          if(appearance.elapsed_raw===0)appearance.render_calls=0;
          appearance.render_calls++;this.alphas.set(channel.actor_id,Math.min(1,appearance.render_calls/appearance.render_limit));
          if(appearance.render_calls<appearance.render_limit)return;
          // Render-count completion occurs NOW; do not backdate this to a
          // guessed duration and skip the following source sprite frames.
          channel.deadline=now;
        }else{
          if(limit===null||limit===undefined){channel.blocked='appearance-renderer-threshold-unresolved';return;}
          this.alphas.set(channel.actor_id,Math.min(1,appearance.elapsed_raw/limit));
          if(appearance.elapsed_raw<limit)return;
          channel.deadline=appearance.started+limit*APPEARANCE_ALPHA_ADAPTER.source_clock_ms;
        }
        channel.nativeBridge?.appearanceComplete?.();channel.appearance=null;channel.blocked=null;this.alphas.set(channel.actor_id,1);
      }
      if(channel.cursor>=channel.skill.timeline.length){this._finish(channel);return;}
      const step=channel.skill.timeline[channel.cursor++];
      if(step.raw_hex&&step.chr_record_index!==channel.record_visited){channel.nativeBridge?.record(step.raw_hex);channel.record_visited=step.chr_record_index;channel.record_frame=0;}
      if(step.kind==='sprite'){
        // DGP explicit frame tables can repeat/reorder physical frames. Sound
        // fields refer to the CHR logical cursor, including reverse records.
        if(this.onFrame&&step.raw_hex){
          const raw=Uint8Array.from(step.raw_hex.match(/../g),part=>parseInt(part,16)),v=new DataView(raw.buffer);
          const logical=raw[0x1d]?v.getUint32(0x2a,true)-1-channel.record_frame:v.getUint32(0x26,true)+channel.record_frame;
          this.onFrame({...copy(step),actor_id:channel.actor_id,resource_id:channel.resource_id,battle_id:this.battleId,
            lifecycle_token:channel.event.token,source_skill_index:channel.skill.index,plan_record_index:step.chr_record_index,logical_frame:logical});
        }
        channel.record_frame++;
        if(channel.escape){
          const path=channel.escape;
          path.from=path.to;path.at=channel.deadline;path.interval=step.interval_raw;
          path.cursor=Math.max(0,path.cursor+path.step);
          if(path.step<-8&&(path.cursor&3)===0)path.step>>=1;
          path.to=(path.distance-Math.min(path.distance,path.cursor*8))*path.direction;
          // Keep the source running record cycling until the path reaches
          // its destination, then hide only after that frame is displayed.
          const next=channel.skill.timeline[channel.cursor];
          if(path.cursor===0)channel.cursor=channel.skill.timeline.length;
          else if(!next||step.movement_step_raw<0&&next.chr_record_index!==step.chr_record_index){
            channel.cursor=channel.skill.timeline.findIndex(row=>row.chr_record_index===step.chr_record_index);channel.record_frame=0;
          }
        }
        channel.pose={action_index:step.action_index,action_frame:step.action_frame,source_frame:step.source_frame};channel.deadline+=step.interval_raw;
      }else if(step.command_raw===3){
        need(channel.nativeBridge&&step.raw_hex,'Lifecycle source vertical command missing');
        const vertical=channel.nativeBridge.begin(step.raw_hex,channel.deadline);channel.vertical_wait=vertical.waiting;
      }else if(step.command_raw===7){
        const sourceMode=step.mode_raw_0x47??step.mode_raw47;
        const mode=channel.nativeBridge?.appearance&&step.raw_hex?channel.nativeBridge.appearance(step.raw_hex).mode:sourceMode;
        if(!integer(mode,1)){channel.blocked='appearance-mode-requires-controller-rng';channel.mode='blocked';return;}
        channel.appearance={mode,clock_raw:60,elapsed_raw:0,started:channel.deadline,render_calls:0,render_limit:null,geometry_source:null};this.alphas.set(channel.actor_id,0);
        if(mode===3){
          const effect=this.appearanceEffect?.(channel.actor_id,channel.resource_id,mode,channel.event)??null;
          if(effect?.pose)channel.pose=copy(effect.pose);
          // Real surfaces return the original per-pixel active flag. Headless
          // drawing keeps only the source30-step hard ceiling, explicitly.
          channel.appearance.particles=new DeathParticlePlayback({mode,clock_ms:60,started:channel.deadline,
            effect:effect??{reset(){},step:()=>true}});
          channel.appearance.geometry_source=effect?'source-column-particles':'headless-source-hard-ceiling';
        }
      }else{channel.blocked=`unsupported-lifecycle-command-${step.command_raw}`;channel.mode='blocked';return;}
    }
  }
  advance(snapshot,roster,now){
    need(Number.isFinite(now)&&now>=0,'Lifecycle presentation time invalid');need(Array.isArray(snapshot?.actors)&&Array.isArray(roster),'Lifecycle snapshot or roster invalid');
    if(this.battleId!==null&&snapshot.id!==undefined&&snapshot.id!==this.battleId)this.reset();
    if(snapshot.id!==undefined)this.battleId=snapshot.id;
    const time=this.lastNow===null?now:Math.max(now,this.lastNow);this.lastNow=time;
    const actors=new Map(snapshot.actors.map(actor=>[actor.id,actor])),members=new Map(roster.map(actor=>[actor.id,actor]));
    for(const [id,epoch]of this.epochs){if(!actors.has(id)||!members.has(id)){this._cancel(id);this.epochs.delete(id);}else if((actors.get(id).life_epoch??0)!==epoch){this._cancel(id);this.epochs.set(id,actors.get(id).life_epoch??0);}}
    for(const actor of snapshot.actors)if(members.has(actor.id)&&!this.epochs.has(actor.id))this.epochs.set(actor.id,actor.life_epoch??0);
    const latest=new Map();for(const event of snapshot.lifecycle_events??[]){
      const actor=actors.get(event.actor_id);if(!actor||!members.has(actor.id)||(actor.life_epoch??0)!==event.life_epoch)continue;
      need(typeof event.token==='string'&&event.token.length>0&&integer(event.life_epoch)&&['entry','death','revive','response','escape'].includes(event.kind),'Lifecycle event invalid');latest.set(actor.id,event);
    }
    for(const[id,channel]of this.channels){const event=latest.get(id);if(!event||event.token!==channel.event.token||event.life_epoch!==channel.event.life_epoch)this._cancel(id);}
    for(const[id,event]of latest){
      if(this.finished.has(this._key(event))||this.retired.has(this._key(event)))continue;
      let channel=this.channels.get(id);
      if(!channel){this._cancel(id);channel=this._start(event,actors.get(id),members.get(id),time);}
      this._advanceChannel(channel,time);
    }
    return this.snapshot();
  }
  alpha(actorId){return this.alphas.get(actorId)??1;}
  pose(actorId){const channel=this.channels.get(actorId),pose=channel?.pose??this.held.get(actorId)?.pose,path=channel?.escape;
    return pose?{...pose,alpha:this.alpha(actorId),...(path?{offset_x:path.from+(path.to-path.from)*Math.min(1,Math.max(0,this.lastNow-path.at)/path.interval)}:{})}:null;}
  hidden(actorId){return this.hiddenActors.has(actorId);}
  drawParticles(actorId,context,x,y){
    const channel=this.channels.get(actorId),effect=channel?.particles?.effect??channel?.appearance?.particles?.effect;
    if(!effect?.draw)return false;effect.draw(context,x,y);return true;
  }
  drainCompleted(){const rows=this.completed;this.completed=[];return rows.map(copy);}
  snapshot(){
    return {active:[...this.channels.values()].map(channel=>({actor_id:channel.actor_id,token:channel.event.token,life_epoch:channel.event.life_epoch,kind:channel.event.kind,
      source_skill_index:channel.skill?.index??null,cursor:channel.cursor,frame:channel.pose?.source_frame??null,alpha:this.alpha(channel.actor_id),mode:channel.mode,blocked:channel.blocked,
      fade:channel.mode==='fade'?{mode:channel.fade_mode_raw,clock_raw:channel.fade_clock_ms,elapsed_raw:channel.fade_elapsed_raw??0,
        render_calls:channel.particles.calls,pixels:channel.particles.effect?.visible.length??null,
        completion_adapter:'source particle lifetime; fixed60Hz presentation; local visual RNG'}:null,
      appearance:channel.appearance?{mode:channel.appearance.mode,clock_raw:channel.appearance.clock_raw,elapsed_raw:channel.appearance.elapsed_raw,
        render_calls:channel.appearance.render_calls,render_limit:channel.appearance.render_limit,geometry_source:channel.appearance.geometry_source}:null})),
      held:[...this.held].map(([actor_id,row])=>({actor_id,token:row.event.token,life_epoch:row.event.life_epoch,frame:row.pose.source_frame})),hidden:[...this.hiddenActors],completed_count:this.completed.length};
  }
}
