// Original Progress01 + Progress.mnu in a fixed 640x480 viewport.
import {playbackFrame,playbackDelay,playbackTask} from './core/story_playback.mjs';
export class LoadingView {
  static async create({manifest,image,...options}) {
    const [backgrounds,frame,fill]=await Promise.all([
      Promise.all(manifest.backgrounds.map(item=>image(item.image))),image(manifest.frame),image(manifest.fill)]);
    return new LoadingView({...options,manifest,backgrounds,frame,fill});
  }
  constructor({root,manifest,backgrounds,frame,fill,log,clock=null}) {
    Object.assign(this,{root,manifest,backgrounds,frame,fill,log,clock});
    this.canvas=root.querySelector('canvas');this.context=this.canvas.getContext('2d');this.nextBackground=0;
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(root.parentElement);
  }
  resize(){const box=this.root.parentElement.getBoundingClientRect();
    this.root.style.setProperty('--loading-scale',String(Math.min(box.width/640,box.height/480)));}
  draw(progress){
    const c=this.context,{origin:o,fill_rect:r}=this.manifest;
    c.imageSmoothingEnabled=false;c.drawImage(this.backgrounds[this.backgroundIndex],0,0);
    c.drawImage(this.frame,o.x,o.y);c.fillStyle='#000';c.fillRect(o.x+r.left,o.y+r.top,this.fill.width,this.fill.height);
    const width=Math.floor(this.fill.width*progress);
    if(width)c.drawImage(this.fill,0,0,width,this.fill.height,o.x+r.left,o.y+r.top,width,this.fill.height);
  }
  async run(mapId,work,{signal,kind='opening',minimumDisplayMs=this.manifest.minimum_display_ms,clock=this.clock}={}) {
    signal?.throwIfAborted();
    const now=()=>clock?.time??performance.now(),started=now();this.backgroundIndex=this.nextBackground++%this.backgrounds.length;
    this.root.hidden=false;this.root.dataset.map=mapId;this.root.dataset.kind=kind;this.root.dataset.progress='0';this.resize();this.draw(0);
    this.log?.({type:`${kind}-loading-start`,map_id:mapId,background:this.backgroundIndex});
    try{
      // Paint before beginning preparation, including a memory-cache hit.
      await playbackFrame(clock,signal);await playbackFrame(clock,signal);
      signal?.throwIfAborted();
      let progress=0;
      const scene=await playbackTask(work(({completed,total})=>{
        signal?.throwIfAborted();
        progress=Math.max(progress,Math.min(1,Math.max(0,completed/Math.max(1,total))));
        this.root.dataset.progress=String(progress);this.draw(progress);
      }),signal);
      signal?.throwIfAborted();
      this.root.dataset.progress='1';this.draw(1);
      const remaining=minimumDisplayMs-(now()-started);
      if(remaining>0)await playbackDelay(remaining,{clock,signal});
      signal?.throwIfAborted();
      this.log?.({type:`${kind}-loading-complete`,map_id:mapId,elapsed_ms:now()-started});
      return scene;
    }finally{this.root.hidden=true;delete this.root.dataset.map;delete this.root.dataset.kind;delete this.root.dataset.progress;}
  }
}
