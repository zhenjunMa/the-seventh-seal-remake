// Style3 keeps a 640x480 plane, with the final text centered in its shade.
export function captionLayout(text, height=19, {font=null,characterStep=height+2,waitWidth=31,waitHeight=29}={}) {
  let width=0,left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(const char of text){
    const glyph=font?.glyphs[char];
    if(glyph?.width&&glyph?.height){
      left=Math.min(left,width+glyph.offset_x);top=Math.min(top,glyph.offset_y);
      right=Math.max(right,width+glyph.offset_x+glyph.width+1);
      bottom=Math.max(bottom,glyph.offset_y+glyph.height+1);
    }
    width+=char.codePointAt(0)>127?characterStep:(glyph?.advance??Math.ceil(height/2));
  }
  const ink=Number.isFinite(left)?{left,top,width:right-left,height:bottom-top}:{left:0,top:0,width,height};
  // Mirror the continuation marker's space on the left so the text itself
  // stays centered, including while it is still being revealed.
  const shade={width:Math.ceil(Math.max(width,ink.width))+2*(waitWidth+4),height:Math.max(height+16,ink.height+16,waitHeight+4)};
  shade.x=Math.floor((640-shade.width)/2);shade.y=Math.floor((480-shade.height)/2);
  const x=shade.x+Math.floor((shade.width-ink.width)/2)-ink.left;
  const y=shade.y+Math.floor((shade.height-ink.height)/2)-ink.top;
  return {text:{x,y},shade,
    wait:{x:x+ink.left+ink.width+2,y:shade.y+Math.floor((shade.height-waitHeight)/2)}};
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
