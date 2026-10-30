import {techniqueSlots,sourceTechniqueSlot,techniqueSlotName,techniqueCandidates,TECHNIQUE_CATEGORIES,TECHNIQUE_WHEEL_NAVIGATION,techniqueCombinations,techniqueCombinationName} from './core/menu_techniques.mjs';
import {operationSummaryFields} from './core/menu_presentation.mjs';

const position=(node,x,y,w=null,h=null)=>Object.assign(node.style,{position:'absolute',left:x+'px',top:y+'px',...(w===null?{}:{width:w+'px'}),...(h===null?{}:{height:h+'px'})});
const raw=skill=>new DataView(Uint8Array.from(skill.fixed_raw_hex.match(/../g),v=>parseInt(v,16)).buffer);
const description=skill=>{if(!skill)return '';const bytes=new Uint8Array(raw(skill).buffer).slice(0x3b,0x3b+200);return new TextDecoder('gbk').decode(bytes.slice(0,Math.max(0,bytes.indexOf(0))));};

// Owns only its overlay. World transactions, field casting and test battles are
// host callbacks; scratch previews never modify the persistent seven-slot table.
export class OperationTechniqueView{
  constructor({root,manifest,supplement,textRenderer,onFocus,onSection,onActor,onFieldSkill,onSetSlot,onCreateCombination,onRenameCombination,onDeleteCombination,onMessage,onInfo,onTest}){
    if(supplement?.version!==1)throw new Error('技巧界面补充素材缺失');
    Object.assign(this,{root,manifest,supplement,textRenderer,onFocus,onSection,onActor,onFieldSkill,onSetSlot,onCreateCombination,onRenameCombination,onDeleteCombination,onMessage,onInfo,onTest});
    this.menus=new Map([...manifest.menus,...supplement.menus].map(menu=>[menu.id,menu]));
    this.element=document.createElement('div');this.element.id='menuTechniqueUI';this.element.className='technique-ui';this.element.hidden=true;root.append(this.element);
    const style=document.createElement('style');style.textContent=`
      .technique-ui{position:absolute;inset:0;width:640px;height:480px;pointer-events:none;z-index:3;color:#eee}
      .technique-ui[hidden]{display:none}
      .party-menu .technique-ui button{position:absolute;border:0;border-radius:0;padding:0;margin:0;background:none;box-shadow:none;outline:none;pointer-events:auto;text-align:left;color:inherit;font-family:inherit;overflow:visible}
      .party-menu .technique-ui button:hover,.party-menu .technique-ui button:focus{background:none;box-shadow:none}
      .technique-ui img{position:absolute;pointer-events:none;max-width:none;image-rendering:pixelated}
      .technique-ui .technique-native-control{color:transparent;font-size:0}
      .technique-ui .technique-name{font-size:22px;line-height:26px;white-space:nowrap;text-shadow:1px 1px #111}
      .technique-ui .technique-row{font-size:19px;line-height:28px;white-space:nowrap}
      .technique-ui .technique-row img{z-index:1}.technique-ui .technique-row img[data-highlight]{z-index:0}.technique-ui .technique-row span{position:absolute;z-index:2}
      .technique-ui .technique-row[data-selected=true]{color:#ffff00}
      .technique-ui .technique-target-name{position:absolute;left:20px;top:13px;font-size:20px;line-height:22px}
      .technique-ui .technique-target-value{position:absolute;font-size:18px;line-height:20px}
    `;root.append(style);this.style=style;this.section='use';this.stage='roster';this.mode='sub';this.roleId=null;this.action='compose';this.category=1;this.slotIndex=0;this.listOffset=0;this.composition=[];
  }
  destroy(){this.stopShortcutAnimations();this.element.remove();this.style.remove();}
  page({section='use',roleId=null,layer='sub'}={}){this.stopShortcutAnimations();this.section=section;this.roleId=roleId;this.mode=layer;this.stage=roleId?(section==='edit'?'actions':'list'):'roster';this.preview=null;this.pending=null;this.listOffset=0;this.element.hidden=false;this.paint();return this;}
  hide(){this.stopShortcutAnimations();this.pending=null;this.element.hidden=true;}
  render(world,source,configured,{rows=null,capacity=0}={}){Object.assign(this,{world,source,configured,rows:rows??world.party,capacity});this.paint();return this;}
  asset(menuId){const menu=this.menus.get(menuId);return menu.composed??menu.images[0].image;}
  image(path,x,y,parent=this.element){const image=document.createElement('img');image.alt='';image.src=path;position(image,x,y);parent.append(image);return image;}
  text(value,x,y,parent=this.element,className='technique-name',options={}){const node=document.createElement('span');node.className=className;position(node,x,y);const font=className==='technique-target-value'?'simsun18':className==='technique-target-name'?'simsun20_text':className===''?'simsun19_text':'simsun22_text';node.style.pointerEvents='none';node.style.color=options.foreground??'#ffffff';if(this.textRenderer?.supports?.(String(value),font)){const canvas=document.createElement('canvas'),result=this.textRenderer.paint(canvas,value,{font,foreground:'#ffffff',shadow:'#000000',...options});position(canvas,result.offsetX,result.offsetY);node.append(canvas);}else node.textContent=value;parent.append(node);return node;}
  button(key,label,x,y,w,h,{click,focus,group='content',disabled=false}={}){const button=document.createElement('button');button.type='button';button.dataset.techniqueKey=key;button.dataset.techniqueGroup=group;button.setAttribute('aria-label',label);button.disabled=disabled;position(button,x,y,w,h);button.onclick=click;button.onfocus=()=>{this.mode=group==='background'?'content':group;this.onFocus?.(this.mode);if(!this.restoring)focus?.();};this.element.append(button);return button;}
  sourceButton(menuId,name,origin,key,label,{click,focus,group='content',selected=false,disabled=false}={}){
    const widget=this.menus.get(menuId).widgets.find(row=>row.name.toLowerCase()===name.toLowerCase()),r=widget.rect;
    const retained=key.startsWith('header-')?this.element.querySelector('[data-technique-key="'+key+'"]'):null;
    const button=retained??this.button(key,label,r.left+origin.x,r.top+origin.y,r.right-r.left+1,r.bottom-r.top+1,{group,disabled});
    button.onclick=click;button.onfocus=()=>{this.mode=group==='background'?'content':group;this.onFocus?.(this.mode);this.sourceHighlight(button,widget,true);if(!this.restoring)focus?.();};button.disabled=disabled;
    button._widget=widget;button.classList.add('technique-native-control');button.onblur=()=>this.sourceHighlight(button,widget,selected);this.sourceHighlight(button,widget,selected);return button;
  }
  sourceHighlight(button,widget,active){button.querySelector('img')?.remove();const frames=button._selectedImage?widget.selected_images:widget.active_images;
    // Naming operations share five gold-frame images; their final image is
    // the faint phase. Keep the original bright frame visible while focused.
    const path=active?(button.dataset.techniqueKey?.startsWith('name-')?frames[0]:frames.at(-1)):widget.normal_images[0];if(path)this.image(path,widget.draw_point_raw.x-widget.rect.left,widget.draw_point_raw.y-widget.rect.top,button);
  }
  focus(mode='content',index=0){this.mode=mode;this.onFocus?.(mode);const group=this.controls(mode);(group[(index+group.length)%group.length]??this.root).focus({preventScroll:true});}
  controls(mode=this.mode){return [...this.element.querySelectorAll('button')].filter(button=>button.dataset.techniqueGroup===mode&&!button.hidden&&!button.disabled);}
  invoke(callback,args){if(!callback)return;Promise.resolve().then(()=>callback(args)).then(()=>{this.paint();if(!this.element.contains(document.activeElement))this.focus(this.mode);}).catch(error=>this.onMessage?.(error.message,true));}
  invokeTest(){
    if(this.testPending)return this.testPending;
    if(!this.onTest){this.onMessage?.('技巧测试战斗尚未接入。',true);return;}
    // Battle startup transfers focus and input ownership to the host. The
    // ordinary transaction helper would repaint and focus the hidden menu.
    const pending=Promise.resolve().then(()=>this.onTest({})).catch(error=>this.onMessage?.(error.message,true)).finally(()=>{if(this.testPending===pending)this.testPending=null;});
    this.testPending=pending;return pending;
  }
  chooseSection(section,confirmed=false){if(confirmed&&section==='test'&&this.testPending)return this.testPending;this.stopShortcutAnimations();this.section=section;this.roleId=null;this.stage='roster';this.preview=null;this.pending=null;this.listOffset=0;this.onSection?.(section,confirmed);this.paint();if(confirmed&&section==='test')return this.invokeTest();else if(confirmed)this.focus('content');}
  chooseActor(roleId){this.stopShortcutAnimations();this.roleId=roleId;this.onActor?.(roleId,true);this.stage=this.section==='edit'?'actions':'list';this.mode='content';this.paint();this.focus('content');}
  paint(){
    if(!this.world||!this.source||this.element.hidden)return;
    if(this.stage!=='slot-confirm')this.stopShortcutCursor();
    if(!this.shortcutWheelVisible())this.stopShortcutReplacement();
    const focusKey=document.activeElement?.dataset?.techniqueKey;
    // Keep a focused header attached through its preview repaint, so a mouse
    // press can complete its click on the same control.
    for(const node of [...this.element.childNodes])if(!node.dataset?.techniqueKey?.startsWith('header-')||['name-editor','icon-editor','compose-confirm'].includes(this.stage))node.remove();
    if(this.stage==='name-editor'||this.stage==='icon-editor'){this.paintNameEditor();if(focusKey){const b=[...this.element.querySelectorAll('button')].find(row=>row.dataset.techniqueKey===focusKey);if(b&&!b.disabled){this.restoring=true;b.focus({preventScroll:true});this.restoring=false;if(b._widget)this.sourceHighlight(b,b._widget,true);}}return;}
    if(this.stage==='compose-confirm'){this.image(this.asset('game004'),0,0);this.sourceButton('game004','END',{x:0,y:0},'compose-end','结束编成',{click:()=>this.beginName()});this.sourceButton('game004','CONTINUE',{x:0,y:0},'compose-continue','继续编成',{click:()=>{this.stage='candidates';this.paint();this.focus('content');}});return;}
    const origins=this.supplement.origins;this.element.prepend(this.image(this.asset('game002a'),origins.header.x,origins.header.y));
    ['use','edit','test'].forEach((section,index)=>this.sourceButton('game002a',['USE','EDIT','TEST'][index],origins.header,'header-'+section,['技巧使用','技巧编成','技巧测试'][index],{group:'sub',selected:this.mode!=='main'&&this.section===section,click:()=>this.chooseSection(section,true),focus:()=>{if(this.section!==section)this.chooseSection(section);}}));
    if(this.stage==='roster'){this.paintRoster();}
    else{
      this.paintCompositionBoard();
      if(this.section==='use'){this.paintShortcuts(false);this.paintList(this.fieldEntries(),'game002_1');if(this.stage==='targets')this.paintTargets();}
      else {this.paintActions();if(this.action==='set'&&['categories','candidates','slot-confirm'].includes(this.stage))this.paintShortcuts(this.stage==='slot-confirm');if(['actions','categories'].includes(this.stage))this.paintCategories();if(['candidates','slot-confirm'].includes(this.stage))this.paintList(this.candidateEntries(),'game002_1'+['a','b','c','d','e'][this.category]);}
    }
    this.paintShortcutReplacement();
    if(focusKey){
      const button=[...this.element.querySelectorAll('button')].find(row=>row.dataset.techniqueKey===focusKey);
      if(button&&!button.disabled){
        this.restoring=true;button.focus({preventScroll:true});this.restoring=false;
        if(button._widget)this.sourceHighlight(button,button._widget,true);
        // Restoring skips focus handlers, so repaint the retained healing target.
        if(button.dataset.techniqueTarget)button.querySelector('img').src=this.manifest.item_target_panels.selected;
      }
    }
  }
  paintRoster(){
    for(const [index,status]of this.rows.entries()){
      const button=this.button('actor-'+status.id,status.name,20,50+index*86,480,83,{click:()=>this.chooseActor(status.id),focus:()=>{for(const row of this.element.querySelectorAll('[data-role-id]'))row.querySelector('img').src=this.manifest.actor_panels[row.dataset.roleId][row===button?'unfocused':'normal'];this.roleFocus=status.id;this.onActor?.(status.id,false);}});button.dataset.roleId=status.id;button.className='roster-actor';
      const panel=this.manifest.actor_panels?.[status.id];if(panel)this.image(panel[this.roleFocus===status.id?'unfocused':'normal'],0,0,button);
      const dl=document.createElement('dl');dl.className='actor-summary-values';button.append(dl);
      for(const [label,value,className]of operationSummaryFields(status)){const row=document.createElement('div'),number=document.createElement('dd');row.className='summary-'+className;number.setAttribute('aria-label',label+' '+value);if(this.textRenderer){const canvas=document.createElement('canvas');const result=this.textRenderer.paint(canvas,value,{font:className==='level'?'simsun26':'simsun18'});position(canvas,result.offsetX,result.offsetY);number.append(canvas);}else number.textContent=value;row.append(number);dl.append(row);}
    }
  }
  paintCompositionBoard(){
    const o=this.supplement.origins.composition_board,menu=this.menus.get('game002e');this.image(menu.images[0].image,o.x,o.y);
    // All seven ornamental holes are baked into BACKGROUND. Native 0x44DDE0
    // closes the rightmost 7-capacity holes with Char_Ball frame 7; +0x155 is
    // the separate crystal socket count and does not control this panel.
    for(let n=0;n<7-Math.max(0,Math.min(7,this.capacity));n++){const widget=menu.widgets[n+2],image=this.image(this.supplement.icons.char_ball.frames[7],o.x+widget.rect.left-1,o.y+widget.rect.top-2);image.dataset.compositionLocked=widget.name;}
    this.text(this.world.party.find(role=>role.id===this.roleId)?.name??'',o.x+20,o.y+10);this.paintPreview();
  }
  slotName(slot){const record=slot.type===1?techniqueCombinations(this.world,this.source,this.roleId)[slot.index_one_based-1]:null;return record?techniqueCombinationName(record,this.supplement.name_charset):techniqueSlotName(this.source,this.roleId,slot);}
  paintIcon(slot,x,y,active=false,parent=this.element){const bank=this.supplement.icons[slot.type===2?'other_ball':slot.type===1?'name_ball':'magic_ball1'],frame=slot.icon+(active?(slot.type===2?4:slot.type===1?88:6):0);if(bank?.frames[frame])this.image(bank.frames[frame],x,y,parent);if(slot.color){const numbers=this.supplement.icons.magic_ball1_num,index=(slot.type===1?Math.floor(slot.icon/11):slot.icon)*7-1+slot.color;if(numbers?.frames[index])this.image(numbers.frames[index],x+14,y+12,parent);}}
  paintShortcuts(confirm){
    const o=this.supplement.origins.shortcuts;this.image(this.asset('game002d'),o.x,o.y).dataset.shortcutBoard='true';const slots=techniqueSlots(this.world,this.source,this.roleId),icons=[];
    const refresh=()=>slots.forEach((slot,index)=>{const preview=confirm&&index===this.slotIndex&&this.pending?this.pending.slot:slot;icons[index].replaceChildren();this.paintIcon(preview,0,0,confirm&&index===this.slotIndex,icons[index]);this.element.querySelector('[data-technique-key="slot-'+index+'"]')?.setAttribute('aria-label',`槽${index+1}：${this.slotName(preview)}`);});
    slots.forEach((slot,index)=>{const widget=this.menus.get('game002d').widgets.find(w=>w.name===String(index+1).padStart(3,'0')),r=widget.rect,icon=document.createElement('span');position(icon,o.x+r.left,o.y+r.top);this.element.append(icon);icons.push(icon);
      if(confirm)this.button('slot-'+index,`槽${index+1}：${this.slotName(slot)}`,o.x+r.left-5,o.y+r.top-5,r.right-r.left+11,r.bottom-r.top+11,{click:()=>this.commitSlot(index),focus:()=>{this.slotIndex=index;refresh();this.showShortcutCursor(index);this.onInfo?.(this.slotName(this.pending?.slot??slot));}});
    });refresh();if(confirm)this.showShortcutCursor(this.slotIndex);
  }
  showShortcutCursor(index){
    const o=this.supplement.origins.shortcuts,w=this.menus.get('game002d').widgets[index+1],bank=this.supplement.icons.board_bright;let image=this.element.querySelector('[data-shortcut-cursor]');
    if(!image){image=this.image(bank.frames[0],0,0);image.dataset.shortcutCursor='true';}position(image,o.x+w.rect.left-13,o.y+w.rect.top-13);image.style.zIndex='4';
    if(this.cursorIndex!==index){this.cursorIndex=index;this.cursorStarted=globalThis.performance?.now?.()??0;image.src=bank.frames[0];}
    if(this.cursorAnimation===undefined&&globalThis.requestAnimationFrame){const step=now=>{this.cursorAnimation=undefined;if(this.element.hidden||this.stage!=='slot-confirm')return;const cursor=this.element.querySelector('[data-shortcut-cursor]');if(!cursor)return;const interval=bank.actions?.[0]?.interval_raw??120;cursor.src=bank.frames[Math.floor(Math.max(0,now-this.cursorStarted)/Math.max(1,interval))%bank.frames.length];this.cursorAnimation=globalThis.requestAnimationFrame(step);};this.cursorAnimation=globalThis.requestAnimationFrame(step);}
  }
  shortcutWheelVisible(){return this.roleId&&((this.section==='use'&&['list','targets'].includes(this.stage))||(this.section==='edit'&&this.action==='set'&&['categories','candidates','slot-confirm'].includes(this.stage)));}
  stopShortcutCursor(){if(this.cursorAnimation!==undefined)globalThis.cancelAnimationFrame?.(this.cursorAnimation);this.cursorAnimation=undefined;this.cursorIndex=undefined;this.element.querySelector('[data-shortcut-cursor]')?.remove();}
  stopShortcutReplacement(){this.replacement=null;this.element.querySelector('[data-shortcut-replacement]')?.remove();}
  stopShortcutAnimations(){this.slotCommit=null;this.stopShortcutCursor();this.stopShortcutReplacement();}
  startShortcutReplacement(slotIndex){
    this.stopShortcutReplacement();if(!this.shortcutWheelVisible())return;
    this.replacement={slotIndex,roleId:this.roleId,frame:0,lastTick:globalThis.performance?.now?.()??0};this.paintShortcutReplacement();
  }
  paintShortcutReplacement(){
    const effect=this.replacement;if(!effect||!this.shortcutWheelVisible()||effect.roleId!==this.roleId)return;
    const bank=this.supplement.icons.board_brightB,o=this.supplement.origins.shortcuts,widget=this.menus.get('game002d').widgets[effect.slotIndex+1];
    let image=this.element.querySelector('[data-shortcut-replacement]');if(!image){image=this.image(bank.frames[effect.frame],0,0);image.dataset.shortcutReplacement='true';}
    // 427C90 uses rect[-23,-23]; 536FA0 adds and saturates source RGB.
    position(image,o.x+widget.rect.left-23,o.y+widget.rect.top-23,bank.width,bank.height);image.src=bank.frames[effect.frame];image.dataset.frame=String(effect.frame);image.style.mixBlendMode='plus-lighter';image.style.zIndex='5';
  }
  tick(now){
    const effect=this.replacement;if(!effect)return;
    if(this.element.hidden||!this.shortcutWheelVisible()||effect.roleId!==this.roleId){this.stopShortcutReplacement();return;}
    const bank=this.supplement.icons.board_brightB,interval=bank.actions[0].interval_raw;
    // 426760 advances once per elapsed120ms check; its explicit frame-count
    // stop overrides the DGP loop flag. No input lock or opacity fade.
    if(now-effect.lastTick<interval)return;effect.lastTick=now;effect.frame++;
    if(effect.frame>=bank.frames.length)this.stopShortcutReplacement();else this.paintShortcutReplacement();
  }
  paintActions(){const o=this.supplement.origins.actions;this.image(this.asset('game002c'),o.x,o.y);[['EDIT','compose','技巧编成'],['SET','set','技巧设定'],['NAME','name','重新命名'],['DEL','delete','技巧删除']].forEach(([widget,action,label])=>{const button=this.sourceButton('game002c',widget,o,'action-'+action,label,{group:this.stage==='actions'?'content':'background',selected:this.action===action,disabled:this.stage==='slot-confirm',click:()=>{this.action=action;this.stage='categories';this.category=action==='compose'?1:0;this.composition=[];this.preview=null;this.pending=null;this.listOffset=0;this.paint();this.focusCategory();},focus:()=>{if(this.stage==='actions'){this.action=action;this.paintActionHighlights();this.paintCategories();}}});button._selectedImage=true;button.onblur=()=>this.paintActionHighlights();});this.paintActionHighlights();}
  paintActionHighlights(){for(const button of this.element.querySelectorAll('button'))if(button.dataset.techniqueKey?.startsWith('action-'))this.sourceHighlight(button,button._widget,button.dataset.techniqueKey==='action-'+this.action);}
  allowedCategory(index){return this.action==='compose'?[1,2,3].includes(index):['name','delete'].includes(this.action)?index===0:index<5;}
  paintCategories(){
    // During the action layer the categories are present with the original
    // gray text. They become selectable only after confirming the action.
    this.element.querySelectorAll('[data-technique-category]').forEach(node=>node.remove());
    const o=this.supplement.origins.categories;const img=this.image(this.asset('game002b'),o.x,o.y);img.dataset.techniqueCategory='background';
    TECHNIQUE_CATEGORIES.forEach((label,index)=>{const active=this.stage==='categories'&&this.allowedCategory(index),button=this.sourceButton('game002b','CHAR'+(index+1),o,'category-'+index,label,{disabled:!active,click:()=>{this.category=index;this.stage='candidates';this.preview=null;this.pending=null;this.listOffset=0;this.paint();this.focus('content');},focus:()=>{this.category=index;this.paintCategoryHighlights();}});button._selectedImage=true;button.onblur=()=>this.paintCategoryHighlights();button.dataset.techniqueCategory=String(index);});this.paintCategoryHighlights();
  }
  paintCategoryHighlights(){for(const button of this.element.querySelectorAll('button'))if(button.dataset.techniqueKey?.startsWith('category-'))this.sourceHighlight(button,button._widget,this.stage==='categories'&&Number(button.dataset.techniqueCategory)===this.category);}
  focusCategory(){this.mode='content';this.onFocus?.('content');const button=this.element.querySelector('[data-technique-key="category-'+this.category+'"]');if(button&&!button.disabled)button.focus({preventScroll:true});else this.focus('content');}
  fieldEntries(){const bundle=this.configured?.party_skills??this.configured??this.source;return Object.values(bundle.field_skills??{}).filter(skill=>skill.actor_id===this.roleId&&skill.learned_raw&&((skill.type_flags_u32_0x32>>>13)&1)).map(skill=>({name:skill.name,index:skill.original_skill_index,type:0,source:skill,skillId:skill.id,slot:sourceTechniqueSlot(this.source,this.roleId,0,skill.original_skill_index+1)}));}
  candidateEntries(){if(this.category===0)return techniqueCombinations(this.world,this.source,this.roleId).map((record,index)=>({name:techniqueCombinationName(record,this.supplement.name_charset),index,type:1,record,source:null,slot:sourceTechniqueSlot(this.source,this.roleId,1,index+1,techniqueCombinations(this.world,this.source,this.roleId))}));return techniqueCandidates(this.world,this.source,this.roleId,this.category,{action:this.action==='compose'?'compose':'set',capacity:this.capacity});}
  paintList(entries,menuId){
    if(!this.menus.has(menuId))menuId='game002_1a';const o=this.supplement.origins.use;this.image(this.asset(menuId),o.x,o.y);
    const maxOffset=Math.max(0,entries.length-6);this.listOffset=Math.max(0,Math.min(this.listOffset,maxOffset));
    if(entries.length>6){for(const [name,amount]of [['UP',-6],['DN',6]])this.sourceButton('game002_1',name,o,'scroll-'+name,amount<0?'上一页':'下一页',{click:()=>{this.listOffset=Math.max(0,Math.min(maxOffset,this.listOffset+amount));this.paint();this.focus('content',this.section==='edit'?4:0);}});}
    for(const [visible,entry]of entries.slice(this.listOffset,this.listOffset+6).entries()){
      const widget=this.menus.get(menuId).widgets[visible+3],r=widget.rect,button=this.button('entry-'+entry.type+'-'+entry.index,entry.name,r.left+o.x,r.top+o.y,r.right-r.left+1,r.bottom-r.top+1,{group:['targets','slot-confirm'].includes(this.stage)?'background':'content',disabled:['targets','slot-confirm'].includes(this.stage),click:()=>this.confirmEntry(entry),focus:()=>this.previewEntry(entry,button)});button.className='technique-row';button._entry=entry;button._rowWidget=widget;
      const selected=this.preview?.index===entry.index&&this.preview?.type===entry.type;button.dataset.selected=String(selected);if(selected)this.paintRowHighlight(button);
      const bank=this.supplement.icons[entry.type===2?'other_ball':entry.type===1?'name_ball':'magic_ball1'],frame=entry.slot.icon+(selected?(entry.type===2?4:entry.type===1?88:6):0);if(bank.frames[frame]){const icon=this.image(bank.frames[frame],8,5,button);icon.dataset.rowIcon='true';}
      this.paintRowDetails(button);
      this.paintRowText(button);
    }
  }
  paintRowHighlight(button){const widget=button._rowWidget,path=widget?.active_images[0];if(path){const image=this.image(path,widget.draw_point_raw.x-widget.rect.left,widget.draw_point_raw.y-widget.rect.top,button);image.dataset.highlight='true';}}
  paintRowDetails(button){
    const entry=button._entry;if(entry.type===2)return;
    const data=entry.source?raw(entry.source):null,units=data?data.getUint32(0x36,true):entry.record?.total_units??entry.slot.color;
    // 450110/451670 use this same numeric bank. +0x36 is also the
    // composition-unit count; do not substitute the character's level.
    const numberFrame=(entry.type===1?Math.floor(entry.slot.icon/11):entry.slot.icon)*7+units-1;
    if(units>0&&this.supplement.icons.magic_ball1_num.frames[numberFrame]){const image=this.image(this.supplement.icons.magic_ball1_num.frames[numberFrame],22,17,button);image.dataset.rowLevel=String(units);}
    if(!data)return;
    const flags=data.getUint32(0x32,true),attributes=this.supplement.icons.magic_ball1_attr;
    for(let n=0;n<5;n++)if(flags&(1<<(8+n))){const image=this.image(attributes.frames[n],34+170+n*attributes.width,5,button);image.dataset.rowAttribute=String(n);}
    const required=data.getInt32(0x2f7,true),experience=data.getInt32(0x2fb,true);if(required<=0)return;
    const percent=Math.trunc(experience*100/required),amount=Math.trunc(experience*255/required)&255,signed=amount<128?amount:amount-256;
    // The native byte arithmetic is signed before RGB packing (45067D).
    const redByte=(255-2*signed)&255,color=[redByte<128?redByte:0,(128+(signed>>1))&255,amount];
    const bank=this.supplement.icons.use_ball,ball=document.createElement('div');position(ball,34+305,3,bank.width,bank.height);ball.style.pointerEvents='none';ball.style.zIndex='1';ball.dataset.rowExperience=String(percent);ball.setAttribute('aria-label',`技巧经验 ${experience}/${required}（${percent}%）`);button.append(ball);this.image(bank.frames[0],0,0,ball);
    // 52945A interpolates the original grayscale sprite toward the packed
    // color with weight128. Alpha masking preserves its original silhouette.
    const tint=document.createElement('span');position(tint,0,0,bank.width,bank.height);Object.assign(tint.style,{backgroundColor:`rgb(${color.join(',')})`,opacity:'0.5',maskImage:`url("${bank.frames[0]}")`,maskSize:'100% 100%',maskRepeat:'no-repeat',pointerEvents:'none'});ball.append(tint);
    const digits=this.supplement.icons.use_ball_num;
    const draw=(frame,x)=>{if(digits.frames[frame]){const image=this.image(digits.frames[frame],34+x,15,button);image.dataset.rowExperienceDigit=String(frame);}};
    draw(10,330);draw(percent%10,323);if(percent>=10)draw(Math.trunc(percent/10)%10,316);if(percent>=100)draw(Math.trunc(percent/100),309);
  }
  paintRowText(button){
    const entry=button._entry,selected=button.dataset.selected==='true',direct=entry.type===0;
    // 450110 calls534C2B: a30px rectangle centers a19px line at Y+5,
    // with19px CJK steps. 451670 uses whole-string5358C4 at Y+7 instead.
    const yellow=entry.type!==2&&selected;
    const options={foreground:yellow?'#ffff00':'#ffffff',shadow:yellow?'#4f4f00':'#000000',
      ...(direct?{layout:'mnu',advanceOverride:19,lineHeight:19,maxWidth:250,maxLines:1}:{})};
    const cost=entry.source?Math.max(0,-raw(entry.source).getInt32(0x14f,true)):0;
    button._labelNode?.remove();button._labelNode=this.text(entry.name+(cost?' Mp/'+cost:''),34,direct?5:7,button,'',options);
  }
  previewEntry(entry,button){this.preview=entry;for(const row of this.element.querySelectorAll('.technique-row')){row.dataset.selected=String(row===button);row.querySelector('img[data-highlight]')?.remove();const e=row._entry,bank=this.supplement.icons[e.type===2?'other_ball':e.type===1?'name_ball':'magic_ball1'],frame=e.slot.icon+(row===button?(e.type===2?4:e.type===1?88:6):0);const icon=row.querySelector('[data-row-icon]');if(icon&&bank.frames[frame])icon.src=bank.frames[frame];this.paintRowText(row);}this.paintRowHighlight(button);this.onInfo?.(entry.record?entry.record.indices.map(index=>this.source.roles[this.roleId].skills[index].name).join(' → '):description(entry.source));this.paintPreview();}
  paintPreview(){this.element.querySelectorAll('[data-preview-icon]').forEach(node=>node.remove());const o=this.supplement.origins.composition_board,count=this.element.childNodes.length,compiled=this.section==='edit'&&this.action==='compose'?this.compositionUnits():0,ghost=this.preview?.slot.color??0,units=compiled+ghost<=this.capacity?compiled+ghost:compiled;for(let n=0;n<Math.min(7,units);n++){const w=this.menus.get('game002e').widgets.find(row=>row.name===String(8-n).padStart(3,'0')),image=this.image(this.supplement.icons.char_ball.frames[n],o.x+w.rect.left-1,o.y+w.rect.top-2);if(n>=compiled)image.style.opacity='0.5';}for(const node of [...this.element.childNodes].slice(count))node.dataset.previewIcon='true';}
  confirmEntry(entry){
    if(this.section==='use'){this.selectedSkill=entry;this.stage='targets';this.paint();this.focus('content',Math.max(0,this.controls('content').findIndex(button=>button.dataset.techniqueKey==='target-'+this.roleId)));return;}
    if(this.action==='compose'){if(this.composition.includes(entry.index)){this.onMessage?.('此技巧已经加入编成。',true);return;}const total=this.compositionUnits()+entry.slot.color;if(total>this.capacity){this.onMessage?.('编成球数超出法器容量。',true);return;}this.composition.push(entry.index);if(total===this.capacity)this.beginName();else this.paintPreview();return;}
    if(this.action==='name'){this.renameIndex=entry.index+1;this.composition=[...entry.record.indices];this.beginName(entry.record);return;}
    if(this.action==='delete'){this.invoke(this.onDeleteCombination,{roleId:this.roleId,indexOneBased:entry.index+1,expectedRevision:this.world.revision});this.preview=null;return;}
    this.pending=entry;this.slotIndex=0;this.stage='slot-confirm';this.paint();this.focus('content',Math.max(0,this.controls('content').findIndex(button=>button.dataset.techniqueKey==='slot-0')));
  }
  commitSlot(slotIndex){
    const pending=this.pending;if(!pending||!this.onSetSlot||this.slotCommit)return;
    const operation={pending,roleId:this.roleId,slotIndex};this.slotCommit=operation;
    Promise.resolve().then(()=>{if(this.slotCommit===operation)return this.onSetSlot({roleId:operation.roleId,slotIndex,type:pending.slot.type,indexOneBased:pending.slot.index_one_based});}).then(()=>{
      if(this.slotCommit!==operation)return;this.slotCommit=null;
      this.pending=null;this.preview=pending;this.stage='candidates';this.onMessage?.('技巧设定已更新。');this.paint();
      this.element.querySelector('[data-technique-key="entry-'+pending.type+'-'+pending.index+'"]')?.focus({preventScroll:true});this.startShortcutReplacement(slotIndex);
    }).catch(error=>{if(this.slotCommit!==operation)return;this.slotCommit=null;this.onMessage?.(error.message,true);});
  }
  paintTargets(){const o=this.manifest.page_bindings.items.target_origin;this.image(this.asset('game003_4'),o.x,o.y);this.rows.forEach((status,index)=>{const button=this.button('target-'+status.id,`目标 ${status.name}`,o.x+5,o.y+5+index*84,211,84,{click:()=>this.invoke(this.onFieldSkill,{casterId:this.roleId,targetId:status.id,skillId:this.selectedSkill.skillId,index:this.selectedSkill.index}),focus:()=>{for(const node of this.element.querySelectorAll('[data-technique-target]'))node.querySelector('img').src=this.manifest.item_target_panels[node===button?'selected':'normal'];}});button.dataset.techniqueTarget=status.id;this.image(this.manifest.item_target_panels.normal,0,0,button);this.text(status.name,20,13,button,'technique-target-name');for(const [key,y,frame,barY]of [['hp',30,1,47],['mp',53,0,70]]){this.text(status[key].current,110,y,button,'technique-target-value');this.text(status[key].maximum,155,y,button,'technique-target-value');const clip=document.createElement('span');position(clip,49,barY,status[key].maximum?Math.floor(147*status[key].current/status[key].maximum):0,3);clip.style.overflow='hidden';button.append(clip);this.image(this.manifest.item_target_bars.frames[frame],0,0,clip);}});}
  compositionUnits(){return this.composition.reduce((n,index)=>n+sourceTechniqueSlot(this.source,this.roleId,0,index+1).color,0);}
  beginName(record=null){if(!this.composition.length){this.onMessage?.('请先选择要编成的技巧。',true);return;}this.nameCodes=record?[...record.name_codes]:[];this.nameCursor=0;this.nameCharacterIndex=0;this.nameFocusZone='characters';this.nameIcon=record?.icon??null;this.iconFocus=record?.icon??0;this.editorRevision=this.world.revision;this.stage='name-editor';this.paint();this.focus('content',5);}
  paintNameEditor(){
    const naming=this.stage==='name-editor',menuId=naming?'game002_2a':'game002_2b';this.image(this.asset(menuId),0,0);
    for(const [index,code]of this.nameCodes.entries())this.image(this.supplement.icons.name_text.frames[code-1],(naming?30:110)+index*22,20);
    if(naming){
      this.image(this.supplement.icons.name_cursor.frames[0],30+this.nameCursor*22,20);
      for(const [name,label,click]of [['PROV','前移',()=>{this.nameCursor=Math.max(0,this.nameCursor-1);}],['NEXT','后移',()=>{this.nameCursor=Math.min(this.nameCodes.length,this.nameCursor+1);}],['DEL','删除',()=>this.nameCodes.splice(this.nameCursor,1)],['CANCEL','取消',()=>this.cancelNaming()],['OK','决定',()=>{if(!this.nameCodes.length){this.onMessage?.('请为技巧命名。',true);return;}this.stage='icon-editor';this.paint();this.focus('content',3+this.iconFocus);}]] )this.sourceButton(menuId,name,{x:0,y:0},'name-'+name,label,{focus:()=>{this.nameFocusZone='actions';},click:()=>{click();this.paint();}});
      this.supplement.name_charset.characters.forEach((char,index)=>this.sourceButton(menuId,String(index+1).padStart(3,'0'),{x:0,y:0},'char-'+index,char,{focus:()=>{this.nameFocusZone='characters';this.nameCharacterIndex=index;},click:()=>{if(this.nameCursor>=8){this.onMessage?.('技巧名称最多八个字符。',true);return;}if(this.action==='name')this.nameCodes[this.nameCursor]=index+1;else if(this.nameCodes.length<8)this.nameCodes.splice(this.nameCursor,0,index+1);else this.nameCodes[this.nameCursor]=index+1;this.nameCursor=Math.min(8,this.nameCursor+1);this.paint();}}));
    }else{
      if(this.nameIcon!==null)this.image(this.supplement.icons.name_ball.frames[this.nameIcon+88],66,22);
      [['OK','完成',false],['SET','设定',true],['CANCEL','取消',null]].forEach(([name,label,setAfter])=>this.sourceButton(menuId,name,{x:0,y:0},'icon-'+name,label,{click:()=>{if(setAfter===null){this.stage='name-editor';this.paint();this.focus('content',5);return;}this.saveNamedCombination(setAfter);}}));
      for(let index=0;index<66;index++){const button=this.sourceButton(menuId,String(index+1).padStart(3,'0'),{x:0,y:0},'icon-choice-'+index,'技巧图标'+(index+1),{selected:this.iconFocus===index,click:()=>{this.nameIcon=index;this.iconFocus=index;this.paint();this.focus('content');},focus:()=>{this.iconFocus=index;const widget=this.menus.get(menuId).widgets.find(w=>w.name===String(index+1).padStart(3,'0')),old=this.element.querySelector('[data-icon-highlight]');old?.remove();const icon=this.image(this.supplement.icons.name_ball.frames[index+88],widget.rect.left+1,widget.rect.top+1);icon.dataset.iconHighlight='true';}});button.dataset.iconIndex=String(index);}
      const widget=this.menus.get(menuId).widgets.find(w=>w.name===String(this.iconFocus+1).padStart(3,'0')),highlight=this.image(this.supplement.icons.name_ball.frames[this.iconFocus+88],widget.rect.left+1,widget.rect.top+1);highlight.dataset.iconHighlight='true';
    }
  }
  cancelNaming(){this.nameCodes=[];this.nameIcon=null;this.composition=[];this.preview=null;this.pending=null;this.stage='candidates';this.paint();this.focus('content');}
  saveNamedCombination(setAfter){
    if(this.nameIcon===null){this.onMessage?.('请选择技巧图标。',true);return;}
    const callback=this.action==='name'?this.onRenameCombination:this.onCreateCombination;if(!callback){this.onMessage?.('技巧编成保存尚未接入。',true);return;}
    const indexOneBased=this.action==='name'?this.renameIndex:techniqueCombinations(this.world,this.source,this.roleId).length+1;
    const options={roleId:this.roleId,nameCodes:[...this.nameCodes],icon:this.nameIcon,expectedRevision:this.editorRevision,...(this.action==='name'?{indexOneBased}:{indices:[...this.composition],capacity:this.capacity})};
    this.invoke(async()=>{await callback(options);this.composition=[];this.preview=null;this.category=0;if(setAfter){this.action='set';this.stage='slot-confirm';this.slotIndex=0;const record=techniqueCombinations(this.world,this.source,this.roleId)[indexOneBased-1];this.pending={name:techniqueCombinationName(record,this.supplement.name_charset),index:indexOneBased-1,type:1,record,slot:sourceTechniqueSlot(this.source,this.roleId,1,indexOneBased,techniqueCombinations(this.world,this.source,this.roleId))};}else this.stage='categories';this.paint();this.focus('content');},{});
  }
  directionalFocus(key){const current=document.activeElement,group=this.controls('content'),r=current?.getBoundingClientRect();if(!r)return;const horizontal=['ArrowLeft','ArrowRight'].includes(key),sign=['ArrowLeft','ArrowUp'].includes(key)?-1:1,cx=r.left+r.width/2,cy=r.top+r.height/2;let best=null,score=Infinity;for(const b of group){if(b===current)continue;const q=b.getBoundingClientRect(),dx=q.left+q.width/2-cx,dy=q.top+q.height/2-cy,along=horizontal?dx:dy,across=horizontal?dy:dx;if(along*sign<=1)continue;const value=Math.abs(along)+Math.abs(across)*3;if(value<score){best=b;score=value;}}best?.focus({preventScroll:true});}
  key(key,repeat=false){
    if(this.element.hidden||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown',' ','Enter','Tab','x','X','z','Z'].includes(key))return false;
    if(key==='Tab')return true;if((key===' '||key==='Enter')){if(!repeat)(document.activeElement?.closest('.technique-ui')?document.activeElement:this.controls(this.mode)[0])?.click();return true;}
    if(['name-editor','icon-editor'].includes(this.stage)){if(key.startsWith('Arrow'))this.directionalFocus(key);return true;}
    if(this.stage==='candidates'&&this.action==='compose'&&this.composition.length&&['ArrowLeft','ArrowRight'].includes(key)){this.stage='compose-confirm';this.paint();this.focus('content');return true;}
    if(['list','candidates'].includes(this.stage)&&['ArrowUp','ArrowDown','PageUp','PageDown'].includes(key)){
      const entries=this.section==='use'?this.fieldEntries():this.candidateEntries();if(!entries.length)return true;const current=Math.max(0,entries.findIndex(entry=>entry.type===this.preview?.type&&entry.index===this.preview?.index)),next=Math.max(0,Math.min(entries.length-1,current+(key==='ArrowUp'?-1:key==='ArrowDown'?1:key==='PageUp'?-6:6)));this.preview=entries[next];if(next<this.listOffset)this.listOffset=next;else if(next>this.listOffset+5)this.listOffset=next-5;this.paint();const button=this.element.querySelector('[data-technique-key="entry-'+this.preview.type+'-'+this.preview.index+'"]');button?.focus({preventScroll:true});return true;
    }
    if(this.stage==='candidates'&&['x','X','z','Z'].includes(key)&&['compose','set'].includes(this.action)){const choices=this.action==='compose'?[1,2,3]:[0,1,2,3,4],at=choices.indexOf(this.category);this.category=choices[(at+(['x','X'].includes(key)?1:choices.length-1))%choices.length];this.preview=null;this.listOffset=0;this.paint();this.focus('content');return true;}
    if(this.mode==='sub'){const index=['use','edit','test'].indexOf(this.section);this.focus('sub',index+(['ArrowLeft','ArrowUp'].includes(key)?-1:1));return true;}
    if(this.stage==='slot-confirm'&&key.startsWith('Arrow')){const next=TECHNIQUE_WHEEL_NAVIGATION[key][this.slotIndex];this.element.querySelector('[data-technique-key="slot-'+next+'"]')?.focus({preventScroll:true});return true;}
    const group=this.controls('content'),index=Math.max(0,group.indexOf(document.activeElement));
    if(key==='PageUp'||key==='PageDown'){this.listOffset=Math.max(0,this.listOffset+(key==='PageUp'?-6:6));this.paint();this.focus('content',this.section==='edit'?4:0);return true;}
    if(this.stage==='categories'&&document.activeElement?.dataset.techniqueCategory){const current=Number(document.activeElement.dataset.techniqueCategory),delta=key==='ArrowUp'?-2:key==='ArrowDown'?2:key==='ArrowLeft'?-1:1,next=Math.max(0,Math.min(5,current+delta));if(this.allowedCategory(next))this.element.querySelector('[data-technique-key="category-'+next+'"]')?.focus();return true;}
    this.focus('content',index+(['ArrowUp','ArrowLeft'].includes(key)?-1:1));return true;
  }
  escape(){
    this.slotCommit=null;this.stopShortcutReplacement();
    if(this.mode==='sub')return true;
    // Native 0x456CF0 treats Esc as a switch between the character grid and
    // the operation strip. A second Esc restores the selected character; the
    // actual CANCEL action is what discards the naming scratch record.
    if(this.stage==='name-editor'){const grid=this.nameFocusZone!=='actions',key=grid?'name-PROV':'char-'+(this.nameCharacterIndex??0);this.element.querySelector('[data-technique-key="'+key+'"]')?.focus({preventScroll:true});return false;}
    if(this.stage==='icon-editor'){this.cancelNaming();return false;}
    if(this.stage==='compose-confirm'){this.stage='candidates';this.paint();this.focus('content');return false;}
    if(this.stage==='targets'){this.stage='list';this.paint();this.focus('content');return false;}
    if(this.stage==='slot-confirm'){this.pending=null;this.preview=null;this.stage='candidates';this.paint();this.focus('content');return false;}
    if(this.stage==='candidates'){if(this.action==='compose'&&this.composition.length){this.composition.pop();this.paintPreview();return false;}this.pending=null;this.preview=null;this.stage='categories';this.paint();this.focusCategory();return false;}
    if(this.stage==='categories'){this.preview=null;this.stage='actions';this.paint();this.focus('content',['compose','set','name','delete'].indexOf(this.action));return false;}
    if(this.stage==='actions'||this.stage==='list'){this.roleId=null;this.preview=null;this.stage='roster';this.paint();this.focus('content');return false;}
    this.mode='sub';this.paint();this.focus('sub',['use','edit','test'].indexOf(this.section));return false;
  }
}
