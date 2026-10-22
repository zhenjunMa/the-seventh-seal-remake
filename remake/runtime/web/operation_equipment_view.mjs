// Game001a / Game001b equipment presentation. This view never changes world
// equipment, saved item rolls, or actor resources; the controller owns commits.
import {EQUIPMENT_ATTRIBUTES} from './core/item_registry.mjs';

const sourceNumber=(definition,instanceOffset,definitionOffset)=>{
  const name=EQUIPMENT_ATTRIBUTES.find(row=>row[1]===instanceOffset)?.[0];
  if(name&&definition?.runtime_attributes?.[name])return definition.runtime_attributes[name].minimum;
  if(!definition)return 0;
  const range=definition.value_ranges?.find(row=>row.instance_offset===instanceOffset);
  if(range)return range.minimum;
  const bytes=Uint8Array.from(definition.raw_hex.match(/../g),n=>parseInt(n,16));
  return new DataView(bytes.buffer).getInt32(definitionOffset,true);
};
const clamp=n=>Math.max(0,Math.min(999,n|0));
const div=(a,b)=>b===0?0:Math.trunc(a/b);

/** Native 47E2F0 / 47E650 compare definition minima, not saved random rolls.
 * The original rate preview has two retained quirks: physical row 4 calculates
 * both sides from the current actor, and defense rows 2..4 add only the new
 * definition delta on the right. Do not silently replace them with battle rules.
 */
export function operationEquipmentPreview(actor,wornDefinition,candidateDefinition){
  if(!actor?.header_raw_hex||!actor.linked_by_address||!candidateDefinition)return null;
  const bytes=Uint8Array.from(actor.header_raw_hex.match(/../g),n=>parseInt(n,16)),header=new DataView(bytes.buffer);
  const linked=n=>actor.linked_by_address['0x'+n.toString(16).padStart(8,'0')]??0;
  const actual=(offset,address)=>header.getInt32(offset,true)+linked(address);
  const delta=(instanceOffset,definitionOffset)=>sourceNumber(candidateDefinition,instanceOffset,definitionOffset)-sourceNumber(wornDefinition,instanceOffset,definitionOffset);
  const hp=actual(0x30,0x4f99088),maxHp=actual(0x34,0x4f9908c),attack=actual(0x40,0x4f99098),defense=actual(0x48,0x4f9909c),speed=actual(0x58,0x4f990a4);
  const nextHp=hp+delta(0x0d,0x17e),nextMaxHp=maxHp+delta(0x11,0x186),nextAttack=attack+delta(0x1d,0x19e),nextDefense=defense+delta(0x21,0x1a6),nextSpeed=speed+delta(0x29,0x1b6);
  const elements=Array.from({length:6},(_,i)=>actual(0x7a+i*4,0x4f990e0+i*4));
  const nextElements=elements.map((n,i)=>n+delta(0x65+i*4,0x24a+i*8));
  const pairs=(before,after)=>before.map((n,i)=>({before:clamp(n),after:clamp(after[i])}));
  const physicalBase=div(speed*70+defense*20,999)+(maxHp?div(hp,maxHp):0),physicalNext=div(nextSpeed*70+nextDefense*20,999)+(nextMaxHp?div(nextHp,nextMaxHp):0);
  const physical=[physicalBase,div((speed*80+attack*20)*20,99900)+80,defense,div((physicalBase*70+speed*30)*85,99900)];
  const physicalAfter=[physicalNext,div((nextSpeed*80+nextAttack*20)*20,99900)+80,nextDefense,physical[3]];
  const defenseBase=maxHp?div(hp,maxHp)+div(speed*70+defense*20,99900)*100:0;
  const defenseNext=maxHp?div(nextHp,nextMaxHp)+div(nextSpeed*70+nextDefense*20,99900)*100:0;
  const defenses=[div(elements.reduce((a,b)=>a+b,0),6),div((defenseBase*80+defense*20)*30,99900)+linked(0x4f990d4),div((defenseBase*70+speed*30)*40,99900)+linked(0x4f990d8),div(defenseBase*1350,99900)+linked(0x4f990dc)];
  const defensesAfter=[div(nextElements.reduce((a,b)=>a+b,0),6),div((defenseNext*80+nextDefense*20)*30,99900)+delta(0x59,0x232),div((defenseNext*70+nextSpeed*30)*40,99900)+delta(0x5d,0x23a),div(defenseNext*1350,99900)+delta(0x61,0x242)];
  return [pairs([0,2,1,3,4,5].map(i=>elements[i]),[0,2,1,3,4,5].map(i=>nextElements[i])),pairs(physical,physicalAfter),pairs(defenses,defensesAfter)];
}

