// One transient owner for a complete story event. World commits remain with
// ChapterRunner / the scene transaction; cancellation never means completion.
export const storyCancelled = () => new DOMException('剧情已中止', 'AbortError');

export function linkPlaybackAbort(signal, controller) {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, {once:true});
  return () => signal.removeEventListener('abort', abort);
}

export function playbackTask(task, signal) {
  if (!signal) return Promise.resolve(task);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, {once:true});
    Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function playbackFrame(clock, signal) {
  if (clock) return new Promise((resolve, reject) => clock.requestFrame(resolve, {signal, onCancel:reject}));
  return new Promise((resolve, reject) => {
    const abort = () => {cancelAnimationFrame(frame); reject(signal.reason);};
    let frame;
    if (signal?.aborted) {reject(signal.reason); return;}
    signal?.addEventListener('abort', abort, {once:true});
    frame = requestAnimationFrame(now => {signal?.removeEventListener('abort', abort); resolve(now);});
  });
}

export function playbackDelay(ms, {clock, signal} = {}) {
  if (clock) return clock.tween(ms, () => {}, [signal]);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {reject(signal.reason); return;}
    const abort = () => {clearTimeout(timer); reject(signal.reason);};
    const timer = setTimeout(() => {signal?.removeEventListener('abort', abort); resolve();}, ms);
    signal?.addEventListener('abort', abort, {once:true});
  });
}

export class StoryPlayback {
  constructor({clock = null} = {}) {
    this.clock = clock;
    this.controller = new AbortController();
    this.phase = 'running';
    this.finished = new Promise(resolve => {this.resolveFinished = resolve;});
  }
  get signal() {return this.controller.signal;}
  get paused() {return Boolean(this.clock?.paused);}
  get status() {return this.phase === 'running' && this.paused ? 'paused' : this.phase;}
  check() {
    this.signal.throwIfAborted();
    if (this.clock?.closed) throw new Error('剧情时钟已关闭');
  }
  async ready() {
    this.check();
    while (this.paused) await playbackFrame(this.clock, this.signal);
    this.check();
  }
  wait(ms) {this.check(); return playbackDelay(ms, {clock:this.clock, signal:this.signal});}
  complete() {this.check(); this.phase = 'completed';}
  fail(error) {
    if (this.phase !== 'running') return;
    this.phase = 'failed'; this.controller.abort(error);
  }
  cancel(reason = storyCancelled()) {
    if (this.phase !== 'running') return;
    this.phase = 'cancelled'; this.controller.abort(reason);
  }
  dispose() {
    this.cancel();
    if (!this.signal.aborted) this.controller.abort(storyCancelled());
    this.resolveFinished();
  }
}
