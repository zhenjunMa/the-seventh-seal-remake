import {createMenuTextRenderer} from './core/menu_text.mjs';
import {dialoguePages,DialoguePlayback} from './core/dialogue.mjs';

export class DialogueView {
  static async create({manifest,fonts,image,...options}){
    const resources={};
    await Promise.all(Object.entries(manifest.resources).map(async([key,value])=>{
      resources[key]={...value,bitmaps:await Promise.all(value.frames.map(frame=>image(frame.image)))};
    }));
    return new DialogueView({...options,manifest,resources,textRenderer:await createMenuTextRenderer(fonts)});
  }
  constructor({root,manifest,resources,textRenderer,onAdvance,onChoose,log,clock=null}){
    Object.assign(this,{root,manifest,resources,textRenderer,onAdvance,onChoose,log,clock});
    this.canvas=root.querySelector('canvas');this.context=this.canvas.getContext('2d');
    this.button=root.querySelector('#dialogueNext');this.speaker=root.querySelector('#speaker');
    this.label=root.querySelector('#dialogueText');this.choicesRoot=root.querySelector('#dialogueChoices');
    this.active=false;this.epoch=0;this.inkCache=new Map();
    this.button.onclick=event=>{if(event.detail!==0)this.onAdvance();};
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(root.parentElement);
  }
  resize(){
    const box=this.root.parentElement.getBoundingClientRect();
    this.root.style.setProperty('--dialogue-scale',String(Math.min(box.width/640,box.height/480)));
  }
  show({speaker,text,style,choices,record,sessionId,getAnchor}){
    this.close();this.active=true;this.root.hidden=false;
    Object.assign(this,{style:style&15,sessionId,getAnchor,record});
    const m=this.manifest;
    this.started=this.now();this.entryDuration=m.ordinary.portrait_entry.ticks*m.ordinary.portrait_entry.tick_ms;
    this.readyAt=this.started+(this.style<=1?this.entryDuration:0);
    const bytes=record?.raw_hex?.match(/../g)?.map(byte=>parseInt(byte,16));
    this.faceIndex=(record?.portrait_id??bytes?.[2]??0)-1;this.faceLeft=Boolean(record?.region_byte_raw??bytes?.[6]);
    this.speaker.textContent=speaker||'对话';this.label.textContent=text;
    const profile=this.style===2?m.thought:m.ordinary;
    this.profile={width:profile.text_width,height:profile.text_height,fontHeight:profile.font_height,lineHeight:profile.line_step};
    this.font=profile.font_key;this.latinFont=profile.ascii_font_key;
    const measureLatin=word=>this.textRenderer.measure(word,this.latinFont);
    this.playback=new DialoguePlayback(dialoguePages(text,{...this.profile,scroll:this.style<=1,measureLatin}),{now:this.readyAt,interval:m.timing.character_interval_ms,choices});
    this.choicesRoot.replaceChildren(...(choices??[]).map(choice=>{
      const button=document.createElement('button');button.textContent=choice.text;button.dataset.index=String(choice.index);
      button.onclick=event=>{if(event.detail===0||this.suspended||!this.active||!this.playback.select(choice.index))return;this.commitChoice();};
      button.onpointerenter=()=>{if(!this.suspended&&this.playback.select(choice.index))this.draw(this.now());};
      button.onfocus=()=>{if(!this.suspended&&this.playback.select(choice.index))this.draw(this.now());};
      return button;
    }));
    this.choicesRoot.hidden=true;this.button.hidden=false;this.resize();this.button.focus({preventScroll:true});
    const epoch=this.epoch;
    const frame=now=>{if(!this.active||epoch!==this.epoch)return;this.draw(now);this.scheduleFrame(frame);};
    this.draw(this.started);this.scheduleFrame(frame);
    this.log?.({type:'dialogue-open',session:sessionId,style:this.style,text,speaker,face_index:this.faceIndex,
      face_left:this.faceLeft,pages:this.playback.pages.length,choices:choices?.map(choice=>({index:choice.index,text:choice.text}))??[]});
  }
  now(){return this.clock?.time??performance.now();}
  get suspended(){return Boolean(this.clock?.paused||this.clock?.closed);}
  scheduleFrame(frame){
    if(this.clock)this.frameTask=this.clock.requestFrame(frame);
    else this.raf=requestAnimationFrame(frame);
  }
  geometry(){
    const m=this.manifest;
    if(this.style===2){
      const anchor=this.getAnchor?.()??{x:320,y:240};
      const x=Math.max(0,Math.min(640-this.profile.width,anchor.x-this.profile.width/2));
      const y=Math.max(0,Math.min(480-this.profile.height,anchor.y-this.profile.height));
      return {board:{x:x+m.thought.background_offset[0],y:y+m.thought.background_offset[1]},text:{x,y}};
    }
    const [x,y]=m.ordinary.board_origin[this.style];
    return {board:{x,y},text:{x:this.faceLeft&&this.faceIndex>=0?m.ordinary.left_portrait_text_origin_x:m.ordinary.text_origin_x,
      y:m.ordinary.text_origin_y[this.style]}};
  }
  ink(text,font,foreground,shadow){
    const key=[text,font,foreground,shadow].join('|');
    if(!this.inkCache.has(key)){
      const canvas=document.createElement('canvas');
      if(this.textRenderer.supports(text,font)){
        const bounds=this.textRenderer.paint(canvas,text,{font,foreground,shadow,shadowOffsets:[[1,1]],advanceOverride:this.profile.fontHeight+2});
        this.inkCache.set(key,{canvas,...bounds});
      }else{
        const height=this.profile.fontHeight;canvas.width=Math.ceil([...text].length*(height+2)+4);canvas.height=height+5;
        const c=canvas.getContext('2d');c.font=`${height}px SimSun,serif`;c.textBaseline='top';
        c.fillStyle=shadow;c.fillText(text,2,2);c.fillStyle=foreground;c.fillText(text,1,1);
        this.inkCache.set(key,{canvas,offsetX:-1,offsetY:-1});
      }
    }
    return this.inkCache.get(key);
  }
  paintText(text,x,y,foreground,shadow){
    const font=text.codePointAt(0)<128?this.latinFont:this.font,ink=this.ink(text,font,foreground,shadow);
    this.context.drawImage(ink.canvas,x-1+ink.offsetX,y-1+ink.offsetY);
  }
  choiceLayout(){
    const l=this.geometry(),height=this.profile.fontHeight,pen=this.playback.current.pen;
    let x=l.text.x;const y=l.text.y+pen.y+(pen.y+this.profile.lineHeight<this.profile.height?this.profile.lineHeight:0);
    return this.playback.choices.map(choice=>{
      const width=[...choice.text].reduce((sum,char)=>sum+(char.codePointAt(0)>127?height:this.textRenderer.measure(char,this.latinFont)),0);
      const result={...choice,x,y,width,height:height+2};x+=width+height;return result;
    });
  }
  paintChoice(choice,selected){
    const colors=this.manifest.colors,c=this.context;
    if(selected){
      const [left,top,right,bottom]=this.manifest.input.choices.highlight_padding;
      c.fillStyle=`rgb(${colors.choice_fill_rgb.join(',')})`;c.fillRect(choice.x+left,choice.y+top,choice.width+right-left,choice.height+bottom-top);
      c.strokeStyle=`rgb(${colors.choice_border_rgb.join(',')})`;c.strokeRect(choice.x+left+.5,choice.y+top+.5,choice.width+right-left-1,choice.height+bottom-top-1);
    }
    const color=selected?colors.choice_selected:colors.choice_normal;let x=choice.x;
    for(const char of choice.text){this.paintText(char,x+1,choice.y+1,color.foreground,color.shadow);
      x+=char.codePointAt(0)>127?this.profile.fontHeight:this.textRenderer.measure(char,this.latinFont);}
  }
  draw(now){
    if(!this.active)return;
    const c=this.context,r=this.resources,l=this.geometry();c.clearRect(0,0,640,480);c.imageSmoothingEnabled=false;
    if(this.style===2)c.drawImage(r.think.bitmaps[0],l.board.x,l.board.y);
    else{
      const entry=this.manifest.ordinary.board_entry;
      const slide=Math.min(entry.end_x,entry.start_x+entry.step_x*Math.floor((now-this.started)/entry.tick_ms));
      c.drawImage(r.board.bitmaps[0],l.board.x+(this.faceLeft?-slide:slide),l.board.y);
      const face=r.faces.bitmaps[this.faceIndex];
      if(face){
        const entry=this.manifest.ordinary.portrait_entry,tick=Math.min(entry.ticks,Math.floor((now-this.started)/entry.tick_ms));
        const width=entry.initial_size[0]+tick*entry.size_step[0],height=entry.initial_size[1]+tick*entry.size_step[1];
        c.save();c.globalAlpha=tick===entry.ticks?1:1-(entry.initial_alpha_raw+tick*entry.alpha_step_raw)/255;
        c.drawImage(face,this.faceLeft?0:640-width,this.style===0?0:480-height,width,height);c.restore();
      }
    }
    if(now<this.readyAt)return;
    this.playback.tick(now);
    if(this.playback.stage==='choices'&&this.choicesRoot.hidden)this.showChoices();
    const colors=this.manifest.colors,player=(this.record?.speaker??1)<colors.speaker_cutoff;
    const {foreground,shadow}=player?colors.party:colors.npc;
    if(this.playback.stage==='choices'){
      const shift=this.playback.current.pen.y+this.profile.lineHeight<this.profile.height?0:this.profile.lineHeight;
      for(const run of [...this.playback.current.carriedRuns,...this.playback.current.runs])if(run.text&&run.y>=shift)this.paintText(run.text,l.text.x+run.x,l.text.y+run.y-shift,foreground,shadow);
      this.choiceLayout().forEach((choice,index)=>this.paintChoice(choice,index===this.playback.selected));
    }else{
      for(const run of [...this.playback.current.carriedRuns,...this.playback.current.runs.slice(0,this.playback.revealed)])if(run.text)this.paintText(run.text,l.text.x+run.x,l.text.y+run.y,foreground,shadow);
      if(this.playback.complete){
        const wait=this.style===2?r.wait2:r.wait1,index=Math.floor((now-this.readyAt)/wait.interval_ms)%wait.bitmaps.length;
        const pen=this.playback.current.pen;
        c.drawImage(wait.bitmaps[index],l.text.x+pen.x+2,l.text.y+pen.y+this.profile.fontHeight-wait.height);
      }
    }
    this.root.dataset.stage=this.playback.stage;this.root.dataset.page=String(this.playback.page);
    this.root.dataset.pages=String(this.playback.pages.length);this.root.dataset.revealed=String(this.playback.revealed);
    this.root.dataset.style=String(this.style);this.root.dataset.face=String(this.faceIndex);
    this.root.dataset.selection=String(this.playback.selected);
  }
  commitChoice(){
    if(!this.active||this.suspended||this.playback.stage!=='choices')return;
    const index=this.playback.choices[this.playback.selected].index;
    this.log?.({type:'dialogue-choice',session:this.sessionId,index});this.onChoose(index,this.sessionId);
  }
  showChoices(){
    this.button.hidden=true;this.choicesRoot.hidden=false;
    const layouts=this.choiceLayout();
    [...this.choicesRoot.children].forEach((button,index)=>{
      const layout=layouts[index];Object.assign(button.style,{left:`${layout.x-5}px`,top:`${layout.y-2}px`,width:`${layout.width+10}px`,height:`${layout.height+4}px`});
    });
    this.choicesRoot.children[this.playback.selected]?.focus({preventScroll:true});
  }
  advance(){
    if(!this.active||this.suspended||this.now()<this.readyAt)return false;
    const result=this.playback.advance(this.now());
    this.log?.({type:'dialogue-advance',session:this.sessionId,page:this.playback.page,result:result.kind});
    if(result.kind==='close')return true;
    if(result.kind==='choice'){this.commitChoice();return false;}
    if(result.kind==='choices')this.showChoices();
    this.draw(this.now());return false;
  }
  key(key,repeat=false){
    if(!this.active||this.suspended)return false;
    if(['ArrowUp','ArrowLeft','ArrowDown','ArrowRight'].includes(key)){
      if(this.playback.stage==='choices'){
        this.playback.move(['ArrowUp','ArrowLeft'].includes(key)?-1:1);
        this.choicesRoot.children[this.playback.selected]?.focus({preventScroll:true});this.draw(this.now());
      }
      return true;
    }
    return ['Escape','Tab','e'].includes(key);
  }
  close(){
    this.active=false;this.epoch++;this.frameTask?.cancel();this.frameTask=null;cancelAnimationFrame(this.raf);this.root.hidden=true;
    this.context.clearRect(0,0,640,480);this.inkCache.clear();this.label.textContent='';
    this.choicesRoot.replaceChildren();this.choicesRoot.hidden=true;
    for(const key of ['stage','page','pages','revealed','style','face','selection'])delete this.root.dataset[key];
  }
}
