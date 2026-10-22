// Native 460360/466450: DBCS cells and Latin words advance independently.
// These are presentation pages; no script mutation or world state lives here.
export function dialoguePages(text,{width,height,fontHeight,lineHeight,scroll=false,measureLatin=word=>word.length*fontHeight/2}){
  const tokens=[];
  for(const part of String(text).replace(/\r\n?/g,'\n').match(/\n|[^\x00-\x7f]|[^\S\n]|[^\s\x80-\uffff]+ ?/gu)??[]){
    if(part==='\n'){tokens.push({text:'',newline:true});continue;}
    const latin=part.codePointAt(0)<128;
    const inkWidth=latin?measureLatin(part.trimEnd()):fontHeight;
    tokens.push({text:part.trimEnd(),width:inkWidth,advance:latin?inkWidth+measureLatin(' ')+2:fontHeight+2});
  }
  const pages=[];let runs=[],carriedRuns=[],x=0,y=0;
  const finish=()=>{pages.push({runs,carriedRuns,text:[...carriedRuns,...runs].map(run=>run.text).join(''),pen:{x,y}});};
  const newline=()=>{
    const nextY=y+lineHeight;
    if(nextY>height-10){
      finish();carriedRuns=scroll?[...carriedRuns,...runs].filter(run=>run.y>=lineHeight).map(run=>({...run,y:run.y-lineHeight})):[];
      runs=[];x=0;y=scroll?nextY-lineHeight:0;
    }else{x=0;y=nextY;}
  };
  for(const token of tokens){
    if(token.newline){newline();continue;}
    if(x>0&&x+token.width>width)newline();
    runs.push({...token,x,y});x+=token.advance;
  }
  if(runs.length||!pages.length)finish();
  return pages;
}

export class DialoguePlayback {
  constructor(pages,{now=0,interval=120,choices=[]}={}){
    this.pages=pages;this.interval=interval;this.choices=choices??[];
    this.page=0;this.revealed=0;this.started=now;this.stage='typing';this.selected=0;
  }
  get current(){return this.pages[this.page];}
  get complete(){return this.revealed>=this.current.runs.length;}
  tick(now){
    if(this.stage==='typing'){
      this.revealed=Math.max(this.revealed,Math.min(this.current.runs.length,1+Math.floor(Math.max(0,now-this.started)/this.interval)));
      if(this.complete)this.stage=this.page===this.pages.length-1&&this.choices.length?'choices':'waiting';
    }
    return this.current.runs.slice(0,this.revealed);
  }
  advance(now){
    if(this.stage==='closed')return {kind:'none'};
    if(this.stage==='choices')return {kind:'choice',index:this.choices[this.selected].index};
    if(!this.complete){this.revealed=this.current.runs.length;this.stage='typing';return {kind:'reveal'};}
    if(this.page+1<this.pages.length){this.page++;this.revealed=0;this.started=now;this.stage='typing';return {kind:'page'};}
    if(this.choices.length){this.stage='choices';return {kind:'choices'};}
    this.stage='closed';return {kind:'close'};
  }
  move(delta){
    if(this.stage!=='choices')return false;
    const previous=this.selected;this.selected=Math.max(0,Math.min(this.choices.length-1,previous+delta));
    return previous!==this.selected;
  }
  select(index){
    if(this.stage!=='choices')return false;
    const selected=this.choices.findIndex(choice=>choice.index===index);if(selected<0)return false;
    this.selected=selected;return true;
  }
}
