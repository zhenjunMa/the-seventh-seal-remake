// Presentation preview for the source-bound ANM player. Interpolation and
// blend-state transitions are browser approximations, not native equivalence.
import {locomotion} from './core/movement.mjs';
import {linkPlaybackAbort,playbackFrame,playbackTask} from './core/story_playback.mjs';
import {openingCamera,approachPoint,directArrivalMoves} from './core/opening_presentation.mjs';
import {ActorEffectView} from './actor_effect_view.mjs';
import {drawMapSprite} from './map_sprite.mjs';
import {runtimeContent} from './core/content_registry.mjs';
import {DistanceGait,mapMotionProfile,mapTravelDistance} from './core/map_locomotion.mjs';
import {nativeNpcActionBindings} from './core/map_npcs.mjs';

export function physicalFrame(action, logicalIndex) {
  const frame = action.uses_sequence ? action.sequence_raw[logicalIndex] : logicalIndex;
  if (!Number.isInteger(frame) || frame < 0 || frame >= action.frame_count)
    throw new Error(`动作 ${action.index} 缺少逻辑帧 ${logicalIndex}`);
  return frame;
}
export class OpeningView {
  constructor({resources, prepared, prepare, install, camera, say, shade, log, program,staging={},effects={},nativeViewport=false,clock=null,
    initialActor=0,content=runtimeContent,cameraRenderMode=0}) {
    Object.assign(this, {resources, prepared, prepare, install, camera, say, shade, log,staging,effects,nativeViewport,clock,content});
    this.controlledActor=initialActor;
    this.cameraRenderMode=cameraRenderMode;
    this.actors = new Map(); this.active = false; this.focus = null;
    this.controller=new AbortController();
    this.directArrivals=directArrivalMoves(program,staging);
  }
  getActor(id) {
    const actor = this.actors.get(id);
    if (!actor) throw new Error(`序章角色尚未准备：${id}`);
    return actor;
  }
  dispose() {
    this.controller.abort(new Error('演出已关闭'));
    this.active = false;
    this.focus = null;
    this.actors.clear();
    this.prepared.clear();
  }
  updateCamera() {
    if (this.focus === null) return;
    const actor = this.getActor(this.focus);
    if(this.nativeViewport){
      const at=openingCamera(actor,this.scene.bitmap.width,this.scene.bitmap.height);
      this.setCamera(at.x,at.y);
    }else this.setCamera(actor.x + 16, actor.y);
  }
  setCamera(x,y){this.cameraAt={x,y};this.camera(x,y);}
  snapshot(type,extra={}) {
    this.log?.({type,map_id:this.mapId,...extra,actors:[...this.actors.entries()].map(([slot,a])=>
      ({slot,visible:a.visible,direction:a.direction,x:a.x,y:a.y,action:a.action,frame:a.frame}))});
  }
  async tween(duration, update, signal) {
    if(this.clock)return this.clock.tween(duration,progress=>{update(progress);this.updateCamera();},[signal,this.controller.signal]);
    const controller=new AbortController(),unlink=[signal,this.controller.signal].map(signal=>linkPlaybackAbort(signal,controller));
    const start=performance.now();
    try{
      let progress;
      do{
        const now=await playbackFrame(null,controller.signal);
        progress=Math.max(0,Math.min(1,(now-start)/Math.max(1,duration)));
        update(progress);this.updateCamera();
      }while(progress<1);
    }finally{for(const detach of unlink)detach();}
  }
  hooks() {
    return {
      map: async ({mapId,initialLocation,signal}) => {
        let scene = this.prepared.get(mapId);
        if(!scene&&this.prepare){scene=await playbackTask(this.prepare(mapId,signal),signal);this.prepared.set(mapId,scene);}
        if (!scene) throw new Error(`序章地图尚未准备：${mapId}`);
        while(this.clock?.paused)await this.clock.tween(0,()=>{},[signal,this.controller.signal]);
        if(signal?.aborted||this.controller.signal.aborted)throw signal?.reason??this.controller.signal.reason;
        this.scene=scene;this.mapId=mapId;
        this.actors.clear(); this.focus = null; this.active = true;
        const npcs=new Map((scene.data.opening_npcs??[]).map(npc=>[npc.slot_zero_based,npc]));
        for(const npc of scene.npcs??[])if(this.resources.roles[npc.resource_id])npcs.set(npc.slot_zero_based,npc);
        for (const npc of npcs.values()) {
          const stage=this.staging[mapId],awaitingAppearance=Boolean(stage?.initially_hidden&&stage.slots.includes(npc.slot_zero_based));
          const {motion,...pose}=npc;
          this.actors.set(npc.slot_zero_based,
            {...pose,x:motion?.x??pose.x,y:motion?.y??pose.y,direction:motion?.direction??pose.direction,
              awaitingAppearance,role:this.resources.roles[npc.resource_id],visible:!npc.hidden&&!awaitingAppearance,
              action:motion?.action??0,frame:motion?.frame??0,alpha:1});
        }
        this.actors.set(0, {x: 0, y: 0, direction: 1, role: this.resources.roles['001'], visible: false, action: 0, frame: 0, alpha: 1});
        if(initialLocation){
          Object.assign(this.actors.get(0),{...initialLocation,visible:true});
          for(const [id,definition]of Object.entries(this.content.roles))if(definition.side==='player'&&definition.native_slot!==0&&this.resources.roles[id])
            this.actors.set(definition.native_slot,{...initialLocation,role:this.resources.roles[id],visible:false,action:0,frame:0,alpha:1});
          this.getActor(0).visible=this.controlledActor===0;this.getActor(this.controlledActor).visible=true;
          this.focus=this.controlledActor;
        }
        this.install(scene);
        this.updateCamera();
        this.log?.({type:'opening-actors-initialized',map_id:mapId,
          actors:[...this.actors.entries()].map(([slot,actor])=>({slot,direction:actor.direction,
            direction_raw_45:actor.direction_raw_45,visible:actor.visible,x:actor.x,y:actor.y})),
          staging:this.staging[mapId]??null});
      },
      actor: async payload => {
        const {kind, signal} = payload;
        if (kind === 'restore') {
          for(const [slot,actor]of this.actors)if(slot<10)actor.visible=false;
          this.controlledActor=payload.controlledActor??this.controlledActor;
          const hero=this.getActor(this.controlledActor);hero.action=0;hero.frame=0;hero.visible=true;return;
        }
        if(kind==='control'){
          const previous=this.getActor(payload.previousActor),next=this.getActor(payload.actor);
          // 4B6720 mode3 copies +6F/+73 position only. The destination's
          // initialized direction and pose are not copied from the old actor.
          Object.assign(next,{x:previous.x,y:previous.y,visible:true});
          if(previous!==next)previous.visible=false;
          this.controlledActor=payload.actor;if(this.focus===payload.previousActor)this.focus=payload.actor;
          this.updateCamera();return;
        }
        const actor = this.getActor(payload.actor);
        // Native opcode35's hide branch only changes visibility. Its pose and
        // coordinates do not relocate or rotate an already loaded actor.
        if(kind==='hide'){actor.visible=false;return;}
        if (kind === 'place') {
          actor.x = payload.x; actor.y = payload.y; actor.visible = !actor.awaitingAppearance;
          const flat = Math.max(0, payload.poseRaw - 1), action = actor.role.actions.find(a =>
            flat >= a.first_frame && flat < a.first_frame + a.frame_count * a.directions);
          if (!action) throw new Error(`角色 ${payload.actor} 的姿态帧未恢复：${payload.poseRaw}`);
          const relative = flat - action.first_frame;
          actor.action = action.index; actor.direction = Math.floor(relative / action.frame_count); actor.frame = relative % action.frame_count;
          this.updateCamera(); return;
        }
        if (kind === 'animation') {
          const action = actor.role.actions.find(a => a.index === payload.actionId);
          if (!action) throw new Error(`角色 ${payload.actor} 缺少动作 ${payload.actionId}`);
          // Native writes zero-based start/end. The last sentinel frame and
          // exact busy-state boundary still need native runtime comparison.
          const start=payload.frameStart||1,end=payload.frameEnd||(action.logical_count??(action.uses_sequence?action.sequence_length_raw:action.frame_count));
          if(!Number.isInteger(end)||end<start)throw new Error('剧情原动作默认帧范围无效');
          const indices = Array.from({length:end-start},(_,i)=>i+start-1);
          const frames = indices.map(index => physicalFrame(action, index));
          actor.action = action.index;
          if(!frames.length){actor.frame=physicalFrame(action,start-1);return;}
          const interval = Math.max(16, action.interval_raw), total = frames.length * (payload.repetitions||1);
          await this.tween(interval * total, t => { actor.frame = frames[Math.min(total - 1, Math.floor(t * total)) % frames.length]; }, signal);
          this.snapshot('opening-animation-complete',{actor:payload.actor,command:payload.command?.index});
          return;
        }
        if (kind === 'facing' || kind === 'behavior') {
          const tickMs=this.effects.tick_ms??20,particleTicks=this.effects.particle_ticks??30;
          this.snapshot('opening-effect-start',{actor:payload.actor,kind,native_state:payload.nativeStateRaw,command:payload.command?.index});
          actor.awaitingAppearance=false;actor.visible=true;
          if(kind==='facing'&&payload.nativeStateRaw===7){
            const ticks=this.effects.reveal_ticks??40;actor.alpha=15/255;
            await this.tween(ticks*tickMs,t=>{actor.alpha=Math.min(1,(15+6*Math.floor(t*ticks))/255);},signal);
            actor.alpha=1;
          }else if(payload.nativeStateRaw===2){
            actor.effect=new ActorEffectView(actor,kind==='behavior'?'rise':'fall');
            try{await this.tween(particleTicks*tickMs,t=>actor.effect.update(Math.min(particleTicks-1,Math.floor(t*particleTicks))),signal);}
            finally{actor.effect=null;}
            if(kind==='behavior')actor.visible=false;
          }else throw new Error(`未支持的人物像素效果 ${kind}:${payload.nativeStateRaw}`);
          this.snapshot('opening-effect-complete',{actor:payload.actor,kind,command:payload.command?.index});
          return;
        }
        throw new Error(`未支持的序章人物演出：${kind}`);
      },
      move: async ({actor: id, x, y, arrivalFacingRaw=0, actionRaw=0, signal,command}) => {
        signal?.throwIfAborted();this.controller.signal.throwIfAborted();
        const actor = this.getActor(id), from = {x: actor.x, y: actor.y};
        const arrival=this.directArrivals.get(command?.index);
        if(arrival?.defer){
          this.snapshot('opening-move-complete',{actor:id,command:command.index,
            presentation:'deferred-to-direct-arrival',source_commands:arrival.sourceCommands,motion_frames:[]});
          return;
        }
        const axisApproach=!arrival&&this.staging[this.mapId]?.axis_approach;
        const source=this.scene.npcRuntime?.actors.get(actor.id)?.source;
        if(source&&!source.bindings_initialized)throw new Error(`角色 ${id} 的原动作绑定尚未初始化`);
        const bindings=source?.bindings??nativeNpcActionBindings(actor.role);
        const action = actor.role.actions.find(a => a.index === (actionRaw||bindings[1]));
        if (!action) throw new Error(`角色 ${id} 缺少移动动作`);
        if(!Number.isInteger(arrivalFacingRaw)||arrivalFacingRaw<0||arrivalFacingRaw>8)throw new Error('剧情到达朝向无效');
        const motion=mapMotionProfile(action,this.scene.data.movement,'',source?.speedBias??0);
        const gait=new DistanceGait();let previous=0;
        const motionFrames=[];
        const distance=mapTravelDistance(from,{x,y},axisApproach);
        const duration=distance/motion.speed*1000;
        const update=t=>{
          const point=approachPoint(from,{x,y},t,axisApproach);
          actor.x=point.x;actor.y=point.y;
          if(point.dx||point.dy)actor.direction=locomotion(point,true).direction;
          actor.action=action.index;
          actor.frame=gait.advance(action,{dx:distance*Math.max(0,t-previous),stride:motion.stride});
          previous=t;
          if(this.nativeViewport&&this.focus!==null){
            const focus=this.getActor(this.focus),camera=openingCamera(focus,this.scene.bitmap.width,this.scene.bitmap.height);
            motionFrames.push({time_ms:this.clock?.time??performance.now(),x:actor.x,y:actor.y,camera_x:camera.x,camera_y:camera.y});
          }
        };
        if(distance)await this.tween(duration,update,signal);
        actor.action = bindings[0]; actor.frame = 0;
        if(arrival)actor.direction=arrival.arrivalDirection;
        else if(arrivalFacingRaw)actor.direction=arrivalFacingRaw-1;
        this.snapshot('opening-move-complete',{actor:id,command:command?.index,
          presentation:arrival?'direct-arrival':'source-move',motion_frames:motionFrames});
      },
      camera: async ({kind,actor,x,y,modeRaw,signal,cycles,amplitude}) => {
        if(kind==='shake'){
          if(!Number.isInteger(cycles)||cycles<0||cycles>10000||!Number.isFinite(amplitude))throw new Error('剧情原镜头摇动参数无效');
          const origin={...this.cameraAt},focus=this.focus;this.focus=null;
          try{
            for(let index=0;index<cycles;index++){
              signal?.throwIfAborted();
              const offset=this.cameraRenderMode===0?{x:modeRaw?-amplitude:amplitude,y:amplitude}
                :modeRaw?{x:amplitude,y:0}:{x:0,y:amplitude};
              this.setCamera(origin.x+offset.x,origin.y+offset.y);
              await this.tween(16,()=>{},signal);this.setCamera(origin.x,origin.y);
              await this.tween(16,()=>{},signal);
            }
          }finally{
            // A disposed view no longer owns the camera. A late rejection
            // must not move a newly installed scene or restore stale focus.
            if(!this.controller.signal.aborted){this.focus=focus;this.setCamera(origin.x,origin.y);}
          }
          return;
        }
        if(kind!=='position'){this.focus=actor;this.updateCamera();return;}
        this.focus=null;
        const movement=this.scene.data.movement,shift=movement.native_camera_step_shift;
        if(!Number.isInteger(shift)||shift<0||shift>30)throw new Error('地图缺少原镜头步长');
        const quantum=2**shift*(movement.native_to_pixel_scale??2),round=value=>Math.floor(value/quantum)*quantum;
        const target=openingCamera({x:round(x)+16,y:round(y)+16},this.scene.bitmap.width,this.scene.bitmap.height);
        if(modeRaw===1){this.setCamera(target.x,target.y);return;}
        const from=this.cameraAt??target,dx=target.x-from.x,dy=target.y-from.y;
        const steps=Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/quantum);
        if(!steps){this.setCamera(target.x,target.y);return;}
        await this.tween(steps*(modeRaw===0?16:40),progress=>{
          const distance=Math.floor(progress*steps+1e-9)*quantum;
          this.setCamera(from.x+Math.sign(dx)*Math.min(Math.abs(dx),distance),from.y+Math.sign(dy)*Math.min(Math.abs(dy),distance));
        },signal);
      },
      fade: async ({kind, signal}) => this.tween(450, t => this.shade(kind === 'out' ? t : 1 - t), signal),
      say: async ({records,signal}) => {
        this.snapshot('opening-dialogue-stage',{records:records.map(r=>r.id)});
        for (const record of records) await this.say(record.speaker === 1 ? '英格妮' : '', record.text_raw, record.style,{signal,record,mapId:this.mapId});
      },
      wait: async ({frames, signal}) => this.tween(frames * 16, () => {}, signal),
    };
  }
  drawQueue(layer = 2) {
    return [...this.actors.entries()].filter(([,a]) => a.visible).map(([slot,actor]) => {
      const r=actor.role,a=r.actions.find(a=>a.index===actor.action);
      return {key:`opening:${slot}`,layer,sort_y:actor.y+32,alpha:actor.alpha,
      blend:actor.effect?.kind==='rise'?'lighter':'source-over',
      pose:actor.effect?{image:actor.effect.canvas,x:actor.x+16-r.anchor.x,y:actor.y-r.anchor.y-160}
        :{image:a.bitmap,light:a.intrinsic_bitmap,shadow:a.shadow_bitmap,shadow_geometry:a.shadow_geometry,sx:actor.frame*r.frame_width,sy:actor.direction*r.frame_height,
          width:r.frame_width,height:r.frame_height,x:actor.x+16-r.anchor.x,y:actor.y-r.anchor.y},
      draw: ctx => {
        const r = actor.role, a = r.actions.find(a => a.index === actor.action);
        ctx.save(); ctx.globalAlpha = actor.alpha;
        if(actor.effect)actor.effect.draw(ctx,actor.x+16-r.anchor.x,actor.y-r.anchor.y);
        else drawMapSprite(ctx,a.bitmap,a.intrinsic_bitmap,actor.frame*r.frame_width,actor.direction*r.frame_height,
          r.frame_width,r.frame_height,actor.x+16-r.anchor.x,actor.y-r.anchor.y,a.shadow_bitmap,a.shadow_geometry);
        ctx.restore();
      }};});
  }
}
