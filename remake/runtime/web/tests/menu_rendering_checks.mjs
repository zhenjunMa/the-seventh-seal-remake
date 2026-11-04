import {OperationMenuView} from '../operation_menu_view.mjs';
import {createMenuController} from '../controllers/menu.mjs';
import {chapterRoleFromDefinition} from '../core/chapter.mjs';
import {createPartyActors} from '../core/party_attributes.mjs';
import {WorldStore} from '../core/world.mjs';
import {registerGlyph} from '../phaser/rendering/recorded_surface.mjs';

const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const assert=(value,message)=>{if(!value)throw new Error(message);};
const read=async name=>(await fetch('../'+name)).json();

// Production views/controller/compositor with illustrative pixels. This does
// not substitute for the missing original bitmaps or font-atlas acceptance.
export async function checkMenuRendering(runtime,record){
  const [manifest,supplement,items,skills,attributes,seed,html]=await Promise.all([
    ...['operation_menu','operation_techniques','items','party_skills','party_combat','opening_seed'].map(name=>read('data/'+name+'.json')),
    fetch('../index.html').then(response=>response.text())]);
  seed.party.push(chapterRoleFromDefinition(seed.source.role_definitions['002']));
  const pixels=new Map();
  function image(width=24,height=24,label=''){
    const key=width+':'+height+':'+label;if(pixels.has(key))return pixels.get(key);
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');
    ctx.fillStyle=width>200?'#172a40':'#605132';ctx.fillRect(0,0,width,height);ctx.strokeStyle='#8b794b';ctx.strokeRect(.5,.5,width-1,height-1);
    if(label){ctx.fillStyle='#dfd4a6';ctx.font='14px sans-serif';ctx.fillText(label,4,16);}
    const url=canvas.toDataURL();pixels.set(key,url);return url;
  }
  const sources=new Map();
  for(const menu of [...manifest.menus,...supplement.menus]){
    if(menu.composed)sources.set(menu.composed,image(menu.width,menu.height,menu.id));
    for(const row of menu.images)sources.set(row.image,image(row.width??menu.width,row.height??menu.height,menu.id));
  }
  for(const [id,panel]of Object.entries(manifest.actor_panels))for(const path of Object.values(panel))if(typeof path==='string')sources.set(path,image(480,83,'人物 '+id));
  const replace=value=>{
    if(typeof value==='string')return value.startsWith('assets/')?sources.get(value)??image():value;
    if(Array.isArray(value))return value.map(replace);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,replace(child)]));
    return value;
  };
  const root=new DOMParser().parseFromString(html,'text/html').querySelector('#partyMenu');
  root.style.cssText='position:relative;width:640px;height:480px;z-index:20';runtime.parent.after(root);
  const label=document.createElement('p');label.textContent='菜单示意素材检查：实际视图、事务与 WebGL；非原版像素。';root.before(label);
  const $=id=>id==='partyMenu'?root:root.querySelector('#'+id);
  for(const id of ['mapName','menuVitals'])if(!$(id)){const node=document.createElement('span');node.id=id;node.hidden=true;root.append(node);}
  $('mapName').textContent='菜单检查';
  let paints=0;
  const textRenderer={supports:()=>true,paint(canvas,value,options={}){
    const signature=JSON.stringify([String(value),options]);if(canvas.menuTextSignature===signature)return canvas.menuTextBounds;
    paints++;canvas.width=Math.max(2,String(value).length*12+2);canvas.height=24;const ctx=canvas.getContext('2d');
    ctx.font='18px sans-serif';ctx.fillStyle=options.foreground??'#fff';ctx.fillText(String(value),1,19);
    canvas.menuTextSignature=signature;canvas.menuTextBounds={offsetX:0,offsetY:0};registerGlyph(canvas);return canvas.menuTextBounds;
  }};
  let controller,view;
  const configured={items:{...items,runtime_configuration:{differences:[]}},party_skills:skills,audit:{mode:'original'}};
  const state={world:new WorldStore(seed),partyCombat:attributes,partySkills:skills,itemData:items,keys:new Set(),selectedRole:seed.party[0].id,
    scenes:{phase:'map',setPhase(phase){this.phase=phase;}},audio:{playCue(){},snapshot:()=>({channels:{master:{volume:1},music:{volume:1},effects:{volume:1}}})},menuSettings:{snapshot:()=>({battleCursor:'initial'})}};
  const actions={readMenuConfiguration:async()=>configured,log(){},status(){},option:(value,text)=>Object.assign(document.createElement('option'),{value,textContent:text})};
  actions.buildHud=actions.readConfiguredData=()=>{throw new Error('打开菜单不应重建地图 HUD 或复制战斗配置');};
  controller=createMenuController({state,actions,$,canvas:runtime.canvas});
  Object.assign(actions,controller);
  view=state.operationMenu=new OperationMenuView({manifest:replace(manifest),techniquesSupplement:replace(supplement),textRenderer,root,
    onPage:controller.showOperationPage,onActor:(id,confirmed)=>{$('menuActor').value=id;if(confirmed)controller.showOperationPage(state.menuContext.selectionPage??'status');},
    onItemSelect:id=>controller.selectMenuItem(id,{showInfo:true}),onItemFilter:(type,subtype)=>{state.menuContext.itemFilter=[type,subtype];controller.refreshPartyMenu();},
    onSlot:slotId=>{$('menuSlot').value=slotId;controller.refreshPartyMenu();},onSystemSetting(){},onSystemExit(){}});
  try{
    await controller.openPartyMenu();await frame();await frame();
    assert(view.current==='roster'&&runtime.ui.snapshot().visible>0,'人物首页或实际 GPU 字形没有显示');
    const gold=$('menuGold').querySelector('canvas'),summary=view.rosterButtons.values().next().value.querySelector('dl');
    const reopen=[];for(let n=0;n<5;n++){controller.closePartyMenu();const start=performance.now();await controller.openPartyMenu();reopen.push(performance.now()-start);}
    assert($('menuGold').querySelector('canvas')===gold&&view.rosterButtons.values().next().value.querySelector('dl')===summary,'重开菜单丢失文字节点');
    record('菜单首次／重复打开：无完整配置复制、无外围 HUD 重建；人物摘要和文字画布保留');
    controller.showOperationPage('status');await frame();await frame();
    const actorGlyph=$('menuActorSummary').querySelector('canvas');
    assert(runtime.ui.visible.some(entry=>entry.canvas===actorGlyph),'状态页人物摘要未参与合成');

    // Forty entries exercise the native scroll viewport with a bounded pixel pool.
    const inventory=state.world.value.inventory;
    const definition=items.definitions['156'];state.world.value.inventory=Array.from({length:40},(_,n)=>({id:156,instance_id:'probe-'+n,name:definition.name,quantity:2}));
    controller.showOperationPage('items','crystals');view.focusItem();await frame();await frame();
    assert(!runtime.ui.visible.some(entry=>entry.canvas===actorGlyph),'切页样式隐藏的旧人物文字仍在合成');
    const itemNodes=[...$('menuItemList').querySelectorAll('canvas')],itemGold=$('menuGold').querySelector('canvas');
    const itemTimes=[];for(let n=0;n<20;n++){const start=performance.now();view.key(n%2?'ArrowUp':'ArrowDown');itemTimes.push(performance.now()-start);await frame();}
    assert(itemNodes.length===view.itemPageSize*2&&itemNodes.every(node=>node.isConnected),'物品移动重新建立了可见文字画布');
    assert($('menuGold').querySelector('canvas')===itemGold,'物品移动刷新了无关金额');
    view.key('PageDown');view.key('PageDown');await frame();
    assert(view.itemOffset>0&&$('menuItemList').querySelectorAll('canvas').length===itemNodes.length,'翻页没有保留有界可见行池');
    assert(itemNodes.every(node=>node.isConnected),'翻页替换了文字画布');
    record('物品40项：上下移动、原生翻页与焦点通过；可见文字画布数量固定，金额未刷新');
    const targets=createPartyActors(state.world.value,attributes,{},items);view.itemTargets(targets,targets[0].id);
    const target=view.targetButtons.get(targets[0].id),hp=target._fields.hp.current.querySelector('canvas');
    view.itemTargets(targets,targets[0].id);assert(view.targetButtons.get(targets[0].id)===target&&target._fields.hp.current.querySelector('canvas')===hp,'目标列表丢失按钮或数值画布');
    view.escape();assert($('menuItemTargets').hidden,'目标层取消失败');
    record('物品目标栏：重复刷新保留按钮、HP／MP画布及焦点，逐层取消通过');

    controller.showOperationPage('skills');const tech=view.techniques;tech.page({section:'edit',roleId:seed.party[0].id,layer:'content'});tech.action='set';tech.category=1;tech.stage='candidates';tech.paint();tech.focus('content');
    const panel=tech.listBackground,rows=[...tech.listButtons],canvases=rows.map(row=>row._labelNode.querySelector('canvas')),revision=tech.paintRevision;
    const skillTimes=[];for(let n=0;n<20;n++){const start=performance.now();tech.key(n%2?'ArrowUp':'ArrowDown');skillTimes.push(performance.now()-start);await frame();}
    assert(tech.paintRevision===revision&&tech.listBackground===panel,'技能移动重建了面板');
    assert(rows.every((row,index)=>row===tech.listButtons[index]&&row._labelNode.querySelector('canvas')===canvases[index]),'技能移动替换了列表或文字');
    tech.key('PageDown');await frame();assert(tech.paintRevision===revision,'技能翻页重建了其他区域');
    assert(runtime.ui.game.renderer.gl.getError()===0,'菜单合成产生 WebGL 错误');
    record('技能列表：键盘／翻页保留六行、文字画布和其他面板；实际 WebGL 无错误');
    tech.stage='name-editor';tech.nameCodes=[1,2];tech.nameCursor=1;tech.paint();const character=tech.element.querySelector('[data-technique-key="char-0"]'),nameRevision=tech.paintRevision;
    character.click();assert(tech.paintRevision===nameRevision&&character.isConnected,'输入名称重建了字符面板');
    tech.element.querySelector('[data-technique-key="name-OK"]').click();const iconRevision=tech.paintRevision;
    tech.element.querySelector('[data-technique-key="icon-choice-2"]').click();assert(tech.nameIcon===2&&tech.paintRevision===iconRevision,'图标选择重建了面板');
    record('技巧命名与图标选择：仅更新名称／预览，字符与图标面板保留');
    state.world.value.inventory=inventory;
    controller.showOperationPage('equipment');controller.selectEquipmentSlot('head');const equipment=view.equipmentView;
    equipment.openPicker();const eqRows=[...equipment.rowButtons];equipment.key('ArrowDown');assert(eqRows.every((row,index)=>row===equipment.rowButtons[index]),'装备候选移动替换了控件');view.escape();
    controller.showOperationPage('weapon');const weapon=view.weaponView;weapon.socketButtons.get(0).focus();weapon.openPicker();weapon.key('ArrowDown');view.escape();
    for(const page of ['status','formation','system','roster']){controller.showOperationPage(page);await frame();}
    record('状态、装备、法器、队列、系统与返回人物首页切换通过');
    const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)].toFixed(3);
    record(`浏览器同步处理耗时中位数：重开 ${median(reopen)}ms，物品移动 ${median(itemTimes)}ms，技能移动 ${median(skillTimes)}ms；不含帧呈现延迟。栅格绘制累计 ${paints} 次。`);
  }finally{
    controller.closePartyMenu();view.messageObserver.disconnect();view.resize.disconnect();view.equipmentView.picker.remove();view.techniques.destroy();root.remove();label.remove();
  }
}
