// Shared execution mechanics for source-validated ANM programs. Map entry,
// TLK interpretation and persistent writes remain with their owning runner.
export const COMMON_ANM_OPCODES = new Set([16,17,30,31,32,33,35,48,49]);

export class AnmActions {
  constructor({hooks, context, positions, controller = new AbortController(),
    describeError = error => error, nativeMetadata = false}) {
    Object.assign(this, {hooks, context, positions, controller, describeError, nativeMetadata});
    this.pending = [];
    this.error = null;
    this.failure = new Promise((resolve, reject) => { this.rejectFailure = reject; });
    this.failure.catch(() => {});
  }

  check() { if (this.error) throw this.error; }
  abort(error) { this.controller.abort(error); }
  call(hook, command, payload = {}) {
    return this.hooks[hook]({command, source: command.source, ...this.context(),
      signal: this.controller.signal, ...payload});
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
      case 16:
        await this.frame(command, command.u32_plus25 + 1); break;
      case 17:
        if (typeof this.hooks.fade !== 'function') throw new Error('剧情淡入淡出接口缺失');
        await this.call('fade', command, {kind:command.byte_plus29 ? 'out':'in', effectRaw:actor});
        await this.frame(command); break;
      case 30:
        await this.flush();
        await this.call('actor', command, {kind:'restore', actor:null, controlledActor:0}); break;
      case 31: {
        const pendingCount = await this.flush();
        await this.call('wait', command, {kind:'barrier', frames:1,
          ...(this.nativeMetadata ? {pendingCount, modeRaw:command.byte_plus29}: {})}); break;
      }
      case 32:
        // Native +29 is a focus mode; record x/y are not camera coordinates.
        await this.call('camera', command, {kind:'focus', actor, modeRaw:command.byte_plus29}); break;
      case 33:
        this.launch('move', command, {actor, ...position, speedRaw:command.u32_plus25,
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
      case 49:
        // This writes +4bd rather than changing eight-direction facing.
        this.launch('actor', command, {kind:'facing', actor, blendModeRaw:command.byte_plus29,
          nativeStateRaw:command.byte_plus29 + 1, nativeField:'0x4bd',
          motionModeRaw:command.u32_plus1, ...(this.nativeMetadata ? {hidden:false}: {})}); break;
      default: throw new Error(`ANM指令${command.opcode}不属于共用执行核心`);
    }
  }
}