const absolute=(node,left,top,width,height)=>Object.assign(node.style,{position:'absolute',left:left+'px',top:top+'px',...(width==null?{}:{width:width+'px'}),...(height==null?{}:{height:height+'px'})});
const buttonStyle=node=>Object.assign(node.style,{margin:'0',padding:'0',border:'0',borderRadius:'0',background:'none',boxShadow:'none',outline:'none',textAlign:'left',whiteSpace:'nowrap',fontFamily:'inherit',lineHeight:'25px'});

// Native linked lists keep the selected row separate from the first visible
// record. Page keys first reach an edge, then scroll by the visible-row count.
export function operationPickerPage({index,offset,count,size=8},direction,{edgeFirst=true}={}){
  const maximum=Math.max(0,count-size),last=Math.min(count-1,offset+size-1);
  if(edgeFirst&&direction>0&&index<last)return {index:last,offset};
  if(edgeFirst&&direction<0&&index>offset)return {index:offset,offset};
  const next=Math.max(0,Math.min(maximum,offset+direction*size));
  return {index:Math.max(0,Math.min(count-1,next+index-offset)),offset:next};
}

export class OperationEquipmentView{
  constructor({manifest,root,onSlot,onSelect,onConfirm,onUnequip,onInfo,onFocus,onDetails,textRenderer=null}){
    this.manifest=manifest;this.root=root;this.onSlot=onSlot;this.onSelect=onSelect;this.onConfirm=onConfirm;this.onUnequip=onUnequip;this.onInfo=onInfo;this.onFocus=onFocus;this.onDetails=onDetails;this.textRenderer=textRenderer;
    this.menus=new Map(manifest.menus.map(row=>[row.id,row]));this.section=root.querySelector('#menuEquipmentSection');
    if(!this.section)throw new Error('装备视图区缺失');
    this.slotButtons=new Map();this.candidateButtons=new Map();this.slots=[];this.rows=[];this.candidates=[];this.definitions={};this.offset=0;this.selectedIndex=0;this.detailsIndex=0;this.slotFocused=false;
    this.list=this.section.querySelector('#menuEquipped')??this.section.appendChild(document.createElement('div'));this.list.id='menuEquipped';absolute(this.list,0,0,469,180);this.list.replaceChildren();
    this.picker=this.section.querySelector('#menuEquipmentPicker')??this.section.appendChild(document.createElement('div'));this.picker.id='menuEquipmentPicker';this.picker.hidden=true;absolute(this.picker,160,3,294,280);this.picker.style.zIndex='4';
    // Legacy form controls can still be used as controller state, but never as
    // the visible original-game list or as extra equipment action buttons.
    for(const child of this.picker.children)child.hidden=true;
    this.background=this.picker.querySelector('#menuEquipmentPickerSource')??this.picture(this.picker,null,0,0);this.background.id='menuEquipmentPickerSource';this.background.src=this.menus.get('game001b').composed;this.background.hidden=false;absolute(this.background,0,0);
    this.rowButtons=Array.from({length:8},(_,i)=>{
      const widget=this.menus.get('game001b').widgets.find(row=>row.name==='list'+(i+1)),r=widget.rect,button=document.createElement('button');button.type='button';button.className='equipment-source-candidate';buttonStyle(button);absolute(button,r.left,r.top,r.right-r.left+1,r.bottom-r.top+1);button.style.fontSize='20px';
      button._highlight=this.picture(button,widget.active_images[0],widget.draw_point_raw.x-r.left,widget.draw_point_raw.y-r.top);button._icon=this.picture(button,null,10,0);button._name=document.createElement('span');absolute(button._name,40,3);button.append(button._name);button._name.style.lineHeight='22px';
      button.onfocus=()=>{if(button.hidden)return;this.selectCandidate(this.offset+i);this.onFocus?.();};button.onclick=()=>{this.selectCandidate(this.offset+i);this.confirm();};this.picker.append(button);return button;
    });
    this.scrollButtons=[['scroll_up',-1],['scroll_dn',1]].map(([name,direction])=>{
      const widget=this.menus.get('game001b').widgets.find(row=>row.name===name),r=widget.rect,button=document.createElement('button');button.type='button';button.className='equipment-source-scroll';button.tabIndex=-1;button.setAttribute('aria-label',direction<0?'装备候选向上翻页':'装备候选向下翻页');buttonStyle(button);absolute(button,r.left,r.top,r.right-r.left+1,r.bottom-r.top+1);const image=this.picture(button,widget.active_images[0],widget.draw_point_raw.x-r.left,widget.draw_point_raw.y-r.top);image.hidden=true;button.onpointerenter=()=>image.hidden=false;button.onpointerleave=()=>image.hidden=true;button.onclick=()=>this.pageCandidates(direction,false);this.picker.append(button);return button;
    });
    this.picker.addEventListener('wheel',event=>{event.preventDefault();this.move(event.deltaY>0?1:-1);},{passive:false});
    this.details=document.createElement('div');this.details.className='equipment-source-details';this.details.hidden=true;absolute(this.details,-8,103,171,173);this.details.style.zIndex='5';this.detailsBackground=this.picture(this.details,null,0,0);this.detailNumbers=[];this.section.append(this.details);
  }
  picture(parent,src,x,y){const image=document.createElement('img');image.alt='';image.className='menu-source';if(src)image.src=src;absolute(image,x,y);image.hidden=!src;parent.append(image);return image;}
  text(node,value,font,foreground,shadow='#222222'){
    node.style.color=foreground;
    if(!value||!this.textRenderer?.supports(value,font)){node.textContent=value;return;}
    const canvas=node._canvas??=document.createElement('canvas');node.replaceChildren(canvas);canvas.style.pointerEvents='none';const box=this.textRenderer.paint(canvas,value,{font,foreground,shadow,maxLines:1});absolute(canvas,box.offsetX??-1,box.offsetY??-1);
  }
  get pickerOpen(){return !this.picker.hidden;}
  get selectedId(){return this.candidates[this.selectedIndex]?.instance_id??'';}
  definition(row){return row?this.definitions[String(row.item_id??row.id)]:null;}
  worn(slotId=this.slotId){return this.rows.find(row=>(row.slot_id??this.definition(row)?.slot_id)===slotId);}
  available(row){const def=this.definition(row),mask=def?.allowed_role_mask_raw_13e;return row.available!==false&&def?.runtime_enabled!==false&&(!this.roleId||mask===0||(mask&(1<<(Number(this.roleId)-1)))!==0);}
  render({slots=[],rows=[],definitions={},candidates=[],slotId,selectedId,actor=null,roleId=actor?.id}={}){
    const previousId=this.selectedId,changed=this.slotId!==slotId||this.roleId!==roleId;this.slots=slots;this.rows=rows;this.definitions=definitions;this.actor=actor;this.roleId=roleId;this.slotId=slotId;
    this.candidates=[...candidates.filter(row=>row.quantity>0&&this.definition(row)?.slot_id===slotId),{instance_id:'',empty:true}];
    let next=this.candidates.findIndex(row=>row.instance_id===(this.pickerOpen&&!changed?previousId:selectedId));this.selectedIndex=next<0?0:next;
    if(changed){this.offset=0;this.slotFocused=this.root.ownerDocument.activeElement===this.slotButtons.get(slotId);if(this.pickerOpen)this.closePicker({focus:false});}
    for(const [index,slot] of slots.entries()){
      const widget=this.menus.get('game001a').widgets.find(row=>row.name==='text'+String(index+1).padStart(2,'0'));if(!widget)continue;
      let button=this.slotButtons.get(slot.id);if(!button){button=document.createElement('button');button.type='button';button.className='equipment-source-slot';buttonStyle(button);button._icon=this.picture(button,this.manifest.slot_icons.frames[index],-49,0);button._name=document.createElement('span');absolute(button._name,5,2);button.append(button._name);button.onclick=()=>this.onSlot?.(slot.id,true);button.onfocus=()=>{this.slotFocused=true;this.slotId=slot.id;this.paintSlots();this.onFocus?.();this.onSlot?.(slot.id,false);this.infoWorn();};this.slotButtons.set(slot.id,button);this.list.append(button);}
      const r=widget.rect;absolute(button,r.left,r.top,r.right-r.left+1,r.bottom-r.top+1);button.style.fontSize='22px';button.disabled=slot.group_index===0||slot.id==='weapon';const worn=this.worn(slot.id),def=this.definition(worn),label=this.manifest.slot_icons.labels_observed[index]??slot.label;button._text=def?.name??'';button.setAttribute('aria-label',`${label}：${def?.name??'空槽'}`);button.dataset.slotId=slot.id;
    }
    for(const [id,button]of this.slotButtons)if(!slots.some(slot=>slot.id===id)){button.remove();this.slotButtons.delete(id);}
    this.paintSlots();this.ensureVisible();this.paintCandidates();if(this.pickerOpen)this.paintDetails();
  }
  paintSlots(){for(const [id,button] of this.slotButtons){const selected=this.slotFocused&&id===this.slotId&&!this.pickerOpen;button.classList.toggle('selected',selected);button._icon.hidden=!selected;this.text(button._name,button._text??'','simsun22_text',button.disabled?'#ff8000':selected?'#ffff00':'#ffffff',selected?'#222200':'#222222');button.setAttribute('aria-pressed',String(selected));}}
  controls(){return this.pickerOpen?this.rowButtons.filter(button=>!button.hidden):[...this.slotButtons.values()].filter(button=>!button.disabled);}
  ensureVisible(){this.offset=Math.min(this.offset,Math.max(0,this.candidates.length-8));if(this.selectedIndex<this.offset)this.offset=this.selectedIndex;if(this.selectedIndex>=this.offset+8)this.offset=this.selectedIndex-7;}
  paintCandidates(){
    this.candidateButtons.clear();for(const [visibleIndex,button]of this.rowButtons.entries()){
      const row=this.candidates[this.offset+visibleIndex];button.hidden=!row;if(!row)continue;const selected=this.offset+visibleIndex===this.selectedIndex,def=this.definition(row);button._highlight.hidden=!selected;button.setAttribute('aria-pressed',String(selected));button.dataset.instanceId=row.instance_id;button.dataset.empty=String(Boolean(row.empty));button.dataset.available=String(row.empty||this.available(row));
      this.text(button._name,row.empty?'':`${def?.name??row.name}${row.quantity>=2?'x'+row.quantity:''}`,'simsun20_text',row.empty||this.available(row)?selected?'#ffffff':'#ffff00':'#505050',this.available(row)?selected?'#222222':'#222200':'#000000');button.setAttribute('aria-label',row.empty?`卸下${this.slots.find(slot=>slot.id===this.slotId)?.label??'装备'}`:`${def?.name??row.name} ×${row.quantity}${this.available(row)?'':'，此角色无法装备'}`);
      const raw=def?.raw_hex,bytes=raw?Uint8Array.from(raw.match(/../g),n=>parseInt(n,16)):null,iconIndex=bytes?new DataView(bytes.buffer).getUint32(0x1c,true):null,frame=selected&&iconIndex>=1&&iconIndex<=21?iconIndex+95:iconIndex,asset=frame==null?null:this.manifest.item_row_icons?.frames?.[frame];button._icon.hidden=!asset;if(asset)button._icon.src=asset.image??asset;this.candidateButtons.set(row.instance_id,button);
    }
  }
  infoWorn(){this.onInfo?.(this.definition(this.worn())?.description??'');}
  selectCandidate(index,{focus=false}={}){this.selectedIndex=Math.max(0,Math.min(this.candidates.length-1,index));this.ensureVisible();this.paintCandidates();const row=this.candidates[this.selectedIndex];this.onInfo?.(this.definition(row)?.description??'');this.paintDetails();this.onSelect?.(row?.instance_id??'',row);if(focus)this.rowButtons[this.selectedIndex-this.offset]?.focus({preventScroll:true});}
  move(delta){this.selectCandidate(this.selectedIndex+delta,{focus:true});}
  pageCandidates(direction,edgeFirst=true){const next=operationPickerPage({index:this.selectedIndex,offset:this.offset,count:this.candidates.length,size:this.rowButtons.length},direction,{edgeFirst});this.offset=next.offset;this.selectCandidate(next.index,{focus:true});}
  openPicker(){if(this.slotButtons.get(this.slotId)?.disabled)return false;this.picker.hidden=false;this.slotFocused=true;this.paintSlots();this.selectCandidate(this.selectedIndex,{focus:true});return true;}
  closePicker({focus=true}={}){this.picker.hidden=true;this.details.hidden=true;this.paintSlots();this.infoWorn();if(focus)this.slotButtons.get(this.slotId)?.focus({preventScroll:true});}
  confirm(){const row=this.candidates[this.selectedIndex];if(!row)return;if(row.empty){if(this.worn())this.onUnequip?.(this.slotId);}else if(this.available(row))this.onConfirm?.(row.instance_id,this.slotId,row);}
  paintDetails(){
    const row=this.candidates[this.selectedIndex],def=this.definition(row),values=operationEquipmentPreview(this.actor,this.definition(this.worn()),def);this.onDetails?.(this.detailsIndex,def,row,values?.[this.detailsIndex]??null);this.details.hidden=!this.pickerOpen||!def||!values;if(this.details.hidden)return;
    const menu=this.menus.get(['game001f','game001g','game001h'][this.detailsIndex]);this.detailsBackground.src=menu.composed;this.detailsBackground.hidden=false;for(const number of this.detailNumbers)number.remove();this.detailNumbers=values[this.detailsIndex].map((value,index)=>{const widget=menu.widgets.find(row=>row.name===String(index+1).padStart(2,'0')),number=document.createElement('span');absolute(number,widget.rect.left,widget.rect.top);Object.assign(number.style,{fontFamily:'inherit',fontSize:'18px',lineHeight:'18px',whiteSpace:'pre',textShadow:'none'});this.text(number,value.before===value.after?String(value.before).padStart(3,' '):`${String(value.before).padStart(3,' ')}>${value.after}`,'simsun18',value.after<value.before?'#ff4040':value.after>value.before?'#00ff00':'#ffffff','#000000');this.details.append(number);return number;});
  }
  key(key,repeat=false){
    if(key==='Tab')return true;if(!this.pickerOpen){if([' ','Enter'].includes(key)){if(!repeat)this.slotButtons.get(this.slotId)?.click();return true;}if(!['ArrowUp','ArrowDown'].includes(key))return false;const slots=this.controls(),index=Math.max(0,slots.indexOf(this.root.ownerDocument.activeElement));slots[(index+(key==='ArrowUp'?-1:1)+slots.length)%slots.length]?.focus({preventScroll:true});return true;}
    if([' ','Enter'].includes(key)){if(!repeat)this.confirm();return true;}if(key==='ArrowUp'||key==='ArrowDown'){this.move(key==='ArrowUp'?-1:1);return true;}if(key==='PageUp'||key==='PageDown'){this.pageCandidates(key==='PageUp'?-1:1);return true;}if(key==='ArrowLeft'||key==='ArrowRight'){this.detailsIndex=(this.detailsIndex+(key==='ArrowLeft'?2:1))%3;this.paintDetails();return true;}return false;
  }
  escape(){if(!this.pickerOpen)return false;this.closePicker();return true;}
  reset(){this.closePicker({focus:false});this.offset=0;this.selectedIndex=0;this.slotFocused=false;this.paintSlots();}
}
