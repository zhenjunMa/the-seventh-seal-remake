import {setImageSource} from './core/ui/image_dom.mjs';
import {menuText} from './menu_dom.mjs';
import {nativeShopFilters} from './core/items/native_economy.mjs';
// Original Boss MNU pixels and hit rectangles; economic decisions stay in the
// controller. The two buying pages share the native (10,50) listing origin.
const labels={buy:'购买',sell:'卖出',forge:'锻造',synthesize:'合成'};
const sidebarOptions=[
  {widget:'01',label:'买卖道具',category:'items',modes:['buy','sell']},
  {widget:'02',label:'买卖防具',category:'equipment',modes:['buy','sell']},
  {widget:'03',label:'武器锻造',modes:['forge']},
  {widget:'04',label:'物件合成',modes:['synthesize']},
];
const regularFont='simsun19_text',compactFont='simsun12_text';
// Keep shop glyphs alongside the DOM artwork so the confirmation panel
// covers the list and its text together.
const textStyle={shadowOffsets:[[1,1]],composite:false};
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
  text(value,rect,parent=this.frame,{font=regularFont,foreground='#eee',shadow='#000000',lineHeight=20,
    align='left',verticalAlign='top'}={}){
    const width=rect.right-rect.left+1,height=rect.bottom-rect.top+1;
    const node=document.createElement('span');node.className='native-service-text';
    Object.assign(node.style,{color:foreground,lineHeight:`${verticalAlign==='center'?height:lineHeight}px`,textAlign:align});
    place(node,rect.left,rect.top,width,height);
    menuText(node,value,this.textRenderer,{font,foreground,lineHeight,align,verticalAlign,
      maxWidth:width,maxLines:Math.max(1,Math.floor(height/lineHeight)),boxHeight:height,...textStyle,shadow});
    parent.append(node);
  }
  control(menu,widget,label,action,{x=0,y=0,selected=false,disabled=false}={},parent=this.frame){
    const r=widget.rect,button=document.createElement('button');button.type='button';button.className='native-service-control';button.setAttribute('aria-label',label);
    button.disabled=disabled;
    place(button,x+r.left,y+r.top,r.right-r.left+1,r.bottom-r.top+1);parent.append(button);
    const normal=widget.normal_images.at(-1);
    const highlight=disabled?null:((selected?widget.selected_images.at(-1):null)??widget.active_images.at(-1));
    const {x:drawX,y:drawY}=widget.draw_point_raw;
    if(normal)this.image(normal,drawX-r.left,drawY-r.top,button);
    if(highlight){
      button.classList.add('has-highlight');
      this.image(highlight,drawX-r.left,drawY-r.top,button).className='native-service-highlight';
    }
    button.classList.toggle('is-selected',selected);
    if(!disabled)button.onclick=()=>{if(!this.isSuspended())action();};
    return button;
  }
  show(state){
    this.state=state;this.root.hidden=false;this.fit();this.paint();
  }
  get trading(){return this.state.mode==='buy'||this.state.mode==='sell';}
  get allowedModes(){return this.state.allowedModes??[this.state.mode];}
  currentSidebarOption(option){
    return option.modes.includes(this.state.mode)&&(!option.category||option.category===(this.state.category??'items'));
  }
  enabledSidebarOptions(){return sidebarOptions.filter(option=>option.modes.some(mode=>this.allowedModes.includes(mode)));}
  tradeCommands(){return ['buy','sell'].filter(mode=>this.allowedModes.includes(mode)).concat('exit');}
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
  sidebarKey(key,repeat){
    if((key==='Enter'||key===' ')&&!repeat)this.focusTrade(this.trading?'header':'list');
    if(key==='ArrowUp'||key==='ArrowDown'){
      const enabled=this.enabledSidebarOptions();
      const current=enabled.findIndex(option=>this.currentSidebarOption(option)),step=key==='ArrowUp'?-1:1;
      const next=enabled[(current+step+enabled.length)%enabled.length];
      if(next&&next!==enabled[current]){
        if(next.category)this.changeCategory(next.category);
        else this.changeMode(next.modes[0]);
      }
    }
    if(key==='Escape'&&!repeat)this.close();
    return true;
  }
  paint(){
    const state=this.state,rows=state.rows??[],mode=state.mode??'buy',allowed=this.allowedModes;
    this.index=Math.max(0,rows.findIndex(row=>row.id===state.selected));
    const selected=rows[this.index],main=this.menus.get('boss_main'),o=this.manifest.origins.listing;
    this.frame.replaceChildren();this.image(main.images[0].image);
    this.frame.setAttribute('aria-label',`${state.title??'城镇服务'} · ${labels[mode]}`);
    const enabledOptions=this.enabledSidebarOptions();
    for(const option of sidebarOptions){
      const enabled=enabledOptions.includes(option);
      const current=enabled&&this.currentSidebarOption(option);
      const button=this.control(main,this.widget(main,option.widget),option.label,()=>{
        if(option.category)this.switchTradeCategory(option.category);
        else{this.tradeFocus='list';this.changeMode(option.modes[0]);}
      },{selected:current,disabled:!enabled});
      button.setAttribute('aria-pressed',String(current));
    }
    const area=this.widget(main,'AREA'),gold=this.widget(main,'GOLD');
    this.text(state.title,{...area.rect,top:area.draw_point_raw.y,right:639},this.frame,
      {font:'requested_black20_text',foreground:'#ffffff',shadow:'#444444'});
    this.text(String(state.money??0).padStart(8,'0'),{...gold.rect,top:gold.draw_point_raw.y,right:639},this.frame,
      {font:'simsun20',foreground:'#ffff24',shadow:'#313100'});
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
    const selling=mode==='sell';
    for(const [index,widget]of slots.entries()){
      const row=rows[this.offset+index];if(!row)continue;
      const current=row.id===selected?.id&&(!this.trading||this.tradeFocus==='list');
      // Both native sell lists use "%sx%d" for stacks larger than one.
      const name=selling&&row.quantity>1?`${row.name}x${row.quantity}`:row.name;
      const button=this.control(listing,widget,`${name}，${row.price??0}库伦`,()=>{
        if(this.trading)this.tradeFocus='list';
        if(current)this.openConfirmation();else this.select(this.offset+index);
      },{...o,selected:current});this.rowButtons.push(button);
      button.setAttribute('aria-disabled',String(row.enabled===false));
      const {left,top,right,bottom}=widget.rect,width=right-left+1,height=bottom-top+1;
      if(selling){
        const foreground=current?'#44ffff':'#ffffff',shadow=current?'#4f4f4f':'#4f4f00';
        const font=this.textRenderer?.supports(name,'simsun22_text')&&
          this.textRenderer.measure(name,'simsun22_text')>187?'simsun20_text':'simsun22_text';
        this.text(name,{left:3,top:1,right:189,bottom:height-1},button,
          {font,lineHeight:22,foreground,shadow});
        this.text(row.price,{left:190,top:4,right:width-9,bottom:height-1},button,
          {font:'simsun18',lineHeight:18,foreground,shadow});
      }else{
        this.text(name,{left:14,top:0,right:183,bottom:height-1},button,
          {verticalAlign:'center',foreground:row.enabled===false?'#8a8278':'#eee'});
        this.text(row.price??row.quantity,{left:184,top:0,right:width-9,bottom:height-1},button,
          {font:compactFont,lineHeight:12,verticalAlign:'center',foreground:'#e4c485',align:'right'});
      }
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
      const menu=this.menus.get('boss_buy');
      const x=Math.floor((640-menu.width)/2),y=Math.floor((480-menu.height)/2);
      popup.classList.add('native-service-trade-popup');
      popup.setAttribute('role','dialog');
      popup.setAttribute('aria-label',labels[mode]);
      this.image(menu.images[0].image,x,y,popup);
      const cursor=this.widget(menu,'CURSOR');
      this.image(cursor.normal_images[2],x+cursor.draw_point_raw.x,y+cursor.draw_point_raw.y,popup);
      const selling=mode==='sell',owned=row.quantity??0;
      const total=row.price*this.quantity;
      // 0x434420 fills the same six MNU fields in both transaction modes.
      const values={NAME:row.name,C01:selling?owned-this.quantity:owned,C02:selling?this.quantity:owned+this.quantity,
        G01:row.price,G02:total,G03:(this.state.money+(selling?total:-total))>>>0};
      for(const [name,value]of Object.entries(values)){
        const widget=this.widget(menu,name),r=widget.rect;
        const isName=name==='NAME';
        const drawRight=isName?menu.width-widget.draw_point_raw.x-1:r.right;
        this.text(value,{left:x+widget.draw_point_raw.x,top:y+widget.draw_point_raw.y,right:x+drawRight,bottom:y+widget.draw_point_raw.y+19},popup,
          {font:isName?'requested_black20_text':'simsun20',foreground:'#ffffff',
            shadow:isName?'#404040':'#4d4d4d',align:name.startsWith('G')?'right':'left'});
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
    if(this.tradeFocus==='header'){
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
    const mixedService=this.allowedModes.includes('buy')&&this.allowedModes.some(mode=>mode==='forge'||mode==='synthesize');
    if(!this.confirming&&['Escape','Enter',' ','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','PageUp','PageDown','Tab'].includes(key)){
      if(this.tradeFocus==='category'&&(this.trading||mixedService)){
        this.frame?.classList.add('keyboard-navigation');
        return this.sidebarKey(key,repeat);
      }
      if(this.trading)return this.tradeKey(key,repeat);
    }
    if(key==='Escape'){
      if(this.confirming){this.confirming=false;this.paint();}
      else if(mixedService)this.focusTrade('category');
      else this.close();
      return true;
    }
    if(['Enter',' '].includes(key)){if(!repeat){if(this.confirming)this.confirm();else this.openConfirmation();}return true;}
    if(['ArrowUp','ArrowDown','PageUp','PageDown'].includes(key)&&!this.confirming){const step={ArrowUp:-1,ArrowDown:1,PageUp:-9,PageDown:9}[key];this.moveRow(step);return true;}
    if(this.confirming&&this.trading&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key)){
      const step=key==='ArrowLeft'||key==='ArrowUp'?-1:1;
      this.changeQuantity(this.quantity+step);
      return true;
    }
    if(['ArrowLeft','ArrowRight'].includes(key)){
      if(!this.confirming&&!mixedService){
        const modes=this.allowedModes,index=modes.indexOf(this.state.mode);
        this.changeMode(modes[(index+(key==='ArrowLeft'?-1:1)+modes.length)%modes.length]);
      }
      return true;
    }
    return key==='Tab';
  }
  dispose(){this.resize.disconnect();this.root.replaceChildren();this.root.hidden=true;}
}
