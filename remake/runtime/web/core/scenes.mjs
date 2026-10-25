// Load and validate a destination before replacing the current world or scene.
import {validateWorld} from './world.mjs';
export class SceneController {
  constructor({world, prepare, validateEntry, commitView, enter = null, captureView = () => null, rollbackView = () => {}, onPhase = () => {},afterCommit=null}) {
    Object.assign(this, {world, prepare, validateEntry, commitView, enter, captureView, rollbackView, onPhase,afterCommit});
    this.current = null; this.phase = 'boot'; this.request = 0;
  }
  setPhase(phase) { this.phase = phase; this.onPhase(phase); }
  async loadLocation(location, {restoredWorld = null, reason = 'exit'} = {}) {
    if (!['boot','map'].includes(this.phase)) throw new Error('当前操作尚未完成');
    const request = ++this.request, previous = this.current, checkpoint = this.captureView(), before = this.world.snapshot();
    const checkCurrent = () => {
      if (request !== this.request || this.world.value.revision !== before.revision) throw new Error('场景加载期间世界状态已变化');
    };
    let viewAttempted = false,prepared,resumeExploration = true;
    this.setPhase('loading');
    try {
      prepared = await this.prepare(location.map_id,{world:restoredWorld??before});
      checkCurrent();
      this.validateEntry(prepared, location);
      const next = structuredClone(restoredWorld ?? before);
      next.location = {...location};
      if (!restoredWorld) next.revision = (next.revision + 1) >>> 0;
      validateWorld(next, this.world.mapIds);
      // commitView must be synchronous and must not mutate persistent data.
      viewAttempted = true;
      this.commitView(prepared, location, reason);
      this.current = prepared;
      checkCurrent();
      const entered = this.enter && await this.enter(prepared, next, reason);
      if (entered) {
        checkCurrent();
        resumeExploration = entered.resume_exploration !== false;
        if(resumeExploration){
          this.validateEntry(this.current, next.location);
          this.commitView(this.current, next.location, reason);
        }
      }
      checkCurrent();
      if (!restoredWorld) next.revision = (before.revision + 1) >>> 0;
      this.world.replace(validateWorld(next, this.world.mapIds));
      // A terminal entry commits its world before afterCommit presents the
      // title, without exposing exploration or validating a cinematic pose.
      this.setPhase(resumeExploration ? 'map' : 'event');
    } catch (error) {
      this.current = previous;
      if (viewAttempted) this.rollbackView(checkpoint);
      this.setPhase(previous ? 'map' : 'boot'); throw error;
    }
    // A terminal presentation observes a committed world. Its failure must
    // not roll the scene back while leaving the new world already committed.
    this.afterCommit?.({world:this.world,scene:this.current,reason});return prepared;
  }
  canSave() { return this.phase === 'map' && this.current !== null; }
}
