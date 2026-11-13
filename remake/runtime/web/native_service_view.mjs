import {setImageSource} from './core/ui/image_dom.mjs';
import {menuText} from './menu_dom.mjs';
import {nativeShopFilters} from './core/items/native_economy.mjs';
// Original Boss MNU pixels and hit rectangles; economic decisions stay in the
// controller. The two buying pages share the native (10,50) listing origin.
const labels={buy:'购买',sell:'卖出',forge:'锻造',synthesize:'合成'};
const regularFont='simsun19_text',compactFont='simsun12_text';
// Keep shop glyphs alongside the DOM artwork so the confirmation panel
// covers the list and its text together.
const textStyle={shadow:'#000000',shadowOffsets:[[1,1]],composite:false};
const place=(node,x,y,w,h)=>Object.assign(node.style,{left:`${x}px`,top:`${y}px`,...(w===undefined?{}:{width:`${w}px`,height:`${h}px`})});
export class NativeServiceView{
  constructor({root,manifest,textRenderer,onAction,onClose,isSuspended=()=>false}){
    if(manifest?.schema!=='seventh-seal-native-services'||manifest.version!==1)throw new Error('城镇服务素材版本无效');
    Object.assign(this,{root,manifest,textRenderer,onAction,onClose,isSuspended});
    this.tradeFocus='category';
    this.menus=new Map(manifest.menus.map(menu=>[menu.id,menu]));
    root.classList.add('native-service-panel');root.hidden=true;
    this.frame=document.createElement('div');this.frame.className='native-service-frame keyboard-navigation';this.frame.tabIndex=-1;
    this.frame.addEventListener('pointermove',()=>this.frame.classList.remove('keyboard-navigation'));
    this.frame.setAttribute('role','dialog');this.frame.setAttribute('aria-label','城镇服务');root.append(this.frame);
    this.resize=new ResizeObserver(()=>this.fit());this.resize.observe(root);
  }
  get active(){return !this.root.hidden;}
  fit(){this.frame.style.transform=`translate(-50%,-50%) scale(${Math.min(this.root.clientWidth/640,this.root.clientHeight/480)})`;}
  widget(menu,name){return menu.widgets.find(widget=>widget.name.toUpperCase()===name.toUpperCase());}
  image(path,x=0,y=0,parent=this.frame){const node=document.createElement('img');node.alt='';setImageSource(node,path);place(node,x,y);parent.append(node);return node;}
  text(value,rect,parent=this.frame,{font=regularFont,foreground='#eee',lineHeight=20,
    align='left',verticalAlign='top'}={}){
    const width=rect.right-rect.left+1,height=rect.bottom-rect.top+1;
    const node=document.createElement('span');node.className='native-service-text';
    Object.assign(node.style,{color:foreground,lineHeight:`${verticalAlign==='center'?height:lineHeight}px`,textAlign:align});
    place(node,rect.left,rect.top,width,height);
    menuText(node,value,this.textRenderer,{font,foreground,lineHeight,align,verticalAlign,
      maxWidth:width,maxLines:Math.max(1,Math.floor(height/lineHeight)),boxHeight:height,...textStyle});
    parent.append(node);
  }
  control(menu,widget,label,action,{x=0,y=0,selected=false}={},parent=this.frame){
    const r=widget.rect,button=document.createElement('button');button.type='button';button.className='native-service-control';button.setAttribute('aria-label',label);
    place(button,x+r.left,y+r.top,r.right-r.left+1,r.bottom-r.top+1);parent.append(button);
    const normal=widget.normal_images.at(-1);
    const highlight=(selected?widget.selected_images.at(-1):null)??widget.active_images.at(-1);
    const {x:drawX,y:drawY}=widget.draw_point_raw;
    if(normal)this.image(normal,drawX-r.left,drawY-r.top,button);
    if(highlight){
      button.classList.add('has-highlight');
      this.image(highlight,drawX-r.left,drawY-r.top,button).className='native-service-highlight';
    }
    button.classList.toggle('is-selected',selected);
    button.onclick=()=>{if(!this.isSuspended())action();};return button;
  }
  show(state){
    this.state=state;this.root.hidden=false;this.fit();this.paint();
  }
  get trading(){return this.state.mode==='buy'||this.state.mode==='sell';}
  tradeCommands(){return ['buy','sell'].filter(mode=>this.state.allowedModes.includes(mode)).concat('exit');}
  focusTrade(target){
    this.tradeFocus=target;
    this.tradeCommand=target==='header'?this.state.mode:null;
    this.paint();
  }
  switchTradeCategory(category){
    this.tradeFocus='header';
    this.tradeCommand=category===this.state.category?this.state.mode:'buy';
    this.changeCategory(category);
  }
  paint(){
    const state=this.state,rows=state.rows??[],mode=state.mode??'buy',allowed=state.allowedModes??[mode];
    this.index=Math.max(0,rows.findIndex(row=>row.id===state.selected));
    const selected=rows[this.index],main=this.menus.get('boss_main'),o=this.manifest.origins.listing;
    this.frame.replaceChildren();this.image(main.images[0].image);
    this.frame.setAttribute('aria-label',`${state.title??'城镇服务'} · ${labels[mode]}`);
    for(const [key,target,category]of [['01','buy','items'],['02','buy','equipment'],['03','forge'],['04','synthesize']]){
      if(!allowed.some(value=>value===target||target==='buy'&&value==='sell'))continue;
      const current=category?this.trading&&(state.category??'items')===category:target===mode;
      const widget=this.widget(main,key),button=this.control(main,widget,category?(category==='items'?'买卖道具':'买卖防具'):labels[target],()=>{
        if(category)this.switchTradeCategory(category);
        else this.changeMode(target);
      },{selected:current});
      button.setAttribute('aria-pressed',String(current));
    }
    const area=this.widget(main,'AREA'),gold=this.widget(main,'GOLD');
    this.text(state.title,{...area.rect,top:area.draw_point_raw.y});
    this.text(state.money??0,{...gold.rect,top:gold.draw_point_raw.y},this.frame,{font:compactFont});
    const header=this.menus.get(mode==='forge'?'boss_text_02':mode==='synthesize'?'boss_text_03':'boss_text_01');this.image(header.images[0].image);
    const command=this.tradeFocus==='category'?null:this.tradeFocus==='header'?this.tradeCommand:mode;
    if(this.trading){
      for(const [index,value]of ['buy','sell'].entries())if(allowed.includes(value)){
        const button=this.control(header,this.widget(header,String(index+1).padStart(2,'0')),labels[value],()=>this.enterTrade(value),{selected:command===value});
        button.setAttribute('aria-pressed',String(command===value));
      }
    }else{
      const categories=mode==='forge'?['weapon','crystal']:['material','all'];
      for(const [index,category]of categories.entries())this.control(header,this.widget(header,String(index+1).padStart(2,'0')),category==='weapon'?'锻造武器':category==='crystal'?'强化水晶':category==='material'?'合成材料':'配方列表',()=>{
        this.confirming=false;this.offset=0;this.onAction({type:'category',category});
      },{selected:category===state.category});
    }
    this.control(header,this.widget(header,'03'),'离开',()=>this.close(),{selected:command==='exit'});
    const listing=this.menus.get(state.category==='equipment'||mode==='forge'||mode==='synthesize'?'boss_buy_02':'boss_buy_01');this.image(listing.images[0].image,o.x,o.y);
    this.offset=Math.max(0,Math.min(this.offset??0,Math.max(0,rows.length-9)));
    if(this.index<this.offset)this.offset=this.index;if(this.index>=this.offset+9)this.offset=this.index-8;
    this.rowButtons=[];
    if(this.trading){
      for(const [index,filter] of nativeShopFilters[state.category??'items'].entries()){
        const current=this.tradeFocus==='list'&&index===(state.filterIndex??0);
        const widget=this.widget(listing,String(index+1).padStart(2,'0'));
        const button=this.control(listing,widget,filter.label,()=>this.changeFilter(index),{...o,selected:current});
        button.setAttribute('aria-pressed',String(current));
        button.title=filter.label;
      }
    }
    const slots=listing.widgets.filter(widget=>/^LIST\d+$/i.test(widget.name));
    for(const [index,widget]of slots.entries()){
      const row=rows[this.offset+index];if(!row)continue;
      const current=row.id===selected?.id&&(!this.trading||this.tradeFocus==='list');
      const button=this.control(listing,widget,`${row.name}，${row.price??0}库伦`,()=>{
        if(this.trading)this.tradeFocus='list';
        if(current)this.openConfirmation();else this.select(this.offset+index);
      },{...o,selected:current});this.rowButtons.push(button);
      button.setAttribute('aria-disabled',String(row.enabled===false));
      const {left,top,right,bottom}=widget.rect,width=right-left+1,height=bottom-top+1;
      this.text(row.name,{left:14,top:0,right:183,bottom:height-1},button,
        {verticalAlign:'center',foreground:row.enabled===false?'#8a8278':'#eee'});
      this.text(row.price??row.quantity,{left:184,top:0,right:width-9,bottom:height-1},button,
        {font:compactFont,lineHeight:12,verticalAlign:'center',foreground:'#e4c485',align:'right'});
    }
    for(const [name,step]of [['up',-9],['dn',9]])this.control(listing,this.widget(listing,name),step<0?'上一页':'下一页',()=>{
      if(rows.length){
        if(this.trading)this.tradeFocus='list';
        this.moveRow(step);
      }
    },o);
    const details=(!this.trading||this.tradeFocus==='list')?state.details??{}:{};
    // The native list renderer draws the selected ITM card at the PIC origin.
    const pic=this.widget(listing,'PIC').rect;
    if(details.card){
      const card=this.image(details.card.image,o.x+pic.left,o.y+pic.top);
      card.className='native-service-card';
      place(card,o.x+pic.left,o.y+pic.top,details.card.width,details.card.height);
    }
    // Boss_Main widget 40007 receives the selected item's description.
    const info=this.widget(main,'INFO');
    const infoRect={...info.rect,top:info.draw_point_raw.y,bottom:479};
    const crafting=mode==='forge'||mode==='synthesize';
    const materials=crafting?(details.materials??[]).map(row=>`${row.name} ${row.owned??0}/${row.quantity}`).join('　'):'';
    const infoText=state.clearInfo?'':state.message||[details.description,materials].filter(Boolean).join('\n');
    this.text(infoText,infoRect,this.frame,crafting?{font:compactFont,lineHeight:13}:{font:'requested_black20_text'});
    if(this.confirming&&selected)this.paintConfirmation(selected,mode);
  }
  paintConfirmation(row,mode){
    const popup=document.createElement('div');popup.className='native-service-popup';this.frame.append(popup);
    if(mode==='forge'||mode==='synthesize'){
      const menu=this.menus.get('boss_buy_03a');this.image(menu.images[0].image,0,0,popup);
      this.text(this.state.details?.name??row.name,{left:180,top:152,right:460,bottom:173},popup,
        {align:'center',verticalAlign:'center'});
      this.control(menu,this.widget(menu,'OK'),'确认合成',()=>this.confirm(),{},popup);
      this.control(menu,this.widget(menu,'CANCEL'),'取消合成',()=>{this.confirming=false;this.paint();},{},popup);
    }else{
      const menu=this.menus.get('boss_buy'),x=205,y=82;this.image(menu.images[0].image,x,y,popup);
      const owned=mode==='sell'?row.quantity:this.state.details?.owned??row.quantity;
      const values={NAME:row.name,C01:this.quantity,C02:owned??0,G01:row.price,G02:(row.price??0)*this.quantity,G03:this.state.money};
      for(const [name,value]of Object.entries(values)){
        const r=this.widget(menu,name).rect;
        this.text(value,{left:r.left+x,top:r.top+y,right:r.right+x,bottom:r.bottom+y},popup,
          {font:compactFont,lineHeight:18});
      }
      const controls=document.createElement('div');controls.className='native-service-quantity';popup.append(controls);
      for(const [label,action]of [['−',()=>this.changeQuantity(this.quantity-1)],['＋',()=>this.changeQuantity(this.quantity+1)],['确定',()=>this.confirm()],['取消',()=>{this.confirming=false;this.paint();}]]){
        const button=document.createElement('button');button.type='button';button.setAttribute('aria-label',label);
        if(label==='−')button.disabled=this.quantity===this.minimumQuantity;
        if(label==='＋')button.disabled=this.quantity===this.maximumQuantity(row);
        menuText(button,label,this.textRenderer,{font:compactFont,foreground:'#eed4a5',...textStyle},'native-menu-number');
        button.onclick=()=>{if(!this.isSuspended())action();};controls.append(button);
      }
    }
  }
  changeMode(mode){this.confirming=false;this.offset=0;this.onAction({type:'mode',mode});}
  enterTrade(mode){
    if(mode===this.state.mode){
      if(this.state.clearInfo&&this.state.rows[this.index]){
        this.tradeFocus='list';
        this.select(this.index);
      }else this.focusTrade('list');
    }
    else{this.tradeFocus='list';this.changeMode(mode);}
  }
  changeCategory(category){this.confirming=false;this.offset=0;this.onAction({type:'category',category});}
  changeFilter(index){this.tradeFocus='list';this.offset=0;this.onAction({type:'filter',index});}
  select(index){const row=this.state.rows[index];if(row)this.onAction({type:'select',id:row.id});}
  moveRow(step){this.select(Math.max(0,Math.min(this.state.rows.length-1,this.index+step)));}
  get minimumQuantity(){return this.state.mode==='sell'?0:1;}
  maximumQuantity(row){
    // The native quantity control checks the limit before increasing.
    if(this.state.mode==='sell')return row.quantity;
    const affordable=row.price>0?Math.floor(this.state.money/row.price):99;
    return Math.min(affordable,99-(row.quantity??0));
  }
  changeQuantity(quantity){
    const row=this.state.rows[this.index];
    if(!this.trading||!row||quantity<this.minimumQuantity||quantity>this.maximumQuantity(row))return;
    this.quantity=quantity;
    this.paint();
  }
  openConfirmation(){
    const row=this.state.rows[this.index];
    if(this.state.category==='all'||!row||row.enabled===false)return;
    this.quantity=this.minimumQuantity;
    this.confirming=true;
    this.paint();
  }
  confirm(){
    const row=this.state.rows[this.index];
    if(this.state.category==='all'||!row||row.enabled===false)return;
    this.confirming=false;
    if(this.quantity===0)this.paint();
    else this.onAction({type:'confirm',id:row.id,quantity:this.quantity});
  }
  hide(){this.confirming=false;this.root.hidden=true;}
  close(){this.hide();this.onClose();}
  tradeKey(key,repeat){
    this.frame?.classList.add('keyboard-navigation');
    const confirm=key==='Enter'||key===' ';
    const horizontal=key==='ArrowLeft'||key==='ArrowRight';
    const vertical=key==='ArrowUp'||key==='ArrowDown';
    const step=key==='ArrowLeft'||key==='ArrowUp'?-1:1;
    if(this.tradeFocus==='category'){
      if(confirm&&!repeat)this.focusTrade('header');
      if(vertical){
        const category=this.state.category==='equipment'?'items':'equipment';
        this.changeCategory(category);
      }
      if(key==='Escape'&&!repeat)this.close();
    }else if(this.tradeFocus==='header'){
      if(horizontal){
        const commands=this.tradeCommands(),index=commands.indexOf(this.tradeCommand);
        this.tradeCommand=commands[(index+step+commands.length)%commands.length];
        this.paint();
      }
      if(confirm&&!repeat){
        if(this.tradeCommand==='exit')this.close();
        else this.enterTrade(this.tradeCommand);
      }
      if(key==='Escape'&&!repeat)this.focusTrade('category');
    }else{
      if(horizontal){
        const count=nativeShopFilters[this.state.category??'items'].length,index=this.state.filterIndex??0;
        this.changeFilter((index+step+count)%count);
      }
      if(vertical)this.moveRow(step);
      if(key==='PageUp'||key==='PageDown')this.moveRow(key==='PageUp'?-9:9);
      if(confirm&&!repeat)this.openConfirmation();
      if(key==='Escape'&&!repeat)this.focusTrade('header');
    }
    return true;
  }
  key(key,repeat=false){
    if(!this.active||this.isSuspended())return false;
    if(this.trading&&!this.confirming&&['Escape','Enter',' ','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','PageUp','PageDown','Tab'].includes(key))return this.tradeKey(key,repeat);
    if(key==='Escape'){if(this.confirming){this.confirming=false;this.paint();}else this.close();return true;}
    if(['Enter',' '].includes(key)){if(!repeat){if(this.confirming)this.confirm();else this.openConfirmation();}return true;}
    if(['ArrowUp','ArrowDown','PageUp','PageDown'].includes(key)&&!this.confirming){const step={ArrowUp:-1,ArrowDown:1,PageUp:-9,PageDown:9}[key];this.moveRow(step);return true;}
    if(['ArrowLeft','ArrowRight'].includes(key)){
      if(this.confirming)this.changeQuantity(this.quantity+(key==='ArrowLeft'?-1:1));
      else{const modes=this.state.allowedModes??[this.state.mode],index=modes.indexOf(this.state.mode);this.changeMode(modes[(index+(key==='ArrowLeft'?-1:1)+modes.length)%modes.length]);}return true;
    }
    return key==='Tab';
  }
  dispose(){this.resize.disconnect();this.root.replaceChildren();this.root.hidden=true;}
}
