// Presentation clocks for source CF4 idle objects. Triggering/collecting an
// object remains an event transaction, never an animation side effect.
export class MapObjectRuntime {
  constructor({objects,resources,mapFlagIndex}) {
    this.mapFlagIndex=mapFlagIndex;this.lastTime=null;
    this.actors=resources.map(({index,resource,behavior_raw_cf})=>{
      if(behavior_raw_cf!==4)throw new Error('地图物件待机类型尚未恢复');
      const object=objects.find(object=>object.index===index);
      if(!object)throw new Error('地图光效没有对应物件');
      const actor={object,resource,state:null,frame:0,elapsed:0};
      this.project(actor,0);return actor;
    });
  }
  project(actor,state) {
    // 4137C0: CF4 states 0/1 loop action0; 40CFE0 restores state3 at
    // action1's last logical frame. Never loop the collection action.
    const action=actor.resource.actions.find(action=>action.index===(state===3?1:0));
    if(!action)throw new Error('地图物件动作缺失');
    actor.state=state;
    if(state===3)actor.frame=action.logical_frames.length-1;
    actor.object.motion={main:action.main_bitmap,intrinsic:action.intrinsic_bitmap,
      width:actor.resource.frame_width,height:actor.resource.frame_height,
      frame:action.logical_frames[actor.frame]};
    return action;
  }
  update(now,{world,paused=false}) {
    const delta=this.lastTime===null?0:Math.max(0,now-this.lastTime);this.lastTime=now;
    for(const actor of this.actors){
      const record=world.event_records?.[this.mapFlagIndex]?.[actor.object.index];
      const state=record?parseInt(record.slice(0,2),16):0;
      if(state!==actor.state){actor.frame=0;actor.elapsed=0;}
      if(![0,1,3].includes(state)){
        // Active collection has its own event playback; do not fabricate it.
        actor.state=state;actor.object.motion=null;actor.elapsed=0;continue;
      }
      const action=this.project(actor,state);
      if(paused||delta>250){actor.elapsed=0;continue;}
      if(state===3)continue;
      actor.elapsed+=delta;
      const interval=Math.max(1,action.interval_raw),ticks=Math.floor(actor.elapsed/interval);
      actor.elapsed%=interval;
      actor.frame=(actor.frame+ticks)%action.logical_frames.length;this.project(actor,state);
    }
  }
}
