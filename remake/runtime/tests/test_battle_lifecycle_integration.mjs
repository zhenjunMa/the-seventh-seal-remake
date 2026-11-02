// Real exported source metadata; synthetic Canvas and deterministic RAF times.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BattleView} from '../web/battle_view.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {compileNativeSequence,directSequence} from '../web/core/skill_sequence.mjs';
import {WorldStore} from '../web/core/world.mjs';
import {createForestSample} from '../web/forest_sample.mjs';
import {createHandoffFixture} from '../web/tests/battle_handoff_fixture.mjs';
import {isActorReady} from '../web/core/battle_scheduler.mjs';
import {selectNativeNormalReaction} from '../web/core/battle_reactions.mjs';
const base=new URL('../web/',import.meta.url),read=async p=>JSON.parse(await readFile(new URL(p.replace(/^\//,''),base),'utf8'));
const meta=await read('/data/party_battle_view.json'),life=await read('/data/battle_lifecycle.json');
function canvas(){const calls=[],c={globalAlpha:1,save(){},restore(){},setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},ellipse(){},fill(){},moveTo(){},lineTo(){},stroke(){},createLinearGradient(){return {addColorStop(){}};},drawImage(img,...args){calls.push({path:img.path,args});},fillText(){},strokeText(){}};return {width:960,height:540,getContext:()=>c,calls};}
async function fixture(){
 const target=canvas(),view=new BattleView({canvas:target,metadataPath:'/data/party_battle_view.json',lifecycleMetadataPath:'/data/battle_lifecycle.json',jsonLoader:read,assetLoader:async a=>({image:{width:a.width,height:a.height,path:a.path},sha256:a.sha256})});
 await view.prepare();view.setRoster([{id:'001',side:'player'},{id:'002',side:'player'},{id:'enemy',resource_id:'012',side:'enemy'}],{'yantu':{id:'yantu',actor_id:'001'},'001_43':{id:'001_43',actor_id:'001'},'kai_mieyan':{id:'kai_mieyan',actor_id:'002'},'enemy':{id:'enemy',actor_id:'enemy'}});
 // This Canvas fixture owns source-record writes through the same controller
 // bridge as the browser. HP submission / lifecycle acknowledgements remain
 // explicit test inputs; no numeric battle is synthesized by these pixels.
 const control=new BattleController({});control.state={actors:view.roster.map(actor=>({...actor,native_z_raw:0}))};control.verticalClocks=new Map();
 view.nativeControl=control;view.nativeControlIsCurrent=()=>view.nativeControl===control;
 return {view,target,control};
}
const snapshot=(events=[],epoch=0)=>({actors:[{id:'001',hp:{current:900},life_epoch:0},{id:'002',hp:{current:epoch?151:0},life_epoch:epoch},{id:'enemy',hp:{current:100},life_epoch:0}],lifecycle_events:events});
test('prepared view can paint during HUD loading before the battle snapshot exists',async()=>{
 const {view}=await fixture();assert.doesNotThrow(()=>view.draw(null,0));assert.deepEqual(view.lifecycleSnapshot().active,[]);
});

test('transition preview leaves entry hidden and does not execute its records or restart its clock',async()=>{
 const {view,control}=await fixture(),drawn=[],sounds=[],before=structuredClone(control.state);
 view._sprite=(role,action,frame,x,y,alpha)=>drawn.push({id:role.id,alpha});view.onLifecycleFrame=step=>sounds.push(step);
 const event={token:'entry-1',actor_id:'001',life_epoch:0,kind:'entry',source_skill_index:11,source_id_raw:11},state=snapshot([event]);
 view.draw(state,5000,{entryPreview:true});
 assert.equal(drawn.some(row=>row.id==='001'),false);assert.deepEqual(view.lifecycleSnapshot().active,[]);
 assert.deepEqual(control.state,before);assert.deepEqual(sounds,[]);assert.equal(view.lastActorPoses.size,0);
 drawn.length=0;view.draw(state,5000);assert.equal(drawn.find(row=>row.id==='001').alpha,0);assert.equal(sounds.length,1);
 drawn.length=0;view.draw(state,5119);assert.equal(drawn.find(row=>row.id==='001').alpha,0);assert.equal(sounds.length,1);
 drawn.length=0;view.draw(state,5120);const alpha=drawn.find(row=>row.id==='001').alpha;
 assert.ok(alpha>0&&alpha<1);assert.equal(sounds.length,1);assert.equal(view.lifecycleSnapshot().active[0].appearance.mode,5);
});
test('real lifecycle layers load separately and a completed player death stays drawn after its event is acknowledged',async()=>{
 const {view,target}=await fixture();const event={token:'death-1',actor_id:'002',life_epoch:0,kind:'death',source_skill_index:12,hold_final_frame:true};
 view.draw(snapshot([event]),0);view.draw(snapshot([event]),5000);assert.equal(view.drainLifecycleCompleted().length,1);
 target.calls.length=0;view.draw(snapshot(),6000);
 const last=life.roles.find(r=>r.id==='002').skills.find(s=>s.chr_skill_index===12).last_source_pose;
 assert.ok(target.calls.some(c=>c.path?.endsWith(`frame_${String(last.source_frame).padStart(4,'0')}_main.png`)));
 assert.equal(view.lifecycle.pose('002').source_frame,last.source_frame);assert.equal(view.lifecycle.hidden('002'),false);
});
test('revive epoch replaces held corpse without cancelling an unrelated actor lifecycle',async()=>{
 const {view}=await fixture();const dead={token:'d',actor_id:'002',life_epoch:0,kind:'death',source_skill_index:12,hold_final_frame:true};
 view.draw(snapshot([dead]),0);view.draw(snapshot([dead]),4000);view.drainLifecycleCompleted();
 const revive={token:'r',actor_id:'002',life_epoch:1,kind:'revive',source_skill_index:14};
 view.draw(snapshot([revive],1),4100);assert.notEqual(view.lifecycle.pose('002').source_frame,life.roles.find(role=>role.id==='002').skills.find(s=>s.chr_skill_index===12).last_source_pose.source_frame);
 view.draw(snapshot([revive],1),9000);assert.deepEqual(view.drainLifecycleCompleted().map(e=>e.token),['r']);assert.equal(view.lifecycle.hidden('002'),false);
});
test('source revival carrier load failure advances without wait or invented contact, then real effect contacts at frame1',async()=>{
 const {view}=await fixture(),skill=life.roles.find(role=>role.id==='001').skills.find(s=>s.chr_skill_index===43).source_skill;
 const plan=directSequence(skill),compiled=compileNativeSequence(view.meta,'001',plan,[view.layers,...view.alternateLayers.values()]);
 const missing=compiled.steps.find(s=>s.missing_effect==='m77Rwz01');assert.ok(missing);assert.equal(missing.duration_ms,0);assert.equal(missing.event,null);
 assert.deepEqual(compiled.steps.filter(s=>s.event).map(s=>[s.carrier_asset_id,s.logical_frame]),[['_iRelife',1]]);
 const effects=compiled.steps.filter(s=>s.carrier_asset_id==='_iRelife');assert.equal(effects.length,19);assert.ok(effects.every(s=>s.duration_ms===80));
 let contacts=0;const done=view.playSequence({actor_id:'001',target_id:'002',skill_id:'001_43',plan},{onRecord(){},onContact(){contacts++;return {hit:true,damage:0,revived:true,hp_delta:151};}});
 view.draw(snapshot(),0);view.draw(snapshot(),20000);view.draw(snapshot(),21000);await done;assert.equal(contacts,1);assert.equal(view.damageTexts.length,0);
});

// Controlled surviving contacts exercise the production completion callbacks;
// exported CHR/DGP records and renderer timestamps remain unchanged.
async function liveFixture(enemyRole='013',statusData=null){
 const [seed,base,forest,scheduler,reactions,ai,commands]=await Promise.all(['route_seed.json','combat_sample.json','forest_combat.json','battle_scheduler.json','party_reactions.json','forest_ai.json','party_skills.json'].map(n=>read('/data/'+n)));
 let now=0;const drawn=new Map(),logs=[],target=canvas(),world=new WorldStore(structuredClone(seed),['M17010','M70010']);
 const sample=createForestSample(world.snapshot(),base,forest,{map_id:'M70010',members:[{id:enemyRole}]},null,scheduler,ai,null,reactions,statusData);
 const view=new BattleView({canvas:target,metadataPath:'/data/party_battle_view.json',lifecycleMetadataPath:'/data/battle_lifecycle.json',jsonLoader:read,assetLoader:async a=>({width:a.width,height:a.height,path:a.path})});
 await view.prepare();view.setRoster(sample.actors,sample.skills);
 view._sprite=(role,action,frame,x,y)=>drawn.set(role.id,{action,frame,x,y});
 const battle=new BattleController({world,id:()=> 'source-presentation',now:()=>now,log:e=>logs.push({at:now,...e}),
   resolveAction:({skill})=>({hit:true,damage:1,mp_cost:skill.mp_cost,native_return:1,reaction:0,after_settled_raw:0}),applyDamage:a=>a,playSequence:(event,hooks)=>view.playSequence(event,hooks)});
 battle.start({...sample,lifecycle_enabled:true,rng:()=>99});
 for(const event of [...battle.state.lifecycle_events])battle.ackLifecycle(event);
 for(const actor of battle.state.actors)actor.charge.delay=1000000;
 view.nativeControl=battle;view.nativeControlIsCurrent=()=>true;
 return {view,battle,drawn,logs,target,sample,ai,commands,async draw(at){
   now=at;battle.advanceClock(now);drawn.clear();target.calls.length=0;view.draw(battle.presentationSnapshot(),now);
   for(const event of view.drainLifecycleCompleted())battle.ackLifecycle(event);
   await Promise.resolve();
 }};
}

test('enemy and party hit recovery uses source durations and never inserts idle into knockdown/get-up handoffs',async()=>{
 for(const fps of [30,60,144])for(const [side,skillId,enemyRole,knockdown] of [['enemy',15,'013',false],['player','yantu','013',false],['player','001_26','013',true],['enemy',19,'042',true]]){
   const f=await liveFixture(enemyRole),{battle,view,drawn,logs}=f;
   const attacker=battle.actor(side==='player'?'001':'enemy-0'),victim=battle.actor(side==='player'?'enemy-0':'001'),resource=victim.resource_id??victim.id;
   const selected=structuredClone(side==='enemy'?f.ai.roles[enemyRole].skills[skillId]:skillId==='yantu'?f.sample.skills.yantu:f.commands.skills[skillId]);selected.actor_id=attacker.id;
   let ended=false;const task=battle.performSequence(attacker,victim,selected,directSequence(selected)).then(()=>ended=true);
   for(let tick=0;tick<fps*12;tick++){
     const active=victim.native_active;await f.draw(tick*1000/fps);
     if(active)assert.notEqual(drawn.get(resource).action,0,`${side}:${skillId} must retain the response pose at ${tick}/${fps}`);
     if(ended&&!battle.state.lifecycle_events.length&&!battle.pendingPresentations.size)break;
   }
   await task;
   if(knockdown)assert.ok(logs.some(e=>e.type==='battle-source-completed'&&e.actor_id===victim.id&&e.descriptor.reason==='source-end-get-up'));
   else{
     const contact=logs.find(e=>e.type==='battle-impact'),end=logs.find(e=>e.type==='battle-source-completed'&&e.actor_id===victim.id);
     const source=life.roles.find(r=>r.id===resource).skills.find(s=>s.chr_skill_index===contact.reaction.source_skill_index);
     const duration=source.timeline.reduce((n,s)=>n+(s.interval_raw??0),0);
     assert.ok(Math.abs(end.at-contact.presentation.presentation_time_ms-duration)<=1000/fps+0.001,'ordinary response ends without the old 260ms tail');
   }
   assert.equal(view.run,null);
 }
});

test('party and enemy attackers return to idle when their final source frame ends without a preview tail',async()=>{
 // Source records:燕突32 frames / 烈爪突击34 frames, at the attack adapter's65ms.
 for(const [side,duration] of [['player',2080],['enemy',2210]]){
   const f=await liveFixture(),{battle,view,drawn,logs}=f;
   const attacker=battle.actor(side==='player'?'001':'enemy-0'),victim=battle.actor(side==='player'?'enemy-0':'001');
   const skill=structuredClone(side==='player'?f.sample.skills.yantu:f.ai.roles['013'].skills[15]);skill.actor_id=attacker.id;
   const task=battle.performSequence(attacker,victim,skill,directSequence(skill));
   await f.draw(0);await f.draw(duration-1);assert.equal(attacker.native_active,true);
   await f.draw(duration);
   assert.ok(logs.some(e=>e.type==='battle-source-completed'&&e.actor_id===attacker.id&&e.at===duration));
   assert.equal(attacker.native_active,false);await f.draw(duration+1);
   assert.equal(drawn.get(attacker.resource_id??attacker.id).action,0);assert.equal(view.run,null);await task;
 }
});

test('four compiled attacks hand off before return, retain their leases and chain across 50/60/144 FPS',async()=>{
 for(const fps of [50,60,144]){
   const f=await createHandoffFixture({load:read,canvas:canvas(),assetLoader:async a=>({width:a.width,height:a.height,path:a.path})});
   f.view._sprite=()=>{};let released=0,checkedReturn=false;
   f.view.run.resourceLease={release(){released++;}};
   try{
     for(let frame=0;frame<fps*20;frame++){
       await f.advance(frame*1000/fps);
       if(!checkedReturn&&f.events.some(e=>e.type==='battle-attack-completed'&&e.actor_id==='004')){
         checkedReturn=true;assert.equal(f.battle.canCommand('004'),false,'returning actor remains locked');
         assert.equal(f.battle.activeActions.has('004'),true);assert.equal(released,0,'handoff must retain the action lease');
         assert.ok(f.view.detachedRuns.some(run=>run.result.actor_id==='004'&&!run.main_done));
       }
       const enemy=f.battle.actor('enemy-0');
       if(enemy.native_active&&enemy.charge.gauge>=f.battle.state.scheduler.threshold)assert.equal(isActorReady(enemy,f.battle.state.scheduler),false);
       if(f.finished)break;
     }
     const hits=f.events.filter(e=>e.type==='battle-impact'&&e.hit&&e.actor_id!=='enemy-0');
     assert.equal(checkedReturn,true);assert.equal(hits.length,16);assert.equal(f.battle.state.reward_ledger.chain.maximum,16);
     assert.deepEqual(hits.slice(1).map(e=>e.chain),Array.from({length:15},(_,i)=>i+2));
     const starts=f.events.filter(e=>e.type==='battle-scheduled'),second=starts.find(e=>e.actor_id==='001');
     const firstEnd=f.events.find(e=>e.type==='battle-source-completed'&&e.actor_id==='004');
     assert.ok(second.at<firstEnd.at,'next actor starts while its predecessor returns');
     assert.ok(starts.find(e=>e.actor_id==='enemy-0').at>hits.at(-1).at,'a full enemy waits for hit recovery');
     assert.equal(f.finished,true);assert.equal(released,1);assert.equal(f.battle.activeActions.size,0);assert.equal(f.battle.pendingPresentations.size,0);
   }finally{f.dispose();}
 }
});

test('handoff preserves ordinary-hit gaps, enemy recovery and native action ordering',async()=>{
 for(const [scenario,maximum]of [['ordinary',0],['gap',0],['natural',8]]){
   const f=await createHandoffFixture({load:read,canvas:canvas(),assetLoader:async a=>({width:a.width,height:a.height,path:a.path}),scenario});f.view._sprite=()=>{};
   try{
     for(let frame=0;frame<60*20;frame++){await f.advance(frame*1000/60);if(f.finished)break;}
     assert.equal(f.finished,true);assert.equal(f.battle.state.reward_ledger.chain.maximum,maximum,scenario);
     if(scenario==='ordinary')assert.ok(f.events.filter(e=>e.type==='battle-impact'&&e.actor_id!=='enemy-0').every(e=>e.settled_before===0));
     if(scenario==='gap'){
       const recovered=f.events.find(e=>e.type==='battle-source-completed'&&e.actor_id==='enemy-0'&&e.descriptor.reason==='source-end-idle');
       const attack=f.events.find(e=>e.type==='battle-scheduled'&&e.actor_id==='enemy-0');
       assert.ok(attack.at>=recovered.at&&attack.at-recovered.at<=40);assert.equal(f.battle.state.history.some(e=>e.actor_id==='002'),false);
     }
     if(scenario==='natural')assert.deepEqual(f.events.filter(e=>e.type==='battle-scheduled'&&e.actor_id!=='enemy-0').map(e=>e.actor_id),['004','003','002','001']);
   }finally{f.dispose();}
 }
});

test('a new hit interrupts a detached return without retiring the next actor or the old target reaction',async()=>{
 const f=await createHandoffFixture({load:read,canvas:canvas(),assetLoader:async a=>({width:a.width,height:a.height,path:a.path})});f.view._sprite=()=>{};
 try{
   for(let frame=0;frame<=95;frame++)await f.advance(frame*20);
   const returning=f.view.detachedRuns.find(run=>run.result.actor_id==='004'),next=f.view.run;
   assert.ok(returning&&!returning.main_done);assert.equal(next.result.actor_id,'001');
   const actor=f.battle.actor('004'),response=selectNativeNormalReaction({actor,ident:1,data:f.sample.reaction_data,rng:()=>50});
   Object.assign(actor,structuredClone(response.after));actor.native_sequence_token='controlled-return-hit';f.battle.queueLifecycle(actor,response);
   await f.advance(1920);
   assert.equal(returning.main_done,true);assert.equal(returning.interrupted,true);assert.equal(f.battle.activeActions.has('004'),false);
   assert.equal(f.view.run,next);assert.equal(next.main_done,false);assert.equal(f.battle.activeActions.has('001'),true);
   assert.ok(returning.children.some(child=>child.result.actor_id==='enemy-0'&&!child.done));
   for(let frame=97;frame<1000;frame++){await f.advance(frame*20);if(f.finished)break;}
   assert.equal(f.finished,true);assert.equal(f.battle.pendingPresentations.size,0);
 }finally{f.dispose();}
});

test('warm healing retains the source effect waits and restores idle immediately after their last frame',async()=>{
 const f=await liveFixture('013',await read('/data/forest_status.json')),{battle,view,drawn,logs}=f,attacker=battle.actor('001'),target=attacker;
 const skill=f.commands.skills.yannuan,task=battle.performSequence(attacker,target,skill,directSequence(skill));
 // Source body2200ms, then m01Rwz01 19*70ms and _iReSTfr 19*80ms.
 await f.draw(0);await f.draw(2200);const held=structuredClone(drawn.get('001'));
 await f.draw(5049);assert.equal(attacker.native_active,true);assert.deepEqual(drawn.get('001'),held);
 assert.equal(battle.state.history.at(-1).contacts.length,1);
 await f.draw(5050);assert.equal(attacker.native_active,false);
 assert.ok(logs.some(e=>e.type==='battle-source-completed'&&e.actor_id==='001'&&e.at===5050));
 await f.draw(5051);assert.equal(drawn.get('001').action,0);assert.equal(view.run,null);await task;
});

test('successful escape remains visible while its source action moves out, then acknowledges before battle exit',async()=>{
 const f=await liveFixture(),{battle,view,drawn}=f,actor=battle.actor('001');
 actor.charge.delay=0;actor.charge.gauge=battle.state.scheduler.threshold;battle.refreshCommandState();
 await battle.chooseEscape();
 assert.equal(actor.state_raw,11);assert.equal(battle.canCommand('001'),false);assert.equal(battle.state.outcome,null);
 assert.equal(battle.state.lifecycle_events[0].kind,'escape');assert.equal(battle.state.lifecycle_events[0].source_id_raw,10);
 const positions=[];
 for(let tick=0;tick<300;tick++){
   await f.draw(tick*1000/60);const pose=drawn.get('001');if(pose)positions.push(pose.x);
   if(battle.state.phase==='escaped')break;
 }
 assert.ok(positions.length>2);assert.ok(positions.at(-1)>positions[0]+300,'selected actor travels outside the battle plane');
 assert.equal(view.lifecycle.hidden('001'),true);assert.equal(drawn.has('001'),false);assert.equal(battle.state.phase,'escaped');
 assert.equal(battle.state.lifecycle_events.length,0);
});

test('battle draws each displayed physical frame shadow and keeps it on the ground under native altitude',async()=>{
 const f=await liveFixture(),{view,battle,target,drawn}=f,role=view.meta.roles.find(r=>r.id==='001'),shadow=role.shadow;
 target.getContext().ellipse=()=>assert.fail('formal battle must use source masks');
 await f.draw(0);const first=target.calls.find(c=>c.path===shadow.sheet),firstY=first.args[5],bodyY=drawn.get('001').y;
 assert.equal(first.args[0],0);assert.equal(first.args[1],0);
 battle.actor('001').native_z_raw=-40;await f.draw(70);
 const next=target.calls.find(c=>c.path===shadow.sheet);
 assert.equal(next.args[0],shadow.frame_width,'shadow advances with source idle frame1');
 assert.equal(next.args[5],firstY,'source shadow remains grounded');assert.ok(drawn.get('001').y<bodyY);
});
