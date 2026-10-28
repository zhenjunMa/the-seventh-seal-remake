import {CaptionPlayback,captionLayout} from './core/caption.mjs';
import {createMenuTextRenderer} from './core/menu_text.mjs';

export class CaptionView {
  static async create({manifest,fonts,image,...options}) {
    const resources={};
    await Promise.all(Object.entries(manifest.resources).map(async([key,value])=>{
      resources[key]={...value,bitmaps:await Promise.all(value.frames.map(frame=>image(frame.image)))};
    }));
    return new CaptionView({...options,manifest,resources,font:fonts.fonts.caption19,textRenderer:await createMenuTextRenderer(fonts)});
  }
  constructor({root,manifest,resources,font,textRenderer,onAdvance,log,clock=null}) {
    Object.assign(this,{root,manifest,resources,font,textRenderer,onAdvance,log,clock});
    this.canvas=root.querySelector('canvas');this.context=this.canvas.getContext('2d');
    this.button=root.querySelector('button');this.label=root.querySelector('p');
    this.ink=document.createElement('canvas');this.active=false;this.epoch=0;
    this.button.onclick=()=>this.onAdvance();
    // Confirmation belongs to the window's keydown handler. Consume keyup
    // too, so a focused button cannot synthesize a second Space click.
    this.button.onkeyup=event=>{if(event.key===' '||event.key==='Enter')event.preventDefault();};
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(root.parentElement);
  }
  resize(){
    const box=this.root.parentElement.getBoundingClientRect();
    this.root.style.setProperty('--caption-scale',String(Math.min(box.width/640,box.height/480)));
  }
  show(text) {
    this.close();this.active=true;this.root.hidden=false;this.label.textContent=text;
    this.layout=captionLayout(text,this.manifest.font_height,{
      font:this.font,characterStep:this.manifest.character_step,
      waitWidth:this.resources.wait.width,waitHeight:this.resources.wait.height});
    this.playback=new CaptionPlayback(text,this.now(),this.manifest.character_interval_ms);
    this.lastText=null;this.resize();this.button.focus({preventScroll:true});
    const epoch=this.epoch;
    const frame=now=>{if(!this.active||this.epoch!==epoch)return;this.draw(now);this.scheduleFrame(frame);};
    this.draw(this.now());this.scheduleFrame(frame);
    this.log?.({type:'caption-open',style:3,text,layout:this.layout});
  }
  now(){return this.clock?.time??performance.now();}
  scheduleFrame(frame){
    if(this.clock)this.frameTask=this.clock.requestFrame(frame);
    else this.raf=requestAnimationFrame(frame);
  }
  draw(now) {
    if(!this.active)return;
    const text=this.playback.tick(now),{manifest:m,resources:r,layout:l,context:c}=this;
    if(text!==this.lastText){
      this.inkBounds=this.textRenderer.paint(this.ink,text,{font:'caption19',foreground:m.foreground,
        shadow:m.shadow,shadowOffsets:[[1,1]],advanceOverride:m.character_step});this.lastText=text;
    }
    c.clearRect(0,0,640,480);c.imageSmoothingEnabled=false;
    c.fillStyle='#00000080';c.fillRect(l.shade.x,l.shade.y,l.shade.width,l.shade.height);
    c.drawImage(this.ink,l.text.x+this.inkBounds.offsetX,l.text.y+this.inkBounds.offsetY);
    if(this.playback.complete){
      const index=Math.floor(now/r.wait.interval_ms)%r.wait.bitmaps.length;
      c.drawImage(r.wait.bitmaps[index],l.wait.x,l.wait.y);
    }
    this.root.dataset.complete=String(this.playback.complete);
    this.root.dataset.revealed=String(this.playback.revealed);
  }
  advance(){
    if(!this.active||this.clock?.paused||this.clock?.closed)return false;
    const done=this.playback.advance();
    if(done)this.close();else this.draw(this.now());
    return done;
  }
  close(){
    this.active=false;this.epoch++;this.frameTask?.cancel();this.frameTask=null;cancelAnimationFrame(this.raf);this.root.hidden=true;
    this.context?.clearRect(0,0,640,480);this.label.textContent='';
    delete this.root.dataset.complete;delete this.root.dataset.revealed;
  }
}
