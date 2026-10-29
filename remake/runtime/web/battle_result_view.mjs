import {BattleResultSequence,validateBattleResultManifest} from './core/battle_result.mjs';
import {battleResources,drawBattleImage} from './core/battle_resources.mjs';

// Original report assets stay in the battle's 640x480 plane. The reward plan
// belongs to combat; this view only counts and acknowledges its presentation.
export class BattleResultView{
  constructor({root,manifest,onComplete,onEvent=()=>{},textRenderer=null,now=()=>performance.now()}){
    Object.assign(this,{root,manifest:validateBattleResultManifest(manifest),onComplete,onEvent,textRenderer,now});
    this.doc=root.ownerDocument;this.images=new Map();this.textCache=new Map();this.active=false;this.resourceScope=battleResources.createScope('battle-result');
    this.hit=this.doc.createElement('button');this.hit.type='button';this.hit.className='battle-report-hit';
    this.hit.setAttribute('aria-label','战斗结算，按空格继续');this.hit.hidden=true;this.hit.onclick=()=>{this.advance();this.release();};root.append(this.hit);
    this.status=this.doc.createElement('div');this.status.className='sr-only';this.status.setAttribute('role','status');this.status.setAttribute('aria-live','polite');root.append(this.status);
  }
  async prepare({onProgress=()=>{}}={}){
    const paths=new Set(Object.values(this.manifest.assets).flatMap(a=>a.frames.flatMap(f=>[f.image,f.indexed_image,f.inverse_mask_image,f.render_image].filter(Boolean))));
    this.images=await this.resourceScope.preparePaths([...paths],{onProgress});this.ready=true;
  }
  open(snapshot,now=this.now()){
    if(this.model?.battleId===snapshot.id)return;
    if(snapshot.phase!=='victory'||!snapshot.rewards)return;
    this.model=new BattleResultSequence({battleId:snapshot.id,summary:snapshot.rewards,actors:snapshot.actors,now,victorFrames:this.manifest.assets.victor.frames.length});
    this.active=true;this.hit.hidden=false;this.hit.focus({preventScroll:true});this.publish('opened');
  }
  publish(kind){
    const s=this.model.snapshot();this.root.dataset.resultStage=s.phase;this.root.dataset.resultPage=String(s.page);this.root.dataset.resultComplete=String(s.done);
    this.root.dataset.resultNotices=JSON.stringify(s.notifications.filter(n=>n.active).map(({id,type,actor_name,skill_name,after,x})=>({id,type,actor_name,skill_name,after,x})));
    const notices=s.notifications.filter(n=>n.active).map(n=>n.type==='practice-bonus'?`技巧经验加值 ${n.value}`:`${n.actor_name} ${n.type==='role-level-up'?'人物升级':n.type==='skill-level-up'?'招式升级':'学会招式'}${n.skill_name?' '+n.skill_name:''}`);
    const message=['战斗胜利',...s.experience.map(r=>`${r.name} 获得经验 ${r.experience}`),`获得金钱 ${this.model.summary.money}`,
      ...this.model.summary.drops.map(d=>`${d.name} ×${d.quantity}`),...notices,'按空格继续，全部展示后再按空格返回地图'].join('。');
    if(this.status.textContent!==message)this.status.textContent=message;
    if(kind)this.onEvent({type:'battle-report-'+kind,battle_id:s.battle_id,phase:s.phase,page:s.page,visible_notice_ids:s.notifications.filter(n=>n.active).map(n=>n.id),complete:s.done});
  }
  advance(repeat=false,now=this.now()){
    if(!this.active||!this.model)return;
    const result=this.model.advance({repeat,now});if(result.kind==='ignored')return;
    this.publish(result.kind);if(result.kind==='complete')this.onComplete();
  }
  release(){this.model?.release();}
  key(key,repeat=false){if(!this.active)return false;if(key===' ')this.advance(repeat);return true;}
  get complete(){return this.model?.done??false;}
  asset(ctx,glow,id,frame,x,y,{inverseMask=false}={}){
    const source=this.manifest.assets[id].frames[frame];if(!source)return;
    const image=this.images.get(inverseMask?(source.render_image??source.inverse_mask_image??source.image):source.image);if(image)drawBattleImage(ctx,image,x,y);
    if(source.indexed_image){const indexed=this.images.get(source.indexed_image);if(indexed){glow.save();glow.globalCompositeOperation='lighter';drawBattleImage(glow,indexed,x,y);glow.restore();}}
  }
  text(ctx,value,x,y,{width=null,align='left',shadow=true}={}){
    value=String(value);ctx.font='18px "全真特黑體", SimSun';ctx.textBaseline='top';ctx.textAlign=align;
    // The requested original typeface is unavailable on this host. Reuse the
    // checked GDI SimSun18 glyphs where covered, retaining Canvas fallback.
    if(this.textRenderer?.supports(value,'simsun18')){
      const key=JSON.stringify([value,width,align,shadow]);let entry=this.textCache.get(key);
      if(!entry){const canvas=this.doc.createElement('canvas'),placement=this.textRenderer.paint(canvas,value,{font:'simsun18',foreground:'#fff',shadow:shadow?'#000':null,maxWidth:width,maxLines:1,align});entry={canvas,...placement};if(this.textCache.size>=128)this.textCache.clear();this.textCache.set(key,entry);}
      ctx.drawImage(entry.canvas,x+entry.offsetX,y+entry.offsetY);return;
    }
    // x is the source rectangle's left edge; Canvas expects the alignment
    // anchor instead. Keep the same rectangle as the glyph-atlas path.
    const anchor=x+(width===null?0:align==='center'?width/2:align==='right'?width:0);
    if(shadow){ctx.fillStyle='#000';ctx.fillText(value,anchor+1,y+1,width??640);}ctx.fillStyle='#fff';ctx.fillText(value,anchor,y,width??640);
  }
  nextExperience(row){
    const before=row.before_total_experience??row.total_experience-row.experience;
    let threshold=row.before_next_level_experience??row.next_level_experience;
    for(const level of row.levels??[])if(row.gain>=level.gained_at)threshold=level.next_level_experience;
    if(row.gain===row.experience)return row.experience_remaining_raw;
    return threshold-before-row.gain;
  }
  draw(ctx,glow,now){
    if(!this.active||!this.model)return;
    this.model.tick(now);const s=this.model.snapshot();
    if(!s.victor_finished){this.asset(ctx,glow,'victor',s.victor_frame,0,0);return;}
    const x=s.report_x;this.asset(ctx,glow,'fight_report_01',0,x,0,{inverseMask:true});
    for(let i=0;i<s.experience.length;i++){const row=s.experience[i],y=110+i*35;this.text(ctx,row.name,x+55,y);this.text(ctx,String(row.gain).padStart(5,' '),x+120,y);this.text(ctx,this.nextExperience(row),x+220,y);}
    this.text(ctx,String(s.money).padStart(9,'0').slice(-9),x+112,75);this.text(ctx,s.combo,x+112,251);this.text(ctx,s.practice,x+112,320);
    for(let i=0;i<this.model.summary.drops.length;i+=4)this.text(ctx,this.model.summary.drops.slice(i,i+4).map(d=>`${d.name}x${d.quantity}  `).join(''),x+90,353+Math.floor(i/4)*33);
    // Native 50BB50 groups by actor. Older active records remain behind the
    // new card at the same row; never replace the queue with a single toast.
    for(const notice of s.notifications)if(notice.active){
      this.asset(ctx,glow,'fight_report_02',notice.type==='practice-bonus'?2:notice.type==='skill-learned'?0:1,notice.x,notice.y);
      this.text(ctx,notice.type==='practice-bonus'?`x${notice.value}`:notice.skill_name??notice.actor_name,notice.x+20,notice.y+3,{width:106,align:'center',shadow:false});
    }
    this.publish();
  }
  dispose(){this.resourceScope.release();this.active=false;this.hit.remove();this.status.remove();this.images.clear();this.textCache.clear();}
}
