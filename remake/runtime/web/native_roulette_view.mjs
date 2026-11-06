// GAME.exe mode 4: modal4EBD80, render4E5DE0, left4EC770/right4EE7C0.
// Source pixels and modal state; money, RNG and payouts belong to the controller.
import {NativeCasinoFrame,nativeRectContains,nativeNamedFrame} from './native_casino_frame.mjs';

export const ROULETTE_BET_RECTS=Object.freeze([
  [64,193,102,231],[151,194,189,232],[236,196,274,234],[322,197,360,235],[408,198,448,236],[496,199,532,237],
  [64,237,102,275],[150,238,188,276],[236,240,274,278],[322,241,360,279],[408,242,446,280],[494,243,532,281],
  [64,281,102,319],[150,282,188,320],[236,284,274,322],[322,285,360,323],[408,286,446,324],[494,287,532,325],
  [64,324,102,362],[150,326,188,364],[236,328,274,366],[322,329,360,367],[408,330,446,368],[494,331,532,369],
  [194,80,232,118],[367,81,405,119],[282,106,320,144],
  [64,149,102,187],[150,150,189,188],[236,152,274,190],[322,153,360,191],[408,154,446,192],[494,155,532,193],
  [107,106,145,144],[451,111,490,149],
].map(Object.freeze));
// The source right-click handler differs at three edges from its left handler.
export const ROULETTE_RIGHT_BET_RECTS=Object.freeze(ROULETTE_BET_RECTS.map((rect,id)=>
  Object.freeze(id===4?[408,198,446,236]:id===5?[494,199,532,237]:id===25?[367,81,405,120]:[...rect])));
