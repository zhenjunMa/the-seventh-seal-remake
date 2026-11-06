import {BattleSurface} from './battle_surface.mjs';
import {installInterfaceCompositor} from './recorded_surface.mjs';
import {characterPipeline,XBR_PIPELINE} from './xbr_pipeline.mjs';
import {elementImage,maintainDomImages,disposeDomImages} from '../../core/ui/image_dom.mjs';

// One shared WebGL context for every DOM-anchored UI surface. Move its output
// beside the active screen's pixel plane, retaining semantic DOM controls and
// their stacking order. Creating a renderer per label would exhaust contexts.
export class InterfaceCompositor {
  constructor(runtime){
    this.runtime=runtime;this.records=new Map();this.dirty=true;this.layoutDirty=true;this.frames=0;
    this.layoutRoots=new Set();this.fullLayout=true;this.layoutReads=0;this.rebuilds=0;
    this.mount=document.createElement('div');this.mount.hidden=true;runtime.parent.append(this.mount);
    const owner=this,Phaser=globalThis.Phaser;
    class InterfaceScene extends Phaser.Scene{
      create(){owner.scene=this;owner.surface=new BattleSurface(this);owner.canvas=this.game.canvas;owner.canvas.className='gpu-interface-output';owner.canvas.setAttribute('aria-hidden','true');
        const pipeline=this.game.renderer.pipelines.get(XBR_PIPELINE);
        this.game.renderer.pipelines.MULTI_PIPELINE=pipeline;pipeline.enabled=runtime.actorSmoothing;
        owner.resize();
        this.game.renderer.on(Phaser.Renderer.Events.LOSE_WEBGL,()=>runtime.pause('webgl-interface'));
        this.game.renderer.on(Phaser.Renderer.Events.RESTORE_WEBGL,()=>{owner.invalidate(true);runtime.resume('webgl-interface');});owner.resolve();}
      update(){try{owner.update();}catch(error){runtime.fail(error);}}
    }
    this.ready=new Promise(resolve=>{this.resolve=resolve;});
    this.game=new Phaser.Game({type:Phaser.WEBGL,parent:this.mount,width:640*runtime.renderScale,height:480*runtime.renderScale,transparent:true,antialias:false,antialiasGL:false,
      pipeline:{[XBR_PIPELINE]:characterPipeline(Phaser)},defaultPipeline:XBR_PIPELINE,autoMobilePipeline:false,
      banner:false,audio:{noAudio:true},input:{keyboard:false,mouse:false,touch:false,gamepad:false},scene:[InterfaceScene]});
    this.observer=new MutationObserver(changes=>{
      for(const change of changes){
        if(change.target===this.canvas||change.target===this.mount)continue;
        // A DOM image, navigation highlight or hidden page without glyphs does
        // not affect the shared GPU surfaces' geometry.
        const node=change.target;
        if(!this.records.has(node)&&!node.querySelector?.('canvas')&&
          ![...(change.removedNodes??[])].some(child=>this.records.has(child)||child.querySelector?.('canvas')))continue;
        if(node.parentElement?.closest('[hidden]'))continue;
        this.invalidate(true,node);
      }
    });
    this.observer.observe(runtime.parent.parentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','style','class','width','height','data-menu-page']});
    this.listeners=new AbortController();
    document.addEventListener('scroll',()=>this.invalidate(true),{capture:true,signal:this.listeners.signal});
    installInterfaceCompositor(this);
  }
  invalidate(layout=false,node=null){
    this.dirty=true;if(!layout)return;this.layoutDirty=true;
    if(node)this.layoutRoots.add(node);else this.fullLayout=true;
  }
  resize(){
    if(!this.scene)return;
    const scale=this.runtime.renderScale;
    if(this.renderScale===scale)return;
    this.renderScale=scale;this.game.scale.setGameSize(640*scale,480*scale);
    const camera=this.scene.cameras.main;
    camera.setZoom(scale).setScroll(320-camera.width/2,240-camera.height/2);
    Object.assign(this.canvas.style,{width:'640px',height:'480px'});
    this.invalidate(true);
  }
  register(canvas,{embedded=false,glyph=false}={}){
    if(!this.records.has(canvas)){
      const opacity=Number.parseFloat(getComputedStyle(canvas).opacity);
      canvas.gpuOriginalOpacity??=Number.isFinite(opacity)?opacity:1;
      this.records.set(canvas,{canvas,embedded,glyph,lastSeen:this.frames});
      canvas.style.opacity='0';
      if(glyph)canvas.dataset.gpuGlyph='';
      this.invalidate(true,canvas);
    }
  }
  root(node){let root=node;const screen=this.runtime.parent.parentElement;while(root.parentElement&&root.parentElement!==screen)root=root.parentElement;return root;}
  geometry(record){
    const node=record.canvas;if(node.closest('[hidden]'))return null;
    this.layoutReads++;
    const root=this.root(node),box=node.getBoundingClientRect();
    if(!box.width||!box.height||getComputedStyle(node).visibility==='hidden')return null;
    const clip={left:box.left,top:box.top,right:box.right,bottom:box.bottom};let alpha=node.gpuOriginalOpacity??Number(getComputedStyle(node).opacity);
    for(let parent=node.parentElement;parent&&parent!==this.runtime.parent.parentElement;parent=parent.parentElement){
      const style=getComputedStyle(parent);
      alpha*=Number(style.opacity);
      if(/hidden|clip|auto|scroll/.test(style.overflowX+' '+style.overflowY)){const r=parent.getBoundingClientRect();
        if(/hidden|clip|auto|scroll/.test(style.overflowX)){clip.left=Math.max(clip.left,r.left);clip.right=Math.min(clip.right,r.right);}
        if(/hidden|clip|auto|scroll/.test(style.overflowY)){clip.top=Math.max(clip.top,r.top);clip.bottom=Math.min(clip.bottom,r.bottom);}}
    }
    return {canvas:node,embedded:record.embedded,glyph:record.glyph,root,box,clip,alpha,z:Number.parseInt(getComputedStyle(root).zIndex)||0};
  }
  update(){
    if(!this.surface||this.runtime.destroyed||this.game.renderer.contextLost)return;this.frames++;
    maintainDomImages();
    if(this.frames%120===0&&this.records.size)this.invalidate(true);
    if(this.layoutDirty){
      // Cached glyph nodes can be detached and inserted again without painting.
      const roots=this.fullLayout?[this.runtime.parent.parentElement]:[...this.layoutRoots];
      for(const root of roots)for(const node of root.querySelectorAll?.('canvas[data-gpu-glyph]')??[])if(!this.records.has(node))this.register(node,{glyph:true});
      this.visible=[];
      for(const [node,record]of this.records){
        if(!node.isConnected){if(this.frames-record.lastSeen>120)this.records.delete(node);continue;}
        record.lastSeen=this.frames;if(record.embedded)continue;
        if(this.fullLayout||!record.measured||roots.some(root=>root===node||root.contains(node))){record.entry=this.geometry(record);record.measured=true;}
        if(record.entry)this.visible.push(record.entry);
      }
      this.visible.sort((a,b)=>a.z-b.z||((a.canvas.compareDocumentPosition(b.canvas)&Node.DOCUMENT_POSITION_FOLLOWING)?-1:1));
      this.layoutDirty=false;this.fullLayout=false;this.layoutRoots.clear();
    }
    if(!this.dirty)return;this.dirty=false;this.rebuilds++;
    const visible=this.visible??[],top=visible.at(-1),entries=visible.filter(entry=>entry.z===(top?.z??0));
    const plane=entries.filter(entry=>!entry.glyph).at(-1)??top;
    this.surface.beginFrame();
    if(!plane){this.canvas.style.display='none';this.surface.endFrame();return;}
    const anchor=plane.canvas.closest('.operation-frame,.dialogue-viewport,.caption-viewport,.map-name-viewport,.world-map-viewport,.save-menu-viewport,.startup-viewport');
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
  capture(root){
    const base=root?.getBoundingClientRect();
    if(!base?.width||!base.height||root.closest('[hidden]'))throw new Error('待转场的菜单画面不可见');
    const scene=this.runtime.transitions.scene,surface=new BattleSurface(scene),entries=[];
    try{
      for(const node of root.querySelectorAll('img,canvas')){
        if(node===this.canvas||this.records.get(node)?.embedded||node.tagName==='IMG'&&(!node.complete||!node.naturalWidth))continue;
        const entry=this.geometry({canvas:node});if(!entry||entry.alpha<=0)continue;
        // Glyphs are normally drawn by the shared output at z-index 6.
        // Replay their original sources, never copy the other WebGL canvas.
        entry.stack=[];
        for(let parent=node;parent&&parent!==root;parent=parent.parentElement){
          const z=getComputedStyle(parent).zIndex;if(z!=='auto')entry.stack.unshift(Number.parseInt(z)||0);
        }
        if(this.records.has(node)||node.gpuSurface||node.hasAttribute('data-gpu-glyph'))entry.stack=[6];
        entries.push(entry);
      }
      entries.sort((a,b)=>{
        for(let i=0;i<Math.max(a.stack.length,b.stack.length);i++){const delta=(a.stack[i]??0)-(b.stack[i]??0);if(delta)return delta;}
        return a.canvas.compareDocumentPosition(b.canvas)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1;
      });
      const kx=640/base.width,ky=480/base.height;
      surface.fillStyle='#000000';surface.fillRect(0,0,640,480);
      for(const entry of entries){
        const node=entry.canvas,b=entry.box,c=entry.clip;if(c.right<=c.left||c.bottom<=c.top)continue;
        surface.save();surface.beginPath();surface.rect((c.left-base.left)*kx,(c.top-base.top)*ky,(c.right-c.left)*kx,(c.bottom-c.top)*ky);surface.clip();
        surface.globalAlpha=entry.alpha;
        const natural=node.tagName==='IMG'&&getComputedStyle(node).objectFit==='none';
        surface.drawImage(elementImage(node),0,0,node.naturalWidth??node.width,node.naturalHeight??node.height,
          (b.left-base.left)*kx,(b.top-base.top)*ky,natural?node.naturalWidth:b.width*kx,natural?node.naturalHeight:b.height*ky);
        surface.restore();
      }
      surface.endFrame();
      const objects=Object.values(surface.pools).flat().sort((a,b)=>a.depth-b.depth);
      // Keep the immutable drawing objects for context restoration, detached
      // from the live scene. The snapshot owns their textures and disposal.
      for(const object of objects)scene.children.remove(object);
      return this.runtime.captureTexture(scene,{objects,onDestroy:()=>surface.destroy()});
    }catch(error){surface.destroy();throw error;}
  }
  destroy(){installInterfaceCompositor(null);disposeDomImages();this.listeners.abort();this.observer.disconnect();this.records.clear();this.surface?.destroy();this.game.destroy(true);this.mount.remove();}
  snapshot(){return {renderer:'WEBGL',surfaces:this.records.size,visible:this.visible?.length??0,layoutReads:this.layoutReads,rebuilds:this.rebuilds,textures:this.surface?.textures.snapshot()};}
}
