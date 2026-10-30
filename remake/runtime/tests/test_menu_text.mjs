import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createMenuTextRenderer} from '../web/core/menu_text.mjs';
import {operationMnuTextOptions} from '../web/core/menu_presentation.mjs';

const manifest=JSON.parse(fs.readFileSync(new URL('../web/data/menu_fonts.json',import.meta.url),'utf8'));
function canvas() {
  const calls=[];
  return {calls,width:0,height:0,setAttribute(){},getContext(){return {
    drawImage(...args){calls.push(args);},fillRect(){},
    set globalCompositeOperation(value){},set fillStyle(value){},set imageSmoothingEnabled(value){},
  };}};
}
async function renderer() {
  return createMenuTextRenderer(manifest,{
    document:{createElement(){return canvas();}},
    makeImage:()=>({width:1280,height:1200,async decode(){}}),
  });
}

test('all connected skill and item descriptions and enemy target names have exported menu and battle glyphs',async()=>{
  const text=await renderer(),load=name=>JSON.parse(fs.readFileSync(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
  const menu=load('operation_menu').menus.find(m=>m.id==='game001'),battle=load('battle_ui').menus.find(m=>m.id==='fight_info');
  const profiles=[operationMnuTextOptions(menu.widgets.find(w=>w.name==='INFO')).font,operationMnuTextOptions(battle.widgets.find(w=>w.name==='TEXT')).font,'simsun12_text'];
  const descriptions=Object.values(load('items').definitions).flatMap(item=>[item.name,item.description??'']);
  descriptions.push(...Object.values(load('forest_combat').actors).map(actor=>actor.name));
  for(const role of Object.values(load('party_skills').roles))for(const index of new Set([...role.learned_indices,...role.exposed_indices??[]])){
    const skill=role.skills[index],raw=Buffer.from(skill.fixed_raw_hex,'hex').subarray(0x3b,0x3b+200);
    descriptions.push(skill.name,new TextDecoder('gbk').decode(raw.subarray(0,raw.indexOf(0))));
  }
  descriptions.push(' → ','　MP 999');
  for(const font of profiles)for(const description of descriptions)assert.equal(text.supports(description,font),true,`${font}: ${description}`);
});

test('caption single lower-right shadow does not inherit both menu shadow passes',async()=>{
  const text=await renderer(),target=canvas();
  text.paint(target,'9',{font:'simsun18',shadowOffsets:[[1,1]]});
  assert.equal(target.calls.length,2);
  assert.equal(target.calls[0][5],target.calls[1][5]+1);
  assert.equal(target.calls[0][6],target.calls[1][6]+1);
});

test('roster %5d/ uses the exported one-pixel GDI character extra',async()=>{
  const text=await renderer(),font=manifest.fonts.simsun18;
  assert.equal(font.glyphs['0'].advance,10);
  assert.equal(text.measure('  900/','simsun18'),60);
  const target=canvas(),result=text.paint(target,'  900/',{font:'simsun18'});
  assert.equal(result.offsetX,-1);
  assert.equal(target.calls.length,12);
  // The first digit follows two measured spaces; blank padding has no ink.
  assert.equal(target.calls[0][5]+result.offsetX,19+font.glyphs['9'].offset_x);
  assert.equal(target.calls[4][5]+result.offsetX,21+font.glyphs['9'].offset_x);
  assert.equal(target.calls[8][5]+result.offsetX,20+font.glyphs['9'].offset_x);
});

test('GDI negative side bearing and both diagonal shadows survive canvas bounds',async()=>{
  const text=await renderer(),target=canvas();
  assert.equal(manifest.fonts.simsun19_text.glyphs.N.offset_x,-1);
  const result=text.paint(target,'N',{font:'simsun19_text'});
  assert.equal(result.offsetX,-2);
  for(const draw of target.calls){
    assert.ok(draw[5]>=0,'left ink is not clipped');
    assert.ok(draw[5]+draw[7]<=target.width,'right ink is not clipped');
  }
  assert.equal(target.calls[0][5]+result.offsetX,-2);
  assert.equal(target.calls[1][5]+result.offsetX,0);
  assert.equal(target.calls[2][5]+result.offsetX,-1);
});

test('short MNU rectangles align their baseline without clipping the font or shadow',async()=>{
  const text=await renderer(),target=canvas();
  const result=text.paint(target,'999',{font:'arial23_mnu',boxHeight:14,lineHeight:24,verticalAlign:'center'});
  assert.equal(target.calls.at(-1)[6]+result.offsetY,-5+manifest.fonts.arial23_mnu.glyphs['9'].offset_y);
  for(const draw of target.calls){assert.ok(draw[6]>=0);assert.ok(draw[6]+draw[8]<=target.height);}
  assert.ok(result.offsetY<-1);
});

test('a character wider than a source text rectangle retains its full ink',async()=>{
  const text=await renderer(),target=canvas();
  text.paint(target,'火',{font:'simsun19_text',maxWidth:7,advanceOverride:20});
  for(const draw of target.calls)assert.ok(draw[5]+draw[7]<=target.width);
  assert.ok(target.width>9);
});

test('MNU Chinese wrapping uses declared size while preserving glyph height',async()=>{
  const text=await renderer(),target=canvas();
  const result=text.paint(target,'火之谷',{font:'requested_black19_mnu',maxWidth:40,lineHeight:20,advanceOverride:20,shadow:null});
  assert.equal(result.lineCount,2);
  assert.equal(target.calls[1][5]-target.calls[0][5],20+manifest.fonts.requested_black19_mnu.glyphs['之'].offset_x-manifest.fonts.requested_black19_mnu.glyphs['火'].offset_x);
  assert.equal(target.calls[2][6]-manifest.fonts.requested_black19_mnu.glyphs['谷'].offset_y,target.calls[0][6]-manifest.fonts.requested_black19_mnu.glyphs['火'].offset_y+20);
});

test('the atlas covers all original combination names and connected operation labels',async()=>{
  const text=await renderer();
  const source=JSON.parse(fs.readFileSync(new URL('../web/data/operation_techniques.json',import.meta.url),'utf8'));
  assert.ok(text.supports(source.name_charset.characters.join(''),'simsun19_text'));
  assert.ok(text.supports('决定删除测试关闭记忆，请先选择技巧。','requested_black19_mnu'));
});

test('MNU numeric centering uses GetCharWidthA while retaining TextOut character extra',async()=>{
  const text=await renderer(),font=manifest.fonts.arial23_mnu,target=canvas();
  const nativeWidth=font.glyphs['9'].char_width*3;
  assert.equal(text.measure('999','arial23_mnu',{layout:'mnu',lineHeight:24}),nativeWidth);
  assert.equal(text.measure('999','arial23_mnu'),font.glyphs['9'].advance*3);
  const result=text.paint(target,'999',{font:'arial23_mnu',layout:'mnu',lineHeight:24,maxWidth:60,align:'center',shadow:null});
  assert.equal(target.calls[0][5]+result.offsetX,Math.floor((60-nativeWidth)/2)+font.glyphs['9'].offset_x);
  assert.equal(target.calls[1][5]-target.calls[0][5],font.glyphs['9'].advance);
});

test('MNU ASCII groups wrap together and leave the native group gap before Chinese',async()=>{
  const text=await renderer(),font=manifest.fonts.simsun19_text;
  const target=canvas(),result=text.paint(target,'HP 火',{font:'simsun19_text',layout:'mnu',advanceOverride:20,lineHeight:20,maxWidth:34,shadow:null});
  assert.equal(result.lineCount,2);
  assert.equal(target.calls[0][6]-font.glyphs.H.offset_y,target.calls[1][6]-font.glyphs.P.offset_y);
  assert.equal(target.calls[2][6]-font.glyphs['火'].offset_y,target.calls[0][6]-font.glyphs.H.offset_y+20);
  assert.equal(text.measure('HP 火','simsun19_text',{layout:'mnu',advanceOverride:20}),font.glyphs.H.char_width+font.glyphs.P.char_width+12+20);
});

test('direct skill rectangle layout keeps its full requested font height and 19px Chinese step',async()=>{
  const text=await renderer(),font=manifest.fonts.simsun19_text,target=canvas();
  const result=text.paint(target,'炎浴．暖心之炎',{font:'simsun19_text',layout:'mnu',advanceOverride:19,lineHeight:19,maxWidth:250,boxHeight:30,verticalAlign:'center',shadow:null});
  assert.equal(font.height,19,'0x534C2B uses the requested height without the MNU size-1 rule');
  assert.equal(target.calls[0][6]+result.offsetY,5+font.glyphs['炎'].offset_y);
  assert.equal(target.calls[1][5]-font.glyphs['浴'].offset_x,target.calls[0][5]-font.glyphs['炎'].offset_x+19);
  assert.equal(text.measure('炎浴．暖心之炎','simsun19_text',{layout:'mnu',advanceOverride:19}),7*19);
});
