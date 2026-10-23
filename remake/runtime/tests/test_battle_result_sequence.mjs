import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BattleResultSequence,validateBattleResultManifest} from '../web/core/battle_result.mjs';
import {BattleResultView} from '../web/battle_result_view.mjs';
import {createBattleController} from '../web/controllers/battle.mjs';
import {createMenuTextRenderer} from '../web/core/menu_text.mjs';
const copy=structuredClone;
const actors=[{id:'001',name:'英格妮',side:'player'},{id:'002',name:'凯',side:'player'}];
const summary={battle_id:'source-result',experience:[{role_id:'001',experience:3,level_before:11,level_after:11,total_experience:100,next_level_experience:200,experience_remaining_raw:100},{role_id:'002',experience:2,level_before:10,level_after:10,total_experience:200,next_level_experience:300,experience_remaining_raw:100}],money:2,money_before:50,money_after:52,drops:[{id:12,name:'碧沙草茶',quantity:1}],maximum_player_chain:3,practice_total:2,notifications:[]};
const event=(id,type,actor_id,skill_name=null)=>({id,type,actor_id,actor_name:actors.find(a=>a.id===actor_id).name,skill_index:skill_name?22:null,skill_name,before:1,after:2});
const create=notifications=>new BattleResultSequence({battleId:summary.battle_id,summary:{...copy(summary),notifications},actors,now:0});
const press=(model,now=0)=>{model.release();return model.advance({now});};
const settle=model=>{for(let time=30;time<=120;time+=30)model.tick(time);};

test('Fallback notice names stay centered inside the source card while it slides, including a one-character name',()=>{
  const draws=[],ctx={fillText(value,x,y,maxWidth){draws.push({value,x,y,maxWidth,align:this.textAlign,color:this.fillStyle});}};
  const view={textRenderer:null};
  for(const cardX of [500,420,340,280])for(const name of ['凯','英格妮','炎剑．燕落']){
    BattleResultView.prototype.text.call(view,ctx,name,cardX+20,106,{width:106,align:'center',shadow:false});
    const draw=draws.at(-1);assert.equal(draw.align,'center');assert.equal(draw.x,cardX+73);assert.equal(draw.y,106);assert.equal(draw.maxWidth,106);
  }
  BattleResultView.prototype.text.call(view,ctx,'TOTAL',112,75);
  assert.deepEqual(draws.slice(-2).map(d=>[d.x,d.y,d.align,d.color]),[[113,76,'left','#000'],[112,75,'left','#fff']]);
});

test('Cached report glyphs retain the exported ink origin instead of shifting the source rectangle',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../web/data/menu_fonts.json',import.meta.url),'utf8'));
  const canvas=()=>({calls:[],setAttribute(){},getContext(){return {drawImage:(...args)=>this.calls.push(args),fillRect(){}};}});
  const doc={createElement:canvas},renderer=await createMenuTextRenderer(manifest,{document:doc,makeImage:()=>({width:1280,height:1200,async decode(){}})});
  const draws=[],ctx={drawImage:(...args)=>draws.push(args)},view={doc,textRenderer:renderer,textCache:new Map()};
  assert.equal(renderer.supports('x10','simsun18'),true);
  for(const cardX of [500,280]){
    BattleResultView.prototype.text.call(view,ctx,'x10',cardX+20,316,{width:106,align:'center',shadow:false});
    const [image,x,y]=draws.at(-1),first=image.calls[0],glyph=manifest.fonts.simsun18.glyphs.x;
    assert.equal(x+first[5]-glyph.offset_x,cardX+20+Math.floor((106-renderer.measure('x10','simsun18'))/2));
    assert.equal(y+first[6]-glyph.offset_y,316);
  }
  assert.equal(view.textCache.size,1);assert.equal(draws[0][0],draws[1][0]);
});