export const ROULETTE_CONTROLS=Object.freeze({
  ruleYes:[377,380,449,411],ruleNo:[457,380,529,411],
  clear:[386,383,450,413],play:[470,383,534,413],skip:[533,329,573,369],
  continueYes:[245,271,317,302],continueNo:[325,271,397,302],
});
const ballOrigins=Object.freeze([
  [64,193],[150,194],[236,196],[322,197],[408,198],[494,199],
  [64,237],[150,238],[236,240],[322,241],[408,242],[494,243],
  [64,281],[150,282],[236,284],[322,285],[408,286],[494,287],
  [64,325],[150,326],[236,328],[322,329],[408,330],[494,331],
  [194,80],[367,81],[282,106],
  [64,149],[150,150],[236,152],[322,153],[408,154],[494,155],
  [107,106],[451,111],
]);
const numberOrigins=Object.freeze([
  [118,206],[204,207],[290,209],[376,210],[462,211],[548,212],
  [118,250],[204,251],[290,253],[378,254],[462,255],[548,256],
  [118,294],[204,295],[290,297],[376,298],[462,299],[548,300],
  [118,338],[204,339],[290,341],[376,342],[462,343],[548,344],
  [248,93],[421,94],[336,119],
  [118,162],[204,163],[290,165],[376,166],[462,167],[548,168],
  [161,119],[505,124],
]);
const buttonOrigins=Object.freeze({ruleYes:[377,380],ruleNo:[457,380],clear:[388,384],play:[472,384],continueYes:[245,271],continueNo:[325,271]});
const buttonNames=Object.freeze({ruleYes:'Yes.bmp',ruleNo:'No.bmp',clear:'Clear.bmp',play:'Open.bmp',continueYes:'Yes.bmp',continueNo:'No.bmp'});
const keyboardPoints=Object.freeze([
  null,[83,212],[170,213],[255,213],[341,216],[428,217],[514,218],
  [83,256],[169,257],[255,259],[341,260],[427,261],[513,262],
  [83,300],[169,301],[255,303],[341,304],[427,305],[513,306],
  [83,343],[169,345],[255,347],[341,348],[427,349],[514,350],
  [213,99],[386,100],[301,125],[83,168],[169,169],[255,171],[341,172],[427,173],[513,174],
  [126,125],[470,130],[418,398],[499,398],
]);
const f32=Math.fround;
export const nativeRouletteAnimationState=()=>({frame:0,laps:0,marker:0,elapsed:0,skipped:false});
export function tickNativeRouletteAnimation(state,outcome,delta){
  const previous=Math.trunc(state.frame),wasFinished=state.laps>=5&&previous===outcome;
  if(wasFinished)return {changed:false,finished:true};
  state.elapsed+=Math.max(0,delta)/1000;
  const gate=state.elapsed>.01;if(gate)state.elapsed=0;
  if(state.skipped){state.frame=outcome;state.laps=5;}
  else{
    if(gate){
      if(state.laps===0){const distance=Math.abs(state.frame-state.marker);state.frame=f32(state.frame+(distance<3?f32(.1):distance<10?f32(.4):1));}
      else if(state.laps<5)state.frame=f32(state.frame+1);
      else{
        if(Math.abs(outcome-state.frame)>3)state.frame=f32(state.frame+f32(.4));
        state.frame=f32(state.frame+(Math.abs(outcome-state.frame)>10?f32(.1):1));
      }
    }
    if(state.laps>=5){
      if(state.frame>=24)state.frame=0;
      if(Math.trunc(state.frame)===outcome){state.marker=Math.trunc(state.frame);state.skipped=false;}
    }else if(state.frame>=24){state.frame=0;state.laps++;}
  }
  const finished=state.laps>=5&&Math.trunc(state.frame)===outcome;
  return {changed:previous!==Math.trunc(state.frame)||finished!==wasFinished,finished};
}
export function nativeRouletteKeyboardIndex(index,key,phase){
  if(phase==='draw')return key==='ArrowUp'?1:key==='ArrowDown'?2:index;
  if(phase!=='choose')return index;
  if(key==='ArrowUp'){
    if(index>=7&&index<=24)return index-6;
    if(index>=1&&index<=6)return index+27;
    return ({28:34,29:34,30:27,31:27,32:35,33:35,34:25,27:25,35:26,36:24,37:24})[index]??index;
  }
  if(key==='ArrowDown'){
    if(index>=1&&index<=18)return index+6;
    if(index>=19&&index<=24)return 36;
    return ({25:34,26:35,34:28,27:30,35:32,28:1,29:2,30:3,31:4,32:5,33:6})[index]??index;
  }
  return index;
}
export function nativeRouletteKeyboardPoint(index,phase){
  if(phase==='rule')return index===2?[413,395]:[493,395];
  if(phase==='draw')return index===2?[487,411]:[553,349];
  if(phase==='continue')return index===2?[281,286]:[361,286];
  return [...(keyboardPoints[index]??[418,398])];
}
export function nativeRouletteBetAt(point,button=0){return (button===2?ROULETTE_RIGHT_BET_RECTS:ROULETTE_BET_RECTS).findIndex(rect=>nativeRectContains(point,rect));}

