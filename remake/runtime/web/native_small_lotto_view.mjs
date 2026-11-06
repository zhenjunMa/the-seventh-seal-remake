// GAME.exe 4F38E0 / 4F51D0 / 4F6B90: original small-lotto surfaces,
// numeric sprites, hit regions and wheel progression. Money and all random
// outcomes belong to the caller's story draft; animation never draws RNG.
import {NativeCasinoFrame,nativeNamedFrame,nativeRectContains} from './native_casino_frame.mjs';
import {setImageSource} from './core/ui/image_dom.mjs';

export const NATIVE_SMALL_LOTTO_HITS=Object.freeze({
  startYes:[377,380,449,411],startNo:[457,380,529,411],
  stop:[533,329,573,369],result:[467,392,508,431],
  continueYes:[245,271,317,302],continueNo:[325,271,397,302],
});
const f32=Math.fround;
const place=(node,x,y)=>Object.assign(node.style,{left:`${x}px`,top:`${y}px`});
const named=(rows,name)=>{
  const row=nativeNamedFrame(rows??[],name);
  if(!row?.image)throw new Error(`小乐透原素材缺失：${name}`);
  return row.image;
};

export function initialSmallLottoAnimation(){
  return {position:0,start:0,revolutions:0,revealed:0,dwell:0,gate:0,skipped:false};
}

// Source 4F597A..4F5D9F: first revolution accelerates at distances3/10;
// three full revolutions precede the target hold. Each accepted source gate
// advances once and discards overshoot, retaining the original frame pacing.
export function advanceSmallLottoAnimation(animation,faces,delta){
  if(animation.skipped)return false;
  animation.gate+=Math.max(0,delta);
  // 4F5271 compares the elapsed source seconds with float[66F7F0]=0.01.
  if(animation.gate<10)return false;
  animation.gate=0;
  if(animation.revealed>=6)return true;
  const distance=Math.abs(animation.position-animation.start);
  if(animation.revolutions===0){
    animation.position=f32(animation.position+(distance<3?f32(.1):distance<10?f32(.4):1));
  }else if(animation.revolutions<3)animation.position=f32(animation.position+1);
  else{
    const target=faces[animation.revealed]-1;
    if(Math.trunc(animation.position)!==target){
      // Keep the source's ordered <10 / <3 checks, including the dormant
      // second branch. Replacing this with target-distance easing changes it.
      animation.position=f32(animation.position+(distance<10?f32(.4):distance<3?f32(.1):1));
    }
    if(Math.trunc(animation.position)===target){
      animation.dwell=f32(animation.dwell+f32(.2));
      if(animation.dwell>=1){
        animation.revealed++;
        animation.start=Math.trunc(animation.position);
        animation.revolutions=0;animation.dwell=0;
      }
    }
  }
  if(animation.position>=24){animation.position=0;if(animation.revolutions<3)animation.revolutions++;}
  return false;
}