test('Report fast-forward respects both native stages and key releases; the same press cannot return to the map',()=>{
  const model=create([]),before=copy(summary);
  assert.equal(model.advance().kind,'victory-skipped');assert.equal(model.snapshot().report_landed,false);
  assert.equal(model.advance().kind,'ignored');assert.equal(model.advance({repeat:true}).kind,'ignored');
  assert.equal(press(model).kind,'counters-completed');assert.equal(model.snapshot().done,false);
  assert.deepEqual(model.snapshot().experience.map(r=>r.gain),[3,2]);assert.equal(model.snapshot().money,52);
  assert.equal(model.advance().kind,'ignored');assert.equal(press(model).kind,'complete');assert.equal(press(model).kind,'ignored');assert.deepEqual(summary,before);
});

test('Source timers finish the victory effect, slide the report and count all parallel rows without an input',()=>{
  const model=create([]);for(let time=60;time<=1440;time+=60)model.tick(time);
  assert.equal(model.snapshot().victor_finished,true);assert.equal(model.snapshot().report_x,-630);
  for(let time=1470;time<=3000;time+=30)model.tick(time);
  const state=model.snapshot();assert.equal(state.report_x,0);assert.equal(state.phase,'notices');assert.equal(state.done,false);assert.deepEqual(state.experience.map(r=>r.gain),[3,2]);
  assert.equal(press(model).kind,'complete');
});

test('Same-actor notices advance one ordinal at a time, with different party rows in parallel and a separate final confirmation',()=>{
  const notices=[event('s1','skill-level-up','001','炎剑．燕突'),event('l1','skill-learned','001','炎剑．燕落'),event('s2','skill-level-up','002','灭颜打'),event('r1','role-level-up','001'),event('r2','role-level-up','002')];
  const model=create(notices);settle(model);assert.deepEqual(model.snapshot().notifications.filter(n=>n.active).map(n=>n.id),['s1','s2']);
  press(model);press(model);assert.equal(model.snapshot().done,false);
  assert.deepEqual(press(model).ids,['l1','r2']);assert.equal(model.snapshot().page,1);
  assert.equal(model.advance({repeat:true}).kind,'ignored');assert.equal(model.snapshot().done,false);
  assert.deepEqual(press(model).ids,['r1']);assert.equal(model.snapshot().done,false);
  settle(model);assert.equal(press(model).kind,'complete');
  assert.deepEqual(model.snapshot().notifications.map(n=>n.y),[103,103,138,103,138]);
});

test('Role upgrades enter only when their report EXP crosses the planned threshold; practice bonus keeps its native type6 row',()=>{
  const role={...event('r1','role-level-up','001'),experience_gained_at:2},bonus={id:'bonus',type:'practice-bonus',actor_id:null,actor_name:null,skill_name:null,value:10,source_type_raw:6};
  const model=create([event('s1','skill-level-up','001','炎剑．燕突'),bonus,role]);
  assert.equal(model.snapshot().notifications.some(n=>n.id==='r1'),false);assert.equal(model.snapshot().notifications.find(n=>n.id==='bonus').y,313);
  model.victorFinished=true;model.reportLanded=true;model.reportX=0;model.tick(10);assert.equal(model.snapshot().notifications.some(n=>n.id==='r1'),false);
  model.tick(20);const notification=model.snapshot().notifications.find(n=>n.id==='r1');assert.equal(notification.ordinal,1);assert.equal(notification.active,false);
});

test('Repeated open/update cannot restart the same report or issue its completion callback twice',()=>{
  const node=()=>({hidden:true,dataset:{},setAttribute(){},focus(){},remove(){}}),root={dataset:{},ownerDocument:{createElement:node},append(){}};
  const manifest={schema:'seventh-seal-battle-result',version:1,native_canvas:{width:640,height:480},assets:Object.fromEntries(['fight_report_01','fight_report_02','victor'].map(id=>[id,{frames:Array.from({length:id==='fight_report_02'?4:24},(_,i)=>({image:`assets/battle_result/${id}/${i}.png`}))}]))};
  let completed=0;const view=new BattleResultView({root,manifest,onComplete:()=>completed++});const snapshot={id:summary.battle_id,phase:'victory',rewards:summary,actors};
  view.open(snapshot,0);view.key(' ');const model=view.model;view.open(snapshot,500);assert.equal(view.model,model);assert.equal(view.model.victorFinished,true);
  view.release();view.key(' ');assert.equal(completed,0);view.release();view.key('Escape');assert.equal(completed,0);view.key(' ');assert.equal(completed,1);view.release();view.key(' ');assert.equal(completed,1);
  view.dispose();assert.equal(view.active,false);
});

