// Shared execution mechanics for source-validated ANM programs. Map entry,
// TLK interpretation and persistent writes remain with their owning runner.
import {linkPlaybackAbort,playbackTask} from './story_playback.mjs';

export const COMMON_ANM_OPCODES = new Set([11,16,17,30,31,32,33,35,41,48,49,60,62,63,255]);

export function anmFilename(command){
  const bytes=Uint8Array.from(command.raw_hex.match(/../g),value=>parseInt(value,16));
  return new TextDecoder().decode(bytes.slice(54,74)).split('\0')[0];
}

export class AnmActions {
  constructor({hooks, context, positions, controller = new AbortController(),
    describeError = error => error, nativeMetadata = false, playback = null,visualState={}}) {
    Object.assign(this, {hooks, context, positions, controller, describeError, nativeMetadata, playback});
    this.pending = [];
    // Original data-segment defaults at679244/679248. Parameter0 preserves
    // the current playback-session value, rather than inventing a reset.
    this.visualState={shakeCycles:10,shakeAmplitudeNative:4,...visualState};
    this.error = null;
    this.failure = new Promise((resolve, reject) => { this.rejectFailure = reject; });
    this.failure.catch(() => {});
    this.onAbort=()=>{this.error??=this.controller.signal.reason;this.rejectFailure(this.error);};
    this.controller.signal.addEventListener('abort',this.onAbort,{once:true});
    this.unlink=linkPlaybackAbort(playback?.signal,this.controller);
    if(this.controller.signal.aborted)this.onAbort();
  }

  check() { if (this.error) throw this.error; this.controller.signal.throwIfAborted(); this.playback?.check(); }
  dispose() {this.unlink();this.controller.signal.removeEventListener('abort',this.onAbort);}
  abort(error) { this.controller.abort(error); }
  call(hook, command, payload = {}) {
    const invoke=()=>{
      this.check();
      if(typeof this.hooks[hook]!=='function')throw new Error(`剧情演出接口缺失：${hook}`);
      return playbackTask(this.hooks[hook]({command, source:command.source,...this.context(),
        signal:this.controller.signal,...payload}),this.controller.signal);
    };
    return this.playback?.paused?this.playback.ready().then(invoke):invoke();
  }
  launch(hook, command, payload, done) {
    // Invoke before advancing the instruction cursor. Only native barriers
    // wait for concurrent actions; a late completion cannot change positions
    // after another action has failed.
    this.pending.push(Promise.resolve(this.call(hook, command, payload))
      .then(() => { if (!this.controller.signal.aborted) done?.(); })
      .catch(error => {
        this.error ??= this.describeError(error, command);
        this.abort(this.error);
        this.rejectFailure(this.error);
      }));
  }
  async flush() {
    const tasks = this.pending.splice(0);
    await Promise.race([Promise.all(tasks), this.failure]);
    this.check();
    return tasks.length;
  }
  frame(command, frames = 1) { return this.call('wait', command, {kind:'frame', frames}); }

  async execute(command) {
    this.check();
    const actor = command.u32_plus5;
    const position = {x:(command.u32_plus13 | 0) * 2, y:(command.u32_plus17 | 0) * 2};
    if (this.nativeMetadata) Object.assign(position, {
      nativeX:command.u32_plus13 | 0, nativeY:command.u32_plus17 | 0});
    const recordPosition = () => this.positions.set(actor, {
      map_id:this.context().mapId, x:position.x, y:position.y});
    switch (command.opcode) {
      case 11: {
        const payload={kind:'position',x:position.x,y:position.y,modeRaw:command.byte_plus29};
        // Native mode0 scrolls synchronously; mode1 sets immediately; other
        // modes start 433E90's asynchronous camera motion (40ms per step).
        if(command.byte_plus29>=2)this.launch('camera',command,payload);
        else await this.call('camera',command,payload);
        break;
      }
      case 16:
        await this.frame(command, command.u32_plus25 + 1); break;
      case 17:
        if(actor===3){
          if(command.u32_plus13)this.visualState.shakeCycles=command.u32_plus13<<1;
          if(command.u32_plus17)this.visualState.shakeAmplitudeNative=command.u32_plus17|0;
          await this.call('camera',command,{kind:'shake',modeRaw:command.byte_plus29,
            cycles:this.visualState.shakeCycles,amplitude:this.visualState.shakeAmplitudeNative*2});
        }else{
          if (typeof this.hooks.fade !== 'function') throw new Error('剧情淡入淡出接口缺失');
          await this.call('fade', command, {kind:command.byte_plus29 ? 'out':'in', effectRaw:actor});
        }
        await this.frame(command); break;
      case 30:
        await this.flush();
        await this.call('actor', command, {kind:'restore', actor:null, controlledActor:this.context().controlledActor??0}); break;
      case 31: {
        const pendingCount = await this.flush();
        await this.call('wait', command, {kind:'barrier', frames:1,
          ...(this.nativeMetadata ? {pendingCount, modeRaw:command.byte_plus29}: {})}); break;
      }
      case 32:
        // Native +29 is a focus mode; record x/y are not camera coordinates.
        await this.call('camera', command, {kind:'focus', actor, modeRaw:command.byte_plus29}); break;
      case 33:
        // 473E30 copies the low byte to actor+2B1; arrival handlers subtract
        // one into facing. Zero preserves facing; this field is not speed.
        this.launch('move', command, {actor, ...position, arrivalFacingRaw:command.u32_plus25&255,
          motionModeRaw:command.u32_plus1, actionRaw:command.byte_plus29,
          directionRaw:command.byte_plus30}, recordPosition); break;
      case 35:
        await this.call('actor', command, {kind:command.u32_plus1 ? 'hide':'place', actor,
          ...position, poseRaw:command.u32_plus25,
          ...(this.nativeMetadata ? {placementModeRaw:command.u32_plus1}: {})});
        if (!command.u32_plus1) recordPosition(); break;
      case 48:
        this.launch('actor', command, {kind:'animation', actor, actionId:command.byte_plus29,
          frameStart:command.u32_plus13, frameEnd:command.u32_plus17,
          repetitions:command.u32_plus25, motionModeRaw:command.u32_plus1}); break;
      case 41:
        // 473E30: actor+4BE=byte29+1; +4BF=0; +F0=mode+1.
        // The barrier joins this transient actor effect like opcode48/49.
        this.launch('actor',command,{kind:'behavior',actor,behaviorModeRaw:command.byte_plus29,nativeStateRaw:command.byte_plus29+1,
          motionModeRaw:command.u32_plus1,nativeField:'0x4be',...(this.nativeMetadata?{hidden:false}:{})});break;
      case 49:
        // This writes +4bd rather than changing eight-direction facing.
        this.launch('actor', command, {kind:'facing', actor, blendModeRaw:command.byte_plus29,
          nativeStateRaw:command.byte_plus29 + 1, nativeField:'0x4bd',
          motionModeRaw:command.u32_plus1, ...(this.nativeMetadata ? {hidden:false}: {})}); break;
      case 60:
        await this.call('media',command,{filename:anmFilename(command)});break;
      case 62:
        await this.call('sound',command,{kind:command.byte_plus29===1?'restore-music':'play',
          filename:anmFilename(command),persistent:command.byte_plus29===2,modeRaw:command.byte_plus29});break;
      case 63:
        await this.call('sound',command,{kind:'release',modeRaw:command.byte_plus29});break;
      // 473E30's default returns zero. 255 is a shipped annotation record;
      // execution continues through subsequent map and dialogue commands.
      case 255:break;
      default: throw new Error(`ANM指令${command.opcode}不属于共用执行核心`);
    }
  }
}
