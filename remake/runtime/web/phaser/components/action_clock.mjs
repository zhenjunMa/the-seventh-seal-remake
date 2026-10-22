// One clock, driven by Phaser's frame loop. ANM parallelism, waits and aborts
// retain their existing promise contract without independent RAF callbacks.
export class ActionClock {
  constructor(){this.tasks=new Set();this.closed=false;}
  update(now){for(const task of [...this.tasks])if(this.tasks.has(task))task.tick(now);}
  requestFrame(callback){
    if(this.closed)throw new Error('游戏时钟已关闭');
    const task={tick:now=>{this.tasks.delete(task);callback(now);},cancel:()=>this.tasks.delete(task)};
    this.tasks.add(task);return task;
  }
  tween(duration,update,signals=[]){
    if(this.closed)return Promise.reject(new Error('游戏时钟已关闭'));
    return new Promise((resolve,reject)=>{
      const start=performance.now();let task;
      const cleanup=()=>{this.tasks.delete(task);for(const signal of signals)signal?.removeEventListener('abort',abort);};
      const finish=(error)=>{cleanup();error?reject(error):resolve();};
      const abort=()=>finish(signals.find(s=>s?.aborted)?.reason??new DOMException('动作已取消','AbortError'));
      task={cancel:finish,tick:now=>{
        try{const progress=Math.max(0,Math.min(1,(now-start)/Math.max(1,duration)));
          update(progress);if(progress===1)finish();}catch(error){finish(error);}
      }};
      if(signals.some(s=>s?.aborted)){abort();return;}
      for(const signal of signals)signal?.addEventListener('abort',abort,{once:true});
      this.tasks.add(task);
    });
  }
  destroy(){this.closed=true;for(const task of [...this.tasks])task.cancel(new Error('游戏时钟已关闭'));}
}
