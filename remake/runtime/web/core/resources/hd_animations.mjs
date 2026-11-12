import {hdImagesEnabled} from './hd_images.mjs';

const root='/assets/hd/animations/';
const mapSource=/^\/assets\/(?:(?:ROLE_\d+|opening_roles|chapter_roles|npcs|map_effects|map_shadows|chapter_objects)\/|maps\/[^/]+\/objects\/)/;
const battleSource=/^\/assets\/(?:party_roles|enemy_roles|party_layers|enemy_layers|combat_effects|party_effects|enemy_effects|forest_(?:full_)?(?:roles|effects)|forest_response_layers|battle_lifecycle|battle_status|item_presentation|combat_lab|skills|forest_stage|stages)\//;
const pageName=/^[a-f0-9]{64}\.png$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const nonnegative=n=>Number.isSafeInteger(n)&&n>=0;
let manifest;
const plans=new WeakMap();

export function hdAnimation(path,original){
  if(!hdImagesEnabled()||!original?.sha256||!Array.isArray(original.regions))return null;
  const key='/'+path.replace(/^\/+/, '');
  if(!mapSource.test(key)&&!battleSource.test(key))return null;
  let plan=plans.get(original);
  if(plan)return plan.promise;
  manifest??=fetch(root+'manifest.json',{cache:'no-cache'})
    .then(response=>response.ok?response.json():null)
    .then(data=>data?.version===1&&data.scale===2?data:null)
    .catch(()=>null);
  plan={value:null};
  plan.promise=manifest.then(data=>plan.value=describe(data,key,original)).catch(()=>null);
  plans.set(original,plan);
  return plan.promise;
}

export const knownHdAnimation=original=>hdImagesEnabled()?plans.get(original)?.value:null;

function describe(data,key,original){
  const image=data?.images?.[key];
  if(!image||image.sha256!==original.sha256||image.width!==original.width||image.height!==original.height)return null;
  const {frameWidth:w,frameHeight:h}=image;
  if(!positive(w)||!positive(h)||image.width%w||image.height%h)return null;
  const columns=image.width/w,rows=image.height/h,frames=new Map(),pages=new Map();
  const cell=(x,y)=>Math.floor(y/h)*columns+Math.floor(x/w);
  for(const [id,tiles] of Object.entries(image.frames??{})){
    const index=Number(id);
    if(!nonnegative(index)||index>=columns*rows||String(index)!==id||!Array.isArray(tiles)||!tiles.length||
      (mapSource.test(key)&&tiles.length!==1))continue;
    const left=index%columns*w,top=Math.floor(index/columns)*h,framePages=new Map(),regions=[];
    for(const tile of tiles){
      if(!Array.isArray(tile)||tile.length!==7)break;
      const [x,y,tw,th,file,px,py]=tile,page=data.pages?.[file];
      if(!nonnegative(x)||!nonnegative(y)||!positive(tw)||!positive(th)||!nonnegative(px)||!nonnegative(py)||
        x<left||y<top||x+tw>left+w||y+th>top+h||!pageName.test(file)||!positive(page?.width)||!positive(page?.height)||
        page.width>2048||page.height>2048||px+tw*2>page.width||py+th*2>page.height||
        regions.some(([rx,ry,rw,rh])=>x<rx+rw&&x+tw>rx&&y<ry+rh&&y+th>ry))break;
      const path=root+file;
      framePages.set(path,{path,width:page.width,height:page.height,sha256:file.slice(0,-4)});
      regions.push([x,y,tw,th,path,px,py,2]);
    }
    if(regions.length===tiles.length)frames.set(index,{regions,pages:framePages});
  }
  if(!frames.size)return null;
  const originals=new Map();
  for(const [x,y,rw,rh] of original.regions){
    const index=cell(x,y);
    // The original page must describe whole cells, even where a cell spans pages.
    if(index!==cell(x+rw-1,y+rh-1))return null;
    const bounds=originals.get(index)??[x,y,x+rw,y+rh];
    originals.set(index,[Math.min(bounds[0],x),Math.min(bounds[1],y),Math.max(bounds[2],x+rw),Math.max(bounds[3],y+rh)]);
  }
  for(const [index,frame] of frames){
    const bounds=originals.get(index);
    if(!bounds){frames.delete(index);continue;}
    const [left,top,right,bottom]=bounds;
    const area=frame.regions.reduce((sum,[,,w,h])=>sum+w*h,0);
    if(area!==(right-left)*(bottom-top)||frame.regions.some(([x,y,w,h])=>x<left||y<top||x+w>right||y+h>bottom)){
      frames.delete(index);continue;
    }
    for(const [path,page] of frame.pages)pages.set(path,page);
  }
  return frames.size?{frames,pages,cell}:null;
}

export function selectAnimationRegions(original,plan,usable=()=>true){
  if(!plan)return original.regions;
  const replacements=new Map([...plan.frames].filter(([,frame])=>[...frame.pages.keys()].every(usable)));
  if(!replacements.size)return original.regions;
  return [
    ...original.regions.filter(([x,y])=>!replacements.has(plan.cell(x,y))),
    ...[...replacements.values()].flatMap(frame=>frame.regions),
  ];
}

export async function readAnimationBitmap(page,read=fetch.bind(globalThis),decode=blob=>createImageBitmap(blob),signal){
  const response=await read(page.path,{cache:'force-cache',signal});
  if(!response.ok)throw new Error('高清动画纹理页读取失败：'+page.path);
  const bytes=await response.arrayBuffer();
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  if(hash!==page.sha256)throw new Error('高清动画纹理页指纹不符：'+page.path);
  const bitmap=await decode(new Blob([bytes],{type:'image/png'}));
  if(signal?.aborted||bitmap.width!==page.width||bitmap.height!==page.height){
    bitmap.close?.();
    if(signal?.aborted)throw signal.reason;
    throw new Error('高清动画纹理页尺寸不符：'+page.path);
  }
  return bitmap;
}
