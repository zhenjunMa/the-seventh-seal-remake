import {SpritePose} from '../components/sprite_pose.mjs';

// A transient scene object. Role identity, inventory and progress stay in WorldStore.
export class MapActor {
  constructor(scene,textures,key){
    this.key=key;this.container=scene.add.container();
    this.pose=new SpritePose(scene,this.container,textures);
  }
  sync(entry,depth){
    const pose=entry.pose;
    this.container.setPosition(pose.x,pose.y).setDepth(depth).setAlpha(entry.alpha??1).setVisible(true);
    this.pose.apply(pose);
    this.pose.body.setBlendMode(entry.blend==='lighter'?'ADD':'NORMAL');
  }
  destroy(){this.container.destroy();}
}
