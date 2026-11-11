import {imageCatalog,imageDescriptor} from '../resources/image_catalog.mjs';
import {ImageResources} from '../resources/image_resources.mjs';

const resources=new ImageResources(),records=new Set(),owners=new WeakMap();
let ticks=0;
const blank=(width,height)=>'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`);
function showOriginal(node,image){
  if(!image.regions.length){node.style.backgroundImage='none';node.style.clipPath='';return;}
  const [x,y,w,h,index,px,py]=image.regions[0],page=imageCatalog().pages[index];
  node.style.backgroundImage=`url("${page.path}")`;
  node.style.backgroundRepeat='no-repeat';
  node.style.backgroundSize=`${page.width/image.width*100}% ${page.height/image.height*100}%`;
  node.style.backgroundPosition=`${(x-px)/(image.width-page.width)*100}% ${(y-py)/(image.height-page.height)*100}%`;
  node.style.clipPath=`inset(${y/image.height*100}% ${(image.width-x-w)/image.width*100}% ${(image.height-y-h)/image.height*100}% ${x/image.width*100}%)`;
}
function prepare(node,record){
  record.active=true;
  const path=record.path;
  node.assetPromise=resources.load(path,record.scope).then(image=>{
    if(owners.get(node)===record&&record.path===path&&record.active){
      node.assetImage=image;
      if(image.hdUrl){
        const {width,height,hdRect}=image,[x,y,w,h]=hdRect??[0,0,width,height];
        node.style.backgroundImage=`url("${image.hdUrl}")`;
        node.style.backgroundSize=`${w/width*100}% ${h/height*100}%`;
        node.style.backgroundPosition=`${w===width?0:x/(width-w)*100}% ${h===height?0:y/(height-h)*100}%`;
        node.style.backgroundRepeat='no-repeat';
        node.style.clipPath='';
      }else showOriginal(node,record.image);
    }
    return image;
  });
  node.assetPromise.catch(error=>{if(record.active){node.dataset.assetError=error.message;node.dispatchEvent?.(new Event('error'));}});
}

// Keep semantic <img> elements and their existing layout. The transparent SVG
// supplies intrinsic dimensions; CSS samples the shared page without rasterizing.
export function setImageSource(node,path){
  let record=owners.get(node);
  if(record&&record.path===path&&record.active)return;
  if(record){resources.release(record.scope);record.active=false;records.delete(record);}
  node.assetImage=null;
  const image=imageDescriptor(path);
  if(!image){
    if(record){for(const key of ['backgroundImage','backgroundSize','backgroundPosition','backgroundRepeat','clipPath'])node.style[key]='';}
    owners.delete(node);
    if(record)delete node.dataset.assetPath;
    if(path)node.src=path;else node.removeAttribute?.('src');
    return;
  }
  if(image.regions.length>1)throw new Error('DOM 图片必须在构建时放入单个完整区域：'+path);
  record={path,image,scope:Symbol('dom-image'),ref:new WeakRef(node),active:false,seen:ticks};
  owners.set(node,record);records.add(record);
  node.dataset.assetPath=path;node.src=blank(image.width,image.height);
  showOriginal(node,image);
  prepare(node,record);
}
export function elementImage(node){return node.assetImage??node;}
export function maintainDomImages(){
  ticks++;
  if(ticks%120)return;
  for(const record of records){
    const node=record.ref.deref();
    if(!node){resources.release(record.scope);records.delete(record);continue;}
    if(node.isConnected){record.seen=ticks;if(!record.active)prepare(node,record);}
    else if(record.active&&ticks-record.seen>=120){resources.release(record.scope);record.active=false;node.assetImage=null;}
  }
}
export function disposeDomImages(){for(const record of records){resources.release(record.scope);record.active=false;}records.clear();}
