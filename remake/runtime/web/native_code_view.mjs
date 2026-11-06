// NumberDisc: 4DBE90/4DCF90/4DFF50. The six digits are chosen with the
// original disc, never a browser text field or a second confirmation dialog.
import {NativeCasinoFrame,nativeRectContains} from './native_casino_frame.mjs';
import {STATUE_CONTROLS} from './native_statue_view.mjs';
import {setImageSource} from './core/ui/image_dom.mjs';

export class NativeCodeView{
  constructor({root,manifest,isSuspended=()=>false,onSubmit,onClose,onSound=()=>{},onStopSound=()=>{}}){
    if(manifest.disc?.length!==30||manifest.numbers?.length!==11)throw new Error('兑换数字符盘原素材不完整');
    Object.assign(this,{manifest,isSuspended,onSubmit,onClose,onSound,onStopSound});
    this.symbols=[10,-1,-1,-1,-1,-1];this.selected=0;this.frame=0;this.target=0;
    this.direction=0;this.keyboardIndex=4;this.blink=true;this.blinkCount=0;this.heldMs=0;this.held=false;this.pending=false;
    this.surface=new NativeCasinoFrame({root,title:'赌场数字符盘',cursor:manifest.cursor,isSuspended,
      onDown:(point,event)=>{if(event.button===0)this.activate(point);},
      onUp:()=>this.release(),onFrame:delta=>this.draw(delta)});
    this.surface.image(manifest.background.image,0,0);
    this.disc=this.surface.image(manifest.disc[0].image,0,0);
    this.slots=Array.from({length:6},(_,i)=>{
      const image=this.surface.image(null,385+35*i,90);image.setAttribute('role','img');return image;
    });
    const names=['离开兑换','下一个数字位','上一个数字位','清除当前数字位','输入当前数字','向前转动数字盘','向后转动数字盘'];
    this.controls=STATUE_CONTROLS.map((row,i)=>this.surface.control(names[i],row.bounds));
    this.surface.pointer=[508,386];this.paint();
    this.keys=new AbortController();window.addEventListener('keyup',()=>this.release(),{signal:this.keys.signal});
  }
  get active(){return !this.disposed;}
  move(step){
    if(this.symbols[this.selected]===10)this.symbols[this.selected]=-1;
    this.selected=Math.max(0,Math.min(5,this.selected+step));
    if(this.symbols[this.selected]===-1)this.symbols[this.selected]=10;
  }
  step(){this.frame+=this.direction;if(this.frame>=30)this.frame=0;if(this.frame<0)this.frame=29;}
  draw(delta){
    if(this.pending)return;
    if(++this.blinkCount>50){this.blink=!this.blink;this.blinkCount=0;}
    if(this.held)this.heldMs+=delta;
    const continuous=this.held&&this.heldMs>500&&this.direction;
    if(continuous)this.onSound('roll',{loop:true,singleVoice:true});
    if(this.direction&&(continuous||this.frame!==this.target))this.step();
    if(continuous)this.target=this.frame;
    this.paint();
  }
  release(){
    if(this.disposed)return;this.held=false;this.heldMs=0;
    if(this.direction){let remaining=30;while(this.frame%3!==0&&remaining-->0)this.step();this.target=this.frame;this.direction=0;}
    this.onStopSound('roll');this.paint();
  }
  paint(){
    if(this.disposed)return;
    setImageSource(this.disc,this.manifest.disc[this.frame].image);this.disc.alt=`当前数字 ${Math.trunc(this.target/3)}`;
    this.slots.forEach((image,i)=>{
      const digit=this.symbols[i];image.hidden=digit<0||i===this.selected&&!this.blink;
      if(digit>=0)setImageSource(image,this.manifest.numbers[digit].image);
      image.alt=`兑换码第${i+1}位，${digit<0||digit===10?'空白':digit}${i===this.selected?'，当前输入位':''}`;
    });
  }
  activate(point){
    if(this.disposed||this.pending||this.isSuspended())return;
    const index=STATUE_CONTROLS.findIndex(row=>nativeRectContains(point,row.bounds));if(index<0)return;
    this.onSound(index<5?'click':'rotateClick');
    if(index===0){this.onClose();return;}
    if(index===1||index===2)this.move(index===1?1:-1);
    else if(index===3)this.symbols[this.selected]=10;
    else if(index===4){
      this.symbols[this.selected]=Math.trunc(this.target/3);this.selected=Math.min(5,this.selected+1);
      if(this.symbols[this.selected]===-1)this.symbols[this.selected]=10;
      if(this.symbols.every(digit=>digit!==-1)){
        this.pending=true;this.onSubmit({text:this.symbols.join('')});
      }
    }else{
      this.target+=index===5?3:-3;if(this.target>=30)this.target=0;if(this.target<0)this.target=29;
      this.direction=index===5?1:-1;this.held=true;this.heldMs=0;
    }
    this.paint();
  }
  resume(){this.pending=false;}
  key(key,repeat=false){
    if(this.disposed)return false;if(this.isSuspended()||this.pending)return true;
    if(key==='ArrowUp'||key==='ArrowDown'){
      this.keyboardIndex=Math.max(0,Math.min(6,this.keyboardIndex+(key==='ArrowUp'?-1:1)));
      this.surface.setPointer(STATUE_CONTROLS[this.keyboardIndex].center);
    }else if((key==='Enter'||key===' ')&&!repeat)this.activate(this.surface.pointer);
    return true;
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.keys.abort();this.onStopSound('roll');this.surface.dispose();}
}