test('Victory playback and skip input share the battle clock after time spent outside battle',()=>{
  const node=()=>({hidden:true,dataset:{},setAttribute(){},focus(){},remove(){}}),root={dataset:{},ownerDocument:{createElement:node},append(){}};
  const manifest={schema:'seventh-seal-battle-result',version:1,native_canvas:{width:640,height:480},assets:Object.fromEntries(['fight_report_01','fight_report_02','victor'].map(id=>[id,{frames:Array.from({length:id==='fight_report_02'?4:24},(_,i)=>({image:`assets/battle_result/${id}/${i}.png`}))}]))};
  let battleTime=1000;
  const view=new BattleResultView({root,manifest,onComplete(){},now:()=>battleTime});
  view.asset=()=>{};view.text=()=>{};
  const snapshot={id:summary.battle_id,phase:'victory',rewards:summary,actors};
  view.open(snapshot);battleTime+=60;view.draw({}, {},battleTime);
  assert.equal(view.model.victorFrame,1,'The first source frame must advance without waiting for page uptime');
  battleTime+=60;view.key(' ');assert.equal(view.model.lastReport,battleTime);
  battleTime+=30;view.draw({}, {},battleTime);
  assert.ok(view.model.reportX>-630,'Skipping the victory effect must not inject the page clock into report sliding');
  view.dispose();
});

test('Source report frames retain their audited hashes and the transparent/additive renderer selects the native plate mask',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../web/data/battle_result.json',import.meta.url),'utf8'));validateBattleResultManifest(manifest);
  for(const asset of Object.values(manifest.assets))for(const f of asset.frames){const bytes=await readFile(new URL('../web/'+f.image,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),f.png_sha256);}
  const main=[],glow=[],images=new Map(),plate=manifest.assets.fight_report_01.frames[0],victor=manifest.assets.victor.frames[0];
  for(const path of [plate.render_image,plate.image,victor.image,victor.indexed_image].filter(Boolean))images.set(path,path);
  const context={drawImage:(...a)=>main.push(a)},additive={save(){},restore(){},drawImage:(...a)=>glow.push(a)};
  const facade={manifest,images};BattleResultView.prototype.asset.call(facade,context,additive,'fight_report_01',0,0,0,{inverseMask:true});
  assert.equal(main[0][0],plate.render_image);BattleResultView.prototype.asset.call(facade,context,additive,'victor',0,0,0);assert.equal(glow[0][0],victor.indexed_image);assert.equal(additive.globalCompositeOperation,'lighter');
});

test('Controller refuses to submit unfinished victory presentation and submits once after its last acknowledgement',async()=>{
  let finishes=0;const resultView={active:true,complete:false},elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);};
  const state={scenes:{phase:'battle-result',setPhase(p){this.phase=p;}},battle:{finish(){finishes++;return {outcome:'victory'};},snapshot(){return {};}},battleMenu:{resultView,dispose(){}},battleView:{stop(){}},battleHistory:[],world:{value:{source:{kind:'native-new-game'}},location:{map_id:'M70010'}},view:{},battleCheckpoint:{},audio:{setScene(){}}};
  const actions={buildHud(){},updateNearest(){},resize(){},status(){}};const controller=createBattleController({state,actions,$,canvas:{focus(){}}});
  await controller.returnFromBattle();assert.equal(finishes,0);assert.equal(state.scenes.phase,'battle-result');resultView.complete=true;
  await controller.returnFromBattle();await controller.returnFromBattle();assert.equal(finishes,1);assert.equal(state.battleHistory.length,1);assert.equal(state.scenes.phase,'map');
});
