import {savedPreviewPng,SAVE_PREVIEW_WIDTH,SAVE_PREVIEW_HEIGHT} from './core/save_preview.mjs';

// Paint the embedded PNG with its row; missing previews leave the space empty.
export function appendSavePreview(parent,envelope,left,top){
  const png=savedPreviewPng(envelope);if(!png)return;
  const image=document.createElement('img');
  image.alt='';image.width=SAVE_PREVIEW_WIDTH;image.height=SAVE_PREVIEW_HEIGHT;
  image.decoding='sync';image.draggable=false;
  Object.assign(image.style,{position:'absolute',left:left+'px',top:top+'px',pointerEvents:'none',imageRendering:'pixelated'});
  image.src=png;parent.append(image);
}
