// Original Game_Save_01/02/03 pixels and hit rectangles on a 640x480 plane.
import {MANUAL_SAVE_SLOTS} from './core/save_slots.mjs';
export class SaveMenuView {
  static async create(options){const view=new SaveMenuView(options);await Promise.all(options.manifest.menus.flatMap(menu=>menu.images).map(async record=>view.images.set(record.image,await options.image(record.image))));return view;}
  constructor({manifest,root,image,getPreview,onConfirm,onClose,log=()=>{}}){
    if(manifest?.schema!=='seventh-seal-save-menu'||manifest.slot_count!==20)throw new Error('存档页面来源无效');
    Object.assign(this,{manifest,root,image,getPreview,onConfirm,onClose,log});
    this.menus=new Map(manifest.menus.map(menu=>[menu.id,menu]));this.images=new Map();this.previews=new Map();
    this.ctx=root.querySelector('canvas').getContext('2d');this.buttons=root.querySelector('.save-menu-buttons');this.message=root.querySelector('.save-menu-message');
    this.active=false;this.epoch=0;this.pending=false;this.confirming=false;this.top=0;this.selected=0;
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(root);
    root.addEventListener('wheel',event=>{if(this.active){event.preventDefault();if(!this.pending&&!this.loading&&!this.confirming)this.move(event.deltaY<0?-1:1);}},{passive:false});
  }
  resize(){const rect=this.root.getBoundingClientRect();this.root.style.setProperty('--save-menu-scale',String(Math.min(rect.width/640,rect.height/480)));}
  show({mode='save',entries=[],summary={}}={}){this.active=true;this.epoch++;Object.assign(this,{mode,summary,entries,selected:0,top:0,pending:false,confirming:false,loading:true});this.root.hidden=false;this.resize();this.render();this.root.focus({preventScroll:true});}
  hide(){this.active=false;this.epoch++;this.root.hidden=true;this.buttons.replaceChildren();this.previews.clear();}
  setEntries(entries){this.entries=entries;this.loading=false;this.render();}
  row(index=this.selected){const slot=MANUAL_SAVE_SLOTS[index];return this.entries.find(row=>row.slot===slot)??{slot,envelope:null,error:null};}
  select(index){if(this.pending||this.loading||this.confirming)return;this.selected=Math.max(0,Math.min(19,index));if(this.selected<this.top)this.top=this.selected;if(this.selected>=this.top+3)this.top=this.selected-2;this.render();}
  move(delta){this.select(this.selected+delta);}
  key(key,repeat=false){
    if(!this.active)return false;if(this.pending||this.loading)return true;
    if(key==='Escape'){if(!repeat){if(this.confirming){this.confirming=false;this.render();}else this.onClose();}return true;}
    if(this.confirming){
      if(['ArrowUp','ArrowDown'].includes(key)){this.confirmIndex=key==='ArrowDown'?1:0;this.render();}
      else if(!repeat&&[' ','Enter'].includes(key)){if(this.confirmIndex===1){this.confirming=false;this.render();}else this.submit();}return true;
    }
    const steps={ArrowUp:-1,ArrowDown:1,PageUp:-3,PageDown:3};
    if(key in steps)this.move(steps[key]);else if(key==='Home')this.select(0);else if(key==='End')this.select(19);else if(!repeat&&[' ','Enter'].includes(key))this.confirm();return true;
  }
  async confirm(){
    if(this.pending||this.loading||this.confirming)return;const row=this.row();
    if(row.error){this.setMessage(`栏位 ${row.slot} 无法读取，请选择其他栏位。`);return;}
    if(this.mode==='load'&&!row.envelope){this.setMessage(`栏位 ${row.slot} 为空。`);return;}
    if(this.mode==='save'&&row.envelope){this.confirming=true;this.confirmIndex=0;this.render();return;}return this.submit();
  }
  async submit(){
    if(this.pending||this.loading)return;const row=this.row(),epoch=this.epoch;this.confirming=false;this.pending=true;this.render();
    try{await this.onConfirm(row);}catch(error){if(this.active&&epoch===this.epoch){this.setMessage(error.message);this.log({type:'save-menu-failed',slot:row.slot,error:error.message});}}
    finally{if(this.active&&epoch===this.epoch){this.pending=false;this.render(false);}}
  }
  setMessage(text){this.message.textContent=text;}
  drawImage(path,x=0,y=0){const bitmap=this.images.get(path);if(bitmap)this.ctx.drawImage(bitmap,x,y);}
  page(id){this.drawImage(this.menus.get(id).images[0].image);}
  button(label,rect,handler,{className='',text='',disabled=false}={}){
    const button=document.createElement('button');button.type='button';button.className=className;button.setAttribute('aria-label',label);Object.assign(button.style,{left:rect.left+'px',top:rect.top+'px',width:rect.right-rect.left+'px',height:rect.bottom-rect.top+'px'});
    button.textContent=text;button.disabled=this.pending||this.loading||disabled;button.onclick=()=>{if(!this.pending&&!this.loading)handler();};this.buttons.append(button);return button;
  }
  widgetButton(id,name,label,handler,options){return this.button(label,this.menus.get(id).widgets.find(row=>row.name===name).rect,handler,options);}
  render(resetMessage=true){
    if(!this.active)return;this.buttons.replaceChildren();this.ctx.clearRect(0,0,640,480);this.ctx.imageSmoothingEnabled=false;this.page('game_save_02');this.page('game_save_01');
    const menu=this.menus.get('game_save_02');
    for(let visible=0;visible<3&&this.top+visible<20;visible++){
      const index=this.top+visible,row=this.row(index),widget=menu.widgets.find(item=>item.name===String(visible+1).padStart(2,'0'));
      if(index===this.selected)this.drawImage(widget.active_images[0],widget.draw_point_raw.x,widget.draw_point_raw.y);
      let world={};try{world=JSON.parse(row.envelope?.payload??'{}');}catch{}
      const label=row.error?'无法读取':row.envelope?(world.party??[]).map(role=>role.name).join('　'):'空白存档',date=row.envelope?.saved_at?new Date(row.envelope.saved_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'';
      const button=this.button(`存档栏位 ${row.slot} · ${label}`,widget.rect,()=>this.select(index),{className:'save-slot',text:`${row.slot}　${label}\n${date}\n${world.location?.map_id??''}`,disabled:this.confirming});button.dataset.slot=row.slot;button.setAttribute('aria-current',String(index===this.selected));
      if(row.envelope){const key=row.envelope.sha256,preview=this.previews.get(key);
        if(preview?.image)this.ctx.drawImage(preview.image,26,82+visible*105,104,76);
        else if(!preview&&this.getPreview){const epoch=this.epoch;this.previews.set(key,{pending:true});Promise.resolve().then(()=>this.getPreview(row.envelope)).then(result=>{if(this.active&&epoch===this.epoch){this.previews.set(key,result);this.render(false);}}).catch(error=>{if(this.active&&epoch===this.epoch)this.previews.set(key,{error:error.message});});}
      }
    }
    this.widgetButton('game_save_02','UP','向上翻动存档栏位',()=>this.move(-3),{disabled:this.confirming||this.selected===0});this.widgetButton('game_save_02','DN','向下翻动存档栏位',()=>this.move(3),{disabled:this.confirming||this.selected===19});
    this.widgetButton('game_save_01','OK',this.mode==='save'?'保存所选栏位':'读取所选栏位',()=>this.confirm(),{disabled:this.confirming});this.widgetButton('game_save_01','EXIT','离开存档页面',()=>this.onClose(),{disabled:this.confirming});
    this.ctx.fillStyle='#fff';this.ctx.font='16px SimSun,serif';this.ctx.fillText(this.summary.name??'',522,355);this.ctx.fillText(String(this.summary.money??0),523,406);
    if(this.mode==='load'){const background=this.images.get(menu.images[0].image);if(background)this.ctx.drawImage(background,151,3,43,30,43,3,43,30);}
    if(this.confirming){this.page('game_save_03');const selected=this.menus.get('game_save_03').widgets.find(row=>row.name===(this.confirmIndex===1?'CANCEL':'OK'));this.drawImage(selected.active_images[0],selected.draw_point_raw.x,selected.draw_point_raw.y);this.widgetButton('game_save_03','OK',`覆盖存档 ${this.row().slot}`,()=>this.submit());this.widgetButton('game_save_03','CANCEL','取消覆盖存档',()=>{this.confirming=false;this.render();});}
    if(resetMessage)this.setMessage(this.loading?'正在读取存档栏位…':this.pending?'正在存取进度…':this.confirming?`覆盖栏位 ${this.row().slot} 的现有存档？`:`${this.mode==='save'?'保存':'读取'}栏位 ${this.row().slot}　方向键选择，Enter确认，Esc返回（${this.selected+1}/20）`);
    this.root.dataset.mode=this.mode;this.root.dataset.slot=this.row().slot;this.root.dataset.state=this.pending?'pending':this.confirming?'overwrite':'list';
  }
}
