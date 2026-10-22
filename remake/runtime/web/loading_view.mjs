// Original Progress01 + Progress.mnu in a fixed 640x480 viewport.
export class LoadingView {
  static async create({manifest,image,...options}) {
    const [backgrounds,frame,fill]=await Promise.all([
      Promise.all(manifest.backgrounds.map(item=>image(item.image))),image(manifest.frame),image(manifest.fill)]);
    return new LoadingView({...options,manifest,backgrounds,frame,fill});
  }
  constructor({root,manifest,backgrounds,frame,fill,log}) {
    Object.assign(this,{root,manifest,backgrounds,frame,fill,log});
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
  async run(mapId,work,{signal,kind='opening',minimumDisplayMs=this.manifest.minimum_display_ms}={}) {
    signal?.throwIfAborted();
    const started=performance.now();this.backgroundIndex=this.nextBackground++%this.backgrounds.length;
    this.root.hidden=false;this.root.dataset.map=mapId;this.root.dataset.kind=kind;this.root.dataset.progress='0';this.resize();this.draw(0);
    this.log?.({type:`${kind}-loading-start`,map_id:mapId,background:this.backgroundIndex});
    let timer;
    try{
      // Paint before beginning preparation, including a memory-cache hit.
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      signal?.throwIfAborted();
      let progress=0;
      const scene=await work(({completed,total})=>{
        signal?.throwIfAborted();
        progress=Math.max(progress,Math.min(1,Math.max(0,completed/Math.max(1,total))));
        this.root.dataset.progress=String(progress);this.draw(progress);
      });
      this.root.dataset.progress='1';this.draw(1);
      const remaining=minimumDisplayMs-(performance.now()-started);
      if(remaining>0)await new Promise((resolve,reject)=>{
        const abort=()=>{clearTimeout(timer);reject(signal.reason);};
        timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},remaining);
        signal?.addEventListener('abort',abort,{once:true});
      });
      signal?.throwIfAborted();
      this.log?.({type:`${kind}-loading-complete`,map_id:mapId,elapsed_ms:performance.now()-started});
      return scene;
    }finally{clearTimeout(timer);this.root.hidden=true;delete this.root.dataset.map;delete this.root.dataset.kind;delete this.root.dataset.progress;}
  }
}
