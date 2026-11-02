// Optional presentation metadata lives outside the checksummed world payload.
// Old v1 envelopes remain valid. A preview is used only for its exact payload.
// Native 479D70 -> 478410 draws 0x68 by 0x4c pixels at row origin+[15,10].
export const SAVE_PREVIEW_WIDTH=104;
export const SAVE_PREVIEW_HEIGHT=76;
const prefix='data:image/png;base64,';
export function validPreviewPng(image){
  if(typeof image!=='string'||image.length>100_000||!image.startsWith(prefix))return false;
  const encoded=image.slice(prefix.length);
  if(encoded.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))return false;
  try{
    const bytes=Uint8Array.from(atob(encoded.slice(0,44)),char=>char.charCodeAt(0));
    if(bytes.length<24||[137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82].some((byte,i)=>bytes[i]!==byte))return false;
    const view=new DataView(bytes.buffer);
    return view.getUint32(16)===SAVE_PREVIEW_WIDTH&&view.getUint32(20)===SAVE_PREVIEW_HEIGHT;
  }catch{return false;}
}
export function attachSavePreview(envelope,png){
  if(!validPreviewPng(png))throw new Error('存档截图格式无效');
  return {...envelope,preview:{version:1,width:SAVE_PREVIEW_WIDTH,height:SAVE_PREVIEW_HEIGHT,payload_sha256:envelope.sha256,png}};
}
export function savedPreviewPng(envelope){
  const preview=envelope?.preview;
  return preview?.version===1&&preview.width===SAVE_PREVIEW_WIDTH&&preview.height===SAVE_PREVIEW_HEIGHT
    &&preview.payload_sha256===envelope.sha256&&validPreviewPng(preview.png)?preview.png:null;
}

export function savedSummaryImage(summary){
  const image=summary?.thumbnail;
  if(validPreviewPng(image))return image;
  const prefix='data:image/bmp;base64,',size=66+SAVE_PREVIEW_WIDTH*SAVE_PREVIEW_HEIGHT*2;
  if(typeof image!=='string'||image.length!==prefix.length+Math.ceil(size/3)*4||!image.startsWith(prefix))return null;
  try{
    const header=Uint8Array.from(atob(image.slice(prefix.length,prefix.length+88)),char=>char.charCodeAt(0)),view=new DataView(header.buffer);
    return view.getUint16(0,true)===0x4d42&&view.getUint32(2,true)===size&&view.getUint32(10,true)===66
      &&view.getUint32(14,true)===40&&view.getInt32(18,true)===SAVE_PREVIEW_WIDTH&&view.getInt32(22,true)===-SAVE_PREVIEW_HEIGHT
      &&view.getUint16(26,true)===1&&view.getUint16(28,true)===16&&view.getUint32(30,true)===3
      &&view.getUint32(54,true)===0xf800&&view.getUint32(58,true)===0x07e0&&view.getUint32(62,true)===0x001f?image:null;
  }catch{return null;}
}
