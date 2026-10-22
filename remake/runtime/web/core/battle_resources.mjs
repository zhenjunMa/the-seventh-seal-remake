// Shared, verified battle atlases. Views retain geometry, never private bitmap copies.
const canonical=path=>'/'+path.replace(/^\/+/, '');
const need=(ok,message)=>{if(!ok)throw new Error(`战斗资源：${message}`);};
const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
const safe=path=>/^\/assets\/battle_packs\/[a-f0-9]{24}\.png$/.test(path);

export class BattleResources {
  constructor({read=fetch.bind(globalThis),decode=blob=>createImageBitmap(blob),budgetBytes=192*1024*1024}={}){
    Object.assign(this,{read,decode,budgetBytes});this.pages=new Map();this.pending=new Map();this.scopes=new Map();this.leases=new Map();this.clock=0;
    this.stats={page_requests:0,page_decodes:0,page_hits:0,evictions:0};
  }
  async catalog(){
    if(!this.catalogPromise)this.catalogPromise=(async()=>{
      const response=await this.read('/data/battle_packs.json',{cache:'no-cache'});
      need(response.ok,'图集清单读取失败');const data=await response.json();
      need(data.schema==='seventh-seal-battle-packs'&&data.version===1&&Array.isArray(data.pages)&&data.images&&data.manifests,'图集清单无效');
      for(const page of data.pages)need(safe(page.path)&&/^[a-f0-9]{64}$/.test(page.sha256)&&Number.isInteger(page.width)&&page.width>0&&page.width<=2048&&Number.isInteger(page.height)&&page.height>0&&page.height<=2048,'图集描述无效');
      for(const image of Object.values(data.images)){
        need(image.width>0&&image.height>0&&/^[a-f0-9]{64}$/.test(image.sha256)&&Array.isArray(image.regions),'图片描述无效');
        for(const region of image.regions){const [x,y,w,h,index,px,py]=region,page=data.pages[index];
          need(region.length===7&&region.every(Number.isInteger)&&page&&x>=0&&y>=0&&w>0&&h>0&&x+w<=image.width&&y+h<=image.height&&px>=0&&py>=0&&px+w<=page.width&&py+h<=page.height,'图集坐标无效');
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
  async page(index){
    if(this.pages.has(index)){const entry=this.pages.get(index);entry.used=++this.clock;this.stats.page_hits++;return entry.bitmap;}
    if(this.pending.has(index))return this.pending.get(index);
    const page=this.data.pages[index];
    const promise=(async()=>{
      this.stats.page_requests++;const response=await this.read(page.path,{cache:'force-cache'});
      need(response.ok,'图集读取失败');const bytes=await response.arrayBuffer();
      need(await sha(bytes)===page.sha256,'图集指纹不符');const bitmap=await this.decode(new Blob([bytes],{type:'image/png'}));
      if(bitmap.width!==page.width||bitmap.height!==page.height){bitmap.close?.();throw new Error('战斗图集尺寸不符');}
      this.stats.page_decodes++;this.pages.set(index,{bitmap,used:++this.clock,bytes:page.width*page.height*4});return bitmap;
    })();
    this.pending.set(index,promise);
    try{return await promise;}finally{this.pending.delete(index);}
  }
  async preparePaths(paths,{scope='battle',onProgress=()=>{},isCurrent=()=>true}={}){
    const data=await this.catalog(),required=new Set(),entries=new Map();
    for(const path of new Set(paths)){
      const entry=data.images[canonical(path)];need(entry,`图片未登记到图集：${path}`);
      for(const region of entry.regions)required.add(region[4]);
      entries.set(path,{packed:true,path,width:entry.width,height:entry.height,regions:entry.regions,pool:this});
    }
    for(const index of required)this.leases.set(index,(this.leases.get(index)??0)+1);
    let completed=0,next=0;const pages=[...required],total=Math.max(1,pages.length);
    try{
      onProgress({completed,total});
      // Keep a failed request from leaving other workers unobserved or releasing
      // their pending atlas leases before all decoding has settled.
      const workers=await Promise.allSettled(Array.from({length:Math.min(4,pages.length)},async()=>{
        while(next<pages.length){await this.page(pages[next++]);onProgress({completed:++completed,total});}
      }));
      const failure=workers.find(result=>result.status==='rejected');if(failure)throw failure.reason;
      need(isCurrent(),'资源准备已取消');
      if(!pages.length)onProgress({completed:1,total});
      this.scopes.set(scope,required);return entries;
    }finally{
      for(const index of required){const count=this.leases.get(index)-1;if(count)this.leases.set(index,count);else this.leases.delete(index);}
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
  release(scope){this.scopes.delete(scope);this.prune();}
  prune(){
    let bytes=[...this.pages.values()].reduce((sum,e)=>sum+e.bytes,0);
    const held=new Set([...this.scopes.values()].flatMap(set=>[...set]));
    for(const [index,entry]of [...this.pages].sort((a,b)=>a[1].used-b[1].used)){
      if(bytes<=this.budgetBytes)break;
      if(held.has(index)||this.leases.has(index))continue;
      entry.bitmap.close?.();this.pages.delete(index);bytes-=entry.bytes;this.stats.evictions++;
    }
  }
  snapshot(){const held=new Set([...this.scopes.values()].flatMap(set=>[...set]));
    const bytes=[...this.pages.values()].reduce((sum,e)=>sum+e.bytes,0),active=[...this.pages].reduce((sum,[index,e])=>sum+(held.has(index)?e.bytes:0),0);
    return {...this.stats,resident_pages:this.pages.size,decoded_bytes:bytes,active_decoded_bytes:active,inactive_cache_bytes:bytes-active,budget_bytes:this.budgetBytes};}
  dispose(){for(const entry of this.pages.values())entry.bitmap.close?.();this.pages.clear();this.scopes.clear();}
}

export const battleResources=new BattleResources();

// Retain the original source coordinate system while drawing only occupied tiles.
// UI masks are exported as full rectangles to preserve destination-in semantics.
export function drawBattleImage(context,image,...args){
  if(!image?.packed){context.drawImage(image,...args);return;}
  let sx=0,sy=0,sw=image.width,sh=image.height,dx,dy,dw=sw,dh=sh;
  if(args.length===2)[dx,dy]=args;
  else if(args.length===4)[dx,dy,dw,dh]=args;
  else if(args.length===8)[sx,sy,sw,sh,dx,dy,dw,dh]=args;
  else throw new Error('战斗图片绘制参数无效');
  if(sw<=0||sh<=0||dw<=0||dh<=0)return;
  for(const [x,y,w,h,index,px,py]of image.regions){
    const left=Math.max(x,sx),top=Math.max(y,sy),right=Math.min(x+w,sx+sw),bottom=Math.min(y+h,sy+sh);
    if(left>=right||top>=bottom)continue;
    const entry=image.pool.pages.get(index);need(entry,'当前战斗图集未准备好');entry.used=++image.pool.clock;
    context.drawImage(entry.bitmap,px+left-x,py+top-y,right-left,bottom-top,
      dx+(left-sx)*dw/sw,dy+(top-sy)*dh/sh,(right-left)*dw/sw,(bottom-top)*dh/sh);
  }
}
