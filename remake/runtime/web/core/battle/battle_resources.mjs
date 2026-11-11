import {ownBitmap,bitmapResident,onBitmapEvicted,evictBitmap} from '../resources/bitmap_residency.mjs';
import {loadHdImage} from '../resources/hd_images.mjs';
import {hdAnimation,knownHdAnimation,selectAnimationRegions} from '../resources/hd_animations.mjs';
export {drawImageRegion as drawBattleImage} from '../resources/image_regions.mjs';

// Shared, verified battle atlases. Views retain geometry, never private bitmap copies.
const canonical=path=>'/'+path.replace(/^\/+/, '');
const need=(ok,message)=>{if(!ok)throw new Error(`战斗资源：${message}`);};
const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
const safe=path=>/^\/assets\/battle_packs\/[a-f0-9]{24}\.png$/.test(path);
export {bitmapResident as battleBitmapResident,onBitmapEvicted as onBattleBitmapEvicted};

export class BattleResources {
  constructor({read=fetch.bind(globalThis),decode=blob=>createImageBitmap(blob),budgetBytes=192*1024*1024}={}){
    Object.assign(this,{read,decode,budgetBytes});this.pages=new Map();this.pending=new Map();this.requests=new Map();this.scopes=new Map();this.leases=new Map();this.preparations=new Map();this.clock=0;
    this.stats={page_requests:0,page_decodes:0,page_hits:0,evictions:0,request_ms:0,verify_ms:0,decode_ms:0,peak_decoded_bytes:0};
    this.failedAnimationPages=new Set();
  }
  async catalog(){
    if(!this.catalogPromise)this.catalogPromise=(async()=>{
      const response=await this.read('/data/battle_packs.json',{cache:'no-cache'});
      need(response.ok,'图集清单读取失败');const data=await response.json();
      need(data.schema==='seventh-seal-battle-packs'&&data.version===1&&Array.isArray(data.pages)&&data.images&&data.manifests,'图集清单无效');
      for(const page of data.pages)need(safe(page.path)&&/^[a-f0-9]{64}$/.test(page.sha256)&&Number.isInteger(page.width)&&page.width>0&&page.width<=2048&&Number.isInteger(page.height)&&page.height>0&&page.height<=2048,'图集描述无效');
      let checked=0,started=performance.now();
      for(const image of Object.values(data.images)){
        need(image.width>0&&image.height>0&&/^[a-f0-9]{64}$/.test(image.sha256)&&Array.isArray(image.regions),'图片描述无效');
        for(const region of image.regions){const [x,y,w,h,index,px,py]=region,page=data.pages[index];
          need(region.length===7&&region.every(Number.isInteger)&&page&&x>=0&&y>=0&&w>0&&h>0&&x+w<=image.width&&y+h<=image.height&&px>=0&&py>=0&&px+w<=page.width&&py+h<=page.height,'图集坐标无效');
        }
        if(++checked%256===0&&performance.now()-started>=4){
          await new Promise(resolve=>setTimeout(resolve,0));started=performance.now();
        }
      }
      this.data=data;return data;
    })().catch(error=>{this.catalogPromise=null;throw error;});
    return this.catalogPromise;
  }
  async json(path,expectedHash){
    const data=await this.catalog(),entry=data.manifests[canonical(path)];
    need(entry&&(!expectedHash||expectedHash===entry.sha256),'来源清单与图集不一致，请重新导出');
    return structuredClone(entry.value);
  }
  async page(index,hdPage){
    if(this.pages.has(index)){const entry=this.pages.get(index);entry.used=++this.clock;this.stats.page_hits++;return entry.bitmap;}
    if(this.pending.has(index)&&!this.requests.get(index)?.signal.aborted)return this.pending.get(index);
    const page=hdPage??this.data.pages[index];
    const controller=new AbortController();this.requests.set(index,controller);
    const promise=(async()=>{
      let started=performance.now();this.stats.page_requests++;const response=await this.read(page.path,{cache:'force-cache',signal:controller.signal});
      need(response.ok,'图集读取失败');const bytes=await response.arrayBuffer();
      this.stats.request_ms+=performance.now()-started;started=performance.now();
      need(await sha(bytes)===page.sha256,'图集指纹不符');this.stats.verify_ms+=performance.now()-started;started=performance.now();
      const bitmap=await this.decode(new Blob([bytes],{type:'image/png'}));this.stats.decode_ms+=performance.now()-started;
      if(controller.signal.aborted){bitmap.close?.();throw controller.signal.reason;}
      if(bitmap.width!==page.width||bitmap.height!==page.height){bitmap.close?.();throw new Error('战斗图集尺寸不符');}
      this.stats.page_decodes++;this.pages.set(index,{bitmap,used:++this.clock,bytes:page.width*page.height*4});ownBitmap(bitmap,this,index);
      this.stats.peak_decoded_bytes=Math.max(this.stats.peak_decoded_bytes,[...this.pages.values()].reduce((sum,e)=>sum+e.bytes,0));return bitmap;
    })();
    this.pending.set(index,promise);
    try{return await promise;}finally{if(this.pending.get(index)===promise){this.pending.delete(index);this.requests.delete(index);}this.prune();}
  }
  async preparePaths(paths,{scope='battle',onProgress=()=>{},isCurrent=()=>true}={}){
    const data=await this.catalog(),required=new Set(),leased=new Set(),entries=new Map();
    need(isCurrent(),'资源准备已取消');
    for(const path of new Set(paths)){
      const entry=data.images[canonical(path)];need(entry,`图片未登记到图集：${path}`);
      entries.set(path,{packed:true,path,width:entry.width,height:entry.height,regions:entry.regions,pool:this});
    }
    let cancelled=false;
    const claim=index=>{if(!leased.has(index)){leased.add(index);this.leases.set(index,(this.leases.get(index)??0)+1);}};
    const releaseLeases=()=>{
      for(const index of leased){const count=this.leases.get(index)-1;if(count)this.leases.set(index,count);else this.leases.delete(index);}
      leased.clear();};
    const operation={cancel(){cancelled=true;releaseLeases();}},current=()=>!cancelled&&isCurrent();
    if(!this.preparations.has(scope))this.preparations.set(scope,new Set());this.preparations.get(scope).add(operation);
    try{
      const upgrades=[];
      for(const [path,entry] of entries){
        const hd=loadHdImage(path,entry);
        if(hd)upgrades.push(hd.then(image=>{if(image)entries.set(path,image);}));
      }
      if(upgrades.length)await Promise.all(upgrades);
      need(current(),'资源准备已取消');
      const animations=new Map(),animationPages=new Map(),originalPages=new Set();
      const plans=[];
      for(const [path,entry] of entries){
        if(entry.pool!==this)continue;
        for(const region of entry.regions)originalPages.add(region[4]);
        const plan=hdAnimation(path,data.images[canonical(path)]);
        if(plan)plans.push(plan.then(animation=>{
          if(!animation)return;
          animations.set(path,animation);
          for(const [index,page] of animation.pages)if(!this.failedAnimationPages.has(index))animationPages.set(index,page);
        }));
      }
      if(plans.length)await Promise.all(plans);
      need(current(),'资源准备已取消');
      const total=Math.max(1,originalPages.size+animationPages.size);
      let completed=0;
      onProgress({completed,total});
      const load=async(pages,optional=false)=>{
        for(const index of pages)claim(index);
        let next=0;
        // Hold leases until every decoder settles, including cancelled requests.
        const workers=await Promise.allSettled(Array.from({length:Math.min(4,pages.length)},async()=>{
          while(next<pages.length){
            need(current(),'资源准备已取消');
            const index=pages[next++];
            try{await this.page(index,animationPages.get(index));}
            catch(error){if(!optional||!current())throw error;this.failedAnimationPages.add(index);}
            onProgress({completed:++completed,total});
          }
        }));
        const failure=workers.find(result=>result.status==='rejected');if(failure)throw failure.reason;
      };
      if(animationPages.size)await load([...animationPages.keys()],true);
      need(current(),'资源准备已取消');
      for(const [path,entry] of entries){
        if(entry.pool!==this)continue;
        const regions=selectAnimationRegions(entry,animations.get(path),index=>this.pages.has(index));
        if(regions!==entry.regions)entries.set(path,{...entry,regions,originalRegions:entry.regions});
        for(const region of regions)required.add(region[4]);
      }
      const originals=[...required].filter(index=>originalPages.has(index));
      const skipped=originalPages.size-originals.length;
      if(skipped){completed+=skipped;onProgress({completed,total});}
      await load(originals);
      need(current(),'资源准备已取消');
      if(!completed)onProgress({completed:1,total});
      this.scopes.set(scope,required);return entries;
    }finally{
      releaseLeases();const operations=this.preparations.get(scope);operations?.delete(operation);if(!operations?.size)this.preparations.delete(scope);
      this.prune();
    }
  }
  async prepare(descriptors,options){
    const data=await this.catalog();
    for(const asset of descriptors){const row=data.images[canonical(asset.path)];
      need(row&&row.sha256===asset.sha256&&row.width===asset.width&&row.height===asset.height,`来源图片与图集不一致：${asset.path}`);
    }
    return this.preparePaths(descriptors.map(a=>a.path),options);
  }
  async pathsWithinBudget(paths,bytes){
    const data=await this.catalog(),included=new Set(),selected=[];
    for(const path of new Set(paths)){
      const image=data.images[canonical(path)];need(image,`图片未登记到图集：${path}`);
      const animation=await hdAnimation(path,image);
      const regions=selectAnimationRegions(image,animation,index=>!this.failedAnimationPages.has(index));
      const pages=new Set(regions.map(region=>region[4]).filter(index=>!included.has(index)));
      const cost=[...pages].reduce((sum,index)=>{
        const page=data.pages[index]??animation.pages.get(index);
        return sum+page.width*page.height*4;
      },0);
      if(cost>bytes)continue;
      for(const index of pages)included.add(index);
      bytes-=cost;selected.push(path);
    }
    return selected;
  }
  has(descriptors){return Boolean(this.data)&&descriptors.every(asset=>{
    const image=this.data.images[canonical(asset.path)];if(!image)return false;
    return selectAnimationRegions(image,knownHdAnimation(image),index=>!this.failedAnimationPages.has(index))
      .every(region=>this.pages.has(region[4]));
  });}
  createScope(label='battle'){
    const scope=Symbol(label),pool=this;let closed=false;
    return {scope,get closed(){return closed;},
      prepare(descriptors,options={}){need(!closed,'资源会话已关闭');const current=options.isCurrent??(()=>true);
        return pool.prepare(descriptors,{...options,scope,isCurrent:()=>!closed&&current()});},
      preparePaths(paths,options={}){need(!closed,'资源会话已关闭');const current=options.isCurrent??(()=>true);
        return pool.preparePaths(paths,{...options,scope,isCurrent:()=>!closed&&current()});},
      release(){if(closed)return;closed=true;pool.release(scope);}};
  }
  release(scope){this.scopes.delete(scope);for(const operation of this.preparations.get(scope)??[])operation.cancel();this.prune();}
  prune(){
    let bytes=[...this.pages.values()].reduce((sum,e)=>sum+e.bytes,0);
    const held=new Set([...this.scopes.values()].flatMap(set=>[...set]));
    for(const [index,controller]of this.requests)if(!held.has(index)&&!this.leases.has(index))controller.abort(new Error('战斗资源请求已取消'));
    for(const [index,entry]of [...this.pages].sort((a,b)=>a[1].used-b[1].used)){
      if(bytes<=this.budgetBytes)break;
      if(held.has(index)||this.leases.has(index))continue;
      this.pages.delete(index);evictBitmap(entry.bitmap);bytes-=entry.bytes;this.stats.evictions++;
    }
  }
  snapshot(){const held=new Set([...this.scopes.values()].flatMap(set=>[...set]));
    const bytes=[...this.pages.values()].reduce((sum,e)=>sum+e.bytes,0),active=[...this.pages].reduce((sum,[index,e])=>sum+(held.has(index)?e.bytes:0),0);
    return {...this.stats,resident_pages:this.pages.size,decoded_bytes:bytes,active_decoded_bytes:active,inactive_cache_bytes:bytes-active,budget_bytes:this.budgetBytes};}
  dispose(){for(const operations of this.preparations.values())for(const operation of operations)operation.cancel();for(const controller of this.requests.values())controller.abort(new Error('战斗资源已释放'));for(const entry of this.pages.values()){evictBitmap(entry.bitmap);}this.pages.clear();this.scopes.clear();}
}

export const battleResources=new BattleResources();
