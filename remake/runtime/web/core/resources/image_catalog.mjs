let catalog=null;
export const imageDescriptor=path=>typeof path==='string'?catalog?.images['/'+path.replace(/^\/+/, '')]??null:null;
export const imageCatalog=()=>catalog;
export function installImageCatalog(data){
  if(data?.schema!=='seventh-seal-image-catalog'||data.version!==1||!Array.isArray(data.pages)||!data.images)throw new Error('图片资源索引无效');
  for(const page of data.pages)if(!/^\/assets\/(?:image_packs|battle_packs)\/[a-f0-9]{24}\.png$/.test(page.path)||
    !/^[a-f0-9]{64}$/.test(page.sha256)||!Number.isInteger(page.width)||!Number.isInteger(page.height)||
    page.width<=0||page.height<=0||page.width>2048||page.height>2048)throw new Error('图片纹理页描述无效');
  for(const [path,image]of Object.entries(data.images)){
    if(!path.startsWith('/assets/')||!Number.isInteger(image.width)||!Number.isInteger(image.height)||image.width<=0||image.height<=0||!Array.isArray(image.regions))throw new Error('逻辑图片描述无效');
    for(const r of image.regions){const [x,y,w,h,index,px,py]=r,page=data.pages[index];
      if(r.length!==7||!r.every(Number.isInteger)||!page||x<0||y<0||w<=0||h<=0||x+w>image.width||y+h>image.height||px<0||py<0||px+w>page.width||py+h>page.height)throw new Error('图片帧坐标无效');
    }
  }
  catalog=data;return data;
}
export async function loadImageCatalog(read=fetch.bind(globalThis)){
  const response=await read('/assets/image_catalog.json',{cache:'no-cache'});
  // Existing developer exports remain usable before the first media rebuild.
  if(response.status===404)return null;
  if(!response.ok)throw new Error('图片资源索引读取失败');
  return installImageCatalog(await response.json());
}

export async function imageDefinitionJson(path,response,manifests=catalog?.manifests){
  const expected=manifests?.['/'+path.replace(/^\/+/, '')];
  if(!expected)return response.json();
  const bytes=await response.arrayBuffer();
  const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  if(actual!==expected)throw new Error('图片定义已变化，请重新执行素材构建：'+path);
  return JSON.parse(new TextDecoder().decode(bytes));
}
