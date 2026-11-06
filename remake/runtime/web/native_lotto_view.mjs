// GAME.exe 4C84xx/4C8A10, draw4CA110, input4CC7D0/4D0270.
// Source pixels and transient modal state only; the controller owns every draw,
// wager and individual prize-card transaction.
import {NativeCasinoFrame,nativeRectContains,nativeNamedFrame} from './native_casino_frame.mjs';

const columns=Object.freeze([252,299,345,391,437,484,530]);
const rows=Object.freeze([85,130,175,220,264,309]);
export const LOTTO_NUMBER_RECTS=Object.freeze(Array.from({length:42},(_,i)=>
  Object.freeze([columns[i%7],rows[Math.trunc(i/7)],columns[i%7]+38,rows[Math.trunc(i/7)]+38])));
export const LOTTO_CONTROLS=Object.freeze({
  colored:[73,128,201,155],random:[73,165,201,192],plus:[75,230,93,246],minus:[75,247,93,263],
  clear:[386,383,450,413],play:[469,383,530,413],
  skip:[533,329,573,369],result:[467,392,508,431],
  continue:[456,378,530,411],leave:[376,378,450,411],
});
const buttonOrigins=Object.freeze({plus:[75,229],minus:[75,247],play:[469,383],clear:[386,383],
  random:[73,165],colored:[73,128],leave:[376,378],continue:[456,378]});
const buttonFrames=Object.freeze({plus:0,minus:1,play:2,clear:3,random:4,colored:5,leave:6,continue:7});
const keyboardPoints=Object.freeze({43:[137,141],44:[137,178],45:[84,238],46:[84,255],47:[418,398],48:[499,398]});
const f32=Math.fround;
const timing=Object.freeze({fast:f32(.005),normal:f32(.01),medium:f32(.05),slow:f32(.1),stop:f32(.5)});

export function nativeLottoNumberAt(point){return LOTTO_NUMBER_RECTS.findIndex(rect=>nativeRectContains(point,rect))+1;}
export function nativeLottoKeyboardIndex(index,key,phase){
  if(phase==='draw')return key==='ArrowUp'?1:key==='ArrowDown'?2:index;
  if(phase==='result')return key==='ArrowLeft'?2:key==='ArrowRight'?1:index;
  if(phase!=='choose')return index;
  if(!index)return 44;
  if(key==='ArrowLeft'){
    if([1,8,15,22,29,36].includes(index))return 44;
    if(index===48)return 47;
    return [43,44,45,46,47].includes(index)?index:index-1;
  }
  if(key==='ArrowRight'){
    if(index>=43&&index<=46)return 1;
    if(index===47)return 48;
    return [7,14,21,28,35,42,48].includes(index)?index:index+1;
  }
  if(key==='ArrowUp'){
    if(index===47||index===48)return 42;
    if(index>=44&&index<=46)return index-1;
    return index===43||index<=7?index:index-7;
  }
  if(key==='ArrowDown'){
    if(index>=36&&index<=42)return 47;
    if(index>=43&&index<=45)return index+1;
    return [46,47,48].includes(index)?index:index+7;
  }
  return index;
}
export function nativeLottoKeyboardPoint(index,phase){
  if(phase==='draw')return index===2?[487,411]:[553,349];
  if(phase==='result')return index===2?[413,394]:[493,394];
  if(index>=1&&index<=42){const rect=LOTTO_NUMBER_RECTS[index-1];return [rect[0]+19,rect[1]+19];}
  return [...(keyboardPoints[index]??[137,178])];
}
export const nativeLottoAnimationState=()=>({frame:0,cycles:0,revealed:0,startFrame:0,elapsed:0,clockReset:true,skipped:false});
export function tickNativeLottoAnimation(state,draw,delta){
  if(state.skipped||state.revealed>=6){state.revealed=6;state.frame=draw[5]-1;return {changed:false,finished:true,rollRestart:false};}
  const previousFrame=state.frame,previousCount=state.revealed;
  if(state.clockReset){state.elapsed=0;state.clockReset=false;}
  else state.elapsed=f32(state.elapsed+Math.max(0,delta)/1000);
  const target=draw[state.revealed]-1,distance=Math.abs(state.frame-state.startFrame);
  let delay;
  if(state.cycles===0)delay=distance<5?timing.slow:distance<10?timing.medium:timing.normal;
  else if(state.cycles<3)delay=timing.fast;
  else if(state.frame!==target)delay=distance>10?timing.normal:distance>5?timing.medium:timing.slow;
  if(delay!==undefined&&state.elapsed>delay){state.frame=f32(state.frame+1);state.elapsed=0;state.clockReset=true;}
  const rollRestart=state.cycles>=3&&state.frame===target;
  if(rollRestart&&state.elapsed>timing.stop){
    state.revealed++;state.startFrame=state.frame;state.cycles=0;state.elapsed=0;state.clockReset=true;
  }
  if(state.frame>=42){state.frame=0;if(state.cycles!==3)state.cycles++;}
  if(state.revealed>=6)state.frame=draw[5]-1;
  return {changed:previousFrame!==state.frame||previousCount!==state.revealed,finished:state.revealed>=6,rollRestart};
}