export class NativeSmallLottoView{
  constructor({root,manifest,cursor,isSuspended=()=>false,onAction,onClose,onSound=()=>{},onStopSound=()=>{}}){
    this.manifest=manifest?.special?.smallLotto??manifest;
    if(!this.manifest?.backgrounds||!this.manifest?.digits||!this.manifest?.buttons||!this.manifest?.disc)
      throw new Error('小乐透原素材清单缺失');
    Object.assign(this,{isSuspended,onAction,onClose,onSound,onStopSound});
    this.disposed=false;this.phase='rules';this.lastResult=null;this.controls=[];this.numberNodes=[];
    this.surface=new NativeCasinoFrame({root,title:'小乐透',cursor,isSuspended,
      onDown:(point,event)=>{if((event.button??0)===0)this.down(point);},
      onMove:point=>this.hover(point),onFrame:delta=>this.advance(delta)});
    this.background=this.surface.image(named(this.manifest.backgrounds,'rule.bmp'),0,0);
    this.disc=this.surface.image(this.manifest.disc[0]?.image,0,0);this.disc.hidden=true;
    this.popup=this.surface.image(null,160,120);this.popup.hidden=true;
    this.yes=this.surface.image(named(this.manifest.buttons,'Yes.bmp'),377,380);this.yes.hidden=true;
    this.no=this.surface.image(named(this.manifest.buttons,'No.bmp'),457,380);this.no.hidden=true;
    // Constructor 4F0F30..4F0F7A selects target1: the initial No button.
    this.setPoint([493,395]);
    this.onSound('random',{loop:true});
  }
  get active(){return !this.disposed;}
  get collectedMoney(){return Math.max(0,(this.state?.money??0)-(this.state?.pendingPrize??0));}
  show(state){
    if(this.disposed)return;
    this.state=state;this.actionPending=false;
    if(state.result?.changed&&Array.isArray(state.result.faces)&&state.result!==this.lastResult){
      if(state.result.faces.length!==6||!state.result.faces.every(n=>Number.isInteger(n)&&n>=1&&n<=24))throw new Error('小乐透六个原号码无效');
      this.lastResult=state.result;this.animation=initialSmallLottoAnimation();this.phase='spin';
      this.setPoint([553,349]);this.onSound('roll2',{loop:true});
    }else if(!this.lastResult)this.phase=state.money<50?'empty':'rules';
    else if(state.result?.changed===false&&state.money<50)this.phase='empty';
    this.paint();
  }
  setPoint(point){this.surface.setPointer(point);this.hover(point);}
  paint(){
    const rules=this.phase==='rules',empty=this.phase==='empty';
    const background=empty?(this.manifest.noMoney?.image??this.manifest.noMoney):named(this.manifest.backgrounds,rules?'rule.bmp':'Main.bmp');
    if(!background)throw new Error('小乐透原素材缺失：Picture/NoMoney.bmp');
    setImageSource(this.background,background);
    this.disc.hidden=rules||empty;
    if(!this.disc.hidden)this.paintDisc();
    const popupName=this.phase==='win'?'Win.bmp':this.phase==='loss'?'Loss.bmp':this.phase==='continue'?'Continue.bmp':null;
    this.popup.hidden=!popupName;
    if(popupName)setImageSource(this.popup,named(this.manifest.backgrounds,popupName));
    this.controls.forEach(node=>node.remove());this.controls=[];
    const control=(name,rect)=>this.controls.push(this.surface.control(name,rect));
    if(rules){control('开始小乐透，每次50',NATIVE_SMALL_LOTTO_HITS.startYes);control('不玩，离开',NATIVE_SMALL_LOTTO_HITS.startNo);}
    else if(this.phase==='spin'){
      control('停止转动并揭示全部号码',NATIVE_SMALL_LOTTO_HITS.stop);
      control('查看开奖结果',NATIVE_SMALL_LOTTO_HITS.result);
    }else if(this.phase==='continue'){
      control('继续玩，每次50',NATIVE_SMALL_LOTTO_HITS.continueYes);control('不再继续，离开',NATIVE_SMALL_LOTTO_HITS.continueNo);
    }else control(empty?'关闭金钱不足提示':'继续',[0,0,640,480]);
    this.paintNumbers();this.hover(this.surface.pointer);
  }
  paintDisc(){
    const index=Math.max(0,Math.min(23,Math.trunc(this.animation?.position??0)));
    if(index===this.discIndex)return;this.discIndex=index;
    setImageSource(this.disc,this.manifest.disc[index].image);
  }
  paintNumbers(){
    this.numberNodes.forEach(node=>node.remove());this.numberNodes=[];
    const number=(value,x,y,options={})=>this.numberNodes.push(this.surface.number(value,this.manifest.digits,x,y,{advance:10,gap:2,...options}));
    if(this.phase==='rules'||this.phase==='empty')return;
    number(this.collectedMoney,70,450);
    const count=this.animation?.revealed??0;
    for(let index=0;index<count;index++)number(this.lastResult.faces[index],380+index*40,90,{pad:2});
    if(this.phase==='win'){
      number(this.state.pendingPrize??this.lastResult.prize,350,250);number(this.collectedMoney,350,294);
    }else if(this.phase==='loss'){
      number(50,350,250);number(this.collectedMoney,350,290);
    }
  }
  hover(point){
    const rules=this.phase==='rules',next=this.phase==='continue';
    const yesRect=rules?NATIVE_SMALL_LOTTO_HITS.startYes:NATIVE_SMALL_LOTTO_HITS.continueYes;
    const noRect=rules?NATIVE_SMALL_LOTTO_HITS.startNo:NATIVE_SMALL_LOTTO_HITS.continueNo;
    this.yes.hidden=!(rules||next)||!nativeRectContains(point,yesRect);
    this.no.hidden=!(rules||next)||!nativeRectContains(point,noRect);
    place(this.yes,rules?377:244,rules?380:268);place(this.no,rules?457:324,rules?380:268);
  }
  play(){
    if(this.actionPending||this.isSuspended())return;
    this.actionPending=true;this.onSound('click');this.onAction({choice:'play'});
  }
  openResult(){
    this.phase=this.lastResult.prize>0?'win':'loss';this.animation.revealed=6;
    this.animation.position=this.lastResult.faces[5]-1;
    this.onStopSound('roll2');this.onSound(this.phase);this.paint();
  }
  down(point){
    if(this.disposed||this.isSuspended()||this.actionPending)return;
    if(this.phase==='empty'){this.onSound('click');this.onClose();return;}
    if(this.phase==='rules'){
      if(nativeRectContains(point,NATIVE_SMALL_LOTTO_HITS.startYes))this.play();
      else if(nativeRectContains(point,NATIVE_SMALL_LOTTO_HITS.startNo)){this.onSound('click');this.onClose();}
    }else if(this.phase==='spin'){
      if(nativeRectContains(point,NATIVE_SMALL_LOTTO_HITS.stop)){
        this.onSound('click');this.animation.skipped=true;this.animation.revealed=6;
        this.animation.position=this.lastResult.faces[5]-1;this.onStopSound('roll2');this.paint();
      }else if(this.animation.revealed===6&&nativeRectContains(point,NATIVE_SMALL_LOTTO_HITS.result)){
        this.onSound('click');this.openResult();
      }
    }else if(this.phase==='win'||this.phase==='loss'){
      this.onSound('click');
      if(this.collectedMoney===0)this.phase='empty';else this.phase='continue';
      this.setPoint([281,286]);this.paint();
    }else if(this.phase==='continue'){
      if(nativeRectContains(point,NATIVE_SMALL_LOTTO_HITS.continueYes))this.play();
      else if(nativeRectContains(point,NATIVE_SMALL_LOTTO_HITS.continueNo)){this.onSound('click');this.onClose();}
    }
  }
  advance(delta){
    if(this.disposed||this.isSuspended()||this.phase!=='spin'||!this.animation)return;
    const count=this.animation.revealed;
    if(advanceSmallLottoAnimation(this.animation,this.lastResult.faces,delta)){this.openResult();return;}
    if(this.animation.revealed!==count){this.onSound('ballclick');this.paintNumbers();}
    this.paintDisc();
  }
  key(key,repeat=false){
    if(this.disposed)return false;
    if(this.isSuspended())return true;
    if(key==='ArrowUp'||key==='ArrowDown'){
      if(this.phase==='rules')this.setPoint(key==='ArrowUp'?[493,395]:[413,395]);
      else if(this.phase==='continue')this.setPoint(key==='ArrowUp'?[361,286]:[281,286]);
      else if(this.phase==='spin')this.setPoint(key==='ArrowUp'?[553,349]:[487,411]);
      return true;
    }
    if(key==='Enter'||key===' '){if(!repeat)this.down(this.surface.pointer);return true;}
    // Escape was not mapped in the original mini-game message table.
    return ['Escape','Tab','ArrowLeft','ArrowRight'].includes(key);
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;
    for(const sound of ['random','roll2','win','loss'])this.onStopSound(sound);
    this.surface.dispose();
  }
}
