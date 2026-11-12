import {bitmapResident,onBitmapEvicted} from '../../core/resources/bitmap_residency.mjs';
import {imageRegions} from '../../core/resources/image_regions.mjs';
let serial=0;

// ImageResources and BattleResources keep ownership of decoded pixels and hashes.
// This cache only owns Phaser textures / frames referencing those same pixels.
export class TextureCache {
  constructor(scene,{idleFrames=120,budgetBytes=64*1024*1024,maxFrames=512}={}){
    Object.assign(this,{scene,idleFrames,budgetBytes,maxFrames});this.sources=new WeakMap();this.entries=new Set();this.frame=0;
    const gl=scene.game?.renderer?.gl;this.maxSize=Math.min(4096,gl?gl.getParameter(gl.MAX_TEXTURE_SIZE):2048);
    this.cuts=new WeakMap();this.cutOwners=new WeakMap();
    this.unsubscribe=onBitmapEvicted((source,retain)=>{
      const entry=this.sources.get(source);
      if(!entry||entry.releaseBitmap)return;
      // Phaser 在场景更新结束后才绘制，暂停时还会重用上次的精灵列表。
      if(entry.used===this.frame)entry.releaseBitmap=retain();
      else this.remove(entry);
    });
    this.stats={created:0,removed:0,frames_created:0,uploads:0,uploaded_bytes:0};
  }
  begin(){this.frame++;}
  // Padding is virtual: the shader treats samples outside bounds as transparent.
  // A pose stays on its atlas page, including when smoothing is switched off.
  actorFrame(source,sx,sy,sw,sh,patches=imageRegions(source,sx,sy,sw,sh)){
    if(!patches.length)return null;
    if(patches.length!==1)throw new Error('人物帧必须在构建时完整放入同一纹理页');
    const p=patches[0];
    let bitmap=p.bitmap,px=p.sx,py=p.sy;
    // Compatibility for developer PNG exports made before offline pagination.
    // Catalog-backed production frames never enter this raster-cut branch.
    if(!source.packed&&(bitmap.width>this.maxSize||bitmap.height>this.maxSize)){
      const frame=this.region(bitmap,px,py,p.width,p.height);
      bitmap=this.scene.textures.get(frame.key).getSourceImage();px-=Math.floor(px);py-=Math.floor(py);
    }
    return {bitmap,sx:px-2,sy:py-2,x:p.x-sx-2,y:p.y-sy-2,
      width:p.width+4,height:p.height+4,bounds:{x:px,y:py,width:p.width,height:p.height}};
  }
  actorRegion(source,x,y,width,height){
    if(!source.packed)return this.region(source,x,y,width,height);
    const patches=imageRegions(source,x,y,width,height);
    if(patches[0]?.pixelScale>1)return this.region(source,x,y,width,height);
    const pose=this.actorFrame(source,x,y,width,height,patches);
    if(!pose)return {key:'__WHITE',frame:'__BASE',empty:true};
    const entry=this.texture(pose.bitmap),id=`actor:${pose.sx},${pose.sy},${pose.width},${pose.height},${pose.x},${pose.y},${width},${height}`;
    if(!entry.texture.has(id)){
      entry.texture.add(id,0,pose.sx,pose.sy,pose.width,pose.height).setTrim(width,height,pose.x,pose.y,pose.width,pose.height);
      this.stats.frames_created++;
    }
    entry.frames.set(id,this.frame);return {key:entry.key,frame:id,bounds:pose.bounds};
  }
  texture(source){
    if(!source)throw new Error('Phaser 素材尚未准备');
    if(source.width>this.maxSize||source.height>this.maxSize)throw new Error('纹理超过分页上限，请通过区域缓存加载');
    let entry=this.sources.get(source);
    if(entry&&source.gpuRasterRevision!==undefined&&(entry.texture.source[0].width!==source.width||entry.texture.source[0].height!==source.height)){this.remove(entry);entry=null;}
    if(!entry){
      const key=`seal:${++serial}`;
      const texture=source.gpuRasterRevision!==undefined?this.scene.textures.addCanvas(key,source):this.scene.textures.addImage(key,source);
      if(!texture)throw new Error(`Phaser 无法建立纹理：${key}`);
      texture.setFilter(1); // Phaser.Textures.FilterMode.NEAREST; preserve source pixels.
      entry={key,texture,source,used:this.frame,revision:source.gpuRasterRevision,frames:new Map(),bytes:source.width*source.height*4};this.sources.set(source,entry);this.entries.add(entry);this.stats.created++;
      this.stats.uploads++;this.stats.uploaded_bytes+=entry.bytes;
    }
    if(source.gpuRasterRevision!==undefined&&entry.revision!==source.gpuRasterRevision){entry.texture.refresh();entry.revision=source.gpuRasterRevision;this.stats.uploads++;this.stats.uploaded_bytes+=entry.bytes;}
    entry.used=this.frame;return entry;
  }
  region(source,x=0,y=0,width=source.width,height=source.height,name=`${x},${y},${width},${height}`){
    if(source.packed){
      const patches=imageRegions(source,x,y,width,height);
      if(!patches.length)return {key:'__WHITE',frame:'__BASE',empty:true};
      if(patches.length!==1)throw new Error('单个精灵帧跨纹理页，请重新构建图片资源');
      const p=patches[0];
      if(p.pixelScale!==1){
        const frame=this.region(p.bitmap,p.sx,p.sy,p.width*p.pixelScale,p.height*p.pixelScale);
        return {...frame,pixelScale:p.pixelScale,x:p.x-x,y:p.y-y,width:p.width,height:p.height};
      }
      const entry=this.texture(p.bitmap),id=`packed:${p.sx},${p.sy},${p.width},${p.height},${p.x-x},${p.y-y},${width},${height}`;
      if(!entry.texture.has(id)){
        const frame=entry.texture.add(id,0,p.sx,p.sy,p.width,p.height);
        frame.setTrim(width,height,p.x-x,p.y-y,p.width,p.height);this.stats.frames_created++;
      }
      entry.frames.set(id,this.frame);return {key:entry.key,frame:id};
    }
    if(source.width>this.maxSize||source.height>this.maxSize){
      const left=Math.floor(x),top=Math.floor(y),w=Math.ceil(x+width)-left,h=Math.ceil(y+height)-top;
      if(w>this.maxSize||h>this.maxSize)throw new Error('单个显示区域超过 GPU 纹理分页上限');
      let cuts=this.cuts.get(source);if(!cuts){cuts=new Map();this.cuts.set(source,cuts);}
      const key=`${left},${top},${w},${h}`;let bitmap=cuts.get(key);
      if(!bitmap){bitmap=document.createElement('canvas');bitmap.width=w;bitmap.height=h;
        bitmap.getContext('2d').drawImage(source,left,top,w,h,0,0,w,h);cuts.set(key,bitmap);this.cutOwners.set(bitmap,{cuts,key});}
      return this.region(bitmap,x-left,y-top,width,height,name);
    }
    const entry=this.texture(source),old=entry.texture.frames[name];
    if(old&&(old.cutX!==x||old.cutY!==y||old.cutWidth!==width||old.cutHeight!==height))entry.texture.remove(name);
    if(!entry.texture.has(name)){entry.texture.add(name,0,x,y,width,height);this.stats.frames_created++;}
    entry.frames.set(name,this.frame);
    return {key:entry.key,frame:name};
  }
  tiles(source){
    if(source.packed)return imageRegions(source).map(p=>({x:p.x,y:p.y,width:p.width,height:p.height,
      ...this.region(p.bitmap,p.sx,p.sy,p.width*p.pixelScale,p.height*p.pixelScale)}));
    const result=[];for(let y=0;y<source.height;y+=this.maxSize)for(let x=0;x<source.width;x+=this.maxSize){
    const width=Math.min(this.maxSize,source.width-x),height=Math.min(this.maxSize,source.height-y);result.push({x,y,width,height,...this.region(source,x,y,width,height)});
  }return result;}
  prune(){
    for(const entry of this.entries)if(entry.releaseBitmap&&entry.used!==this.frame)this.remove(entry);
    // Atlas residency belongs to BattleResources. Dropping a texture merely
    // because its animation changed pages would undo that cache under WebGL.
    const unmanaged=[...this.entries].filter(entry=>bitmapResident(entry.source)===null).sort((a,b)=>a.used-b.used);
    let bytes=unmanaged.reduce((sum,entry)=>sum+entry.bytes,0);
    for(const entry of unmanaged)if(entry.used<this.frame&&(this.frame-entry.used>this.idleFrames||bytes>this.budgetBytes||entry.source.width===0)){
      this.remove(entry);bytes-=entry.bytes;
    }
    for(const entry of this.entries)if(entry.frames.size>this.maxFrames)for(const [name,used]of entry.frames){
      if(entry.frames.size<=this.maxFrames)break;
      if(used===this.frame)continue;entry.texture.remove(name);entry.frames.delete(name);
    }
  }
  remove(entry){
    this.scene.textures.remove(entry.key);
    this.sources.delete(entry.source);
    this.entries.delete(entry);
    const owner=this.cutOwners.get(entry.source);owner?.cuts.delete(owner.key);
    entry.releaseBitmap?.();
    this.stats.removed++;
  }
  snapshot(){return {...this.stats,resident:this.entries.size,bytes:[...this.entries].reduce((sum,e)=>sum+e.bytes,0)};}
  destroy(){this.unsubscribe();for(const entry of [...this.entries])this.remove(entry);this.sources=new WeakMap();}
}
