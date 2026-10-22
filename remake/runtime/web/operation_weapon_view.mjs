// Source-backed Game001c sockets and the shared Game001b crystal chooser.
// Persistent socket transactions and eligibility remain controller/core owned.
import {operationItemCard} from './core/operation_menu.mjs';
import {operationEquipmentPreview,operationPickerPage} from './operation_equipment_view.mjs';
import {operationMnuTextOptions} from './core/menu_presentation.mjs';

const place=(node,left,top,width,height)=>Object.assign(node.style,{position:'absolute',left:left+'px',top:top+'px',...(width==null?{}:{width:width+'px'}),...(height==null?{}:{height:height+'px'})});
const buttonStyle=node=>Object.assign(node.style,{margin:'0',padding:'0',border:'0',borderRadius:'0',background:'none',boxShadow:'none',outline:'none',textAlign:'left',whiteSpace:'nowrap',fontFamily:'inherit',lineHeight:'25px'});
const definitionView=definition=>definition?.raw_hex?new DataView(Uint8Array.from(definition.raw_hex.match(/../g),n=>parseInt(n,16)).buffer):null;

export class OperationWeaponView{
  constructor({manifest,root,textRenderer=null,onSocket,onSelect,onConfirm,onUnequip,onInfo,onFocus,onDetails,onActorChange}){
    this.manifest=manifest;this.root=root;this.textRenderer=textRenderer;this.onSocket=onSocket;this.onSelect=onSelect;this.onConfirm=onConfirm;this.onUnequip=onUnequip;this.onInfo=onInfo;this.onFocus=onFocus;this.onDetails=onDetails;this.onActorChange=onActorChange;
    this.menus=new Map(manifest.menus.map(menu=>[menu.id,menu]));this.menu=this.menus.get('game001c');this.section=root.querySelector('#menuWeaponSection');if(!this.section)throw new Error('法器视图区缺失');place(this.section,10,50,this.menu.width,this.menu.height);
    this.actorName=this.node('menuWeaponActor');this.weaponName=this.node('menuWeaponName');this.stats=this.node('menuWeaponStats');this.card=this.node('menuWeaponCard');this.socketList=this.node('menuWeaponSockets');
    this.socketButtons=new Map();this.candidateButtons=new Map();this.socketIndex=0;this.focused=false;this.sockets=null;this.socketCount=0;this.definitions={};this.candidates=[];this.selectedIndex=0;this.offset=0;this.detailsIndex=0;
    this.socketList.replaceChildren();
    for(let index=0;index<6;index++){
      const widget=this.menu.widgets.find(row=>row.name===String(index+1).padStart(2,'0')),r=widget.rect,button=document.createElement('button');button.type='button';button.className='weapon-source-socket';buttonStyle(button);place(button,r.left,r.top,r.right-r.left+1,r.bottom-r.top+1);button._widget=widget;button._background=this.picture(button,widget.normal_images[0],widget.draw_point_raw.x-r.left,widget.draw_point_raw.y-r.top);button._icon=this.picture(button,null,12,3);button.dataset.socketIndex=index;
      button.onfocus=()=>{if(button.disabled)return;this.socketIndex=index;this.focused=true;this.paintSockets();this.infoSocket();this.onFocus?.();this.onSocket?.(index,false);};button.onclick=()=>{if(button.disabled)return;this.socketIndex=index;this.focused=true;this.paintSockets();this.infoSocket();this.onSocket?.(index,true);};this.socketButtons.set(index,button);this.socketList.append(button);
    }
    this.picker=document.createElement('div');this.picker.id='menuWeaponPicker';this.picker.className='weapon-source-picker';this.picker.hidden=true;place(this.picker,170,88,294,280);this.picker.style.zIndex='4';this.section.append(this.picker);this.pickerBackground=this.picture(this.picker,this.menus.get('game001b').composed,0,0);
    this.rowButtons=Array.from({length:8},(_,index)=>{
      const widget=this.menus.get('game001b').widgets.find(row=>row.name==='list'+(index+1)),r=widget.rect,button=document.createElement('button');button.type='button';button.className='weapon-source-candidate';buttonStyle(button);place(button,r.left,r.top,r.right-r.left+1,r.bottom-r.top+1);button.style.fontSize='20px';button._highlight=this.picture(button,widget.active_images[0],widget.draw_point_raw.x-r.left,widget.draw_point_raw.y-r.top);button._icon=this.picture(button,null,10,0);button._name=document.createElement('span');place(button._name,40,3);button.append(button._name);button._name.style.lineHeight='22px';
      button.onfocus=()=>{if(button.hidden)return;this.selectCandidate(this.offset+index);this.onFocus?.();};button.onclick=()=>{this.selectCandidate(this.offset+index);this.confirm();};this.picker.append(button);return button;
    });
    this.scrollButtons=[['scroll_up',-1],['scroll_dn',1]].map(([name,direction])=>{
      const widget=this.menus.get('game001b').widgets.find(row=>row.name===name),r=widget.rect,button=document.createElement('button');button.type='button';button.className='weapon-source-scroll';button.tabIndex=-1;button.setAttribute('aria-label',direction<0?'晶石候选向上翻页':'晶石候选向下翻页');buttonStyle(button);place(button,r.left,r.top,r.right-r.left+1,r.bottom-r.top+1);const highlight=this.picture(button,widget.active_images[0],widget.draw_point_raw.x-r.left,widget.draw_point_raw.y-r.top);highlight.hidden=true;button.onpointerenter=()=>highlight.hidden=false;button.onpointerleave=()=>highlight.hidden=true;button.onclick=()=>this.pageCandidates(direction,false);this.picker.append(button);return button;
    });
    this.picker.addEventListener('wheel',event=>{event.preventDefault();this.moveCandidate(event.deltaY>0?1:-1);},{passive:false});
    this.details=document.createElement('div');this.details.className='weapon-source-preview';this.details.hidden=true;place(this.details,2,188,171,173);this.details.style.zIndex='5';this.detailsBackground=this.picture(this.details,null,0,0);this.detailNumbers=[];this.section.append(this.details);
  }
  node(id){const node=this.section.querySelector('#'+id);if(!node)throw new Error('法器视图节点缺失：'+id);return node;}
  picture(parent,path,x,y){const image=document.createElement('img');image.alt='';image.className='menu-source';if(path)image.src=path;image.hidden=!path;place(image,x,y);parent.append(image);return image;}
  text(node,value,options={}){
    const font=options.font??'simsun20_text';node.style.color=options.foreground??'#ffffff';node.setAttribute('aria-label',value);
    if(!value||!this.textRenderer?.supports(value,font)){node.textContent=value;return;}
    const canvas=node._canvas??=document.createElement('canvas');node.replaceChildren(canvas);canvas.style.pointerEvents='none';canvas.setAttribute('aria-hidden','true');const box=this.textRenderer.paint(canvas,value,{font,foreground:'#ffffff',shadow:'#222222',maxLines:1,...(font.endsWith('_mnu')?{layout:'mnu'}:{}),...options});place(canvas,box.offsetX??-1,box.offsetY??-1);
  }
  get pickerOpen(){return !this.picker.hidden;}
  get selectedId(){return this.candidates[this.selectedIndex]?.instance_id??'';}
  definition(row){const id=typeof row==='number'?row:row?.item_id??row?.id;return id?this.definitions[String(id)]??null:null;}
  socket(index=this.socketIndex){return this.sockets?.[index]??null;}
  socketKnown(index){const row=this.sockets?.[index];return Array.isArray(this.sockets)&&index<this.sockets.length&&(!row||Boolean(this.definition(row)));}
  available(row){return row.available!==false&&this.definition(row)?.runtime_enabled!==false;}
  icon(definition,selected=false){const view=definitionView(definition);if(!view)return null;const index=view.getUint32(0x1c,true),frame=selected&&index>=1&&index<=21?index+95:index,asset=this.manifest.item_row_icons?.frames?.[frame];return asset?.image??asset??null;}
  render({status,weapon,socketCount=0,sockets=null,definitions={},candidates=[],actor=null,slotIndex,selectedId}={}){
    const previousId=this.selectedId,changed=this.status?.id!==status?.id||this.weapon?.id!==weapon?.id;this.status=status;this.weapon=weapon;this.socketCount=Math.max(0,Math.min(6,socketCount|0));this.sockets=sockets;this.definitions=definitions;this.actor=actor;
    if(changed){this.socketIndex=0;this.focused=this.root.ownerDocument.activeElement===this.socketButtons.get(0);this.selectedIndex=0;this.offset=0;this.closePicker({focus:false});}if(Number.isInteger(slotIndex)&&slotIndex>=0&&slotIndex<6)this.socketIndex=slotIndex;
    this.candidates=[...candidates.filter(row=>{const def=this.definition(row);return row.quantity>0&&def?.type_raw_24===3&&def?.subtype_raw_25===1;}),{instance_id:'',empty:true}];
    const id=this.pickerOpen&&!changed?previousId:selectedId,index=this.candidates.findIndex(row=>row.instance_id===id);this.selectedIndex=index<0?0:index;
    for(const [node,widgetName,value]of [[this.actorName,'NAME1',status?.name??''],[this.weaponName,'NAME2',weapon?.name??'']]){const widget=this.menu.widgets.find(row=>row.name===widgetName),r=widget.rect;place(node,r.left,r.top,r.right-r.left,r.bottom-r.top);this.text(node,value,operationMnuTextOptions(widget));}
    const card=operationItemCard(weapon?.definition,this.manifest),board=this.menu.widgets.find(row=>row.name==='BOARD').rect;this.card.hidden=!card;if(card){this.card.src=card.image;place(this.card,board.left,board.top,card.width,card.height);}
    this.paintStats();this.paintSockets();this.ensureVisible();this.paintCandidates();if(this.pickerOpen)this.paintDetails();
  }
  paintStats(){
    this.stats.replaceChildren();for(const [index,key]of ['attack','defense','speed'].entries()){
      const widget=this.menu.widgets.find(row=>row.name==='T'+(index+1)),bar=this.menu.widgets.find(row=>row.name==='BAR'+(index+1)),number=document.createElement('dd'),fill=document.createElement('span'),image=document.createElement('img'),value=this.status?.[key]??0;place(number,widget.rect.left,widget.rect.top,widget.rect.right-widget.rect.left,widget.rect.bottom-widget.rect.top);Object.assign(number.style,{margin:'0',fontSize:'19px',lineHeight:'20px'});this.text(number,String(value),operationMnuTextOptions(widget));const width=bar.rect.right-bar.rect.left;fill.className='operation-bars';place(fill,bar.rect.left,bar.rect.top,Math.floor(Math.max(0,value)*width/1000),bar.rect.bottom-bar.rect.top+1);fill.style.overflow='hidden';image.src=bar.normal_images[0];image.alt='';Object.assign(image.style,{display:'block',position:'absolute',right:'0',width:'auto',height:(bar.rect.bottom-bar.rect.top+1)+'px',maxWidth:'none',objectFit:'none',imageRendering:'pixelated'});fill.append(image);this.stats.append(number,fill);
    }
  }
  paintSockets(){
    for(const [index,button]of this.socketButtons){const def=this.definition(this.socket(index)),selected=this.focused&&this.socketIndex===index&&!this.pickerOpen;button.hidden=!this.weapon||index>=this.socketCount;button.disabled=button.hidden||!this.socketKnown(index);button._background.src=selected&&!button.disabled?button._widget.active_images[0]:button._widget.normal_images[0];const icon=this.icon(def);button._icon.hidden=!icon||button.hidden;if(icon)button._icon.src=icon;button.setAttribute('aria-pressed',String(selected&&!button.disabled));button.setAttribute('aria-label',`法器第${index+1}孔：${index>=this.socketCount?'未开放':!this.socketKnown(index)?'未保留的镶嵌记录':def?.name??'空孔'}`);button.dataset.itemId=def?.id??'';}
  }
  controls(){return this.pickerOpen?this.rowButtons.filter(button=>!button.hidden):[...this.socketButtons.values()].filter(button=>!button.disabled);}
  infoSocket(){this.onInfo?.(this.definition(this.socket())?.description??'');}
  ensureVisible(){this.offset=Math.min(this.offset,Math.max(0,this.candidates.length-8));if(this.selectedIndex<this.offset)this.offset=this.selectedIndex;if(this.selectedIndex>=this.offset+8)this.offset=this.selectedIndex-7;}
  paintCandidates(){
    this.candidateButtons.clear();for(const [index,button]of this.rowButtons.entries()){const row=this.candidates[this.offset+index];button.hidden=!row;if(!row)continue;const selected=this.offset+index===this.selectedIndex,def=this.definition(row),available=row.empty||this.available(row);button._highlight.hidden=!selected;button.setAttribute('aria-pressed',String(selected));button.dataset.instanceId=row.instance_id;button.dataset.empty=String(Boolean(row.empty));button.dataset.available=String(available);this.text(button._name,row.empty?'':`${def?.name??row.name}${row.quantity>=2?'x'+row.quantity:''}`,{font:'simsun20_text',foreground:available?selected?'#ffffff':'#ffff00':'#505050',shadow:available?selected?'#222222':'#222200':'#000000'});const icon=this.icon(def,selected);button._icon.hidden=!icon;if(icon)button._icon.src=icon;button.setAttribute('aria-label',row.empty?`卸下第${this.socketIndex+1}孔晶石`:`${def?.name??row.name} ×${row.quantity}${available?'':'，当前无法镶嵌'}`);this.candidateButtons.set(row.instance_id,button);}
  }
  selectCandidate(index,{focus=false}={}){this.selectedIndex=Math.max(0,Math.min(this.candidates.length-1,index));this.ensureVisible();this.paintCandidates();const row=this.candidates[this.selectedIndex];this.onInfo?.(this.definition(row)?.description??'');this.paintDetails();this.onSelect?.(row.instance_id,row,this.socketIndex);if(focus)this.rowButtons[this.selectedIndex-this.offset]?.focus({preventScroll:true});}
  moveCandidate(delta){this.selectCandidate(this.selectedIndex+delta,{focus:true});}
  pageCandidates(direction,edgeFirst=true){const next=operationPickerPage({index:this.selectedIndex,offset:this.offset,count:this.candidates.length,size:this.rowButtons.length},direction,{edgeFirst});this.offset=next.offset;this.selectCandidate(next.index,{focus:true});}
  openPicker(){if(this.socketButtons.get(this.socketIndex)?.disabled)return false;this.picker.hidden=false;this.paintSockets();this.selectCandidate(this.selectedIndex,{focus:true});return true;}
  closePicker({focus=true}={}){this.picker.hidden=true;this.details.hidden=true;this.paintSockets();if(this.status)this.infoSocket();if(focus)this.socketButtons.get(this.socketIndex)?.focus({preventScroll:true});}
  confirm(){const row=this.candidates[this.selectedIndex];if(!row)return;if(row.empty){if(this.definition(this.socket()))this.onUnequip?.(this.socketIndex);}else if(this.available(row))this.onConfirm?.(row.instance_id,this.socketIndex,row);}
  paintDetails(){
    const row=this.candidates[this.selectedIndex],definition=this.definition(row),values=operationEquipmentPreview(this.actor,this.definition(this.socket()),definition);this.onDetails?.(this.detailsIndex,definition,row,values?.[this.detailsIndex]??null);this.details.hidden=!this.pickerOpen||!definition||!values;if(this.details.hidden)return;const menu=this.menus.get(['game001f','game001g','game001h'][this.detailsIndex]);this.detailsBackground.src=menu.composed;this.detailsBackground.hidden=false;for(const node of this.detailNumbers)node.remove();this.detailNumbers=values[this.detailsIndex].map((value,index)=>{const widget=menu.widgets.find(row=>row.name===String(index+1).padStart(2,'0')),node=document.createElement('span');place(node,widget.rect.left,widget.rect.top);Object.assign(node.style,{fontSize:'18px',lineHeight:'18px',whiteSpace:'pre',textShadow:'none'});this.text(node,value.before===value.after?String(value.before).padStart(3,' '):`${String(value.before).padStart(3,' ')}>${value.after}`,{font:'simsun18',foreground:value.after<value.before?'#ff4040':value.after>value.before?'#00ff00':'#ffffff',shadow:'#000000'});this.details.append(node);return node;});
  }
  key(key,repeat=false){
    if(key==='Tab')return true;if(['x','X','z','Z'].includes(key)&&!this.pickerOpen&&this.onActorChange){if(!repeat)this.onActorChange(key.toLowerCase()==='x'?1:-1);return true;}
    if(this.pickerOpen){if(key===' '||key==='Enter'){if(!repeat)this.confirm();return true;}if(key==='ArrowUp'||key==='ArrowDown'){this.moveCandidate(key==='ArrowUp'?-1:1);return true;}if(key==='PageUp'||key==='PageDown'){this.pageCandidates(key==='PageUp'?-1:1);return true;}if(key==='ArrowLeft'||key==='ArrowRight'){this.detailsIndex=(this.detailsIndex+(key==='ArrowLeft'?2:1))%3;this.paintDetails();return true;}return false;}
    if(key===' '||key==='Enter'){if(!repeat)this.socketButtons.get(this.socketIndex)?.click();return true;}if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(key))return false;const controls=this.controls();if(!controls.length)return true;const index=this.socketIndex,row=Math.floor(index/3),column=index%3;let target;if(key==='ArrowLeft'||key==='ArrowRight'){const direction=key==='ArrowLeft'?-1:1;target=(index+direction+6)%6;while(!controls.includes(this.socketButtons.get(target)))target=(target+direction+6)%6;}else{target=(1-row)*3+column;if(!controls.includes(this.socketButtons.get(target)))target=index;}this.socketButtons.get(target)?.focus({preventScroll:true});return true;
  }
  escape(){if(!this.pickerOpen)return false;this.closePicker();return true;}
  reset(){this.closePicker({focus:false});this.socketIndex=0;this.selectedIndex=0;this.offset=0;this.focused=false;this.paintSockets();}
}
