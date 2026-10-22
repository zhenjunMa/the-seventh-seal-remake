import {StartupSequence} from './core/startup.mjs';
import {SAVE_PREVIEW_WIDTH,SAVE_PREVIEW_HEIGHT} from './core/save_preview.mjs';

const labels=['游戏读取','开始游戏','特典','离开'];
const buttonIds=['menuLoad','menuNew','menuExtras','menuExit'];

// The view owns media, menu focus and transient animation. World replacement
// remains in the session controller and only happens after an explicit confirm.
export class StartupView {
  static async create(options) {
    const view=new StartupView(options);
    const assets=options.manifest.assets;
    view.backgroundIndex=Math.floor(Math.random()*assets.menuback.frames.length);
    const frames=Object.entries(assets).flatMap(([key,asset])=>key==='menuback'?[asset.frames[view.backgroundIndex]]:asset.frames);
    await Promise.all(frames.map(async frame=>view.images.set(frame.path,await options.image(frame.path))));
    return view;
  }
  constructor({manifest,media,$,image,audio,onNew,onLoad,onResume,onStage,getSave,getSaves,refreshSaves,isBusy=()=>false,getPreview,status,log}) {
    Object.assign(this,{manifest,media,$,image,audio,onNew,onLoad,onResume,onStage,refreshSaves,isBusy,getPreview,status,log});
    this.readSaves=getSaves??(()=>{const envelope=getSave?.();return envelope?[{slot:'manual',label:'普通存档',envelope}]:[];});
    this.root=$('startMenu');this.canvas=$('startupCanvas');this.ctx=this.canvas.getContext('2d');
    this.video=$('startupVideo');this.images=new Map();this.allowResume=false;this.pending=false;this.previewRequest=0;this.previewCache=null;this.previewImage=null;
    this.sequence=new StartupSequence(snapshot=>this.changeStage(snapshot));
    this.root.addEventListener('pointerdown',event=>{
      if(this.sequence.stage==='menu')return;
      this.syncVideoAudio(true);if(this.sequence.pointer(event.button)){event.preventDefault();event.stopPropagation();}
    });
    this.root.addEventListener('contextmenu',event=>event.preventDefault());
    buttonIds.forEach((id,index)=>{
      $(id).onclick=event=>{event.preventDefault();if(this.sequence.stage!=='menu'||this.pending||this.isBusy()||this.rotation)return;
        if(this.selected!==index)this.select(index);else this.confirm();};
    });
    $('menuResume').onclick=()=>{if(this.allowResume)this.onResume();};
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(this.root);
  }
  asset(key,index=0,x=0,y=0) {
    const frame=this.manifest.assets[key]?.frames[index];if(!frame)return;
    const image=this.images.get(frame.path);if(image)this.ctx.drawImage(image,x,y);
  }
  announce(text){this.$('startupAnnouncement').textContent=text;}
  resize(){const rect=this.root.getBoundingClientRect();this.root.style.setProperty('--startup-scale',String(Math.min(rect.width/640,rect.height/480)));}
  start(){this.allowResume=false;this.sequence.start();}
  showMenu({allowResume=false}={}){this.allowResume=allowResume;this.sequence.enter('menu');}
  hide(){this.sequence.close();}
  stopMedia(){this.video.onended=null;this.video.onerror=null;this.video.pause();this.video.removeAttribute('src');this.video.load();}
  changeStage({stage,epoch}) {
    this.previewRequest++;this.previewImage=null;
    this.stopMedia();this.pending=false;this.rotation=null;this.root.hidden=stage==='closed';
    this.root.dataset.stage=stage;
    if(stage==='closed')return;
    this.onStage(stage);
    this.resize();this.root.focus({preventScroll:true});
    const isMenu=stage==='menu';this.video.hidden=isMenu;this.canvas.hidden=!isMenu;
    this.$('startupButtons').hidden=!isMenu;this.$('startupOptions').hidden=true;
    this.$('menuResume').hidden=!isMenu||!this.allowResume;
    if(isMenu){
      this.selected=0;this.frame=0;this.plaqueIndex=0;this.submenu=null;this.subIndex=0;this.listTop=0;
      this.panelX=-432;this.panelType=null;this.helpX=-432;this.plaqueX=[640,690];this.lastTick=performance.now();
      this.rotation={from:0,to:1,started:performance.now(),direction:1};
      this.audio.setMusic(this.manifest.audio.music);
      this.announce(labels[0]);this.draw();this.renderOptions();this.updateButtons();
      this.log({type:'startup-main-menu',background:this.backgroundIndex,allow_resume:this.allowResume});
      return;
    }
    this.audio.suspend();
    const clip=this.media.media[stage];this.video.loop=stage==='openpress';this.video.src=clip.url;
    this.syncVideoAudio();
    this.video.onended=()=>this.sequence.complete(epoch);
    this.video.onerror=()=>{if(this.sequence.epoch!==epoch)return;this.log({type:'startup-media-error',stage,error:this.video.error?.message});this.sequence.fail(epoch);};
    this.announce(stage==='gametitle'?'片头电影，Esc跳过':stage==='preopenpress'?'启动提示过渡':'按任意键进入主菜单');
    this.log({type:'startup-media-enter',stage,source:clip.source,url:clip.url,loop:this.video.loop});
    const playback=this.video.play();
    playback?.catch(error=>{
      if(this.sequence.epoch!==epoch)return;
      if(error.name==='NotAllowedError'){
        // A browser can block sound before a trusted gesture. Keep the source
        // film running silently, then enable its sound on the first gesture.
        this.video.muted=true;
        this.video.play().catch(failure=>{if(this.sequence.epoch===epoch){this.status('点击启动画面以播放片头。');this.log({type:'startup-play-blocked',error:failure.message});}});
      }else if(error.name!=='AbortError')this.sequence.fail(epoch);
    });
  }
  syncVideoAudio(retry=false){
    const settings=this.audio.snapshot(),channels=settings.channels;
    this.video.muted=!settings.unlocked||channels.master.muted||channels.music.muted;
    this.video.volume=Math.max(1,Math.min(127,Math.floor(2*Math.round(channels.master.volume*64)*Math.round(channels.music.volume*64)/64)))/127;
    if(retry&&this.video.paused&&['gametitle','preopenpress','openpress'].includes(this.sequence.stage))this.video.play().catch(()=>{});
  }
  cue(name){const id=this.manifest.audio.cues[name];if(id)this.audio.playClip(id);}
  select(index){
    if(this.submenu||this.rotation||index===this.selected)return;
    this.cue('rotate');this.rotation={from:this.frame,to:1+index*9,started:performance.now(),direction:(index-this.selected+4)%4<=2?1:-1};
    this.selected=index;this.plaqueIndex=0;this.helpX=-432;this.plaqueX=[640,690];this.lastTick=performance.now();
    this.announce(labels[index]);this.renderOptions();this.updateButtons();
  }
  key(key,repeat=false){
    if(this.sequence.stage==='closed')return false;
    this.syncVideoAudio(true);
    if(this.sequence.stage!=='menu')return this.sequence.key(key,repeat);
    if(repeat||this.pending||this.isBusy()||this.rotation)return true;
    if(key==='Escape'){if(this.submenu){this.previewRequest++;this.cue('cancel');this.submenu=null;this.draw();this.renderOptions();this.updateButtons();}return true;}
    if(this.submenu){
      if(['ArrowUp','ArrowDown'].includes(key)){const count=this.optionCount();if(count>1){const next=Math.max(0,Math.min(count-1,this.subIndex+(key==='ArrowUp'?-1:1)));if(next!==this.subIndex){if(this.submenu==='read'){this.previewRequest++;this.previewImage=null;}this.subIndex=next;this.listTop=this.galleryTop(next);this.cue('move');this.draw();this.renderOptions();}}}
      else if([' ','Enter'].includes(key))this.confirm();
      return true;
    }
    if(key==='ArrowLeft')this.select((this.selected+1)%4);
    else if(key==='ArrowRight')this.select((this.selected+3)%4);
    else if(['ArrowUp','ArrowDown'].includes(key)){
      const next=Math.max(0,Math.min(this.plaqueCount()-1,this.plaqueIndex+(key==='ArrowUp'?-1:1)));
      if(next!==this.plaqueIndex){this.plaqueIndex=next;this.helpX=-432;this.cue('move');this.draw();this.renderOptions();}
    }
    else if([' ','Enter'].includes(key))this.confirm();
    else if(key==='Tab')this.select((this.selected+1)%4);
    return true;
  }
  tick(now){
    if(this.sequence.stage!=='menu')return;
    let changed=false;
    if(this.rotation){
      const motion=this.rotation,steps=Math.floor((now-motion.started)/(this.manifest.timing?.button_frame_ms??30));
      const distance=(motion.to-motion.from+36)%36,required=motion.direction===1?distance:(36-distance)%36;
      this.frame=(motion.from+motion.direction*Math.min(steps,required)+36)%36;
      if(steps>=required){this.frame=motion.to;this.rotation=null;this.cue('submenu');}
      changed=true;
    }
    const ticks=Math.max(0,Math.min(60,Math.floor((now-this.lastTick)/10)));this.lastTick+=ticks*10;
    for(let n=0;n<ticks;n++){
      this.plaqueX=this.plaqueX.map(x=>{if(x<=450)return 450;changed=true;return Math.max(450,x-(x>=481?10:x>=461?5:1));});
      if(this.helpX<0){changed=true;const x=this.helpX;this.helpX=Math.min(0,x+(x<-100?32:x<-50?24:x<-20?16:8));}
      const target=this.submenu?0:-432;
      if(this.panelX!==target){changed=true;const step=this.panelX<-100?32:16;this.panelX=target===0?Math.min(0,this.panelX+step):Math.max(-432,this.panelX-step);}
    }
    if(changed){this.draw();this.updateButtons();this.updateOptionPositions();}
  }
  updateButtons(){
    // Native MenuBtn is a single rotating image. Transparent semantic targets
    // follow the four visible plaques, while the canvas retains source pixels.
    const spots=[{x:440,y:380,w:95,h:85},{x:540,y:367,w:80,h:75},{x:525,y:333,w:65,h:35},{x:465,y:340,w:62,h:35}];
    buttonIds.forEach((id,index)=>{const button=this.$(id),spot=spots[(index-this.selected+4)%4];
      Object.assign(button.style,{left:spot.x+'px',top:spot.y+'px',width:spot.w+'px',height:spot.h+'px'});
      button.tabIndex=-1;button.disabled=this.pending||this.isBusy()||Boolean(this.rotation)||Boolean(this.submenu);
      button.setAttribute('aria-pressed',String(index===this.selected));
    });
  }
  draw(){
    const c=this.ctx;c.clearRect(0,0,640,480);c.fillStyle='#000';c.fillRect(0,0,640,480);
    this.asset('menuback',this.backgroundIndex);
    this.asset('menubtn',this.frame,420,320);
    for(let i=0;i<this.plaqueCount();i++)this.asset('menusub'+this.selected+(i===this.plaqueIndex?'':'2'),i,this.plaqueX?.[i]??450,100+50*i);
    this.asset('menuhlp'+this.selected+this.plaqueIndex,0,this.helpX??0,400);
    if(this.panelType==='read'&&this.panelX>-432){
      this.asset('menulbk',0,this.panelX-8,60);
      this.saveEntries().forEach((_entry,index)=>this.asset('menulbx',0,this.panelX,81+108*index));
      if(this.previewImage)c.drawImage(this.previewImage,this.panelX+17,97+108*this.subIndex,SAVE_PREVIEW_WIDTH,SAVE_PREVIEW_HEIGHT);
    }
    if(this.panelType==='extras'&&this.panelX>-432){
      this.asset('specialback',0,this.panelX-8,70);
      this.asset('menuspecial30',this.subIndex<18?0:1,this.panelX+16,60);
      for(let i=0;i<7;i++){const index=this.listTop+i;if(index>=this.optionCount())break;this.asset(index===this.subIndex?'menuspecial00':'menuspecial01',index,this.panelX+3,117+39*i);}
    }
    this.root.dataset.selection=['read','start','special','exit'][this.selected];
    this.root.dataset.submenu=this.submenu??'';this.root.dataset.frame=String(this.frame);
  }
  plaqueCount(){return this.selected===3&&this.allowResume?2:1;}
  galleryTop(index){return index<18?Math.max(0,Math.min(11,index-3)):Math.max(18,Math.min(23,index-3));}
  saveEntries(){return this.readSaves();}
  getSave(){return this.saveEntries()[this.subIndex]?.envelope??null;}
  optionCount(){return this.submenu==='read'?this.saveEntries().length:this.submenu==='extras'?(this.manifest.audio.gallery?.length??0):0;}
  previewKey(save){return `${save?.sha256??''}:${save?.payload??''}:${save?.saved_at??''}:${save?.preview?.png??''}`;}
  requestPreview(save){
    if(!this.getPreview)return;
    const key=this.previewKey(save),request=++this.previewRequest,epoch=this.sequence.epoch;
    if(this.previewCache?.key===key){this.previewImage=this.previewCache.image;this.root.dataset.preview=this.previewCache.source;this.draw();return;}
    this.previewImage=null;this.root.dataset.preview='loading';
    Promise.resolve().then(()=>this.getPreview(save)).then(result=>{
      if(request!==this.previewRequest||epoch!==this.sequence.epoch||this.sequence.stage!=='menu'||this.submenu!=='read'||this.previewKey(this.getSave())!==key)return;
      if(!result?.image)throw new Error('存档截图未生成');
      this.previewImage=result.image;this.previewCache={key,...result};this.root.dataset.preview=result.source;
      this.log({type:'save-preview-ready',source:result.source,map_id:result.map_id,payload_sha256:save.sha256});this.draw();
    }).catch(error=>{
      if(request!==this.previewRequest||epoch!==this.sequence.epoch||this.submenu!=='read')return;
      this.root.dataset.preview='failed';this.log({type:'save-preview-failed',error:error.message});
    });
  }
  renderOptions(){
    const holder=this.$('startupOptions');holder.replaceChildren();holder.hidden=false;
    const add=(text,x,y,w,h,index,handler)=>{const button=document.createElement('button');button.textContent=text;button.type='button';button.tabIndex=-1;
      button.setAttribute('aria-current',String(index===this.subIndex));Object.assign(button.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});
      button.onclick=()=>{if(this.submenu==='read'&&this.subIndex!==index){this.previewRequest++;this.previewImage=null;}this.subIndex=index;handler();};holder.append(button);return button;};
    const captions=this.selected===3?['离开','回到游戏']:[labels[this.selected]];
    for(let i=0;i<this.plaqueCount();i++){
      const button=add('',450,100+50*i,184,51,i,()=>{if(!this.submenu){this.plaqueIndex=i;this.confirm();}});
      button.setAttribute('aria-label','确认'+captions[i]);button.className='startup-plaque';button.dataset.row=String(i);
    }
    if(this.submenu==='read'){
      const entries=this.saveEntries(),selected=this.getSave();
      if(selected)this.requestPreview(selected);
      for(const [index,entry] of entries.entries()){const save=entry.envelope;let world={};try{world=JSON.parse(save.payload);}catch{}
        const date=save.saved_at?new Date(save.saved_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'';
        const party=(world.party??[]).map(actor=>actor.name).join('　');
        add(`${entry.label}　${party}\n${date}\n${world.location?.map_id??''}`,147,99+108*index,265,78,index,()=>{this.draw();this.renderOptions();this.confirm();}).className='startup-save panel-row';
      }
      if(!entries.length)this.announce('尚无重制存档，Esc返回');
    }else if(this.submenu==='extras'){
      for(let i=0;i<7;i++){const index=this.listTop+i;if(index>=this.optionCount())break;
        const button=add('',3,117+39*i,419,35,index,()=>{this.subIndex=index;this.draw();this.renderOptions();this.confirm();});
        button.className='startup-gallery panel-row';button.setAttribute('aria-label','播放音乐 '+(index+1));
      }
    }
    this.updateOptionPositions();
  }
  updateOptionPositions(){
    for(const node of this.$('startupOptions').children??[]){
      const plaque=node.classList.contains('startup-plaque');
      node.style.transform=`translateX(${plaque?(this.plaqueX[Number(node.dataset.row)]??450)-450:this.panelX}px)`;
      node.disabled=this.pending||this.isBusy()||Boolean(this.rotation)||(plaque?Boolean(this.submenu):this.panelX!==0);
    }
  }
  async confirm(){
    if(this.pending||this.isBusy()||this.rotation||this.sequence.stage!=='menu')return;
    if(!this.submenu){
      if(this.selected===1){this.cue('confirm');await this.run(this.onNew);return;}
      if(this.selected===3){
        if(this.plaqueIndex===1&&this.allowResume){this.cue('confirm');this.onResume();}
        else this.status('可关闭此浏览器标签页。Esc可继续留在主菜单。');
        return;
      }
      this.submenu=['read',null,'extras'][this.selected];this.subIndex=0;this.listTop=0;this.panelType=this.submenu;this.cue('open');
      let refreshErrors;
      if(this.submenu==='read'&&this.refreshSaves){await this.run(async()=>{refreshErrors=await this.refreshSaves();});if(this.sequence.stage!=='menu'||this.submenu!=='read')return;}
      this.draw();this.renderOptions();this.updateButtons();
      if(this.submenu==='extras')this.status('上下选择音乐，空格／Enter播放，Esc返回主菜单。');
      if(this.submenu==='read'&&!this.getSave()&&!refreshErrors?.length)this.status('尚无重制存档；可从侧栏导入重制存档，Esc返回。');
      return;
    }
    if(this.submenu==='read'){
      if(this.panelX!==0)return;
      const save=this.getSave();if(!save){this.cue('cancel');return;}
      this.cue('confirm');await this.run(()=>this.onLoad(save,this.saveEntries()[this.subIndex].slot));
    }else if(this.submenu==='extras'&&this.panelX===0){
      const track=this.manifest.audio.gallery?.[this.subIndex];if(track){this.cue('confirm');this.audio.setMusic(track.clip??track);this.log({type:'startup-gallery-play',index:this.subIndex,clip:track.clip??track});}
    }
  }
  async run(action){
    const epoch=this.sequence.epoch;this.pending=true;this.updateButtons();this.updateOptionPositions();
    try{await action();}catch(error){this.status(error.message,true);this.log({type:'startup-action-failed',error:error.message});}
    finally{if(this.sequence.epoch===epoch){this.pending=false;this.updateButtons();this.updateOptionPositions();}}
  }
}
