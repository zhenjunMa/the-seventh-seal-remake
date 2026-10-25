import {battleViewport,battleActorPositions,battleBallState} from './core/battle_layout.mjs';
import {operationMnuTextOptions} from './core/menu_presentation.mjs';
import {BattleResultView} from './battle_result_view.mjs';
import {battleResources,drawBattleImage} from './core/battle_resources.mjs';

const clamp=n=>Math.max(0,Math.min(1,n));
const terminal=phase=>['victory','defeat','escaped','interrupted','closed'].includes(phase);
const originalSlots=[[5,386],[55,334],[205,396],[255,344]];
// GAME.exe 0x429c10: top, upper-left, lower-left, bottom, lower-right,
// upper-right, center. Native navigation keeps unavailable slots focusable.
const wheelNavigation={
  ArrowLeft:[1,1,2,2,3,6,1],
  ArrowUp:[0,0,1,6,5,0,0],
  ArrowRight:[5,6,3,4,4,5,5],
  ArrowDown:[6,2,3,3,3,4,3]
};

// Stable transparent controls over the original source pixels. No world writes.
export class BattleMenuView{
  constructor({root,manifest,battle,getSettings,getBindings=null,playCue,onReturn,onStage=()=>{},textRenderer=null,memory=null,returnLabel=null,resultManifest=null,onResultEvent=()=>{},now=()=>performance.now(),reuseReturnButton=true}){
    Object.assign(this,{root,manifest,battle,getSettings,getBindings,playCue,onReturn,onStage,textRenderer,returnLabel});
    this.doc=root.ownerDocument;this.images=new Map();this.players=new Map();this.targets=new Map();this.memory=memory??new Map();this.textCache=new Map();this.ballCache=new Map();this.fontOptions=new WeakMap();this.stage='waiting';this.focusIndex=0;this.listIndex=0;this.listOffset=0;this.draft=null;this.message='';this.epoch=0;this.cueSequence=0;
    this.menus=new Map(manifest.menus.map(m=>[m.id,m]));
    this.frame=this.doc.createElement('div');this.frame.className='battle-interface-frame';this.frame.tabIndex=-1;this.root.replaceChildren(this.frame);
    this.canvas=this.doc.createElement('canvas');this.canvas.width=640;this.canvas.height=480;this.canvas.className='battle-interface-pixels';this.canvas.setAttribute('aria-hidden','true');this.frame.append(this.canvas);this.ctx=this.canvas.getContext('2d');
    this.glowCanvas=this.doc.createElement('canvas');this.glowCanvas.width=640;this.glowCanvas.height=480;this.glowCanvas.className='battle-interface-glow';this.glowCanvas.setAttribute('aria-hidden','true');this.frame.append(this.glowCanvas);this.glowCtx=this.glowCanvas.getContext('2d');
    this.actorLayer=this.doc.createElement('div');this.frame.append(this.actorLayer);
    this.targetLayer=this.doc.createElement('div');this.frame.append(this.targetLayer);
    this.wheelButtons=Array.from({length:7},(_,i)=>{
      const widget=this.menus.get('game002d')?.widgets.find(w=>w.name===String(i+1).padStart(3,'0'));
      const rect=widget?.rect??[{left:50,top:5,right:73,bottom:29},{left:9,top:30,right:32,bottom:53},{left:9,top:76,right:32,bottom:99},{left:50,top:99,right:73,bottom:122},{left:89,top:76,right:112,bottom:99},{left:89,top:30,right:112,bottom:53},{left:49,top:53,right:76,bottom:80}][i];
      const b=this.button('battle-wheel-hit',()=>this.activateWheel(i));b.dataset.slot=String(i);this.place(b,490+rect.left,340+rect.top,rect.right-rect.left+1,rect.bottom-rect.top+1);b.onfocus=()=>{this.focusIndex=i;this.remember();};this.frame.append(b);return b;
    });
    this.listButtons=Array.from({length:6},(_,i)=>{const b=this.button('battle-list-hit',()=>this.selectEntry(this.listOffset+i));b.onfocus=()=>{this.listIndex=this.listOffset+i;this.remember();this.setInfo(this.entries?.[this.listIndex]?.description??'');};this.frame.append(b);return b;});
    this.previous=this.button('battle-scroll-hit',()=>this.moveList(-6));this.previous.setAttribute('aria-label','上一页');this.place(this.previous,467+152,274+40,12,16);this.frame.append(this.previous);
    this.next=this.button('battle-scroll-hit',()=>this.moveList(6));this.next.setAttribute('aria-label','下一页');this.place(this.next,467+152,274+186,12,16);this.frame.append(this.next);
    this.returnButton=(reuseReturnButton?this.doc.getElementById('battleReturn'):null)??this.doc.createElement('button');this.returnButton.id='battleReturn';this.returnButton.className='battle-result-return';this.returnButton.onclick=()=>this.onReturn();this.frame.append(this.returnButton);
    this.info=this.doc.createElement('span');this.info.className='sr-only';this.info.setAttribute('role','status');this.frame.append(this.info);
    this.resultView=resultManifest?new BattleResultView({root:this.frame,manifest:resultManifest,onComplete:onReturn,onEvent:onResultEvent,textRenderer,now}):null;
    this.resizeObserver=new ResizeObserver(()=>this.fit());this.resizeObserver.observe(root);this.fit();
  }
  button(className,action){const b=this.doc.createElement('button');b.type='button';b.className=className;b.onclick=()=>{if(b.getAttribute('aria-disabled')==='true'){this.reject('当前无法执行此操作。');return;}action();};return b;}
  place(node,x,y,w,h){Object.assign(node.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});}
  fit(){const box=this.root.getBoundingClientRect(),v=battleViewport(box.width,box.height);Object.assign(this.frame.style,{left:v.x+'px',top:v.y+'px',transform:`scale(${v.scale})`});}
  async prepare({onProgress=()=>{}}={}){
    const paths=new Set();
    for(const menu of this.manifest.menus)for(const image of menu.images)paths.add(image.image);
    for(const asset of Object.values(this.manifest.assets))for(const f of asset.frames){paths.add(f.image);if(f.indexed_image)paths.add(f.indexed_image);if(f.inverse_mask_image)paths.add(f.inverse_mask_image);}
    this.images=await battleResources.preparePaths([...paths],{scope:'battle-hud',onProgress:p=>onProgress({...p,stage:'hud'})});
    await this.resultView?.prepare({onProgress:p=>onProgress({...p,stage:'result'})});
  }
  cue(name){this.playCue?.(name,`battle-menu:${this.epoch}:${++this.cueSequence}`);}
  setInfo(message){this.message=message;this.info.textContent=message;}
  reject(message){this.setInfo(message);this.cue('menuError');}
  setStage(stage){if(this.stage===stage)return;this.stage=stage;this.root.dataset.focusLayer=stage;this.onStage(stage);}
  ready(){return this.battle.readyPlayerIds?.()??(this.snapshot?.phase==='command'?[this.snapshot.player_id]:[]);}
  available(id=this.snapshot?.player_id){return this.battle.canCommand?.(id)??this.snapshot?.phase==='command';}
  skills(){const id=this.snapshot.player_id,order=this.snapshot.source.player_command_order?.[id]??[];return Object.values(this.battle.skills).filter(s=>s.actor_id===id).sort((a,b)=>(order.indexOf(a.id)<0?999:order.indexOf(a.id))-(order.indexOf(b.id)<0?999:order.indexOf(b.id)));}
  slots(){const skills=this.skills(),bindings=this.getBindings?.(this.snapshot.player_id);return (bindings??[...Array.from({length:3},(_,i)=>({type:0,index_one_based:(skills[i]?.original_skill_index??i)+1})),...[1,2,3,4].map(n=>({type:2,index_one_based:n,icon:n-1,color:0}))]).map((slot,i)=>{const skill=slot.type===0?(bindings?skills.find(s=>s.original_skill_index===slot.index_one_based-1):skills[i]):null;return {...slot,skill,name:slot.type===2?['使用招式','使用物品','防御','逃跑'][slot.index_one_based-1]:skill?.name??slot.name??(slot.type===1?'编成技巧':'当前不可用')};});}
  remember(){if(this.snapshot)this.memory.set(this.snapshot.player_id,{wheel:this.focusIndex,list:this.listIndex,target:this.targetId});}
  update(snapshot){
    if(this.disposed)return;const previous=this.snapshot;this.snapshot=snapshot;this.root.dataset.phase=snapshot.phase;this.root.dataset.actorId=snapshot.player_id;this.root.dataset.ticks=String(snapshot.scheduler?.ticks??0);this.root.dataset.readyIds=this.ready().join(',');
    const changed=previous?.player_id!==snapshot.player_id;
    if(changed){this.draft=null;this.entries=null;this.listIndex=0;this.listOffset=0;this.setStage(this.available()?(this.stage==='actors'?'actors':'wheel'):'waiting');const memory=this.getSettings?.().battleCursor==='memory'?this.memory.get(snapshot.player_id):null;this.focusIndex=memory?.wheel??0;this.targetId=memory?.target??null;}
    if(terminal(snapshot.phase)){this.draft=null;this.setStage('result');this.setInfo(snapshot.phase==='victory'?'战斗胜利':snapshot.phase==='defeat'?'队伍已经倒下':snapshot.phase==='escaped'?'已经逃离战斗':snapshot.error??'战斗结束');this.resultView?.open(snapshot);}
    else if(!this.available()){this.draft=null;if(this.stage!=='waiting')this.setStage('waiting');this.setInfo('');}
    else if(this.stage==='waiting'){this.focusIndex=this.getSettings?.().battleCursor==='memory'?(this.memory.get(snapshot.player_id)?.wheel??0):0;this.setStage('wheel');this.needsFocus=true;this.setInfo(snapshot.actors.find(a=>a.id===snapshot.player_id)?.name??'');}
    if(this.stage==='items')this.refreshItems();
    if(this.stage==='skills')for(const entry of this.entries??[])entry.available=this.battle.canChoose(entry.id);
    if(this.stage==='target'){
      const candidates=this.targetActors();if(!candidates.length){this.draft=null;this.setStage(this.returnStage??'wheel');this.setInfo('没有可选择的目标。');}
      else if(!candidates.some(a=>a.id===this.targetId))this.targetId=candidates[0].id;
    }
    this.syncPlayers();this.syncWheel();this.syncList();this.syncTargets();
    this.actorLayer.hidden=this.targetLayer.hidden=Boolean(this.resultView?.active);
    this.returnButton.hidden=this.stage!=='result'||Boolean(this.resultView?.active);this.returnButton.disabled=false;this.returnButton.textContent=this.returnLabel??(snapshot.phase==='defeat'?'返回主菜单':'返回地图');
    if((changed||this.needsFocus)&&this.available()){this.needsFocus=false;(this.stage==='actors'?this.players.get(snapshot.player_id):this.wheelButtons[this.focusIndex])?.focus({preventScroll:true});}
  }
  syncPlayers(){
    const party=this.snapshot.actors.filter(a=>a.side==='player');const ready=this.ready();
    party.forEach((a,index)=>{let b=this.players.get(a.id);if(!b){b=this.button('battle-actor-hit',()=>this.selectActor(a.id));b.dataset.actorId=a.id;this.players.set(a.id,b);this.actorLayer.append(b);}b.hidden=a.escaped||a.state_raw===11;const [x,y]=originalSlots[a.party_slot_zero_based??index]??originalSlots[0];this.place(b,x,y,203,53);const queued=[this.snapshot.scheduler?.pending,...(this.snapshot.scheduler?.queued_commands??[])].some(command=>command?.actor_id===a.id);b.setAttribute('aria-label',`${a.name}，HP ${a.hp.current}/${a.hp.maximum}，MP ${a.mp.current}/${a.mp.maximum}，${queued?'指令已确认':ready.includes(a.id)?'行动槽已满':'充能中'}`);b.setAttribute('aria-pressed',String(a.id===this.snapshot.player_id&&ready.includes(a.id)));b.setAttribute('aria-disabled',String(!this.available(a.id)));});
  }
  syncWheel(){
    const slots=this.slots();this.commandSlots=slots;
    this.wheelButtons.forEach((b,i)=>{const slot=slots[i],skill=slot?.skill;b.hidden=this.stage!=='wheel';b.setAttribute('aria-label',slot?.name??'空快捷栏');b.dataset.skill=skill?.id??'';const supported=slot?.type===0?Boolean(skill)&&this.battle.canChoose(skill.id):slot?.type===2?[Boolean(this.skills().length),Boolean(this.battle.itemData&&this.battle.items().length),typeof this.battle.chooseDefend==='function',typeof this.battle.chooseEscape==='function'][slot.index_one_based-1]:false;b.setAttribute('aria-disabled',String(!this.available()||!supported));});
  }
  selectActor(id){if(!this.available(id)){this.reject('此角色尚不能输入新指令。');return;}if(id===this.snapshot.player_id)return;this.remember();this.battle.selectPlayer(id);this.cue('menuSelect');}
  cycleActor(direction=1){const ids=this.ready().filter(id=>this.available(id));if(!ids.length)return;const current=ids.indexOf(this.snapshot.player_id);this.selectActor(ids[current<0?(direction<0?ids.length-1:0):(current+direction+ids.length)%ids.length]);}
  moveActor(key){const slot={ArrowLeft:0,ArrowUp:1,ArrowDown:2,ArrowRight:3}[key],party=this.snapshot.actors.filter(a=>a.side==='player'),actor=party.find((a,index)=>(a.party_slot_zero_based??index)===slot);if(actor&&this.available(actor.id))this.selectActor(actor.id);}
  activateWheel(index){
    if(this.stage!=='wheel')return;
    if(!this.available()){this.reject('请等待行动槽充满。');return;}this.focusIndex=index;this.remember();
    const slot=this.commandSlots[index];
    if(slot?.type===0){const skill=slot.skill;if(!skill||!this.battle.canChoose(skill.id)){this.reject(this.battle.skillUnavailableReason?.(skill?.id)||'资源不足或招式当前不可用。');return;}this.chooseSkill(skill,'wheel');}
    else if(slot?.type===2&&slot.index_one_based===2)this.openItems();
    else if(slot?.type===2&&slot.index_one_based===1)this.openSkills();
    else if(slot?.type===2&&slot.index_one_based===3&&this.battle.chooseDefend)this.commitFixed('defend');
    else if(slot?.type===2&&slot.index_one_based===4&&this.battle.chooseEscape)this.commitFixed('escape');
    else this.reject('当前无法执行此指令。');
  }
  openSkills(){this.entries=this.skills().map(s=>({id:s.id,name:s.name,description:this.battle.skillUnavailableReason?.(s.id)||`${s.name}　MP ${s.mp_cost}`,available:this.battle.canChoose(s.id),skill:s}));this.openList('skills');}
  refreshItems(){this.entries=this.battle.items().map(item=>({id:item.instance_id,name:item.name,quantity:item.quantity,description:item.description??item.name,item,available:true}));this.listIndex=Math.min(this.listIndex,Math.max(0,this.entries.length-1));this.listOffset=Math.max(0,Math.min(this.listOffset,Math.max(0,this.entries.length-6)));}
  openItems(){this.refreshItems();if(!this.entries.length){this.reject('没有可用的药品。');return;}this.openList('items');}
  openList(stage){this.setStage(stage);this.draft=null;const memory=this.getSettings?.().battleCursor==='memory'?this.memory.get(this.snapshot.player_id):null;this.listIndex=Math.min(memory?.list??0,Math.max(0,this.entries.length-1));this.listOffset=Math.max(0,this.listIndex-5);this.cue('menuOpen');this.syncWheel();this.syncList();this.listButtons[this.listIndex-this.listOffset]?.focus({preventScroll:true});}
  syncList(){const show=['skills','items'].includes(this.stage),menu=this.menus.get(this.stage==='items'?'fight002':'fight001');this.listButtons.forEach((b,i)=>{const entry=this.entries?.[this.listOffset+i];b.hidden=!show||!entry;if(!show||!entry)return;const w=menu.widgets.find(w=>w.name.toLowerCase()==='list'+(i+1)),r=w.rect;this.place(b,467+r.left,274+r.top,r.right-r.left+1,r.bottom-r.top+1);b.dataset.entryId=entry.id;b.setAttribute('aria-label',entry.name+(entry.quantity!==undefined?` ×${entry.quantity}`:''));b.setAttribute('aria-disabled',String(!entry.available||!this.available()));});this.previous.hidden=this.next.hidden=!show;this.previous.setAttribute('aria-disabled',String(this.listOffset===0));this.next.setAttribute('aria-disabled',String(this.listOffset+6>=(this.entries?.length??0)));}
  moveList(amount){if(!this.entries?.length)return;const before=this.listIndex;this.listIndex=Math.max(0,Math.min(this.entries.length-1,this.listIndex+amount));if(before===this.listIndex)return;this.listOffset=Math.max(0,Math.min(this.listOffset,this.listIndex));if(this.listIndex>=this.listOffset+6)this.listOffset=this.listIndex-5;this.syncList();this.listButtons[this.listIndex-this.listOffset]?.focus({preventScroll:true});this.cue('menuSelect');}
  selectEntry(index){const entry=this.entries?.[index];if(!entry?.available||!this.available()){this.reject(this.stage==='skills'&&this.battle.skillUnavailableReason?.(entry?.id)||'此项当前无法使用。');return;}this.listIndex=index;this.remember();if(this.stage==='skills')this.chooseSkill(entry.skill,'skills');else{this.draft={kind:'item',instanceId:entry.id,actorId:this.snapshot.player_id,name:entry.name};this.openTarget('items');}}
  chooseSkill(skill,from){this.draft={kind:'skill',skillId:skill.id,actorId:this.snapshot.player_id,name:skill.name};this.openTarget(from);}
  targetActors(){if(this.draft?.kind==='item'&&this.battle.itemTargetIds){const ids=this.battle.itemTargetIds(this.draft.instanceId);return this.snapshot.actors.filter(a=>ids.includes(a.id));}if(this.draft?.kind==='skill'&&this.battle.targetIdsForSkill){const ids=this.battle.targetIdsForSkill(this.draft.skillId);return this.snapshot.actors.filter(a=>ids.includes(a.id));}const side=this.draft?.kind==='item'?'player':'enemy';return this.snapshot.actors.filter(a=>a.side===side&&a.hp.current>0&&!a.escaped&&a.state_raw!==11);}
  openTarget(from){this.returnStage=from;this.setStage('target');const actors=this.targetActors();const remembered=this.getSettings?.().battleCursor==='memory'?this.memory.get(this.snapshot.player_id)?.target:null;this.targetId=actors.some(a=>a.id===remembered)?remembered:actors[0]?.id;this.cue('menuConfirm');this.setInfo(this.draft.name);this.syncWheel();this.syncList();this.syncTargets();this.targets.get(this.targetId)?.focus({preventScroll:true});}
  syncTargets(){const active=this.stage==='target',candidates=active?this.targetActors():[],positions=this.positions??battleActorPositions(this.snapshot.actors);for(const a of this.snapshot.actors){let b=this.targets.get(a.id);if(!b){b=this.button('battle-target-hit',()=>{this.targetId=a.id;this.commit();});b.dataset.targetId=a.id;b.onfocus=()=>{if(this.stage==='target'){this.targetId=a.id;this.remember();this.setInfo(a.name);}};this.targets.set(a.id,b);this.targetLayer.append(b);}b.hidden=!active||!candidates.some(c=>c.id===a.id);const [x,y]=positions[a.id]??[0,0];this.place(b,x-35,y-95,70,105);b.setAttribute('aria-label',`选择目标：${a.name}`);b.setAttribute('aria-disabled',String(!this.available()));}}
  async commitFixed(kind){const epoch=++this.epoch;this.draft=null;this.setStage('waiting');try{await (kind==='defend'?this.battle.chooseDefend():this.battle.chooseEscape());if(!this.disposed&&epoch===this.epoch)this.cue('menuConfirm');}catch(error){if(!this.disposed&&epoch===this.epoch){this.reject(error.message);this.update(this.battle.presentationSnapshot());}}}
  async commit(){
    if(!this.draft||!this.available()){this.reject('当前不能提交行动。');return;}const draft=this.draft,targetId=this.targetId,epoch=++this.epoch;this.remember();this.draft=null;this.setStage('waiting');this.syncTargets();this.cue('menuConfirm');
    try{if(draft.actorId!==this.snapshot.player_id)throw new Error('行动人物已变化，请重新选择。');if(draft.kind==='item')await this.battle.chooseItem(draft.instanceId,targetId);else await this.battle.choose(draft.skillId,targetId);}
    catch(error){if(!this.disposed&&epoch===this.epoch){this.reject(error.message);this.update(this.battle.presentationSnapshot());}}
  }
  escape(){if(this.stage==='target'){this.draft=null;this.setStage(this.returnStage??'wheel');this.syncWheel();if(['skills','items'].includes(this.stage)){this.syncList();this.listButtons[this.listIndex-this.listOffset]?.focus({preventScroll:true});}else this.wheelButtons[this.focusIndex]?.focus({preventScroll:true});}else if(['skills','items'].includes(this.stage)){this.entries=null;this.setStage('wheel');this.syncWheel();this.wheelButtons[this.focusIndex]?.focus({preventScroll:true});}else if(this.stage==='wheel'&&this.snapshot.actors.filter(a=>a.side==='player'&&!a.escaped&&a.state_raw!==11).length>1){this.setStage('actors');this.syncWheel();this.players.get(this.snapshot.player_id)?.focus({preventScroll:true});}else return;this.syncTargets();this.syncList();this.cue('menuCancel');this.setInfo('');}
  moveWheel(key){
    const next=wheelNavigation[key]?.[this.focusIndex];
    if(next===undefined||next===this.focusIndex)return;
    this.focusIndex=next;this.wheelButtons[next].focus({preventScroll:true});this.cue('menuSelect');
  }
  key(key,repeat=false){
    if(this.resultView?.active)return this.resultView.key(key,repeat);
    if(this.disposed)return false;if(['Enter',' ','Escape'].includes(key)&&repeat)return true;
    if(key==='Escape'){this.escape();return true;}if(key==='Tab'||key==='x'||key==='z'){this.cycleActor(key==='z'?-1:1);return true;}
    if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter',' '].includes(key))return false;
    if(this.stage==='result'){if(['Enter',' '].includes(key))this.onReturn();return true;}
    if(['Enter',' '].includes(key)){if(this.stage==='actors'&&this.available()){this.setStage('wheel');this.syncWheel();this.wheelButtons[this.focusIndex]?.focus({preventScroll:true});this.cue('menuOpen');}else if(this.stage==='wheel')this.activateWheel(this.focusIndex);else if(['skills','items'].includes(this.stage))this.selectEntry(this.listIndex);else if(this.stage==='target')this.commit();return true;}
    const direction=['ArrowUp','ArrowLeft'].includes(key)?-1:1;
    if(this.stage==='actors')this.moveActor(key);
    else if(this.stage==='wheel')this.moveWheel(key);
    else if(['skills','items'].includes(this.stage))this.moveList(direction);
    else if(this.stage==='target'){const actors=this.targetActors(),i=actors.findIndex(a=>a.id===this.targetId);if(actors.length){this.targetId=actors[(i+direction+actors.length)%actors.length].id;this.targets.get(this.targetId)?.focus({preventScroll:true});this.cue('menuSelect');}}
    return true;
  }
  keyup(key){if(key===' ')this.resultView?.release();}
  image(path,x,y,w=null,h=null){const image=this.images.get(path);if(image)drawBattleImage(this.ctx,image,x,y,w??image.width,h??image.height);}
  paintTo(canvas){
    // Add over the actual battle pixels. Blending a transparent DOM child
    // inside a transformed frame first would bake its black coverage into HUD.
    const c=canvas.getContext('2d'),v=battleViewport(canvas.width,canvas.height);
    c.save();c.setTransform(1,0,0,1,0,0);c.imageSmoothingEnabled=false;
    c.globalCompositeOperation='source-over';c.drawImage(this.canvas,v.x,v.y,v.width,v.height);
    c.globalCompositeOperation='lighter';c.drawImage(this.glowCanvas,v.x,v.y,v.width,v.height);c.restore();
    this.root.dataset.compositeMode='canvas-source-over-lighter';
  }
  asset(id,index,x,y,{blend='source-over',mask=false}={}){const a=this.manifest.assets[id];if(!a)return;const f=a.frames[((index%a.frames.length)+a.frames.length)%a.frames.length],c=blend==='lighter'?this.glowCtx:this.ctx,image=this.images.get(mask&&f.inverse_mask_image?f.inverse_mask_image:f.image);c.save();c.globalCompositeOperation=blend;if(image)drawBattleImage(c,image,x,y);if(f.indexed_image){const indexed=this.images.get(f.indexed_image);if(indexed){this.glowCtx.save();this.glowCtx.globalCompositeOperation='lighter';drawBattleImage(this.glowCtx,indexed,x,y);this.glowCtx.restore();}}c.restore();}
  text(value,x,y,{font='12px SimSun',color='#ffffff',align='left',width=null,widget=null}={}){
    const c=this.ctx;value=String(value);if(widget&&this.textRenderer){try{let options=this.fontOptions.get(widget);if(!options){options=operationMnuTextOptions(widget);this.fontOptions.set(widget,options);}if(this.textRenderer.supports(value,options.font)){const key=JSON.stringify([value,options]);let canvas=this.textCache.get(key);if(!canvas){canvas=this.doc.createElement('canvas');this.textRenderer.paint(canvas,value,options);if(this.textCache.size>128)this.textCache.clear();this.textCache.set(key,canvas);}c.drawImage(canvas,x,y);return;}}catch{}}
    c.font=font;c.textAlign=align;c.textBaseline='top';c.fillStyle='#000';c.fillText(value,x+1,y+1,width??640);c.fillStyle=color;c.fillText(value,x,y,width??640);
  }
  draw(now,positions=null){
    if(!this.snapshot||this.disposed)return;this.positions=positions;this.syncTargets();const c=this.ctx;c.clearRect(0,0,640,480);this.glowCtx.clearRect(0,0,640,480);c.imageSmoothingEnabled=this.glowCtx.imageSmoothingEnabled=false;
    if(this.resultView?.active){this.resultView.draw(c,this.glowCtx,now);return;}
    const party=this.snapshot.actors.filter(a=>a.side==='player');const stat=this.menus.get('fight_stat');
    party.forEach((actor,i)=>{if(actor.escaped||actor.state_raw===11)return;const [x,y]=originalSlots[actor.party_slot_zero_based??i],g=actor.charge,threshold=this.snapshot.scheduler?.threshold??1,ratio=this.snapshot.scheduler?clamp(g.gauge/threshold):1;
      this.image(stat.images[0].image,x,y);const hp=stat.widgets.find(w=>w.name==='hp_bar'),mp=stat.widgets.find(w=>w.name==='mp_bar');
      for(const [resource,w]of [[actor.hp,hp],[actor.mp,mp]]){const image=this.images.get(w.normal_images[0]),r=w.rect;if(image&&resource.maximum>0){const width=Math.floor(image.width*clamp(resource.current/resource.maximum));if(width)drawBattleImage(c,image,0,0,width,image.height,x+r.left,y+r.top,width,image.height);}}
      this.text(`${actor.hp.current}/${actor.hp.maximum}`,x+70,y+21,{font:'bold 10px Arial',widget:stat.widgets.find(w=>w.name==='HpText')});this.text(`${actor.mp.current}/${actor.mp.maximum}`,x+144,y+21,{font:'bold 10px Arial',widget:stat.widgets.find(w=>w.name==='MpText')});
      const nameIndex=actor.id==='002'?1:actor.id==='001'?0:null;if(nameIndex!==null)this.asset('fight_role_name',nameIndex,x+70,y+3);else this.text(actor.name,x+70,y+3);
      // Native 42EAD0 shades time_bar, then draws time_glass. Canvas uses
      // the original alpha silhouette and an 8bit colour adapter.
      const state=this.snapshot.scheduler?battleBallState(g,threshold):{top:0,color:[0,128,0],phase:'charge',level:23};
      const bar=this.images.get(this.manifest.assets.time_bar.frames[0].image),key=state?`${state.phase}:${state.level}`:null;let ball=this.ballCache.get(key);
      if(state&&state.top<46&&!ball&&bar){ball=this.doc.createElement('canvas');ball.width=47;ball.height=46;const bc=ball.getContext('2d');drawBattleImage(bc,bar,0,0);bc.globalCompositeOperation='multiply';bc.fillStyle=`rgb(${state.color.join(',')})`;bc.fillRect(0,0,47,46);bc.globalCompositeOperation='destination-in';drawBattleImage(bc,bar,0,0);this.ballCache.set(key,ball);}
      if(state&&state.top<46&&ball){c.save();c.beginPath();c.rect(x+16,y+1+state.top,47,46-state.top);c.clip();c.drawImage(ball,x+16,y+1);c.restore();}
      this.asset('time_glass',0,x+16,y+1,{mask:true});
      if(actor.id===this.snapshot.player_id&&this.ready().includes(actor.id))this.asset('fight_mark',Math.floor(now/120),x-30,y-16,{blend:'lighter'});
    });
    this.image(this.menus.get('fight_info').images[0].image,0,443);this.text(this.message,2,457,{font:'14px SimSun',width:434});
    if(this.stage!=='result')this.drawWheel(now);
    if(['skills','items'].includes(this.stage))this.drawList();
    const selected=this.snapshot.actors.find(a=>a.id===this.snapshot.player_id),pointer=this.stage==='target'?this.snapshot.actors.find(a=>a.id===this.targetId):this.ready().includes(selected?.id)?selected:null;
    if(pointer){const [x,y]=(positions??battleActorPositions(this.snapshot.actors))[pointer.id]??[0,0],id=pointer.side==='enemy'?'fight_cursor2':'fight_cursor1',a=this.manifest.assets[id];this.asset(id,Math.floor(now/(a.actions[0]?.interval_raw??120)),x-a.anchor_raw[0],y-130-a.anchor_raw[1]);}
  }
  drawWheel(now){
    this.image(this.menus.get('game002d').images[0].image,490,340);
    if(this.stage==='actors'||!this.available()){this.asset('fight_board_mask',0,490,340);return;}
    const slots=this.commandSlots??this.slots();
    this.wheelButtons.forEach((b,i)=>{const x=parseFloat(b.style.left),y=parseFloat(b.style.top),slot=slots[i],active=i===this.focusIndex&&this.stage==='wheel'&&this.available();if(slot){let icon=slot.icon,units=slot.color;if(slot.type===0&&slot.skill&&icon===undefined){const raw=Uint8Array.from(slot.skill.fixed_raw_hex.match(/../g),x=>parseInt(x,16));icon=(raw[0x32]>>4)&15;units=raw[0x36];}this.asset(slot.type===2?'other_ball':slot.type===1?'name_ball':'magic_ball1',(icon??0)+(active?(slot.type===2?4:slot.type===1?88:6):0),x,y);if(units>0)this.asset('magic_ball1_num',Math.min(41,(slot.type===1?Math.floor(icon/11):icon)*7+units-1),x+14,y+12);}
      if(i===this.focusIndex&&this.stage==='wheel'&&this.available())this.asset('board_bright',Math.floor(now/120),x-13,y-13,{blend:'lighter'});
      if(b.getAttribute('aria-disabled')==='true')this.asset('fight_board_disable',0,x,y);
    });
  }
  drawList(){const menu=this.menus.get(this.stage==='items'?'fight002':'fight001'),x=467,y=274;this.image(menu.images[0].image,x,y);this.listButtons.forEach((b,i)=>{const entry=this.entries?.[this.listOffset+i];if(!entry)return;const w=menu.widgets.find(w=>w.name.toLowerCase()==='list'+(i+1));if(this.listIndex===this.listOffset+i)this.image(w.active_images[0],x+w.draw_point_raw.x,y+w.draw_point_raw.y);this.text(entry.name,x+w.rect.left+6,y+w.rect.top,{font:'12px SimSun',color:entry.available?this.listIndex===this.listOffset+i?'#ffff44':'#fff':'#777',width:entry.quantity===undefined?124:104});if(entry.quantity!==undefined)this.text(entry.quantity,x+140,y+w.rect.top,{font:'11px Arial',align:'right'});});}
  dispose(){this.disposed=true;this.epoch++;this.draft=null;this.resultView?.dispose();this.resizeObserver.disconnect();this.root.replaceChildren();this.images.clear();this.textCache.clear();this.ballCache.clear();}
}
