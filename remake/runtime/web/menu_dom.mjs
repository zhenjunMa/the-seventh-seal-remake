import {setImageSource} from './core/ui/image_dom.mjs';
// Retain each label's raster surface so menu_text can reuse its signature.
export function menuStyle(node,values){
  for(const [key,value]of Object.entries(values))if(node.style[key]!==value)node.style[key]=value;
}
export function menuImage(node,path){
  if(node._menuSource!==path){setImageSource(node,path);node._menuSource=path;}
}
export function menuText(node,value,renderer,options={},className=''){
  value=String(value??'');
  if(!value||!renderer||renderer.supports&&!renderer.supports(value,options.font)){
    // A bitmap label has empty textContent even when its canvas still shows text.
    if(node.textContent!==value||node._menuCanvas?.parentNode===node)node.textContent=value;
    return;
  }
  const canvas=node._menuCanvas??=node.querySelector('canvas')??document.createElement('canvas');
  if(className)canvas.className=className;
  if(canvas.parentNode!==node)node.replaceChildren(canvas);
  const box=renderer.paint(canvas,value,options);
  menuStyle(canvas,{position:className==='native-menu-number'?'relative':'absolute',left:(box.offsetX??-1)+'px',top:(box.offsetY??-1)+'px',pointerEvents:'none'});
  return canvas;
}
