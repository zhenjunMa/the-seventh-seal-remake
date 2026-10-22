// Game005_1 / Game005_2: original pixels and four-row keyboard navigation.
// Values are exposed through the audio adapter's normalized 0..1 API; the
// original mixer and menu use integer ticks 0..64, with steps of four.
export class OperationSystemView {
  constructor({manifest, root, navigation, onSetting, onExit}) {
    this.root=root;this.navigation=navigation;this.onSetting=onSetting;
    this.menus=new Map(manifest.menus.map(menu=>[menu.id,menu]));
    this.rows=[];this.bars=[];this.mutes=[];this.cursorButtons=[];
    this.channels=['master','music','effects'];this.state=null;this.index=0;
    const header=this.menus.get('game005_1');
    this.tabs=['SET','EXIT'].map((key,index)=>{
      const widget=header.widgets.find(row=>row.name===key),button=this.button(widget,index?'离开游戏':'游戏设定',navigation,{x:9,y:4});
      button.onclick=()=>index?onExit():this.rows[0].focus({preventScroll:true});
      button.onfocus=()=>{this.navIndex=index;this.navFocus=true;this.paint();};
      return {button,widget};
    });
    const menu=this.menus.get('game005_2'),widget=name=>menu.widgets.find(row=>row.name===name);
    this.focusImage=document.createElement('img');this.focusImage.className='menu-source system-row-focus';this.focusImage.alt='';root.append(this.focusImage);
    for(let index=0;index<4;index++){
      const row=widget(String(index+1).padStart(2,'0')),button=this.button(row,['音量调整','音乐调整','音效调整','战斗光标位置'][index],root);
      button.dataset.systemRow=index;button.onfocus=()=>{this.index=index;this.navFocus=false;this.paint();};
      button.onclick=()=>{if(index<3)this.change('muted',this.channels[index],!this.state.channels[this.channels[index]].muted);};
      this.rows.push(button);
      if(index===3)continue;
      const bar=widget('BAR0'+(index+1)),slider=this.button(bar,['总音量','音乐音量','音效音量'][index],root);
      slider.setAttribute('role','slider');slider.setAttribute('aria-valuemin','0');slider.setAttribute('aria-valuemax','64');slider.dataset.systemRow=index;
      const fill=document.createElement('span'),image=document.createElement('img');fill.className='system-volume-fill';image.src=bar.normal_images[0];image.alt='';fill.append(image);slider.append(fill);
      slider.onfocus=button.onfocus;slider.onclick=event=>{const rect=slider.getBoundingClientRect(),raw=Math.max(0,Math.min(64,Math.round((event.clientX-rect.left)/rect.width*64)));this.change('volume',this.channels[index],raw/64);};
      this.bars.push(slider);
      const mute=widget('CBTN0'+(index+1)),toggle=this.button(mute,['关闭总音量','关闭音乐','关闭音效'][index],root);
      toggle.setAttribute('role','checkbox');toggle.dataset.systemRow=index;toggle.onfocus=button.onfocus;toggle.onclick=button.onclick;
      this.mutes.push({button:toggle,widget:mute});
    }
    for(const [index,key]of ['BTN01','BTN02'].entries()){
      const w=widget(key),button=this.button(w,index?'记忆':'初始',root);button.dataset.systemRow=3;
      button.onclick=()=>this.change('cursor',null,index?'memory':'initial');button.onfocus=()=>{this.index=3;this.navFocus=false;this.paint();};
      this.cursorButtons.push({button,widget:w});
    }
    this.paint();
  }
  button(widget,label,parent,origin={x:0,y:0}) {
    const button=document.createElement('button'),r=widget.rect;button.className='system-source-control';button.setAttribute('aria-label',label);
    Object.assign(button.style,{left:r.left+origin.x+'px',top:r.top+origin.y+'px',width:r.right-r.left+1+'px',height:r.bottom-r.top+1+'px'});parent.append(button);return button;
  }
  overlay({button,widget},active,origin={x:0,y:0}) {
    let image=button.querySelector('.system-control-image');
    if(!image){image=document.createElement('img');image.alt='';image.className='menu-source system-control-image';button.append(image);}
    image.hidden=!active;if(!active)return;image.src=widget.active_images.at(-1);
    image.style.left=widget.draw_point_raw.x+origin.x-parseFloat(button.style.left)+'px';image.style.top=widget.draw_point_raw.y+origin.y-parseFloat(button.style.top)+'px';
  }
  show(visible){this.root.hidden=!visible;this.navigation.hidden=!visible;}
  render(channels,battleCursor){this.state={channels,battleCursor};this.paint();}
  paint(){
    this.tabs.forEach((tab,index)=>this.overlay(tab,this.navFocus&&this.navIndex===index||this.committed&&index===0,{x:9,y:4}));
    if(!this.state)return;
    const menu=this.menus.get('game005_2'),w=menu.widgets.find(row=>row.name===String(this.index+1).padStart(2,'0'));
    this.focusImage.src=w.active_images[0];this.focusImage.style.left=w.draw_point_raw.x+'px';this.focusImage.style.top=w.draw_point_raw.y+'px';this.focusImage.hidden=this.navFocus;
    this.channels.forEach((channel,index)=>{
      const value=this.state.channels[channel],raw=Math.round(value.volume*64),slider=this.bars[index];
      slider.setAttribute('aria-valuenow',String(raw));slider.setAttribute('aria-valuetext',`${raw}/64`);
      slider.querySelector('.system-volume-fill').style.width=Math.floor(raw*216/64)+'px';
      this.mutes[index].button.setAttribute('aria-checked',String(value.muted));this.overlay(this.mutes[index],value.muted);
    });
    this.cursorButtons.forEach((control,index)=>{const active=this.state.battleCursor===(index?'memory':'initial');control.button.setAttribute('aria-pressed',String(active));this.overlay(control,active);});
  }
  change(kind,channel,value){this.onSetting(kind,channel,value);}
  controls(mode){return mode==='sub'?this.tabs.map(tab=>tab.button):this.rows;}
  key(key,repeat){
    if(!this.state)return false;
    if(['ArrowUp','ArrowDown'].includes(key)){this.index=(this.index+(key==='ArrowUp'?-1:1)+4)%4;this.rows[this.index].focus({preventScroll:true});return true;}
    if(['ArrowLeft','ArrowRight'].includes(key)){
      if(this.index===3)this.change('cursor',null,this.state.battleCursor==='initial'?'memory':'initial');
      else {const channel=this.channels[this.index],raw=Math.round(this.state.channels[channel].volume*64);this.change('volume',channel,Math.max(0,Math.min(64,raw+(key==='ArrowLeft'?-4:4)))/64);}
      return true;
    }
    // Native Game005_2 handles confirmation only for the three mute rows.
    // The cursor row changes with left/right or its explicit choice buttons.
    if([' ','Enter'].includes(key)){if(!repeat&&this.index<3)this.rows[this.index].click();return true;}
    return key==='Tab';
  }
}
