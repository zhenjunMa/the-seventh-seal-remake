// Presentation preview for the source-bound ANM player. Interpolation and
// blend-state transitions are browser approximations, not native equivalence.
import {locomotion} from '/prototype/movement.mjs';
import {openingCamera,approachPoint,directArrivalMoves} from './core/opening_presentation.mjs';
import {ActorEffectView} from './actor_effect_view.mjs';
import {drawMapSprite} from './map_sprite.mjs';
import {runtimeContent} from './core/content_registry.mjs';

export function physicalFrame(action, logicalIndex) {
  const frame = action.uses_sequence ? action.sequence_raw[logicalIndex] : logicalIndex;
  if (!Number.isInteger(frame) || frame < 0 || frame >= action.frame_count)
    throw new Error(`动作 ${action.index} 缺少逻辑帧 ${logicalIndex}`);
  return frame;
}
export class OpeningView {
  constructor({resources, prepared, prepare, install, camera, say, shade, log, program,staging={},effects={},nativeViewport=false}) {
    Object.assign(this, {resources, prepared, prepare, install, camera, say, shade, log,staging,effects,nativeViewport});
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
      this.camera(at.x,at.y);
    }else this.camera(actor.x + 16, actor.y);
  }
  snapshot(type,extra={}) {
    this.log?.({type,map_id:this.mapId,...extra,actors:[...this.actors.entries()].map(([slot,a])=>
      ({slot,visible:a.visible,direction:a.direction,x:a.x,y:a.y,action:a.action,frame:a.frame}))});
  }
  tween(duration, update, signal) {
    return new Promise((resolve, reject) => {
      const start = performance.now();
      const tick = now => {
        if (signal?.aborted||this.controller.signal.aborted) { reject(signal?.reason ?? this.controller.signal.reason); return; }
        try {
          // RAF timestamps mark the start of a frame and can precede the
          // performance.now() read when an ANM starts within that frame.
          const progress = Math.max(0, Math.min(1, (now - start) / Math.max(1, duration)));
          update(progress); this.updateCamera();
          if (progress === 1) resolve(); else requestAnimationFrame(tick);
        } catch (error) { reject(error); }
      };
      requestAnimationFrame(tick);
    });
  }
  hooks() {
    return {
      map: async ({mapId,initialLocation,signal}) => {
        let scene = this.prepared.get(mapId);
        if(!scene&&this.prepare){scene=await this.prepare(mapId,signal);this.prepared.set(mapId,scene);}
        if (!scene) throw new Error(`序章地图尚未准备：${mapId}`);
        if(signal?.aborted||this.controller.signal.aborted)throw signal?.reason??this.controller.signal.reason;
        this.scene=scene;this.mapId=mapId;
        this.actors.clear(); this.focus = null; this.active = true;
        const npcs=new Map((scene.data.opening_npcs??[]).map(npc=>[npc.slot_zero_based,npc]));
        for(const npc of scene.npcs??[])if(this.resources.roles[npc.resource_id])npcs.set(npc.slot_zero_based,npc);
        for (const npc of npcs.values()) {
          const stage=this.staging[mapId],awaitingAppearance=Boolean(stage?.initially_hidden&&stage.slots.includes(npc.slot_zero_based));
          const {motion,...pose}=npc;
          this.actors.set(npc.slot_zero_based,
            {...pose,awaitingAppearance,role:this.resources.roles[npc.resource_id],visible:!npc.hidden&&!awaitingAppearance,
              action:motion?.action??0,frame:motion?.frame??0,alpha:1});
        }
        this.actors.set(0, {x: 0, y: 0, direction: 1, role: this.resources.roles['001'], visible: false, action: 0, frame: 0, alpha: 1});
        if(initialLocation){
          Object.assign(this.actors.get(0),{...initialLocation,visible:true});
          for(const [id,definition]of Object.entries(runtimeContent.roles))if(definition.side==='player'&&definition.native_slot!==0&&this.resources.roles[id])
            this.actors.set(definition.native_slot,{...initialLocation,role:this.resources.roles[id],visible:false,action:0,frame:0,alpha:1});
          this.focus=0;
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
        if (kind === 'restore') { const hero = this.getActor(0); hero.action = 0; hero.frame = 0; return; }
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
          const indices = Array.from({length: payload.frameEnd - payload.frameStart}, (_, i) => i + payload.frameStart - 1);
          const frames = indices.map(index => physicalFrame(action, index));
          actor.action = action.index;
          const interval = Math.max(16, action.interval_raw), total = frames.length * payload.repetitions;
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
      move: async ({actor: id, x, y, speedRaw, signal,command}) => {
        const actor = this.getActor(id), from = {x: actor.x, y: actor.y};
        const arrival=this.directArrivals.get(command?.index);
        if(arrival?.defer){
          this.snapshot('opening-move-complete',{actor:id,command:command.index,
            presentation:'deferred-to-direct-arrival',source_commands:arrival.sourceCommands,motion_frames:[]});
          return;
        }
        const dx = x - from.x, dy = y - from.y,axisApproach=!arrival&&this.staging[this.mapId]?.axis_approach;
        actor.action = 1;
        const action = actor.role.actions.find(a => a.index === 1);
        if (!action) throw new Error(`角色 ${id} 缺少移动动作`);
        // Source speed0 is retained. Default preview speed prevents an infinite
        // tween; its native timing still needs execution comparison.
        const motionFrames=[];
        const distance=axisApproach?Math.abs(dx)+Math.abs(dy):Math.hypot(dx,dy);
        const duration = Math.max(200, distance / (Math.max(1,speedRaw) * 30) * 1000);
        await this.tween(duration, t => {
          const point=approachPoint(from,{x,y},t,axisApproach);
          actor.x=point.x;actor.y=point.y;
          if(point.dx||point.dy)actor.direction=locomotion(point,true).direction;
          const index=Math.floor(t * duration / Math.max(16, action.interval_raw)) % (action.uses_sequence?action.sequence_raw.length:action.frame_count);
          actor.frame=physicalFrame(action,index);
          if(this.nativeViewport&&this.focus!==null){
            const focus=this.getActor(this.focus),camera=openingCamera(focus,this.scene.bitmap.width,this.scene.bitmap.height);
            motionFrames.push({time_ms:performance.now(),x:actor.x,y:actor.y,camera_x:camera.x,camera_y:camera.y});
          }
        }, signal);
        actor.action = 0; actor.frame = 0;
        if(arrival)actor.direction=arrival.arrivalDirection;
        this.snapshot('opening-move-complete',{actor:id,command:command?.index,
          presentation:arrival?'direct-arrival':'source-move',motion_frames:motionFrames});
      },
      camera: async ({actor}) => { this.focus = actor; this.updateCamera(); },
      fade: async ({kind, signal}) => this.tween(450, t => this.shade(kind === 'out' ? t : 1 - t), signal),
      say: async ({records,signal}) => {
        this.snapshot('opening-dialogue-stage',{records:records.map(r=>r.id)});
        for (const record of records) await this.say(record.speaker === 1 ? '英格妮' : '', record.text_raw, record.style,{signal,record,mapId:this.mapId});
      },
      wait: async ({frames, signal}) => this.tween(frames * 16, () => {}, signal),
    };
  }
  drawQueue(layer = 2) {
    return [...this.actors.values()].filter(a => a.visible).map(actor => ({layer, sort_y: actor.y + 32,
      draw: ctx => {
        const r = actor.role, a = r.actions.find(a => a.index === actor.action);
        ctx.save(); ctx.globalAlpha = actor.alpha;
        if(actor.effect)actor.effect.draw(ctx,actor.x+16-r.anchor.x,actor.y-r.anchor.y);
        else drawMapSprite(ctx,a.bitmap,a.intrinsic_bitmap,actor.frame*r.frame_width,actor.direction*r.frame_height,
          r.frame_width,r.frame_height,actor.x+16-r.anchor.x,actor.y-r.anchor.y);
        ctx.restore();
      }}));
  }
}
