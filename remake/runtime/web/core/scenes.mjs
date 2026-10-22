// Load and validate a destination before replacing the current world or scene.
import {validateWorld} from './world.mjs';
export class SceneController {
  constructor({world, prepare, validateEntry, commitView, captureView = () => null, rollbackView = () => {}, onPhase = () => {}}) {
    Object.assign(this, {world, prepare, validateEntry, commitView, captureView, rollbackView, onPhase});
    this.current = null; this.phase = 'boot'; this.request = 0;
  }
  setPhase(phase) { this.phase = phase; this.onPhase(phase); }
  async loadLocation(location, {restoredWorld = null, reason = 'exit'} = {}) {
    if (!['boot','map'].includes(this.phase)) throw new Error('当前操作尚未完成');
    const request = ++this.request, previous = this.current, checkpoint = this.captureView();
    let viewAttempted = false;
    this.setPhase('loading');
    try {
      const prepared = await this.prepare(location.map_id);
      if (request !== this.request) throw new Error('场景加载已取消');
      this.validateEntry(prepared, location);
      const next = restoredWorld ?? this.world.snapshot();
      next.location = {...location};
      if (!restoredWorld) next.revision = (next.revision + 1) >>> 0;
      const normalized = validateWorld(next, this.world.mapIds);
      // commitView must be synchronous and must not mutate persistent data.
      viewAttempted = true;
      this.commitView(prepared, location, reason);
      this.world.replace(normalized); this.current = prepared;
      this.setPhase('map'); return prepared;
    } catch (error) {
      this.current = previous;
      if (viewAttempted) this.rollbackView(checkpoint);
      this.setPhase(previous ? 'map' : 'boot'); throw error;
    }
  }
  canSave() { return this.phase === 'map' && this.current !== null; }
}
