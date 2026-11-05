import {savedSummaryImage,SAVE_PREVIEW_WIDTH,SAVE_PREVIEW_HEIGHT} from './core/world/save_preview.mjs';

// Show only the stored thumbnail; missing previews leave the space empty.
export function appendSavePreview(parent,summary,left,top){
  const source=savedSummaryImage(summary);if(!source)return;
  const image=document.createElement('img');
  image.alt='';image.width=SAVE_PREVIEW_WIDTH;image.height=SAVE_PREVIEW_HEIGHT;
  image.decoding='sync';image.draggable=false;
  Object.assign(image.style,{position:'absolute',left:left+'px',top:top+'px',pointerEvents:'none',imageRendering:'pixelated'});
  image.src=source;parent.append(image);
}
