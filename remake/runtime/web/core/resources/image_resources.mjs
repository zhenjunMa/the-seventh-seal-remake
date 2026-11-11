import {imageCatalog,imageDescriptor} from './image_catalog.mjs';
import {ownBitmap,evictBitmap} from './bitmap_residency.mjs';
import {loadHdImage} from './hd_images.mjs';
import {hdAnimation,readAnimationBitmap,selectAnimationRegions} from './hd_animations.mjs';

// Scope-owned decoded images. A failed load can be retried; releasing an
// unused scene also releases the cache's references to its decoded pixels.
export class ImageResources {
  constructor({createImage = () => new Image()} = {}) {
    this.createImage = createImage;
    this.entries = new Map();
    this.pages = new Map();
    this.clock = 0;
    this.revision = 0;
  }
  load(path, scope = 'shared') {
    let entry = this.entries.get(path);
    if (entry) {
      if (!entry.scopes.has(scope)) { entry.scopes.add(scope); this.revision++; }
      return entry.promise;
    }
    entry = {scopes:new Set([scope]), bitmap:null, promise:null};
    this.entries.set(path, entry);
    this.revision++;
    const descriptor=imageDescriptor(path);
    const hd=loadHdImage(path,descriptor,this.createImage);
    const original=()=>this.loadOriginal(path,entry,descriptor);
    entry.promise=(hd?hd.then(image=>image??original()):original()).then(image=>{
      entry.bitmap=image;
      if(this.entries.get(path)!==entry)this.prunePages();
      return image;
    }).catch(error=>{
      if(this.entries.get(path)===entry){this.entries.delete(path);this.revision++;}
      this.prunePages();throw error;
    });
    return entry.promise;
  }
  loadOriginal(path,entry,descriptor){
    if(descriptor){
      const plan=hdAnimation(path,descriptor);
      return plan?plan.then(animation=>this.loadPacked(path,entry,descriptor,animation)):this.loadPacked(path,entry,descriptor);
    }
    return new Promise((resolve, reject) => {
      const bitmap = this.createImage();
      bitmap.onload = () => { bitmap.onload = bitmap.onerror = null; resolve(bitmap); };
      bitmap.onerror = () => {
        bitmap.onload = bitmap.onerror = null;
        reject(new Error(`图像加载失败：${path}`));
      };
      bitmap.src = path;
    });
  }
  async loadPacked(path,entry,descriptor,animation){
    let regions=descriptor.regions;
    if(animation){
      entry.pages=new Set(animation.pages.keys());
      const ready=new Set();
      await Promise.all([...animation.pages].map(async ([index,page])=>{
        try{await this.page(index,page);ready.add(index);}catch{/* An invalid optional page falls back per frame. */}
      }));
      regions=selectAnimationRegions(descriptor,animation,index=>ready.has(index));
    }
    entry.pages=new Set(regions.map(r=>r[4]));
    await Promise.all([...entry.pages].filter(index=>!animation?.pages.has(index)).map(index=>this.page(index)));
    if(animation)this.prunePages();
    return {packed:true,path,width:descriptor.width,height:descriptor.height,regions,pool:this};
  }
  page(index,hdPage){
    let entry=this.pages.get(index);if(entry)return entry.promise;
    const page=hdPage??imageCatalog().pages[index];
    entry={bitmap:null,promise:null,used:++this.clock};this.pages.set(index,entry);
    const read=hdPage?readAnimationBitmap(page):new Promise((resolve,reject)=>{
      const bitmap=this.createImage();
      bitmap.onload=()=>{bitmap.onload=bitmap.onerror=null;
        if(bitmap.width!==page.width||bitmap.height!==page.height){reject(new Error('图片纹理页尺寸不符：'+page.path));return;}
        resolve(bitmap);};
      bitmap.onerror=()=>{bitmap.onload=bitmap.onerror=null;reject(new Error('图片纹理页加载失败：'+page.path));};
      bitmap.src=page.path;
    });
    entry.promise=read.then(bitmap=>{entry.bitmap=bitmap;ownBitmap(bitmap,this,index);return bitmap;})
      .catch(error=>{if(this.pages.get(index)===entry)this.pages.delete(index);throw error;});
    return entry.promise;
  }
  prunePages(){
    const held=new Set([...this.entries.values()].flatMap(entry=>[...(entry.pages??[])]));
    for(const [index,entry]of this.pages)if(!held.has(index)){
      this.pages.delete(index);if(entry.bitmap)evictBitmap(entry.bitmap);
      else entry.promise.then(bitmap=>evictBitmap(bitmap),()=>{});
    }
  }
  release(scope){
    for(const [path,entry]of this.entries){entry.scopes.delete(scope);if(!entry.scopes.size){this.entries.delete(path);this.revision++;}}
    this.prunePages();
  }
  peek(path) { return this.entries.get(path)?.bitmap ?? null; }
  async attach(target, path, scope, property = 'bitmap') {
    const bitmap = await this.load(path, scope);
    const entry = this.entries.get(path);
    if (entry?.bitmap === bitmap && entry.scopes.has(scope)) target[property] = bitmap;
    return bitmap;
  }
  async loadMany(paths, scope) { return Promise.all([...new Set(paths)].map(path => this.load(path, scope))); }
  retainScopes(scopes) {
    const keep = new Set(scopes);
    let released = 0;
    for (const [path, entry] of this.entries) {
      for (const scope of entry.scopes) if (!keep.has(scope)) { entry.scopes.delete(scope); this.revision++; }
      if (!entry.scopes.size) { this.entries.delete(path); released++; this.revision++; }
    }
    this.prunePages();return released;
  }
  snapshot() {
    let ready = 0, decodedBytes = 0;
    const scopes = new Set();
    for (const entry of this.entries.values()) {
      for (const scope of entry.scopes) scopes.add(scope);
      if (entry.bitmap) {
        ready++;
        const {packed,pixelScale,width,height}=entry.bitmap;
        if(!packed||pixelScale)decodedBytes+=width*height*(pixelScale??1)**2*4;
      }
    }
    for(const entry of this.pages.values())if(entry.bitmap)decodedBytes+=entry.bitmap.width*entry.bitmap.height*4;
    return {entries:this.entries.size, ready, pending:this.entries.size - ready,
      estimatedDecodedBytes:decodedBytes, scopes:[...scopes].sort()};
  }
}