export class NativeLottoView{
  constructor({root,manifest,cursor=manifest?.cursor,isSuspended=()=>false,onAction,onClose,onSound=()=>{},onStopSound=()=>{}}){
    if(manifest?.buttons?.length!==8||manifest.numbers?.length!==10||manifest.balls?.length!==42||
       manifest.disc?.length!==42||manifest.rewards?.length!==25||manifest.backgrounds?.length!==3||
       !['LottoBack.bmp','RandomBack.bmp','FinalBack.bmp'].every(name=>nativeNamedFrame(manifest.backgrounds,name))||
       !manifest.noMoney?.image||!cursor?.image)
      throw new Error('大乐透原版素材不完整');
    Object.assign(this,{root,manifest,isSuspended,onAction,onClose,onSound,onStopSound});
    this.phase=null;this.keyboardIndex=44;this.pending=false;this.disposed=false;this.lastCard=null;this.hover=null;
    this.surface=new NativeCasinoFrame({root,title:'大乐透',cursor,isSuspended,
      onDown:(point,event)=>this.down(point,event),onMove:point=>this.move(point),onFrame:delta=>this.tick(delta)});
    this.layer=document.createElement('div');Object.assign(this.layer.style,{position:'absolute',inset:'0'});
    this.surface.frame.append(this.layer);this.surface.setPointer([137,178]);
    this.controlNodes=new Map();this.controlLayer=document.createElement('div');
    Object.assign(this.controlLayer.style,{position:'absolute',inset:'0',zIndex:'2'});this.surface.frame.append(this.controlLayer);
  }
  get active(){return !this.disposed;}
  get remainingCards(){return Math.max(0,this.state?.result?.remainingCards??this.state?.result?.counts?.cards??0);}
  image(row,x=0,y=0){return this.surface.image(row.image,x,y,this.layer);}
  number(value,x,y,pad=0){const node=this.surface.number(value,this.manifest.numbers,x,y,{pad,advance:10});this.layer.append(node);return node;}
  control(name,rect){
    const key=rect.join(',');let node=this.controlNodes.get(key);
    if(!node){node=this.surface.control(name,rect);this.controlNodes.set(key,node);this.controlLayer.append(node);}
    node.setAttribute('aria-label',name);node.hidden=false;return node;
  }
  sound(name,settings={}){this.onStopSound(name);this.onSound(name,{singleVoice:true,...settings});}
  request(event){
    if(this.disposed||this.pending||this.isSuspended())return;
    if(event.choice==='play')this.awaitingRound=true;
    this.pending=true;try{this.onAction(event);}finally{this.pending=false;this.awaitingRound=false;}
  }
  show(state){
    if(this.disposed)return;
    this.state=state;
    if(this.phase===null){
      this.phase=state.money<50?'no-money':'choose';this.move(this.surface.pointer,false);
      if(this.phase==='choose')this.onSound('random',{singleVoice:true,loop:true});
    }
    if(this.phase==='choose'&&this.awaitingRound&&state.result?.changed&&Array.isArray(state.result.draw)){
      this.phase='draw';this.animation=nativeLottoAnimationState();this.lastCard=null;this.keyboardIndex=1;
      this.surface.setPointer(nativeLottoKeyboardPoint(1,'draw'));this.sound('roll',{loop:true});
    }
    if(this.phase==='result'&&state.result?.card)this.lastCard=state.result.card;
    this.paint();
  }
  paint(){
    if(this.disposed||!this.state)return;
    this.layer.replaceChildren();
    for(const node of this.controlNodes.values())node.hidden=true;
    if(this.phase==='no-money'){
      this.image(this.manifest.noMoney);this.control('离开，金钱不足',[0,0,640,480]);return;
    }
    if(this.phase==='choose')this.paintChoose();
    else if(this.phase==='draw')this.paintDraw();
    else this.paintResult();
  }
  paintChoose(){
    this.image(nativeNamedFrame(this.manifest.backgrounds,'LottoBack.bmp'));
    for(let i=0;i<42;i++){
      const rect=LOTTO_NUMBER_RECTS[i];if(this.state.numbers?.includes(i+1))this.image(this.manifest.balls[i],rect[0],rect[1]);
      const button=this.control(`号码 ${i+1}`,rect);button.setAttribute('aria-pressed',String(this.state.numbers?.includes(i+1)??false));
    }
    this.image(this.manifest.buttons[this.hover==='random'?4:5],73,this.hover==='random'?165:128);
    for(const name of ['plus','minus','clear','play'])if(this.hover===name){const [x,y]=buttonOrigins[name];this.image(this.manifest.buttons[buttonFrames[name]],x,y);}
    const names={colored:'彩球投注',random:'乱数投注',plus:'增加投注倍数',minus:'减少投注倍数',clear:'消除号码',play:'开奖'};
    for(const [name,label]of Object.entries(names))this.control(label,LOTTO_CONTROLS[name]);
    const count=this.state.numbers?.length??0,tickets=count>=7?count*(count-1)*(count-2)*(count-3)*(count-4)*(count-5)/720:count>0?1:0;
    const multiplier=this.state.multiplier??1;
    this.number(tickets*multiplier,100,240);this.number(tickets*50*multiplier,100,310);this.number(this.state.money,120,395);
  }
  paintDraw(){
    this.image(nativeNamedFrame(this.manifest.backgrounds,'RandomBack.bmp'));
    this.image(this.manifest.disc[Math.trunc(this.animation.frame)],0,0);
    for(let i=0;i<this.animation.revealed;i++)this.number(this.state.result.draw[i],380+i*40,90,2);
    this.control('立即显示全部开奖号码',LOTTO_CONTROLS.skip);this.control('查看摇奖结果',LOTTO_CONTROLS.result);
  }
  paintResult(){
    const result=this.state.result,prize=this.lastCard&&nativeNamedFrame(this.manifest.rewards,`${this.lastCard.itemId}.bmp`);
    if(this.lastCard&&!prize)throw new Error(`大乐透奖卡 ${this.lastCard.itemId} 缺少原图`);
    this.image(prize??nativeNamedFrame(this.manifest.backgrounds,'FinalBack.bmp'));
    const ballXs=[275,316,358,400,442,484];
    for(let i=0;i<6;i++)this.image(this.manifest.balls[result.draw[i]-1],ballXs[i],93);
    for(const [i,name]of ['six','five','four','three','two'].entries())this.number(result.counts[name],165,178+i*42);
    this.number(result.prize,175,388);
    if(this.remainingCards>0){this.control(`揭开奖票，剩余 ${this.remainingCards} 张`,[0,0,640,480]);return;}
    for(const name of ['continue','leave']){
      if(this.hover===name){const [x,y]=buttonOrigins[name];this.image(this.manifest.buttons[buttonFrames[name]],x,y);}
      this.control(name==='continue'?'继续投注':'离开大乐透',LOTTO_CONTROLS[name]);
    }
  }
  move(point,paint=true){
    if(this.disposed||this.isSuspended())return;
    const previous=this.hover;
    if(this.phase==='choose'){
      this.hover=['clear','play','random','plus','minus'].find(name=>nativeRectContains(point,LOTTO_CONTROLS[name]))??null;
      // Original draw4CA619 resets the multiplier while the clear control is
      // highlighted, before a click. Keep the parameter in the controller.
      if(this.hover==='clear'&&this.state?.multiplier!==1)this.request({choice:'multiplier',value:1});
    }else if(this.phase==='result'&&this.remainingCards===0)
      this.hover=['continue','leave'].find(name=>nativeRectContains(point,LOTTO_CONTROLS[name]))??null;
    if(paint&&previous!==this.hover)this.paint();
  }
  down(point,event={button:0}){
    if(this.disposed||this.pending||this.isSuspended())return;
    if(event.button===2){if(this.phase==='choose')this.onClose();return;}
    if(event.button!==0)return;
    if(this.phase==='no-money'){this.onClose();return;}
    this.move(point);
    if(this.phase==='choose'){
      const number=nativeLottoNumberAt(point);
      if(number){this.sound('ballClick');this.request({choice:`number:${number}`});return;}
      const name=['clear','random','play','plus','minus'].find(key=>nativeRectContains(point,LOTTO_CONTROLS[key]));
      if(!name)return;
      if(name==='plus'||name==='minus'){
        if((this.state.numbers?.length??0)<=6)this.request({choice:'multiplier',value:Math.max(1,(this.state.multiplier??1)+(name==='plus'?1:-1))});
      }else{
        if(name==='play'){
          this.onStopSound('ballClick');this.onSound('click',{singleVoice:true,restart:false});
        }else this.sound('click');
        this.request({choice:name});
      }
      return;
    }
    if(this.phase==='draw'){
      if(nativeRectContains(point,LOTTO_CONTROLS.skip)){
        this.sound('click');this.animation.skipped=true;this.animation.revealed=6;this.animation.frame=this.state.result.draw[5]-1;
        this.onStopSound('roll');this.paint();
      }else if(nativeRectContains(point,LOTTO_CONTROLS.result)){
        this.onStopSound('roll');this.sound('click');this.phase='result';this.keyboardIndex=1;this.hover=null;
        this.surface.setPointer(nativeLottoKeyboardPoint(1,'result'));
        this.sound(this.state.result.prize>0?'win':'loss');this.paint();
      }
      return;
    }
    if(this.remainingCards>0){this.request({choice:'reveal'});return;}
    if(this.hover==='continue'){
      this.onStopSound('win');this.onStopSound('loss');this.sound('click');
      this.phase='choose';this.lastCard=null;this.keyboardIndex=44;this.hover='random';
      this.surface.setPointer(nativeLottoKeyboardPoint(44,'choose'));this.request({choice:'continue'});
    }else if(this.hover==='leave'){this.sound('click');this.onClose();}
  }
  tick(delta){
    if(this.disposed||this.pending||this.phase!=='draw')return;
    const result=tickNativeLottoAnimation(this.animation,this.state.result.draw,delta);
    // Draw4CB313 explicitly stops Roll before52D74A(loop=1), even while
    // pausing at the target. Preserve that source behavior, unlike WordDisc's
    // continuous voice which calls play without a preceding stop.
    if(result.rollRestart)this.sound('roll',{loop:true});
    if(result.finished)this.onStopSound('roll');
    if(result.changed)this.paint();
  }
  key(key){
    if(this.disposed||this.isSuspended())return false;
    if(key==='Escape'){if(this.phase==='choose')this.onClose();return true;}
    if(key==='Enter'||key===' '){this.down(this.surface.pointer);return true;}
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key))return false;
    if(this.phase==='no-money')return true;
    const index=nativeLottoKeyboardIndex(this.keyboardIndex,key,this.phase);
    if(this.phase==='draw'&&!['ArrowUp','ArrowDown'].includes(key)||this.phase==='result'&&!['ArrowLeft','ArrowRight'].includes(key))return true;
    this.keyboardIndex=index;const point=nativeLottoKeyboardPoint(index,this.phase);
    this.surface.setPointer(point);this.move(point);return true;
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;
    for(const name of ['random','roll','click','ballClick','win','loss'])this.onStopSound(name);
    this.surface.dispose();
  }
}
