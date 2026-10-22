// Native helpers 4304A0 / 4305D0 / 430690, retained in startup_rules.json.
// Browser playback supplies completion; stale media events cannot advance a new session.
export class StartupSequence {
  constructor(onChange = () => {}) { this.onChange=onChange; this.stage='closed'; this.epoch=0; }
  enter(stage) { this.stage=stage; this.epoch++; this.onChange(this.snapshot()); }
  start() { this.enter('gametitle'); }
  close() { this.enter('closed'); }
  complete(epoch=this.epoch) {
    if(epoch!==this.epoch)return false;
    const next={gametitle:'preopenpress',preopenpress:'openpress'}[this.stage];
    if(!next)return false;
    this.enter(next);return true;
  }
  fail(epoch=this.epoch) {
    if(epoch!==this.epoch)return false;
    if(this.stage==='openpress'){this.enter('menu');return true;}
    return this.complete(epoch);
  }
  key(key,repeat=false) {
    if(!['gametitle','preopenpress','openpress'].includes(this.stage))return false;
    if(!repeat&&this.stage==='gametitle'&&key==='Escape')this.complete();
    else if(!repeat&&this.stage==='openpress')this.enter('menu');
    return true;
  }
  pointer(button=0) {
    if(!['gametitle','preopenpress','openpress'].includes(this.stage))return false;
    if(this.stage==='openpress'&&[0,2].includes(button))this.enter('menu');
    return true;
  }
  snapshot() { return {stage:this.stage,epoch:this.epoch}; }
}