export class NativeRouletteView{
  constructor({root,manifest,cursor=manifest?.cursor,isSuspended=()=>false,onAction,onClose,onSound=()=>{},onStopSound=()=>{}}){
    if(manifest?.backgrounds?.length!==6||manifest.buttons?.length!==4||manifest.numbers?.length!==10||manifest.balls?.length!==66||manifest.disc?.length!==24||!manifest.noMoney)
      throw new Error('大转轮原版素材不完整');
    Object.assign(this,{root,manifest,isSuspended,onAction,onClose,onSound,onStopSound});
    this.phase=null;this.keyboardIndex=1;this.hover=null;this.held=null;this.pending=false;this.disposed=false;
    this.surface=new NativeCasinoFrame({root,title:'大转轮',cursor,isSuspended,onDown:(point,event)=>this.down(point,event),onMove:point=>this.move(point),onUp:()=>this.up(),onFrame:delta=>this.tick(delta)});
    this.layer=document.createElement('div');Object.assign(this.layer.style,{position:'absolute',inset:'0'});this.surface.frame.append(this.layer);
    this.surface.setPointer(nativeRouletteKeyboardPoint(1,'rule'));
    this.controlNodes=new Map();this.controlLayer=document.createElement('div');
    Object.assign(this.controlLayer.style,{position:'absolute',inset:'0',zIndex:'2'});this.surface.frame.append(this.controlLayer);
  }
  get active(){return !this.disposed;}
  get bets(){return this.state?.bets??Array(35).fill(0);}
  get cost(){return this.bets.reduce((sum,count)=>sum+count,0)*50;}
  get finished(){return this.animation?.laps>=5&&Math.trunc(this.animation.frame)===this.state?.result?.outcome;}
  image(row,x=0,y=0){return this.surface.image(row.image,x,y,this.layer);}
  background(name){return this.image(nativeNamedFrame(this.manifest.backgrounds,name));}
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
    if(this.disposed)return;this.state=state;
    if(this.phase===null){this.phase=state.money<50?'no-money':'rule';this.move(this.surface.pointer,false);}
    if(this.phase==='choose'&&this.awaitingRound&&state.result?.changed&&Number.isInteger(state.result.outcome)){
      this.up(false);this.phase='draw';this.animation=nativeRouletteAnimationState();this.resultSound=false;this.keyboardIndex=1;this.hover=null;
      this.surface.setPointer(nativeRouletteKeyboardPoint(1,'draw'));this.onStopSound('ballClick');this.sound('roll',{loop:true});
    }
    this.paint();
  }
  paint(){
    if(this.disposed||!this.state)return;this.layer.replaceChildren();
    for(const node of this.controlNodes.values())node.hidden=true;
    if(this.phase==='no-money'){this.image(this.manifest.noMoney);this.control('金钱不足，离开大转轮',[0,0,640,480]);return;}
    if(this.phase==='rule'){
      this.background('Rule.bmp');this.paintButtons(['ruleYes','ruleNo']);return;
    }
    if(this.phase==='choose'){
      this.background('Main.bmp');
      for(let id=0;id<35;id++){
        const held=this.held?.id===id,art=id===33?24:id===34?25:id;
        if(this.bets[id]>0||held)this.image(this.manifest.balls[art+(held?33:0)],...ballOrigins[id]);
        this.number(this.bets[id],...numberOrigins[id],2);
        const control=this.control(`下注 ${id+1}，${this.bets[id]} 注`,ROULETTE_BET_RECTS[id]);control.setAttribute('aria-pressed',String(this.bets[id]>0));
      }
      this.number(this.state.money-this.cost,120,395);this.number(this.cost,260,45);this.paintButtons(['clear','play']);return;
    }
    this.background('Rotate.bmp');
    if(this.phase==='continue'){
      // Repair the installed source's Continue(0,0) / button(245,271)
      // mismatch. The original 316x236 art now meets its original hit map;
      // source coordinates remain recorded in roulette_ui_native_20261106.
      this.image(this.manifest.disc[Math.trunc(this.animation.frame)],0,0);
      this.image(nativeNamedFrame(this.manifest.backgrounds,'Continue.bmp'),160,120);
      this.paintButtons(['continueYes','continueNo']);return;
    }
    this.image(this.manifest.disc[Math.trunc(this.animation.frame)],0,0);
    if(!this.finished)this.control('停止转轮',ROULETTE_CONTROLS.skip);
    if(this.finished){
      const result=this.state.result;this.image(nativeNamedFrame(this.manifest.backgrounds,result.prize>0?'Win.bmp':'Loss.bmp'),280,20);
      this.number(result.prize>0?result.prize:result.cost,468,150);this.number(this.state.money,468,194);
      this.control('继续',[0,0,640,480]);
    }
  }
  paintButtons(names){
    for(const name of names){
      if(this.hover===name)this.image(nativeNamedFrame(this.manifest.buttons,buttonNames[name]),...buttonOrigins[name]);
      this.control(({ruleYes:'开始游戏',ruleNo:'离开大转轮',clear:'清除下注',play:'开奖',continueYes:'继续游戏',continueNo:'离开大转轮'})[name],ROULETTE_CONTROLS[name]);
    }
  }
  move(point,paint=true){
    if(this.disposed||this.isSuspended())return;
    const previous=this.hover;
    const names=this.phase==='rule'?['ruleYes','ruleNo']:this.phase==='choose'?['clear','play']:this.phase==='continue'?['continueYes','continueNo']:[];
    this.hover=names.find(name=>nativeRectContains(point,ROULETTE_CONTROLS[name]))??null;
    if(paint&&previous!==this.hover)this.paint();
  }
  down(point,event={button:0},repeat=false){
    if(this.disposed||this.pending||this.isSuspended()||![0,2].includes(event.button))return;
    this.move(point,false);
    if(this.phase==='choose'){
      const id=nativeRouletteBetAt(point,event.button);
      if(id>=0){
        if(!repeat&&!event.keyboard)this.held={id,button:event.button,elapsed:0,gateElapsed:0};
        this.sound('ballClick');this.request({choice:`bet:${id}`,delta:event.button===2?-1:1});this.paint();return;
      }
      if(event.button===2)return;
      if(this.hover==='clear'){this.request({choice:'clear'});return;}
      if(this.hover==='play'&&this.cost>0)this.request({choice:'play'});
      return;
    }
    if(event.button!==0)return;
    if(this.phase==='no-money'){this.onClose();return;}
    if(this.phase==='rule'){
      if(this.hover==='ruleNo')this.onClose();
      else if(this.hover==='ruleYes'){
        this.sound('click');this.phase='choose';this.keyboardIndex=36;this.surface.setPointer(nativeRouletteKeyboardPoint(36,'choose'));this.move(this.surface.pointer,false);this.paint();
      }
      return;
    }
    if(this.phase==='draw'){
      if(this.finished){
        this.onStopSound('roll');this.phase=this.state.money===0?'no-money':'continue';this.keyboardIndex=2;
        this.surface.setPointer(nativeRouletteKeyboardPoint(2,'continue'));this.move(this.surface.pointer,false);this.paint();return;
      }
      if(nativeRectContains(point,ROULETTE_CONTROLS.skip)){
        this.animation.skipped=true;this.onStopSound('roll');this.tick(0);
      }
      return;
    }
    if(this.phase==='continue'){
      if(this.hover==='continueNo'){this.onStopSound('win');this.onStopSound('loss');this.onClose();}
      else if(this.hover==='continueYes'){
        this.onStopSound('win');this.onStopSound('loss');this.phase='choose';this.keyboardIndex=36;
        this.surface.setPointer(nativeRouletteKeyboardPoint(36,'choose'));this.move(this.surface.pointer,false);this.request({choice:'collect',resetBets:true});
      }
    }
  }
  up(paint=true){const held=this.held;this.held=null;if(held&&paint)this.paint();}
  tick(delta){
    if(this.disposed||this.pending)return;
    if(this.phase==='choose'&&this.held){
      const held=this.held;held.gateElapsed+=delta/1000;
      if(held.gateElapsed>.01){held.gateElapsed=0;held.elapsed=f32(held.elapsed+f32(.1));}
      if(held.elapsed>=1){
        const id=nativeRouletteBetAt(this.surface.pointer,held.button),previous=held.id;held.id=id;
        if(id>=0)this.down(this.surface.pointer,{button:held.button},true);
        else if(previous!==id)this.paint();
      }
    }else if(this.phase==='draw'){
      const result=tickNativeRouletteAnimation(this.animation,this.state.result.outcome,delta);
      if(result.finished&&!this.resultSound){this.resultSound=true;this.sound(this.state.result.prize>0?'win':'loss');}
      if(result.changed)this.paint();
    }
  }
  key(key){
    if(this.disposed||this.isSuspended())return false;
    if(key==='Escape'){if(this.phase==='choose')this.onClose();return true;}
    if(key==='Enter'||key===' '){this.down(this.surface.pointer,{button:0,keyboard:true});return true;}
    if(!['ArrowUp','ArrowDown'].includes(key))return false;
    if(this.phase==='no-money')return true;
    this.keyboardIndex=nativeRouletteKeyboardIndex(this.keyboardIndex,key,this.phase);
    const point=nativeRouletteKeyboardPoint(this.keyboardIndex,this.phase);this.surface.setPointer(point);this.move(point);return true;
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;this.held=null;
    for(const name of ['roll','ballClick','click','win','loss'])this.onStopSound(name);this.surface.dispose();
  }
}
