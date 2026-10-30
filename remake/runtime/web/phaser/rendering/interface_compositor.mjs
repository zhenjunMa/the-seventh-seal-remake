import {BattleSurface} from './battle_surface.mjs';
import {installInterfaceCompositor} from './recorded_surface.mjs';

// One shared WebGL context for every DOM-anchored UI surface. Move its output
// beside the active screen's pixel plane, retaining semantic DOM controls and
// their stacking order. Creating a renderer per label would exhaust contexts.
export class InterfaceCompositor {
  constructor(runtime){
    this.runtime=runtime;this.records=new Map();this.dirty=true;this.layoutDirty=true;this.frames=0;
    this.mount=document.createElement('div');this.mount.hidden=true;runtime.parent.append(this.mount);
    const owner=this,Phaser=globalThis.Phaser;
    class InterfaceScene extends Phaser.Scene{
      create(){owner.scene=this;owner.surface=new BattleSurface(this);owner.canvas=this.game.canvas;owner.canvas.className='gpu-interface-output';owner.canvas.setAttribute('aria-hidden','true');
        this.game.renderer.on(Phaser.Renderer.Events.LOSE_WEBGL,()=>runtime.pause('webgl-interface'));
        this.game.renderer.on(Phaser.Renderer.Events.RESTORE_WEBGL,()=>{owner.invalidate(true);runtime.resume('webgl-interface');});owner.resolve();}
      update(){try{owner.update();}catch(error){runtime.fail(error);}}
    }
    this.ready=new Promise(resolve=>{this.resolve=resolve;});
    this.game=new Phaser.Game({type:Phaser.WEBGL,parent:this.mount,width:640,height:480,transparent:true,antialias:false,antialiasGL:false,
      banner:false,audio:{noAudio:true},input:{keyboard:false,mouse:false,touch:false,gamepad:false},scene:[InterfaceScene]});
    this.observer=new MutationObserver(changes=>{
      if(changes.every(change=>change.target===this.canvas||change.target===this.mount))return;
      this.invalidate(true);
    });
    this.observer.observe(runtime.parent.parentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','style','class','width','height']});
    this.listeners=new AbortController();
    document.addEventListener('scroll',()=>this.invalidate(true),{capture:true,signal:this.listeners.signal});
    installInterfaceCompositor(this);
  }
  invalidate(layout=false){this.dirty=true;this.layoutDirty||=layout;}
  register(canvas,{embedded=false,glyph=false}={}){
    if(!this.records.has(canvas)){
      const opacity=Number.parseFloat(getComputedStyle(canvas).opacity);
      canvas.gpuOriginalOpacity??=Number.isFinite(opacity)?opacity:1;
      this.records.set(canvas,{canvas,embedded,glyph,lastSeen:this.frames});
      canvas.style.opacity='0';
      if(glyph)canvas.dataset.gpuGlyph='';
      this.invalidate(true);
    }
  }
  root(node){let root=node;const screen=this.runtime.parent.parentElement;while(root.parentElement&&root.parentElement!==screen)root=root.parentElement;return root;}
  geometry(record){
    const node=record.canvas,root=this.root(node),box=node.getBoundingClientRect();
    if(!box.width||!box.height||node.closest('[hidden]')||getComputedStyle(node).visibility==='hidden')return null;
    const clip={left:box.left,top:box.top,right:box.right,bottom:box.bottom};let alpha=node.gpuOriginalOpacity;
    for(let parent=node.parentElement;parent&&parent!==this.runtime.parent.parentElement;parent=parent.parentElement){
      const style=getComputedStyle(parent);
      alpha*=Number(style.opacity);
      if(/hidden|clip|auto|scroll/.test(style.overflowX+' '+style.overflowY)){const r=parent.getBoundingClientRect();
        if(/hidden|clip|auto|scroll/.test(style.overflowX)){clip.left=Math.max(clip.left,r.left);clip.right=Math.min(clip.right,r.right);}
        if(/hidden|clip|auto|scroll/.test(style.overflowY)){clip.top=Math.max(clip.top,r.top);clip.bottom=Math.min(clip.bottom,r.bottom);}}
    }
    return {...record,root,box,clip,alpha,z:Number.parseInt(getComputedStyle(root).zIndex)||0};
  }
  update(){
    if(!this.surface||this.runtime.destroyed||this.game.renderer.contextLost)return;this.frames++;
    if(this.frames%120===0&&this.records.size)this.invalidate(true);
    if(this.layoutDirty){
      // Cached glyph nodes can be detached and inserted again without painting.
      for(const node of this.runtime.parent.parentElement.querySelectorAll('canvas[data-gpu-glyph]'))if(!this.records.has(node))this.register(node,{glyph:true});
      this.visible=[];
      for(const [node,record]of this.records){
        if(!node.isConnected){if(this.frames-record.lastSeen>120)this.records.delete(node);continue;}
        record.lastSeen=this.frames;if(record.embedded)continue;
        const entry=this.geometry(record);if(entry)this.visible.push(entry);
      }
      this.visible.sort((a,b)=>a.z-b.z||((a.canvas.compareDocumentPosition(b.canvas)&Node.DOCUMENT_POSITION_FOLLOWING)?-1:1));
      this.layoutDirty=false;
    }
    if(!this.dirty)return;this.dirty=false;
    const visible=this.visible??[],top=visible.at(-1),entries=visible.filter(entry=>entry.z===(top?.z??0));
    const plane=entries.filter(entry=>!entry.glyph).at(-1)??top;
    this.surface.beginFrame();
    if(!plane){this.canvas.style.display='none';this.surface.endFrame();return;}
    const anchor=plane.canvas.closest('.operation-frame,.dialogue-viewport,.caption-viewport,.world-map-viewport,.save-menu-viewport,.startup-viewport');
    const base=anchor?.getBoundingClientRect()??plane.box,parent=anchor??plane.canvas.parentElement;
    if(this.canvas.parentElement!==parent){
      if(anchor)parent.append(this.canvas);else plane.canvas.after(this.canvas);
      this.canvas.style.cssText='position:absolute;inset:0;width:640px;height:480px;pointer-events:none;opacity:1';
      if(!anchor){const style=getComputedStyle(plane.canvas);Object.assign(this.canvas.style,{inset:'auto',left:style.left,top:style.top,transform:style.transform,transformOrigin:style.transformOrigin});}
      // Pixel planes precede semantic text / buttons in menus and save screens.
      const primary=entries.find(entry=>!entry.glyph&&entry.canvas.parentElement===parent);
      if(primary)primary.canvas.after(this.canvas);
    }
    this.canvas.style.display='block';
    const kx=640/base.width,ky=480/base.height;
    for(const entry of entries){const b=entry.box,c=entry.clip;if(c.right<=c.left||c.bottom<=c.top)continue;
      this.surface.save();this.surface.beginPath();this.surface.rect((c.left-base.left)*kx,(c.top-base.top)*ky,(c.right-c.left)*kx,(c.bottom-c.top)*ky);this.surface.clip();
      this.surface.globalAlpha=entry.alpha;this.surface.drawImage(entry.canvas,(b.left-base.left)*kx,(b.top-base.top)*ky,b.width*kx,b.height*ky);this.surface.restore();
    }
    this.surface.endFrame();
  }
  destroy(){installInterfaceCompositor(null);this.listeners.abort();this.observer.disconnect();this.records.clear();this.surface?.destroy();this.game.destroy(true);this.mount.remove();}
  snapshot(){return {renderer:'WEBGL',surfaces:this.records.size,visible:this.visible?.length??0,textures:this.surface?.textures.snapshot()};}
}
