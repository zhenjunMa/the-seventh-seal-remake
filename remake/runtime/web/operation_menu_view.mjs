// Keep original menu images and hit rectangles in the original coordinate plane.
import {operationSummaryFields, operationStandingFrame, operationMnuTextOptions} from './core/menu_presentation.mjs';
import {OperationSystemView} from './operation_system_view.mjs';
import {OperationTechniqueView} from './operation_technique_view.mjs';
import {OperationEquipmentView} from './operation_equipment_view.mjs';
import {OperationWeaponView} from './operation_weapon_view.mjs';
import {OperationFormationView} from './operation_formation_view.mjs';
export class OperationMenuView{
  get mode(){return this._mode;}
  set mode(value){this._mode=value;if(this.root)this.root.dataset.focusLayer=value;}
  constructor({manifest,root,textRenderer,techniquesSupplement,onPage,onActor,onItemSelect,onItemConfirm,onItemTarget,onSlot,onItemFilter,onSystemSetting,onSystemExit,onTechniqueActor,onTechniqueSlot,onTechniqueCast,onTechniqueTest,onTechniqueMessage,onTechniqueCreate,onTechniqueRename,onTechniqueDelete,onEquipmentSelect,onEquipmentConfirm,onEquipmentUnequip,onFormationExchange,onWeaponSocket,onWeaponSelect,onWeaponConfirm,onWeaponUnequip,onWeaponActorChange}){
    if(manifest?.version!==1||!Array.isArray(manifest.menus))throw new Error('操作界面素材版本无效');
    this.manifest=manifest;this.menus=new Map(manifest.menus.map(menu=>[menu.id,menu]));this.root=root;this.frame=root.querySelector('#operationFrame');this.onPage=onPage;this.onActor=onActor;this.onItemSelect=onItemSelect;this.onItemConfirm=onItemConfirm;this.onItemTarget=onItemTarget;this.onSlot=onSlot;this.rosterButtons=new Map();this.itemButtons=new Map();this.slotButtons=new Map();this.mode='main';this.mainIndex=0;
    this.node=id=>root.querySelector('#'+id);this.node('menuBackground').src=this.menus.get('game001').images[0].image;this.frame.tabIndex=-1;
    this.textRenderer=textRenderer;
    this.formation=new OperationFormationView({manifest,root,onExchange:onFormationExchange,onFocus:()=>{this.mode='content';},onInfo:message=>{this.node('menuMessage').textContent=message;}});
    this.messageObserver=new MutationObserver(()=>{const node=this.node('menuMessage');if(node.firstChild?.nodeType===3)this.mnuText(node,node.textContent,'game001','INFO',{maxLines:2});});
    this.messageObserver.observe(this.node('menuMessage'),{childList:true});
    this.equipmentView=new OperationEquipmentView({manifest,root,textRenderer,onSlot,onSelect:onEquipmentSelect,onConfirm:onEquipmentConfirm,onUnequip:onEquipmentUnequip,onInfo:message=>{this.node('menuMessage').textContent=message;},onFocus:()=>{this.mode='content';}});
    this.weaponView=new OperationWeaponView({manifest,root,textRenderer,onSocket:onWeaponSocket,onSelect:onWeaponSelect,onConfirm:onWeaponConfirm,onUnequip:onWeaponUnequip,onActorChange:onWeaponActorChange,onInfo:message=>{this.node('menuMessage').textContent=message;},onFocus:()=>{this.mode='content';}});
    this.techniques=new OperationTechniqueView({root:this.frame,manifest,supplement:techniquesSupplement,textRenderer,onActor:onTechniqueActor,onFieldSkill:onTechniqueCast,onSetSlot:onTechniqueSlot,onCreateCombination:onTechniqueCreate,onRenameCombination:onTechniqueRename,onDeleteCombination:onTechniqueDelete,onTest:onTechniqueTest,onMessage:onTechniqueMessage,onInfo:message=>{this.node('menuMessage').textContent=message;},onFocus:mode=>{this.mode=mode;this.mainCommitted=true;this.subCommitted=mode==='content';this.highlight();}});
    this.system=new OperationSystemView({manifest,root:this.node('menuSystemSection'),navigation:this.node('menuSystemNavigation'),onSetting:onSystemSetting,onExit:onSystemExit});
    for(const {button}of this.system.tabs){const focus=button.onfocus,click=button.onclick;button.onfocus=()=>{this.mode='sub';focus();this.highlight(button);};button.onclick=()=>{this.subCommitted=true;click();};}
    for(const button of [...this.system.rows,...this.system.bars,...this.system.mutes.map(row=>row.button),...this.system.cursorButtons.map(row=>row.button)]){const focus=button.onfocus;button.onfocus=()=>{this.mode='content';focus();this.highlight(button);};}
    this.main=[['menuStatusTab','STATUS','roster'],['menuObjectsTab','OBJECT','items'],['menuTechTab','TECH','skills'],['menuSystemTab','SYSTEM','system']];
    for(const [id,key,page]of this.main){
      const button=this.node(id),widget=this.menus.get('game001').widgets.find(row=>row.name===key),r=widget.rect;
      Object.assign(button.style,{left:r.left+'px',top:r.top+'px',width:r.right-r.left+1+'px',height:r.bottom-r.top+1+'px'});
      this.widgetImage(button,widget,{x:0,y:0},false);
      button.onclick=()=>{this.mainIndex=this.main.findIndex(row=>row[0]===id);this.mainCommitted=true;this.subCommitted=false;if(this.mainPage()!==page)onPage(page);this.focusGroup('sub',this.headerIndex());};button.onfocus=()=>{this.mode='main';this.mainIndex=this.main.findIndex(row=>row[0]===id);this.mainCommitted=true;this.subCommitted=false;if(this.mainPage()!==page)onPage(page);this.highlight(button);};
    }
    this.characterTabs=[['menuStatusPage','STATUS','status'],['menuEquipmentPage','EQUIP','equipment'],['menuFormationPage','TEAM','formation'],['menuWeaponPage','MAGIC','weapon']];
    for(const [id,key,page]of this.characterTabs){const button=this.node(id),widget=this.menus.get('game001d').widgets.find(row=>row.name===key),origin=manifest.page_bindings.characters.header_origin,r=widget.rect;Object.assign(button.style,{left:r.left+origin.x+'px',top:r.top+origin.y+'px',width:r.right-r.left+1+'px',height:r.bottom-r.top+1+'px'});button.onclick=()=>{this.subCommitted=true;onPage('choose-'+page);this.focusGroup('content');};button.onfocus=()=>{this.mode='sub';this.highlight(button);};}
    this.itemTabs=[['menuItemsPage','OBJ1','items'],['menuInventoryEquipmentPage','OBJ2','equipment'],['menuCrystalsPage','OBJ3','crystals']];
    for(const [id,key,category]of this.itemTabs){const button=this.node(id),r=this.menus.get('game003a').widgets.find(row=>row.name===key).rect,origin=manifest.page_bindings.items.header_origin;Object.assign(button.style,{left:r.left+origin.x+'px',top:r.top+origin.y+'px',width:r.right-r.left+1+'px',height:r.bottom-r.top+1+'px'});button.onclick=()=>{this.subCommitted=true;onPage('items',category);this.focusItem();};button.onfocus=()=>{this.mode='sub';if(this.itemCategory!==category)onPage('items',category);this.highlight(button);};}
    this.filters=[[5,1,'药品'],[5,4,'投掷物'],[5,3,'特殊道具'],[3,2,'材料'],[5,2,'重要物品']].map(([type,subtype,label],index)=>{const button=document.createElement('button'),widget=this.menus.get('game003_1').widgets.find(w=>w.name===String(index+1).padStart(2,'0'));button.className='item-filter';button.setAttribute('aria-label',label);Object.assign(button.style,{left:widget.rect.left+'px',top:widget.rect.top+'px',width:widget.rect.right-widget.rect.left+1+'px',height:widget.rect.bottom-widget.rect.top+1+'px'});button.onfocus=()=>{this.widgetImage(button,widget,{x:0,y:0},true);};button.onblur=()=>this.widgetImage(button,widget,{x:0,y:0},false);button.onclick=()=>{this.itemFilterIndex=index;this.itemFocused=false;this.itemOffset=0;this.node('menuItemList').scrollTop=0;onItemFilter?.(type,subtype);};this.node('menuItemSection').append(button);return button;});
    this.equipmentFilters=['头饰／耳环','项链','戒指','徽章','特殊饰品'].map((label,index)=>{
      const button=document.createElement('button'),widget=this.menus.get('game003_2').widgets.find(row=>row.name===String(index+1).padStart(2,'0')),r=widget.rect;
      button.type='button';button.className='item-filter';button.setAttribute('aria-label',label);Object.assign(button.style,{left:r.left+'px',top:r.top+'px',width:r.right-r.left+1+'px',height:r.bottom-r.top+1+'px'});
      button.onfocus=()=>{this.mode='content';this.paintItemFilters();};button.onblur=()=>this.paintItemFilters();
      button.onclick=()=>{this.itemFilterIndex=index;this.itemFocused=true;this.itemOffset=0;this.node('menuItemList').scrollTop=0;this.node('menuItem').value='';this.node('menuMessage').textContent='';this.node('menuItemCard').hidden=true;onItemFilter?.(2,index+1);this.paintItemFilters();this.focusItem();};
      this.node('menuItemSection').append(button);return button;
    });
    this.itemScrollButtons=new Map();
    for(const [category,menuId]of [['items','game003_1'],['equipment','game003_2'],['crystals','game003_3']]){
      const buttons=[['up',-1],['dn',1]].map(([name,direction])=>{const widget=this.menus.get(menuId).widgets.find(row=>row.name.toLowerCase()===name),r=widget.rect,button=document.createElement('button');button.type='button';button.tabIndex=-1;button.className='item-list-scroll';button.setAttribute('aria-label',direction<0?'物品列表向上翻页':'物品列表向下翻页');Object.assign(button.style,{position:'absolute',left:r.left+'px',top:r.top+'px',width:r.right-r.left+1+'px',height:r.bottom-r.top+1+'px',border:'0',padding:'0',background:'none',outline:'none',zIndex:2});button.onpointerenter=()=>this.widgetImage(button,widget,{x:0,y:0},true);button.onpointerleave=()=>this.widgetImage(button,widget,{x:0,y:0},false);button.onclick=()=>this.pageItems(direction,{edgeFirst:false});this.node('menuItemSection').append(button);return button;});this.itemScrollButtons.set(category,buttons);
    }
    this.resize=new ResizeObserver(()=>this.fit());this.resize.observe(root);this.fit();
    for(const tabs of [this.characterTabs,this.itemTabs])tabs.forEach(([id],index)=>{const button=this.node(id),focus=button.onfocus;button.onfocus=()=>{this.subIndex=index;focus();};});
    this.filters.forEach(button=>{const focus=button.onfocus;button.onfocus=()=>{this.mode='content';focus();};});
  }
  widgetImage(button,widget,origin,active,selected=false){
    const path=selected?widget.selected_images.at(-1):active?widget.active_images.at(-1):widget.normal_images[0];let image=button.querySelector('img');
    if(!path){if(image)image.hidden=true;return;}if(!image){image=document.createElement('img');image.alt='';image.className='menu-source menu-highlight';button.append(image);}image.hidden=false;image.src=path;
    Object.assign(image.style,{left:widget.draw_point_raw.x+origin.x-parseFloat(button.style.left)+'px',top:widget.draw_point_raw.y+origin.y-parseFloat(button.style.top)+'px'});
  }
  highlight(button=null){
    if(this.mode!=='content')this.actorFocused=false;
    this.paintRosterFocus();
    this.focused=button;for(const [id,key]of this.main){const node=this.node(id),widget=this.menus.get('game001').widgets.find(row=>row.name===key);this.widgetImage(node,widget,{x:0,y:0},button===node||this.mainCommitted&&node.getAttribute('aria-pressed')==='true');}
    for(const [menuId,tabs,origin]of [['game001d',this.characterTabs,this.manifest.page_bindings.characters.header_origin],['game003a',this.itemTabs,this.manifest.page_bindings.items.header_origin]]){
      const focusedHeader=this.mode==='sub'&&tabs.some(([id])=>this.node(id)===button)?button:null;
      for(const [id,key]of tabs){const node=this.node(id),widget=this.menus.get(menuId).widgets.find(row=>row.name===key);this.widgetImage(node,widget,origin,focusedHeader?node===focusedHeader:this.subCommitted&&node.getAttribute('aria-pressed')==='true');}
    }
    this.system.navFocus=this.mode==='sub';this.system.committed=this.subCommitted;this.system.paint();
  }
  focusInitial(){this.mode='main';this.mainIndex=0;this.mainCommitted=true;this.subCommitted=false;this.actorFocused=false;this.itemFocused=false;this.itemFilterIndex=0;this.itemOffset=0;this.subIndex=0;this.frame.focus({preventScroll:true});this.highlight();}
  mainPage(){return ['roster','status','equipment','weapon','formation'].includes(this.current)?'roster':this.current;}
  headerIndex(){if(this.current==='skills')return Math.max(0,['use','edit','test'].indexOf(this.techniques.section));if(this.current==='system')return this.system.navIndex??0;const controls=this.controls('sub'),pressed=controls.findIndex(node=>node.getAttribute('aria-pressed')==='true');return Math.max(0,pressed);}
  focusGroup(mode,index=0){this.mode=mode;if(this.current==='skills'){this.techniques.mode=mode;this.techniques.paint();}let controls=this.controls(mode);if(mode==='sub'&&!controls.length){this.mode='content';controls=this.controls('content');}if(!controls.length){this.frame.focus({preventScroll:true});return;}controls[((index%controls.length)+controls.length)%controls.length]?.focus({preventScroll:true});}
  itemRows(){return (this.itemOrder??[]).map(id=>this.itemButtons.get(id)).filter(Boolean);}
  currentItemFilters(){return this.itemCategory==='equipment'?this.equipmentFilters:this.itemCategory==='items'?this.filters:[];}
  setItemFilter(type,subtype){const index=this.itemCategory==='equipment'&&type===2?subtype-1:this.itemCategory==='items'?[[5,1],[5,4],[5,3],[3,2],[5,2]].findIndex(row=>row[0]===type&&row[1]===subtype):0;this.itemFilterIndex=Math.max(0,Math.min(4,index));this.paintItemFilters();}
  paintItemFilters(){for(const [index,button]of this.equipmentFilters.entries()){const selected=this.itemCategory==='equipment'&&index===(this.itemFilterIndex??0),widget=this.menus.get('game003_2').widgets.find(row=>row.name===String(index+1).padStart(2,'0'));button.setAttribute('aria-pressed',String(selected));this.widgetImage(button,widget,{x:0,y:0},false,selected);}}
  ensureItemVisible(index){const count=this.itemRows().length,size=this.itemPageSize??9,max=Math.max(0,count-size);let offset=Math.max(0,Math.min(max,this.itemOffset??0));if(index<offset)offset=index;else if(index>=offset+size)offset=index-size+1;this.itemOffset=Math.max(0,Math.min(max,offset));this.node('menuItemList').scrollTop=this.itemOffset*(this.itemRowStep??30);}
  focusItem(id=this.itemSelectedId){const rows=this.itemRows(),index=Math.max(0,rows.findIndex(button=>button.dataset.instanceId===id));this.mode='content';if(!rows.length){const filters=this.currentItemFilters();(filters[this.itemFilterIndex??0]??filters[0]??this.frame).focus({preventScroll:true});return;}this.ensureItemVisible(index);rows[index].focus({preventScroll:true});}
  cycleActor(direction){const ids=this.rosterOrder??[],index=ids.indexOf(this.actorId);if(ids.length>1){const slot=this.current==='equipment'?this.equipmentView.slotId:null;this.onActor?.(ids[(Math.max(0,index)+direction+ids.length)%ids.length],false);if(slot){this.equipmentView.slotFocused=true;this.equipmentView.paintSlots();this.equipmentView.infoWorn();this.equipmentView.slotButtons.get(slot)?.focus({preventScroll:true});}}return true;}
  pageItems(direction,{edgeFirst=true}={}){const rows=this.itemRows();if(!rows.length)return true;const size=this.itemPageSize??9,offset=this.itemOffset??0,last=Math.min(rows.length-1,offset+size-1);let index=rows.indexOf(document.activeElement);if(index<0)index=Math.max(0,rows.findIndex(button=>button.dataset.instanceId===this.itemSelectedId));if(edgeFirst&&(direction>0?index<last:index>offset))index=direction>0?last:offset;else{this.itemOffset=Math.max(0,Math.min(Math.max(0,rows.length-size),offset+direction*size));index=Math.min(rows.length-1,this.itemOffset+Math.max(0,Math.min(size-1,index-offset)));}this.focusItem(rows[index].dataset.instanceId);return true;}
  itemKey(key,repeat=false){
    if(!this.node('menuItemTargets').hidden)return false;
    if(['ArrowLeft','ArrowRight'].includes(key)){
      const filters=this.currentItemFilters();if(filters.length){filters[((this.itemFilterIndex??0)+(key==='ArrowLeft'?-1:1)+filters.length)%filters.length]?.click();this.focusItem();}return true;
    }
    if(!['ArrowUp','ArrowDown','PageUp','PageDown'].includes(key))return false;
    if(key==='PageUp'||key==='PageDown')return this.pageItems(key==='PageUp'?-1:1);
    const rows=this.itemRows();if(!rows.length)return true;
    let index=rows.indexOf(document.activeElement);if(index<0)index=Math.max(0,rows.findIndex(button=>button.dataset.instanceId===this.itemSelectedId));
    index=Math.max(0,Math.min(rows.length-1,index+(key==='ArrowUp'?-1:1)));
    this.focusItem(rows[index].dataset.instanceId);return true;
  }
  controls(mode){
    const visible=node=>node&&!node.hidden&&node.getClientRects().length&&!node.disabled;
    if(mode==='main')return this.main.map(row=>this.node(row[0])).filter(visible);
    if(this.current==='skills')return this.techniques.controls(mode).filter(visible);
    if(this.current==='system')return this.system.controls(mode).filter(visible);
    if(mode==='sub')return (this.current==='items'?this.itemTabs:this.characterTabs).map(row=>this.node(row[0])).filter(visible);
    if(this.current==='roster')return (this.rosterOrder??[...this.rosterButtons.keys()]).map(id=>this.rosterButtons.get(id)).filter(visible);
    if(this.current==='items')return this.node('menuItemTargets').hidden?[...this.itemRows().filter(visible),...this.currentItemFilters().filter(visible)]:[...this.node('menuItemTargetList').querySelectorAll('button')].filter(visible);
    if(this.current==='equipment')return this.equipmentView.controls();
    if(this.current==='weapon')return this.weaponView.controls();
    if(this.current==='formation')return this.formation.controls();
    return [...this.root.querySelectorAll('.operation-content:not([hidden]) button,.operation-content:not([hidden]) select')].filter(visible);
  }
  key(key,repeat=false,{standaloneControl=false}={}){
    // A future key-up adapter can opt in after excluding Ctrl combinations.
    if(key==='Control'&&standaloneControl&&this.current==='formation'&&this.mode==='content'){if(!repeat){this.formation.escape();this.focusGroup('sub',2);}return true;}
    if(this.current==='items'&&this.mode==='content'&&this.itemKey(key,repeat))return true;
    if(this.mode==='content'&&['status','equipment'].includes(this.current)&&!(this.current==='equipment'&&this.equipmentView.pickerOpen)&&['x','z','X','Z'].includes(key))return this.cycleActor(key.toLowerCase()==='x'?1:-1);
    if(['PageUp','PageDown','x','z'].includes(key)){
      if(this.current==='skills'&&this.mode!=='main')return this.techniques.key(key,repeat);
      if(this.current==='equipment'&&this.mode==='content')return this.equipmentView.key(key,repeat);
      if(this.current==='weapon'&&this.mode==='content')return this.weaponView.key(key,repeat);
      return false;
    }
    if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' ','Enter','Tab'].includes(key))return false;
    if(!this.node('menuShortcutEditor').hidden)return false;
    if(this.current==='formation'&&this.mode==='content')return this.formation.key(key,repeat);
    if(this.current==='equipment'&&this.mode==='content')return this.equipmentView.key(key,repeat);
    if(this.current==='weapon'&&this.mode==='content')return this.weaponView.key(key,repeat);
    if(this.current==='skills'&&this.mode!=='main'){this.techniques.mode=this.mode;const handled=this.techniques.key(key,repeat);this.mode=this.techniques.mode;return handled;}
    if(this.current==='system'&&this.mode==='content')return this.system.key(key,repeat);
    if(key==='Tab')return true;
    const active=document.activeElement;if(this.mode==='content'&&active?.tagName==='SELECT'){
      if(this.current==='equipment'&&!this.node('menuEquipmentPicker').hidden&&[' ','Enter'].includes(key)){if(!repeat){this.node('menuEquip').click();this.node('menuEquipmentPicker').hidden=true;this.focusGroup('content');}return true;}
      if(key==='ArrowRight'||key==='ArrowLeft'){const group=this.controls('content'),index=group.indexOf(active);this.focusGroup('content',index+(key==='ArrowRight'?1:-1));return true;}
      if(this.current==='skills'&&[' ','Enter'].includes(key)){if(!repeat)(active.id==='menuSkill'?this.node('menuSkillTarget'):this.node('menuFieldSkill')).focus();return true;}
      return false;
    }
    const group=this.controls(this.mode),index=Math.max(0,group.indexOf(active));
    if(key===' '||key==='Enter'){
      if(repeat)return true;
      if(this.mode==='main'){this.node(this.main[this.mainIndex][0]).click();}
      else if(this.mode==='sub'){active?.click();}
      else active?.click();return true;
    }
    if(this.mode==='main'){this.mainIndex=(this.mainIndex+(['ArrowUp','ArrowLeft'].includes(key)?-1:1)+4)%4;this.focusGroup('main',this.mainIndex);return true;}
    this.focusGroup(this.mode,index+(['ArrowUp','ArrowLeft'].includes(key)?-1:1));return true;
  }
  escape(){
    if(this.current==='formation'&&this.mode==='content'){this.formation.escape();this.focusGroup('sub',2);return false;}
    if(this.current==='equipment'&&this.equipmentView.escape())return false;
    if(this.current==='weapon'&&this.weaponView.escape())return false;
    if(this.current==='skills'&&this.mode!=='main'){
      this.techniques.mode=this.mode;const back=this.techniques.escape();this.mode=this.techniques.mode;
      if(back)this.focusGroup('main',this.mainIndex);return false;
    }
    if(!this.node('menuEquipmentPicker').hidden){this.node('menuEquipmentPicker').hidden=true;this.focusGroup('content');return false;}
    if(!this.node('menuItemTargets').hidden){this.node('menuItemTargets').hidden=true;this.focusItem();return false;}
    if(this.mode==='main')return true;
    if(this.mode==='sub'){this.focusGroup('main',this.mainIndex);return false;}
    if(['status','equipment','weapon'].includes(this.current)){const roleId=this.actorId;this.onPage('back-roster');this.focusGroup('content',Math.max(0,this.controls('content').findIndex(button=>button.dataset.roleId===roleId)));return false;}
    this.focusGroup('sub',this.headerIndex());return false;
  }
  fit(){const r=this.root.getBoundingClientRect();this.frame.style.setProperty('--operation-scale',String(Math.min(r.width/640,r.height/480)));}
  bitmap(menuId){const menu=this.menus.get(menuId);if(!menu)throw new Error('操作界面素材缺失：'+menuId);return menu.composed??menu.images.find(image=>image.group===0).image;}
  source(id,menuId,x,y){const node=this.node(id);node.hidden=!menuId;if(!menuId)return;node.src=this.bitmap(menuId);node.style.left=x+'px';node.style.top=y+'px';}
  page(page,{combat=false,itemCategory='items',selectionPage=null}={}){
    if(page==='items'&&(this.current!=='items'||this.itemCategory!==itemCategory)){this.itemFilterIndex=0;this.itemOffset=0;this.node('menuItemList').scrollTop=0;}
    this.current=page;this.root.dataset.menuPage=page;this.root.classList.toggle('combat-items',combat);this.fit();
    this.equipmentView.reset();
    this.weaponView.reset();
    this.formation.section.hidden=page!=='formation';this.formation.reset();
    if(page==='skills')this.techniques.page({section:'use',layer:this.mode});else this.techniques.hide();
    this.itemCategory=itemCategory;
    for(const [category,buttons]of this.itemScrollButtons)for(const button of buttons)button.hidden=page!=='items'||itemCategory!==category;
    for(const filter of this.filters)filter.hidden=page!=='items'||itemCategory!=='items';
    for(const filter of this.equipmentFilters)filter.hidden=page!=='items'||itemCategory!=='equipment';this.paintItemFilters();
    const status=['roster','status','equipment','weapon','formation'].includes(page);
    for(const [id,value]of [['menuStatusTab',status],['menuObjectsTab',page==='items'],['menuTechTab',page==='skills'],['menuSystemTab',page==='system'],['menuStatusPage',page==='status'||selectionPage==='status'],['menuEquipmentPage',page==='equipment'||selectionPage==='equipment'],['menuWeaponPage',page==='weapon'||selectionPage==='weapon'],['menuFormationPage',page==='formation'||selectionPage==='formation']])this.node(id).setAttribute('aria-pressed',String(value));
    this.node('menuStatusNavigation').hidden=!status||combat;
    this.node('menuInventoryNavigation').hidden=page!=='items'||combat;
    this.system.show(page==='system');
    for(const [id,key]of [['menuItemsPage','items'],['menuInventoryEquipmentPage','equipment'],['menuCrystalsPage','crystals']])this.node(id).setAttribute('aria-pressed',String(itemCategory===key));
    for(const [id,key]of [['menuStatusSection','status'],['menuEquipmentSection','equipment'],['menuWeaponSection','weapon'],['menuItemSection','items'],['menuSkillsSection','skills'],['menuSystemSection','system']])this.node(id).hidden=key!==page;
    this.node('menuRoster').hidden=page!=='roster';this.node('menuActorBar').hidden=['roster','weapon','formation'].includes(page);this.node('menuActorSummary').hidden=['roster','weapon','formation'].includes(page);
    this.node('menuEquipmentPicker').hidden=true;this.node('menuItemTargets').hidden=true;
    const bindings=this.manifest.page_bindings,group=status?bindings.characters:page==='items'?bindings.items:page==='skills'?bindings.techniques:null;
    const head=group?.header_origin??{x:9,y:4};
    this.source('menuPageHeader',group?.header??'game005_1',head.x,head.y);
    const body=page==='status'?group.state_origin:page==='equipment'?group.equipment_origin:page==='weapon'?{x:10,y:50}:page==='formation'?group.formation_origin:page==='items'?group[itemCategory+'_origin']:page==='skills'?group.use_origin:null;
    this.source('menuPageBody',page==='status'?group.state:page==='equipment'?group.equipment:page==='weapon'?'game001c':page==='formation'?group.formation:page==='items'?group[itemCategory]:page==='skills'?group.use:page==='system'?'game005_2':null,page==='system'?5:body?.x??0,page==='system'?50:body?.y??0);
    if(page==='items'){const pic=this.menus.get(group[itemCategory]).widgets.find(row=>row.name.toLowerCase()==='pic').rect;this.cardRect=pic;Object.assign(this.node('menuItemSection').style,{left:body.x+'px',top:body.y+'px'});}
    if(page==='skills'){this.node('menuSkillsSection').hidden=true;this.node('menuPageHeader').hidden=true;this.node('menuPageBody').hidden=true;this.node('menuActorBar').hidden=true;this.node('menuActorSummary').hidden=true;this.node('menuStandingActor').hidden=true;}
    this.highlight(this.focused);
  }
  number(node,value,font='simsun18',foreground='#ffffff',shadow='#222222',options={}){
    if(!this.textRenderer){node.textContent=value;return;}
    const canvas=document.createElement('canvas');canvas.className='native-menu-number';const result=this.textRenderer.paint(canvas,String(value),{font,foreground,shadow,...(font.endsWith('_mnu')?{layout:'mnu'}:{}),...options});canvas.style.left=result.offsetX+'px';canvas.style.top=result.offsetY+'px';node.replaceChildren(canvas);
  }
  text(node,value,options={}){
    value=String(value??'');const font=options.font??'simsun24_text';
    if(!value||!this.textRenderer?.supports(value,font)){if(node.textContent!==value)node.textContent=value;return;}
    const canvas=document.createElement('canvas');canvas.className='native-menu-number';const result=this.textRenderer.paint(canvas,value,{font,foreground:'#ffffff',shadow:'#000000',...(font.endsWith('_mnu')?{layout:'mnu'}:{}),...options});canvas.style.left=result.offsetX+'px';canvas.style.top=result.offsetY+'px';node.replaceChildren(canvas);
  }
  mnuText(node,value,menuId,widgetName,options={}){const widget=this.menus.get(menuId).widgets.find(row=>row.name===widgetName);this.text(node,value,{...operationMnuTextOptions(widget),...options});}
  summary(node,status){node.replaceChildren(...operationSummaryFields(status).map(([label,value,key])=>{const row=document.createElement('div'),term=document.createElement('dt'),number=document.createElement('dd');row.className='summary-'+key;term.className='sr-only';term.textContent=label;this.number(number,value,key==='level'?'simsun26':'simsun18');row.append(term,number);return row;}));}
  paintRosterFocus(selectedId=this.rosterSelectedId){
    this.rosterSelectedId=selectedId;
    const focused=this.current==='roster'&&this.mode==='content'&&this.actorFocused;
    // The retained "unfocused" alias is the original purple focus panel.
    for(const [id,button]of this.rosterButtons){const selected=Boolean(focused&&id===selectedId),panel=this.manifest.actor_panels?.[id];button.classList.toggle('selected',selected);button.querySelector('img').src=panel?.[selected?'unfocused':'normal']??this.manifest.actor_bar.dynamic_name_image;}
  }
  roster(rows,selectedId){
    this.rosterOrder=rows.map(row=>row.id);
    const list=this.node('menuRoster');for(const [index,status]of rows.entries()){
      let button=this.rosterButtons.get(status.id);if(!button){button=document.createElement('button');button.className='roster-actor';button.dataset.roleId=status.id;const image=document.createElement('img'),name=document.createElement('span'),summary=document.createElement('dl');image.className='menu-source roster-actor-image';image.alt='';name.className='roster-actor-name';summary.className='actor-summary-values';button.append(image,name,summary);button.onclick=()=>this.onActor?.(status.id,true);button.onfocus=()=>{this.mode='content';this.actorFocused=true;this.onActor?.(status.id,false);this.paintRosterFocus(status.id);};this.rosterButtons.set(status.id,button);list.append(button);}
      button.style.top=index*86+'px';button.setAttribute('aria-label',`${status.name}，等级${status.level}，HP ${status.hp.current}/${status.hp.maximum}，MP ${status.mp.current}/${status.mp.maximum}`);const panel=this.manifest.actor_panels?.[status.id];button.querySelector('.roster-actor-name').textContent=panel?'':status.name;this.summary(button.querySelector('dl'),status);
    }
    for(const [id,button]of this.rosterButtons)if(!rows.some(row=>row.id===id)){button.remove();this.rosterButtons.delete(id);}
    this.paintRosterFocus(selectedId);
  }
  items(rows,selectedId,definitions,{showSelection=this.itemFocused,usableIds=null}={}){
    const list=this.node('menuItemList');
    const oldActive=document.activeElement,hadFocus=[...this.itemButtons.values()].includes(oldActive);
    this.itemOrder=rows.map(row=>row.instance_id);this.itemSelectedId=selectedId;
    const menuId={items:'game003_1',equipment:'game003_2',crystals:'game003_3'}[this.itemCategory]??'game003_1';
    const cells=this.menus.get(menuId).widgets.filter(widget=>/^list\d+$/i.test(widget.name));this.itemPageSize=cells.length;this.itemRowStep=cells.length>1?cells[1].rect.top-cells[0].rect.top:30;
    Object.assign(list.style,{left:cells[0].rect.left+'px',top:cells[0].rect.top+'px',width:cells[0].rect.right-cells[0].rect.left+1+'px',height:cells.at(-1).rect.bottom-cells[0].rect.top+1+'px'});
    for(const [index,row]of rows.entries()){
      let button=this.itemButtons.get(row.instance_id);if(!button){button=document.createElement('button');button.className='source-item-row';button.dataset.instanceId=row.instance_id;const highlight=document.createElement('img'),icon=document.createElement('img'),name=document.createElement('span'),quantity=document.createElement('span');highlight.className='menu-source item-row-highlight';highlight.alt='';highlight.src=this.menus.get('game003_1').widgets.find(w=>w.name==='list1').active_images[0];icon.className='menu-source item-row-icon';icon.alt='';name.className='item-row-name';quantity.className='item-row-quantity';button.append(highlight,icon,name,quantity);button.onfocus=()=>{this.mode='content';this.itemFocused=true;this.ensureItemVisible(this.itemOrder.indexOf(row.instance_id));this.onItemSelect?.(row.instance_id);};button.onclick=()=>{this.itemFocused=true;this.onItemSelect?.(row.instance_id);if(this.itemCategory==='items')this.onItemConfirm?.();};this.itemButtons.set(row.instance_id,button);}
      const def=definitions[String(row.id)],selected=showSelection&&row.instance_id===selectedId,unusable=usableIds&&!usableIds.has(row.instance_id);button.style.top=index*this.itemRowStep+'px';button.setAttribute('aria-label',`${row.name} ×${row.quantity}`);button.classList.toggle('selected',selected);this.text(button.querySelector('.item-row-name'),row.name,{foreground:unusable?'#505050':selected?'#ffff44':'#ffffff',shadow:unusable?'#000000':selected?'#4f4f4f':'#4f4f00'});this.text(button.querySelector('.item-row-quantity'),row.quantity>1?'x'+row.quantity:'',{font:'simsun20_text',foreground:unusable?'#505050':selected?'#ffff44':'#ffffff',shadow:unusable?'#000000':selected?'#4f4f4f':'#4f4f00'});button.classList.toggle('unusable',Boolean(unusable));const highlight=button.querySelector('.item-row-highlight');highlight.src=cells[index%cells.length].active_images[0];highlight.hidden=!selected;const icon=button.querySelector('.item-row-icon'),raw=Uint8Array.from(def.raw_hex.match(/../g),v=>parseInt(v,16)),indexRaw=new DataView(raw.buffer).getUint32(0x1c,true),frame=selected&&!unusable&&indexRaw>=1&&indexRaw<=21?indexRaw+95:indexRaw,iconAsset=this.manifest.item_row_icons?.frames?.[frame]??(def.type_raw_24===5&&def.subtype_raw_25===1?this.manifest.item_row_icons?.[selected?'active':'ordinary']:null);icon.hidden=!iconAsset;if(!icon.hidden)icon.src=iconAsset.image??iconAsset;if(button.parentNode!==list)list.append(button);
    }
    for(const [id,button]of this.itemButtons)if(!rows.some(row=>row.instance_id===id)){button.remove();this.itemButtons.delete(id);}
    this.ensureItemVisible(Math.max(0,this.itemOrder.indexOf(selectedId)));
    if(hadFocus&&!this.itemButtons.has(oldActive.dataset.instanceId))this.focusItem(selectedId);
  }
  equipment(slots,rows,definitions,selectedId){
    // The controller passes full instance and qualification data to render().
    this.slotButtons=this.equipmentView.slotButtons;
  }
  itemTargets(rows,selectedId){
    this.node('menuItemTargetSource').src=this.bitmap('game003_4');this.node('menuItemTargets').hidden=false;this.node('menuItemTargetList').replaceChildren(...rows.map((row,index)=>{
      const button=document.createElement('button'),panel=document.createElement('img'),name=document.createElement('span');button.style.top=(5+index*84)+'px';button.setAttribute('aria-label',`使用目标 ${row.name}，HP ${row.hp.current}/${row.hp.maximum}，MP ${row.mp.current}/${row.mp.maximum}`);button.disabled=this.root.classList.contains('combat-items')&&row.hp.current===0;panel.className='menu-source target-panel';panel.src=this.manifest.item_target_panels.normal;panel.alt='';name.className='target-name';button.dataset.roleName=row.name;this.text(name,row.name,{font:'simsun20_text',foreground:'#808080',shadow:'#000000'});button.append(panel,name);
      for(const [key,y,frame,barY]of [['hp',30,1,47],['mp',53,0,70]]){const stat=row[key],current=document.createElement('span'),maximum=document.createElement('span'),bar=document.createElement('span'),image=document.createElement('img');current.className='target-current';maximum.className='target-maximum';current.style.top=maximum.style.top=y+'px';this.number(current,stat.current);this.number(maximum,stat.maximum);bar.className='target-bar';bar.style.top=barY+'px';bar.style.width=(stat.maximum>0?Math.floor(147*stat.current/stat.maximum):0)+'px';image.src=this.manifest.item_target_bars.frames[frame];image.alt='';bar.append(image);button.append(current,maximum,bar);}
      button.onfocus=()=>{for(const other of this.node('menuItemTargetList').querySelectorAll('button')){other.querySelector('img').src=other===button?this.manifest.item_target_panels.selected:this.manifest.item_target_panels.normal;this.text(other.querySelector('.target-name'),other.dataset.roleName,{font:'simsun20_text',foreground:other===button?'#ffffff':'#808080',shadow:'#000000'});}};button.onclick=()=>this.onItemTarget?.(row.id);return button;
    }));this.focusGroup('content',Math.max(0,rows.findIndex(row=>row.id===selectedId)));
  }
  equipmentPicker(){this.mode='content';this.equipmentView.openPicker();}
  weapon(details){this.weaponView.render(details);}
  stats(status){
    this.actorId=status.id;
    this.summary(this.node('menuActorSummary'),status);this.node('menuActorBar').src=this.manifest.actor_panels?.[status.id]?.normal??this.manifest.actor_bar.dynamic_name_image;
    const standing=this.manifest.standing_actors?.[status.id],sprite=this.node('menuStandingActor');sprite.hidden=!standing||!['status','equipment'].includes(this.current);
    if(!sprite.hidden){
      if(this.standingRole!==status.id||this.standingPage!==this.current){
        this.standingRole=status.id;this.standingPage=this.current;this.standingStartedAt=performance.now();
        this.standingImages=standing.frames.map(frame=>{const image=new Image();image.src=frame.image??frame;return image;});
      }
      this.standing=standing;this.tick(performance.now());
      sprite.style.left=((standing.position?.x??387)-standing.anchor[0])+'px';sprite.style.top=((standing.position?.y??340)-standing.anchor[1])+'px';
    }
    const values=[['力量',status.attack],['防御',status.defense],['速度',status.speed],...status.elements.map((n,i)=>[['火','风','水','地','日','月'][i]+'属性',n])];
    const body=this.menus.get('game001a_2'),list=this.node('menuStats');
    this.node('menuEquipmentStats').replaceChildren(...[['力量',status.attack],['防御',status.defense],['速度',status.speed]].map(([label,value],i)=>{const row=document.createElement('div'),term=document.createElement('dt'),number=document.createElement('dd');row.style.top=i*30+'px';term.textContent=label;term.className='sr-only';this.mnuText(number,value,'game001a','text'+String(i+7).padStart(2,'0'));row.append(term,number);return row;}));
    list.replaceChildren(...values.map(([label,value],index)=>{
      const row=document.createElement('div'),name=document.createElement('dt'),number=document.createElement('dd');row.className='stat-row';
      const slot=body.widgets.find(w=>w.name===`text${String(index+1).padStart(2,'0')}`),bar=body.widgets.find(w=>w.name===`bar${String(index+1).padStart(2,'0')}`);row.style.top=slot.rect.top+'px';name.textContent=label;this.text(number,value,operationMnuTextOptions(slot));number.style.top='0px';
      const fill=document.createElement('span'),image=document.createElement('img');fill.className='operation-bars';fill.style.left=bar.rect.left+'px';fill.style.top=bar.rect.top-slot.rect.top+'px';fill.style.width=Math.floor(value*(bar.rect.right-bar.rect.left)/1000)+'px';image.src=bar.normal_images[0];image.alt='';fill.append(image);row.append(name,number,fill);return row;
    }));
  }
  tick(now){
    this.formation.tick(now);this.techniques.tick(now);
    const sprite=this.node('menuStandingActor');
    if(this.root.hidden||sprite.hidden||!this.standing)return;
    const frame=operationStandingFrame(this.standing,now-this.standingStartedAt);
    if(sprite.getAttribute('src')!==frame)sprite.src=frame;
  }
  suspend(){this.techniques.hide();this.standing=null;this.standingRole=null;this.standingPage=null;this.standingImages=[];}
}
