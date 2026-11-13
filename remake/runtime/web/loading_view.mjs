import {drawImageRegion} from './core/resources/image_regions.mjs';
import {drawingContext} from './phaser/rendering/recorded_surface.mjs';
// Original Progress01 + Progress.mnu in a fixed 640x480 viewport.
export class LoadingView {
  static async create({manifest,image,...options}) {
    const [backgrounds,frame,fill]=await Promise.all([
      Promise.all(manifest.backgrounds.map(item=>image(item.image))),image(manifest.frame),image(manifest.fill)]);
    return new LoadingView({...options,manifest,backgrounds,frame,fill});
  }
  constructor({root,manifest,backgrounds,frame,fill,log}) {
    Object.assign(this,{root,manifest,backgrounds,frame,fill,log});
    this.canvas=root.querySelector('canvas');this.context=drawingContext(this.canvas);
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(root.parentElement);
  }
  resize(){const box=this.root.parentElement.getBoundingClientRect();
    this.root.style.setProperty('--loading-scale',String(Math.min(box.width/640,box.height/480)));}
  draw(progress){
    const c=this.context,{origin:o,fill_rect:r}=this.manifest;
    c.clearRect(0,0,640,480);c.imageSmoothingEnabled=false;drawImageRegion(c,this.backgrounds[this.backgroundIndex],0,0);
    drawImageRegion(c,this.frame,o.x,o.y);c.fillStyle='#000';c.fillRect(o.x+r.left,o.y+r.top,this.fill.width,this.fill.height);
    const width=Math.floor(this.fill.width*progress);
    if(width)drawImageRegion(c,this.fill,0,0,width,this.fill.height,o.x+r.left,o.y+r.top,width,this.fill.height);
  }
  async run(kind,work) {
    if(!this.root.hidden)throw new Error('场景正在加载，请稍候');
    const started=performance.now();
    this.backgroundIndex=Math.floor(Math.random()*this.backgrounds.length);
    this.root.hidden=false;this.root.dataset.kind=kind;this.root.dataset.progress='0';
    let active=true,progress=0;
    const close=()=>{
      if(!active)return;
      active=false;this.root.hidden=true;
      delete this.root.dataset.kind;delete this.root.dataset.progress;
    };
    const finish=()=>{
      if(!active)return;
      close();
      this.log?.({type:`${kind}-loading-complete`,elapsed_ms:performance.now()-started});
    };
    try{
      this.resize();this.draw(0);
      this.log?.({type:`${kind}-loading-start`,background:this.backgroundIndex});
      const result=await work(({completed,total})=>{
        if(!active)return;
        // Leave the end of the bar for validation and first-frame preparation.
        progress=Math.max(progress,.95*Math.min(1,Math.max(0,completed/Math.max(1,total))));
        this.root.dataset.progress=String(progress);this.draw(progress);
      },finish);
      finish();
      return result;
    }finally{close();}
  }
}
