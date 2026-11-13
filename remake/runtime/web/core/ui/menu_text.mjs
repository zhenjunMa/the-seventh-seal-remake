import {registerGlyph} from '../../phaser/rendering/recorded_surface.mjs';
import {loadHdFont} from '../resources/hd_images.mjs';
// Bitmap masks; manifests retain the rasterizer and actual source face.
// Whole-string shadow passes follow native 0x5358C4 before the foreground pass.
export async function createMenuTextRenderer(manifest, options = {}) {
  const document = options.document ?? globalThis.document;
  const makeImage = options.makeImage ?? (() => new Image());
  const sets={noto:{manifest,atlases:new Map()}},tinted=new Map();
  if(options.windowsFonts)sets.windows={manifest:options.windowsFonts,atlases:new Map()};
  let selected='noto',revision=0,atlases=sets.noto.atlases;
  let hdSet=null,hdAtlases=new Map();
  const hdTinted=new Map();
  const hdAtlas=key=>hdSet===selected?hdAtlases.get(key):null;
  await Promise.all(Object.values(sets).flatMap(set=>Object.entries(set.manifest.fonts).map(async ([key,font]) => {
    const image = makeImage(); image.src = font.image;
    if (image.decode) await image.decode();
    else await new Promise((resolve,reject) => {image.onload=resolve;image.onerror=reject;});
    set.atlases.set(key,image);
  })));
  function selectFonts(name){
    if(name===selected)return;
    selected=name;manifest=sets[name].manifest;atlases=sets[name].atlases;
    tinted.clear();hdTinted.clear();revision++;
  }
  async function prepareHdFonts(name){
    if(name===hdSet)return;
    const entries=await Promise.all(Object.entries(sets[name].manifest.fonts).map(async ([key,font])=>
      [key,await loadHdFont(font,makeImage)]));
    const changed=name===selected&&(hdAtlases.size||entries.some(([,image])=>image));
    hdAtlases=new Map(entries.filter(([,image])=>image));hdSet=name;
    hdTinted.clear();
    if(changed)revision++;
  }
  function tintGlyph(key,char,color,image,glyph){
    const id=JSON.stringify([key,char,color]);
    let tile=hdTinted.get(id);
    if(!tile){
      tile=document.createElement('canvas');tile.width=glyph.width;tile.height=glyph.height;
      const c=tile.getContext('2d');
      c.drawImage(image,glyph.x,glyph.y,glyph.width,glyph.height,0,0,glyph.width,glyph.height);
      c.globalCompositeOperation='source-in';c.fillStyle=color;c.fillRect(0,0,tile.width,tile.height);
      if(hdTinted.size>=1024)hdTinted.delete(hdTinted.keys().next().value);
      hdTinted.set(id,tile);
    }
    return tile;
  }
  function atlas(key,color) {
    const cacheKey=key+':'+color;
    if (!tinted.has(cacheKey)) {
      const source=atlases.get(key), canvas=document.createElement('canvas');
      canvas.width=source.width;canvas.height=source.height;
      const context=canvas.getContext('2d');context.drawImage(source,0,0);
      context.globalCompositeOperation='source-in';context.fillStyle=color;context.fillRect(0,0,canvas.width,canvas.height);
      tinted.set(cacheKey,canvas);
    }
    return tinted.get(cacheKey);
  }
  function runs(text,key,{advanceOverride=null,layout='textout',lineHeight=null}={}) {
    const font=manifest.fonts[key];
    if(!font)throw new Error('菜单字形来源不存在');
    if(!['textout','mnu'].includes(layout))throw new Error('菜单文本布局无效');
    const characters=[...String(text)],result=[],unit=advanceOverride??lineHeight??font.height+1;
    const glyph=char=>{const g=font.glyphs[char];if(!g)throw new Error('菜单字形未导出: '+char);return g;};
    if(layout==='textout')return characters.map(char=>{
      const g=glyph(char),advance=advanceOverride!==null&&char.codePointAt(0)>127?advanceOverride:g.advance;
      return {text:char,advance,wrapWidth:advance};
    });
    // 0x5341A1/0x53434C measure an ASCII word with GetCharWidthA, while
    // 0x5344F0 draws that word with TextOut's character extra still enabled.
    // Do not apply this measurement to the whole-string 0x5358C4 path.
    for(let index=0;index<characters.length;){
      if(characters[index].codePointAt(0)>127){
        const char=characters[index++],g=glyph(char);
        // Keep the middle dot's font spacing inside fixed-width CJK rows.
        const advance=char==='·'?g.advance:unit;
        result.push({text:char,advance,wrapWidth:advance});continue;
      }
      let word='',width=0;
      while(index<characters.length&&characters[index].codePointAt(0)<128&&characters[index]!==' '){
        const char=characters[index++],g=glyph(char);
        if(!Number.isFinite(g.char_width))throw new Error('菜单ASCII字宽未导出: '+char);
        word+=char;width+=g.char_width;
      }
      if(characters[index]===' ')index++;
      const gap=index<characters.length?2+Math.floor(unit/2):0;
      result.push({text:word,advance:width+gap,wrapWidth:width});
    }
    return result;
  }
  function measure(text,key,options={}) {
    return runs(text,key,options).reduce((width,run)=>width+run.advance,0);
  }
  function supports(text,key) {
    const font=manifest.fonts[key];
    return Boolean(font&&[...String(text)].every(char=>char==='\n'||font.glyphs[char]));
  }
  function paint(canvas,text,options={}) {
    const {font:key='simsun18',foreground='#ffffff',shadow:baseShadow='#222222',hdShadow=baseShadow,
      maxWidth=null,maxLines=Infinity,lineHeight=null,align='left',advanceOverride=null,boxHeight=null,verticalAlign='top',layout='textout',shadowOffsets=[[-1,-1],[1,1]],
      composite=true}=options;
    const hd=hdAtlas(key),shadow=hd?hdShadow:baseShadow;
    text=String(text);const signature=JSON.stringify([revision,text,key,foreground,shadow,maxWidth,maxLines,lineHeight,align,advanceOverride,boxHeight,verticalAlign,layout,shadowOffsets,composite]);
    canvas.menuTextRenderer=renderer;canvas.menuTextRequest=[text,options];
    const font=manifest.fonts[key];
    if(!font)throw new Error('菜单字形来源不存在');
    if(maxWidth!==null&&(!Number.isFinite(maxWidth)||maxWidth<=0))throw new Error('菜单文本宽度无效');
    if(!['left','center','right'].includes(align))throw new Error('菜单文本对齐无效');
    if(!['top','center','bottom'].includes(verticalAlign))throw new Error('菜单文本垂直对齐无效');
    if(boxHeight!==null&&(!Number.isFinite(boxHeight)||boxHeight<=0))throw new Error('菜单文本区域高度无效');
    if(advanceOverride!==null&&(!Number.isFinite(advanceOverride)||advanceOverride<=0))throw new Error('菜单文本字符步长无效');
    if(!(maxLines===Infinity||Number.isInteger(maxLines)&&maxLines>0))throw new Error('菜单文本行数无效');
    if(lineHeight!==null&&(!Number.isFinite(lineHeight)||lineHeight<=0))throw new Error('菜单文本行距无效');
    if(canvas.menuTextSignature===signature)return canvas.menuTextBounds;
    const scale=hd?.scale??1;
    const inkGlyphs=hd?.glyphs??font.glyphs;
    const rows=[];
    for(const original of text.split('\n')) {
      let row=[],length=0;
      for(const run of runs(original,key,{advanceOverride,layout,lineHeight})) {
        if(maxWidth!==null&&row.length&&length+run.wrapWidth>maxWidth){rows.push({runs:row,width:length});row=[];length=0;}
        row.push({...run,x:length});length+=run.advance;
      }
      rows.push({runs:row,width:length});
    }
    const visible=rows.slice(0,maxLines),width=maxWidth??Math.max(0,...visible.map(row=>row.width)),step=lineHeight??font.height;
    if(!Number.isFinite(step)||step<=0)throw new Error('菜单文本行距无效');
    const contentHeight=visible.length*step,areaHeight=boxHeight??((visible.length-1)*step+font.height);
    const textTop=boxHeight===null||verticalAlign==='top'?0:verticalAlign==='center'?Math.floor((boxHeight-contentHeight)/2):boxHeight-contentHeight;
    // Native TextOut does not clip to the layout rectangle. Preserve short
    // MNU rows, negative glyph bearings and shadows in the canvas bounds.
    let inkLeft=0,inkRight=width,inkTop=0,inkBottom=areaHeight;
    for(let index=0;index<visible.length;index++){
      const row=visible[index],remaining=width-row.width,origin=align==='center'?Math.floor(remaining/2):align==='right'?remaining:0;
      for(const run of row.runs){
        let pen=origin+run.x;
        for(const char of run.text){
          const glyph=inkGlyphs[char];
          if(glyph.width&&glyph.height){
            inkLeft=Math.min(inkLeft,pen+glyph.offset_x/scale);
            inkRight=Math.max(inkRight,pen+(glyph.offset_x+glyph.width)/scale);
            inkTop=Math.min(inkTop,textTop+index*step+glyph.offset_y/scale);
            inkBottom=Math.max(inkBottom,textTop+index*step+(glyph.offset_y+glyph.height)/scale);
          }
          pen+=advanceOverride!==null&&char.codePointAt(0)>127?advanceOverride:font.glyphs[char].advance;
        }
      }
    }
    const offsetX=Math.min(-1,Math.floor(inkLeft)-(shadow===null?0:1));
    const right=Math.max(Math.ceil(width)+1,Math.ceil(inkRight)+(shadow===null?0:1));
    const offsetY=Math.min(-1,Math.floor(inkTop)-(shadow===null?0:1));
    const bottom=Math.max(Math.ceil(areaHeight)+1,Math.ceil(inkBottom)+(shadow===null?0:1));
    const logicalWidth=right-offsetX,logicalHeight=bottom-offsetY;
    canvas.width=logicalWidth*scale;canvas.height=logicalHeight*scale;
    if(scale>1||canvas.gpuPixelScale>1){
      canvas.style.width=scale>1?`${logicalWidth}px`:'';
      canvas.style.height=scale>1?`${logicalHeight}px`:'';
    }
    canvas.gpuPixelScale=scale;
    canvas.setAttribute('role','img');canvas.setAttribute('aria-label',text);
    const context=canvas.getContext('2d');context.imageSmoothingEnabled=false;
    function pass(color,dx,dy,only=null) {
      const source=hd?null:atlas(key,color);
      for(let index=0;index<visible.length;index++) {
        const row=visible[index],remaining=width-row.width,origin=-offsetX+dx+(align==='center'?Math.floor(remaining/2):align==='right'?remaining:0);
        for(const run of row.runs){
          if(only&&only!==run)continue;
          let pen=origin+run.x;
          for(const char of run.text) {
            const glyph=inkGlyphs[char];
            if(glyph.width&&glyph.height){
              const x=pen*scale+glyph.offset_x,y=(-offsetY+dy+textTop+index*step)*scale+glyph.offset_y;
              if(hd)context.drawImage(tintGlyph(key,char,color,hd.image,glyph),x,y);
              else context.drawImage(source,glyph.x,glyph.y,glyph.width,glyph.height,x,y,glyph.width,glyph.height);
            }
            pen+=advanceOverride!==null&&char.codePointAt(0)>127?advanceOverride:font.glyphs[char].advance;
          }
        }
      }
    }
    if(layout==='mnu'){
      for(const row of visible)for(const run of row.runs){
        if(shadow!==null)for(const [dx,dy] of shadowOffsets)pass(shadow,dx,dy,run);
        pass(foreground,0,0,run);
      }
    }else{
      if(shadow!==null)for(const [dx,dy] of shadowOffsets)pass(shadow,dx,dy);
      pass(foreground,0,0);
    }
    canvas.menuTextSignature=signature;canvas.menuTextBounds={width:logicalWidth,height:logicalHeight,offsetX,offsetY,lineCount:visible.length,truncated:rows.length>visible.length};
    if(composite)registerGlyph(canvas);
    return canvas.menuTextBounds;
  }
  const renderer={paint,measure,supports,selectFonts,prepareHdFonts,hasHdFont:key=>Boolean(hdAtlas(key)),
    get revision(){return revision;},get fonts(){return manifest.fonts;}};
  return renderer;
}
