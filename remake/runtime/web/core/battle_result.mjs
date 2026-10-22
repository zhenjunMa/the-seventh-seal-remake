// Read-only presentation of one already calculated reward plan. No RNG, world
// writes or growth calculations occur while the player advances this report.
const need=(ok,message)=>{if(!ok)throw new Error(`战斗报告：${message}`);};
const copy=structuredClone;
export function validateBattleResultManifest(data){
  need(data?.schema==='seventh-seal-battle-result'&&data.version===1,'来源版本无效');
  need(data.native_canvas?.width===640&&data.native_canvas.height===480,'逻辑平面无效');
  for(const id of ['fight_report_01','fight_report_02','victor']){
    const asset=data.assets?.[id];need(asset&&Array.isArray(asset.frames)&&asset.frames.length>0,'原图集缺失');
    for(const frame of asset.frames)for(const path of [frame.image,frame.indexed_image].filter(Boolean))need(/^assets\/battle_result\/[A-Za-z0-9_./-]+\.png$/.test(path)&&!path.split('/').includes('..'),'原图片路径无效');
  }
  need(data.assets.fight_report_02.frames.length===4,'通知原帧缺失');return data;
}

export class BattleResultSequence{
  constructor({battleId,summary,actors,now=0,victorFrames=24}){
    need(typeof battleId==='string'&&summary?.battle_id===battleId&&Array.isArray(summary.experience),'奖励来源不匹配');
    this.battleId=battleId;this.summary=copy(summary);this.actors=copy(actors.filter(a=>a.side==='player'));
    this.rows=summary.experience.map(row=>{const actor=this.actors.find(a=>a.id===row.role_id);need(actor&&Number.isInteger(row.experience)&&row.experience>=0,'人物经验无效');return {...copy(row),name:actor.name,gain:0};});
    this.victorFrames=victorFrames;this.victorFrame=0;this.victorFinished=false;this.reportX=-630;this.reportLanded=false;this.velocity=120;this.slideSteps=0;
    this.phase='counting';this.page=0;this.done=false;this.held=false;this.lastVictor=this.lastReport=this.lastCount=now;
    this.money=summary.money_before;this.moneyGain=0;this.combo=0;this.practice=0;this.notices=[];this.pendingRoles=[];
    const ids=new Set();this.groups=new Map();
    for(const event of summary.notifications??[]){
      need(['role-level-up','skill-learned','skill-level-up','practice-bonus'].includes(event.type)&&typeof event.id==='string'&&!ids.has(event.id),'通知类型或身份无效');ids.add(event.id);
      if(event.type==='role-level-up'&&event.experience_gained_at>0)this.pendingRoles.push(copy(event));else this.enqueue(event);
    }
  }
  enqueue(event){
    const actorIndex=event.type==='practice-bonus'?6:this.actors.findIndex(a=>a.id===event.actor_id);need(actorIndex>=0,'通知人物未参战');
    const ordinal=this.groups.get(actorIndex)??0;this.groups.set(actorIndex,ordinal+1);
    this.notices.push({...copy(event),actor_index:actorIndex,ordinal,x:500,y:actorIndex*35+103,active:ordinal===0,landed:false,last:0});
  }
  revealRoleNotices(skipped=false){
    const ready=this.pendingRoles.filter(n=>this.rows.find(r=>r.role_id===n.actor_id)?.gain>=n.experience_gained_at);
    // Native 50E070 fast-forwards each participant in row order. Normal
    // counting crosses thresholds in time order, with row order breaking ties.
    if(skipped)ready.sort((a,b)=>this.actors.findIndex(r=>r.id===a.actor_id)-this.actors.findIndex(r=>r.id===b.actor_id)||a.experience_gained_at-b.experience_gained_at);
    for(const event of ready)this.enqueue(event);const shown=new Set(ready.map(n=>n.id));this.pendingRoles=this.pendingRoles.filter(n=>!shown.has(n.id));
  }
  tick(now){
    if(this.done)return;
    // Native 50DB70 advances each timer at most once per render call. A slow
    // browser frame does not silently acknowledge several notices.
    for(const notice of this.notices)if(notice.active&&!notice.landed&&now-notice.last>=30){notice.last=now;notice.x=Math.max(280,notice.x-80);if(notice.x===280)notice.landed=true;}
    if(this.phase!=='counting')return;
    if(!this.victorFinished){if(now-this.lastVictor>=60){this.lastVictor=now;if(this.victorFrame<this.victorFrames-1)this.victorFrame++;else this.victorFinished=true;}return;}
    if(!this.reportLanded){if(now-this.lastReport>=30){this.lastReport=now;if(this.reportX<0){if((this.slideSteps&3)!==0&&this.velocity>10)this.velocity-=this.velocity>>2;this.slideSteps++;this.reportX+=this.velocity;}else{this.reportX=0;this.reportLanded=true;}}return;}
    if(now-this.lastCount>=10){this.lastCount=now;for(const row of this.rows)row.gain=Math.min(row.experience,row.gain+1);this.moneyGain=Math.min(this.summary.money,this.moneyGain+1);this.money=(this.summary.money_before+this.moneyGain)>>>0;this.combo=Math.min(this.summary.maximum_player_chain,this.combo+1);this.practice=Math.min(this.summary.practice_total??0,this.practice+1);this.revealRoleNotices();}
    if(this.rows.every(r=>r.gain===r.experience)&&this.moneyGain===this.summary.money&&this.combo===this.summary.maximum_player_chain&&this.practice===(this.summary.practice_total??0))this.phase='notices';
  }
  release(){this.held=false;}
  advance({repeat=false,now=0}={}){
    if(this.done||repeat||this.held)return {kind:'ignored'};
    this.held=true;
    if(!this.victorFinished){this.victorFinished=true;this.lastReport=now;return {kind:'victory-skipped'};}
    if(this.phase==='counting'){
      this.reportX=0;this.reportLanded=true;for(const row of this.rows)row.gain=row.experience;this.moneyGain=this.summary.money;this.money=this.summary.money_after;this.combo=this.summary.maximum_player_chain;this.practice=this.summary.practice_total??0;this.revealRoleNotices(true);this.phase='notices';return {kind:'counters-completed'};
    }
    if(this.notices.every(n=>n.landed)){this.done=true;return {kind:'complete'};}
    for(const n of this.notices)if(n.active&&!n.landed){n.x=280;n.landed=true;}
    const next=this.notices.filter(n=>!n.landed&&n.ordinal===this.page+1);
    for(const n of next){n.active=true;n.last=now;}
    if(next.length)this.page++;
    return {kind:'notifications-advanced',ids:next.map(n=>n.id)};
  }
  snapshot(){return copy({battle_id:this.battleId,phase:this.phase,page:this.page,done:this.done,victor_frame:this.victorFrame,victor_finished:this.victorFinished,report_x:this.reportX,report_landed:this.reportLanded,
    experience:this.rows,money:this.money,combo:this.combo,practice:this.practice,notifications:this.notices});}
}
