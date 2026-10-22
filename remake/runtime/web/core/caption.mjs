// Original style3: 45F2D0 / 460360 / 4B9020. Coordinate plane is 640x480.
export function captionLayout(text, height=19) {
  const characters=[...text];
  const byteLength=characters.reduce((n,char)=>n+(char.codePointAt(0)>127?2:1),0);
  const textWidth=(byteLength*height)>>1;
  const x=(640-textWidth-30)>>1,y=(480-height)>>1;
  return {text:{x:x-1,y:y-1},
    shade:{x:x-5,y:y-5,width:textWidth+70,height:height+16},
    wait:{x:x+characters.length*(height+2)+2,y:y+height-29}};
}

export class CaptionPlayback {
  constructor(text,now,interval=120) {
    this.characters=[...text];this.started=now;this.interval=interval;
    this.revealed=0;this.closed=false;
  }
  tick(now) {
    if(!this.closed)this.revealed=Math.max(this.revealed,
      Math.min(this.characters.length,1+Math.floor(Math.max(0,now-this.started)/this.interval)));
    return this.characters.slice(0,this.revealed).join('');
  }
  get complete(){return this.revealed===this.characters.length;}
  advance() {
    if(this.closed)return false;
    if(!this.complete){this.revealed=this.characters.length;return false;}
    this.closed=true;return true;
  }
}
