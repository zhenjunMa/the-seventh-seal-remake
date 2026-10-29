// Original Boss MNU pixels and hit rectangles; economic decisions stay in the
// controller. The two buying pages share the native (10,50) listing origin.
const labels={buy:'购买',sell:'卖出',forge:'锻造',synthesize:'合成'};
const place=(node,x,y,w,h)=>Object.assign(node.style,{left:`${x}px`,top:`${y}px`,...(w===undefined?{}:{width:`${w}px`,height:`${h}px`})});
export class NativeServiceView{
  constructor({root,manifest,onAction,onClose,isSuspended=()=>false}){
    if(manifest?.schema!=='seventh-seal-native-services'||manifest.version!==1)throw new Error('城镇服务素材版本无效');
    Object.assign(this,{root,manifest,onAction,onClose,isSuspended});
    this.menus=new Map(manifest.menus.map(menu=>[menu.id,menu]));
    root.classList.add('native-service-panel');root.hidden=true;
    this.frame=document.createElement('div');this.frame.className='native-service-frame';this.frame.tabIndex=-1;
    this.frame.setAttribute('role','dialog');this.frame.setAttribute('aria-label','城镇服务');root.append(this.frame);
    this.resize=new ResizeObserver(()=>this.fit());this.resize.observe(root);
  }
  get active(){return !this.root.hidden;}
  fit(){this.frame.style.transform=`translate(-50%,-50%) scale(${Math.min(this.root.clientWidth/640,this.root.clientHeight/480)})`;}
  widget(menu,name){return menu.widgets.find(widget=>widget.name.toUpperCase()===name.toUpperCase());}
  image(path,x=0,y=0,parent=this.frame){const node=document.createElement('img');node.alt='';node.src=path;place(node,x,y);parent.append(node);return node;}
  text(value,rect,parent=this.frame,className=''){
    const node=document.createElement('span');node.className=`native-service-text ${className}`;node.textContent=value??'';
    place(node,rect.left,rect.top,rect.right-rect.left+1,rect.bottom-rect.top+1);parent.append(node);return node;
  }
  control(menu,widget,label,action,{x=0,y=0}={},parent=this.frame){
    const r=widget.rect,button=document.createElement('button');button.type='button';button.className='native-service-control';button.setAttribute('aria-label',label);
    place(button,x+r.left,y+r.top,r.right-r.left+1,r.bottom-r.top+1);parent.append(button);
    const overlay=(paths)=>{button.querySelector('img')?.remove();if(paths?.length)this.image(paths.at(-1),widget.draw_point_raw.x-r.left,widget.draw_point_raw.y-r.top,button);};
    overlay(widget.normal_images);
    button.onpointerenter=button.onfocus=()=>overlay(widget.active_images.length?widget.active_images:widget.normal_images);
    button.onpointerleave=button.onblur=()=>overlay(widget.normal_images);
    button.onclick=()=>{if(!this.isSuspended())action();};return button;
  }
  show(state){
    this.state=state;this.root.hidden=false;this.fit();this.paint();
  }
  paint(){
    const state=this.state,rows=state.rows??[],mode=state.mode??'buy',allowed=state.allowedModes??[mode];
    this.index=Math.max(0,rows.findIndex(row=>row.id===state.selected));this.quantity=state.quantity??1;
    const selected=rows[this.index],main=this.menus.get('boss_main'),o=this.manifest.origins.listing;
    this.frame.replaceChildren();this.image(main.images[0].image);
    this.frame.setAttribute('aria-label',`${state.title??'城镇服务'} · ${labels[mode]}`);
    for(const [key,target,category]of [['01','buy','items'],['02','buy','equipment'],['03','forge'],['04','synthesize']]){
      if(!allowed.some(value=>value===target||target==='buy'&&value==='sell'))continue;
      const widget=this.widget(main,key),button=this.control(main,widget,category?(category==='items'?'买卖道具':'买卖防具'):labels[target],()=>{
        if(category){this.confirming=false;this.offset=0;this.onAction({type:'category',category});}else this.changeMode(target);
      });
      button.setAttribute('aria-pressed',String(category?(mode==='buy'||mode==='sell')&&(state.category??'items')===category:target===mode));
    }
    this.text(state.title,this.widget(main,'AREA').rect);this.text(String(state.money??0),this.widget(main,'GOLD').rect);
    this.text(state.message??state.details?.description??'',this.widget(main,'INFO').rect,this.frame,'native-service-message');
    const header=this.menus.get(mode==='forge'?'boss_text_02':mode==='synthesize'?'boss_text_03':'boss_text_01');this.image(header.images[0].image);
    if(mode==='buy'||mode==='sell'){
      for(const [index,value]of ['buy','sell'].entries())if(allowed.includes(value))this.control(header,this.widget(header,String(index+1).padStart(2,'0')),labels[value],()=>this.changeMode(value));
    }else{
      const categories=mode==='forge'?['weapon','crystal']:['material','all'];
      for(const [index,category]of categories.entries())this.control(header,this.widget(header,String(index+1).padStart(2,'0')),category==='weapon'?'锻造武器':category==='crystal'?'强化水晶':category==='material'?'合成材料':'配方列表',()=>{
        this.confirming=false;this.offset=0;this.onAction({type:'category',category});
      });
    }
    this.control(header,this.widget(header,'03'),'离开',()=>this.close());
    const listing=this.menus.get(state.category==='equipment'||mode==='forge'||mode==='synthesize'?'boss_buy_02':'boss_buy_01');this.image(listing.images[0].image,o.x,o.y);
    this.offset=Math.max(0,Math.min(this.offset??0,Math.max(0,rows.length-9)));
    if(this.index<this.offset)this.offset=this.index;if(this.index>=this.offset+9)this.offset=this.index-8;
    this.rowButtons=[];
    const slots=listing.widgets.filter(widget=>/^LIST\d+$/i.test(widget.name));
    for(const [index,widget]of slots.entries()){
      const row=rows[this.offset+index];if(!row)continue;
      const button=this.control(listing,widget,`${row.name}，${row.price??0}库伦`,()=>this.select(this.offset+index),o);this.rowButtons.push(button);
      button.classList.toggle('is-selected',row.id===selected?.id);button.setAttribute('aria-disabled',String(row.enabled===false));
      if(row.id===selected?.id&&widget.selected_images.length)this.image(widget.selected_images.at(-1),widget.draw_point_raw.x-widget.rect.left,widget.draw_point_raw.y-widget.rect.top,button);
      const text=document.createElement('span');text.className='native-service-row-text';text.textContent=row.name;
      const amount=document.createElement('span');amount.className='native-service-row-value';amount.textContent=String(row.price??row.quantity??'');button.append(text,amount);
      button.ondblclick=()=>{if(!this.isSuspended()){this.select(this.offset+index);this.openConfirmation();}};
    }
    for(const [name,step]of [['up',-9],['dn',9]])this.control(listing,this.widget(listing,name),step<0?'上一页':'下一页',()=>this.select(Math.max(0,Math.min(rows.length-1,this.index+step))),o);
    const pic=this.widget(listing,'PIC').rect,rect={left:pic.left+o.x+12,top:pic.top+o.y+18,right:pic.right+o.x-12,bottom:pic.bottom+o.y-18};
    const details=state.details??{},lines=[details.name??selected?.name??'',details.owned===undefined?'':`持有 ${details.owned}`,details.description??'',...(details.materials??[]).map(row=>`${row.name} ${row.owned??0}/${row.quantity}`)].filter(Boolean);
    this.text(lines.join('\n'),rect,this.frame,'native-service-details');
    if(this.confirming&&selected)this.paintConfirmation(selected,mode);
  }
  paintConfirmation(row,mode){
    const popup=document.createElement('div');popup.className='native-service-popup';this.frame.append(popup);
    if(mode==='forge'||mode==='synthesize'){
      const menu=this.menus.get('boss_buy_03a');this.image(menu.images[0].image,0,0,popup);
      this.text(this.state.details?.name??row.name,{left:180,top:168,right:460,bottom:194},popup);
      this.control(menu,this.widget(menu,'OK'),'确认合成',()=>this.confirm(),{},popup);
      this.control(menu,this.widget(menu,'CANCEL'),'取消合成',()=>{this.confirming=false;this.paint();},{},popup);
    }else{
      const menu=this.menus.get('boss_buy'),x=205,y=82;this.image(menu.images[0].image,x,y,popup);
      const values={NAME:row.name,C01:this.quantity,C02:this.state.details?.owned??row.quantity??0,G01:row.price,G02:(row.price??0)*this.quantity,G03:this.state.money};
      for(const [name,value]of Object.entries(values)){const r=this.widget(menu,name).rect;this.text(String(value??''),{left:r.left+x,top:r.top+y,right:r.right+x,bottom:r.bottom+y},popup);}
      const controls=document.createElement('div');controls.className='native-service-quantity';popup.append(controls);
      for(const [label,action]of [['−',()=>this.changeQuantity(this.quantity-1)],['＋',()=>this.changeQuantity(this.quantity+1)],['确定',()=>this.confirm()],['取消',()=>{this.confirming=false;this.paint();}]]){
        const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>{if(!this.isSuspended())action();};controls.append(button);
      }
    }
  }
  changeMode(mode){this.confirming=false;this.offset=0;this.onAction({type:'mode',mode});}
  select(index){const row=this.state.rows[index];if(row)this.onAction({type:'select',id:row.id});}
  changeQuantity(quantity){if(quantity>=1)this.onAction({type:'quantity',quantity});}
  openConfirmation(){const row=this.state.rows[this.index];if(this.state.category!=='all'&&row&&row.enabled!==false){this.confirming=true;this.paint();}}
  confirm(){const row=this.state.rows[this.index];if(this.state.category!=='all'&&row?.enabled!==false){this.confirming=false;this.onAction({type:'confirm',id:row.id,quantity:this.quantity});}}
  hide(){this.confirming=false;this.root.hidden=true;}
  close(){this.hide();this.onClose();}
  key(key,repeat=false){
    if(!this.active||this.isSuspended())return false;
    if(key==='Escape'){if(this.confirming){this.confirming=false;this.paint();}else this.close();return true;}
    if(['Enter',' '].includes(key)){if(!repeat){if(this.confirming)this.confirm();else this.openConfirmation();}return true;}
    if(['ArrowUp','ArrowDown','PageUp','PageDown'].includes(key)&&!this.confirming){const step={ArrowUp:-1,ArrowDown:1,PageUp:-9,PageDown:9}[key];this.select(Math.max(0,Math.min(this.state.rows.length-1,this.index+step)));return true;}
    if(['ArrowLeft','ArrowRight'].includes(key)){
      if(this.confirming)this.changeQuantity(this.quantity+(key==='ArrowLeft'?-1:1));
      else{const modes=this.state.allowedModes??[this.state.mode],index=modes.indexOf(this.state.mode);this.changeMode(modes[(index+(key==='ArrowLeft'?-1:1)+modes.length)%modes.length]);}return true;
    }
    return key==='Tab';
  }
  dispose(){this.resize.disconnect();this.root.replaceChildren();this.root.hidden=true;}
}
