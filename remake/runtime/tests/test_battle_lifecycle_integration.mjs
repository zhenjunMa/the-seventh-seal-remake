// Real exported source metadata; synthetic Canvas and deterministic RAF times.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BattleView} from '../web/battle_view.mjs';
import {BattleController} from '../web/core/battle/battle_controller.mjs';
import {compileNativeSequence,directSequence} from '../web/core/battle/skill_sequence.mjs';
import {WorldStore} from '../web/core/world/world.mjs';
import {createForestSample} from '../web/forest_sample.mjs';
import {createHandoffFixture} from '../web/tests/battle_handoff_fixture.mjs';
import {isActorReady} from '../web/core/battle/battle_scheduler.mjs';
import {selectNativeNormalReaction} from '../web/core/battle/battle_reactions.mjs';
const base=new URL('../web/',import.meta.url),read=async p=>JSON.parse(await readFile(new URL(p.replace(/^\//,''),base),'utf8'));
const meta=await read('/data/party_battle_view.json'),life=await read('/data/battle_lifecycle.json');
function canvas(){const calls=[],c={globalAlpha:1,save(){},restore(){},setTransform(){},translate(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},ellipse(){},fill(){},moveTo(){},lineTo(){},stroke(){},createLinearGradient(){return {addColorStop(){}};},drawImage(img,...args){calls.push({path:img.path,args});},fillText(){},strokeText(){}};return {width:960,height:540,getContext:()=>c,calls};}
async function fixture(enemyRole='012'){
 const target=canvas(),view=new BattleView({canvas:target,metadataPath:'/data/party_battle_view.json',lifecycleMetadataPath:'/data/battle_lifecycle.json',jsonLoader:read,assetLoader:async a=>({image:{width:a.width,height:a.height,path:a.path},sha256:a.sha256})});
 await view.prepare();view.setRoster([{id:'001',side:'player'},{id:'002',side:'player'},{id:'enemy',resource_id:enemyRole,side:'enemy'}],{'yantu':{id:'yantu',actor_id:'001'},'001_43':{id:'001_43',actor_id:'001'},'kai_mieyan':{id:'kai_mieyan',actor_id:'002'},'enemy':{id:'enemy',actor_id:'enemy'}});
 // This Canvas fixture owns source-record writes through the same controller
 // bridge as the browser. HP submission / lifecycle acknowledgements remain
 // explicit test inputs; no numeric battle is synthesized by these pixels.
 const control=new BattleController({});control.state={actors:view.roster.map(actor=>({...actor,native_z_raw:0}))};control.verticalClocks=new Map();control.finishNativeSpriteRecord=()=>false;
 view.nativeControl=control;view.nativeControlIsCurrent=()=>view.nativeControl===control;
 return {view,target,control};
}
const snapshot=(events=[],epoch=0)=>({actors:[{id:'001',hp:{current:900},life_epoch:0},{id:'002',hp:{current:epoch?151:0},life_epoch:epoch},{id:'enemy',hp:{current:100},life_epoch:0}],lifecycle_events:events});
test('prepared view can paint during HUD loading before the battle snapshot exists',async()=>{
 const {view}=await fixture();assert.doesNotThrow(()=>view.present(null,0));assert.deepEqual(view.lifecycleSnapshot().active,[]);
});

test('transition preview leaves entry hidden and does not execute its records or restart its clock',async()=>{
 const {view,control}=await fixture(),drawn=[],sounds=[],before=structuredClone(control.state);
 view._sprite=(role,action,frame,x,y,alpha)=>drawn.push({id:role.id,alpha});view.onLifecycleFrame=step=>sounds.push(step);
 const event={token:'entry-1',actor_id:'001',life_epoch:0,kind:'entry',source_skill_index:11,source_id_raw:11},state=snapshot([event]);
 view.present(state,5000,{entryPreview:true});
 assert.equal(drawn.some(row=>row.id==='001'),false);assert.deepEqual(view.lifecycleSnapshot().active,[]);
 assert.deepEqual(control.state,before);assert.deepEqual(sounds,[]);assert.equal(view.lastActorPoses.size,0);
 drawn.length=0;view.present(state,5000);assert.equal(drawn.find(row=>row.id==='001').alpha,0);assert.equal(sounds.length,1);
 drawn.length=0;view.present(state,5119);assert.equal(drawn.find(row=>row.id==='001').alpha,0);assert.equal(sounds.length,1);
 drawn.length=0;view.present(state,5120);view.present(state,5121);const alpha=drawn.findLast(row=>row.id==='001').alpha;
 assert.ok(alpha>0&&alpha<1);assert.equal(sounds.length,1);assert.equal(view.lifecycleSnapshot().active[0].appearance.mode,5);
});
test('transition prepares visible entry poses once, defers cues and resumes their remaining animation without an empty lead',async()=>{
 for(const now of [5000,123.456]){
 const {view}=await fixture(),drawn=[],sounds=[];
 view._sprite=(role,action,frame,x,y,alpha)=>drawn.push({id:role.id,alpha});view.onLifecycleFrame=step=>sounds.push(step);
 const events=['001','enemy'].map(actor_id=>({token:'entry-'+actor_id,actor_id,life_epoch:0,kind:'entry',source_skill_index:11,source_id_raw:11})),state=snapshot(events);
 view.prepareEntry(state,now);const prepared=view.lifecycleSnapshot();
 assert.equal(prepared.active.length,2);assert.ok(prepared.active.every(row=>row.alpha>0&&row.alpha<1));
 assert.equal(view.lifecycle.pose('001').source_frame,170);assert.equal(view.lifecycle.alpha('enemy'),1/7);
 assert.deepEqual(view.drainLifecycleCompleted(),[]);assert.equal(sounds.length,0);assert.equal(view.lastActorPoses.size,0);
 view.prepareEntry(state,now);assert.deepEqual(view.lifecycleSnapshot(),prepared);
 view.present(state,now,{entryPreview:true});assert.deepEqual(view.lifecycleSnapshot(),prepared);assert.equal(sounds.length,0);
 assert.ok(drawn.find(row=>row.id==='001').alpha>0);assert.ok(drawn.find(row=>row.id==='012').alpha>0);
 drawn.length=0;view.present(state,now);assert.equal(sounds.length,2);assert.equal(view.lifecycle.alpha('enemy'),1/7);
 assert.ok(drawn.find(row=>row.id==='001').alpha>0);assert.deepEqual(view.drainLifecycleCompleted(),[]);
 view.present(state,now+60);assert.equal(view.lifecycle.alpha('enemy'),2/7);assert.equal(sounds.length,2);
 view.stop();assert.deepEqual(view.entryFrameSounds,[]);assert.equal(view.lifecycle.entryPrepared,false);
 }
});

test('077 original entry executes both background fades, camera snap and return only after activation, then restores both channels',async()=>{
 for(const prepared of [false,true]){
 const {view,control}=await fixture('077'),visited=[];
 const source=life.roles.find(role=>role.id==='077').skills.find(skill=>skill.chr_skill_index===5);
 assert.deepEqual(source.timeline.filter(step=>step.kind==='command').map(step=>[step.chr_record_index,step.command_raw]),[[0,0],[1,6],[3,7],[5,0],[7,11]]);
 control.actor('enemy').native_x_raw=-146;
 const apply=view._nativeSourceControl.bind(view);view._nativeSourceControl=(step,actor,target,at,owner)=>{
   apply(step,actor,target,at,owner);visited.push({command:step.command_raw,control:step.control,at,
     fade:view.colorFade&&structuredClone(view.colorFade),camera:view.cameraPan&&structuredClone(view.cameraPan)});
 };
 const event={token:'077-entry',actor_id:'enemy',life_epoch:0,kind:'entry',source_skill_index:5,source_id_raw:11},state=snapshot([event]),started=5000;
 if(prepared){
   view.prepareEntry(state,started);assert.deepEqual(view.entryFrameControls.map(step=>step.command_raw),[0,6]);
   assert.equal(view.colorFade,null);assert.equal(view.cameraPan,null);assert.deepEqual(visited,[]);
   const before=view.lifecycleSnapshot();view.present(state,500000,{entryPreview:true});
   assert.deepEqual(view.lifecycleSnapshot(),before);assert.equal(view.colorFade,null);assert.equal(view.cameraPan,null);
 }
 view.present(state,started);assert.equal(visited[0].at,started);assert.equal(view.colorFade.value,50,'no hidden preparation time is charged to the first color update');
 let now=started;for(;view.lifecycleSnapshot().active.length&&now<started+15000;){now+=20;view.present(state,now);}
 assert.ok(now<started+15000);assert.deepEqual(visited.map(row=>row.command),[0,6,0,11]);
 assert.deepEqual(visited[0].control,{mode_raw:0,step_i32_raw:100,amount_i32_raw:50,color_mask_raw:7});
 assert.equal(visited[1].camera.x,-274);assert.equal(visited[1].camera.active,false);
 assert.equal(visited[2].fade.value,0);assert.equal(visited[2].fade.step,1);assert.equal(visited[2].fade.target,15);assert.equal(visited[2].fade.mask,1);
 assert.equal(visited[3].fade.step,-8);assert.equal(visited[3].camera.target,0);
 assert.deepEqual(view.drainLifecycleCompleted(),[{token:event.token,actor_id:'enemy',life_epoch:0}]);
 view.present(state,now+1000);assert.equal(view.colorFade.value,0);assert.equal(view.colorFade.active,false);
 assert.equal(view.cameraPan.x,0);assert.equal(view.cameraPan.active,false);view.destroy();
 }
});

test('real lifecycle layers load separately and a completed player death stays drawn after its event is acknowledged',async()=>{
 const {view,target}=await fixture();const event={token:'death-1',actor_id:'002',life_epoch:0,kind:'death',source_skill_index:12,hold_final_frame:true};
 for(let at=0;at<=5000;at+=20)view.present(snapshot([event]),at);assert.equal(view.drainLifecycleCompleted().length,1);
 target.calls.length=0;view.present(snapshot(),6000);
 const last=life.roles.find(r=>r.id==='002').skills.find(s=>s.chr_skill_index===12).last_source_pose;
 assert.ok(target.calls.some(c=>c.path?.endsWith(`frame_${String(last.source_frame).padStart(4,'0')}_main.png`)));
 assert.equal(view.lifecycle.pose('002').source_frame,last.source_frame);assert.equal(view.lifecycle.hidden('002'),false);
});
test('revive epoch replaces held corpse without cancelling an unrelated actor lifecycle',async()=>{
 const {view}=await fixture();const dead={token:'d',actor_id:'002',life_epoch:0,kind:'death',source_skill_index:12,hold_final_frame:true};
 for(let at=0;at<=4000;at+=20)view.present(snapshot([dead]),at);view.drainLifecycleCompleted();
 const revive={token:'r',actor_id:'002',life_epoch:1,kind:'revive',source_skill_index:14};
 view.present(snapshot([revive],1),4100);assert.notEqual(view.lifecycle.pose('002').source_frame,life.roles.find(role=>role.id==='002').skills.find(s=>s.chr_skill_index===12).last_source_pose.source_frame);
 for(let at=4120;at<=9000;at+=20)view.present(snapshot([revive],1),at);assert.deepEqual(view.drainLifecycleCompleted().map(e=>e.token),['r']);assert.equal(view.lifecycle.hidden('002'),false);
});
test('source revival carrier load failure advances without wait or invented contact, then real effect contacts at frame1',async()=>{
 const {view}=await fixture(),skill=life.roles.find(role=>role.id==='001').skills.find(s=>s.chr_skill_index===43).source_skill;
 const plan=directSequence(skill),compiled=compileNativeSequence(view.meta,'001',plan,[view.layers,...view.alternateLayers.values()]);
 const missing=compiled.steps.find(s=>s.missing_effect==='m77Rwz01');assert.ok(missing);assert.equal(missing.duration_ms,0);assert.equal(missing.event,null);
 assert.deepEqual(compiled.steps.filter(s=>s.event).map(s=>[s.carrier_asset_id,s.logical_frame]),[['_iRelife',1]]);
 const effects=compiled.steps.filter(s=>s.carrier_asset_id==='_iRelife');assert.equal(effects.length,19);assert.ok(effects.every(s=>s.duration_ms===80));
 let contacts=0;const done=view.playSequence({actor_id:'001',target_id:'002',skill_id:'001_43',plan},{onRecord(){},onContact(){contacts++;return {hit:true,damage:0,revived:true,hp_delta:151};}});
 for(let at=0;at<=21000;at+=20)view.present(snapshot(),at);await done;assert.equal(contacts,1);assert.equal(view.damageTexts.length,0);
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
   now=at;battle.advanceClock(now);drawn.clear();target.calls.length=0;view.present(battle.presentationSnapshot(),now);
   for(const event of view.drainLifecycleCompleted())battle.ackLifecycle(event);
   await Promise.resolve();
 }};
}

test('a real knockdown holds its final ground frame for the native5000 budget before getting up',async()=>{
 for(const fps of [30,60,144]){
  const f=await liveFixture('013'),{battle,view,drawn}=f,attacker=battle.actor('001'),victim=battle.actor('enemy-0');
  const skill=structuredClone(f.commands.skills['001_26']);skill.actor_id=attacker.id;
  const task=battle.performSequence(attacker,victim,skill,directSequence(skill));
  let held=null,holdTicks=0,released=false;
  for(let frame=0;frame<fps*12;frame++){
   const ticks=battle.state.scheduler.ticks;await f.draw(frame*1000/fps);
   if(!held&&victim.reaction_special_gate_raw===5000){
    held={charge:structuredClone(victim.charge),pose:structuredClone(drawn.get('013'))};
    const last=life.roles.find(r=>r.id==='013').skills.find(s=>s.chr_skill_index===4).last_source_pose;
    assert.equal(held.pose.frame,last.action_frame,'hold starts on the last ground frame');
    assert.equal(view.lifecycleSnapshot().active.some(row=>row.actor_id===victim.id),false,'sprite completion starts the hold immediately');
   }else if(held&&!released&&battle.state.scheduler.ticks!==ticks){
    holdTicks++;
    if(holdTicks<=50){
     assert.equal(victim.reaction_special_gate_raw,5000-holdTicks*99);
     assert.equal(victim.current_skill.original_id_raw,4);assert.equal(victim.native_active,true);
     assert.deepEqual(victim.charge,held.charge,'hold does not spend preparation or F6A2/F69E');
     assert.deepEqual(drawn.get('013'),held.pose,'ground pose remains still');
    }else{
     assert.equal(holdTicks,51);assert.equal(victim.reaction_special_gate_raw,0);
     assert.equal(victim.current_skill.original_id_raw,6);assert.equal(victim.charge.gauge,held.charge.gauge+49);
     released=true;
    }
   }
   if(released&&!battle.hasLifecycle()&&!battle.pendingPresentations.size)break;
  }
  await task;assert.ok(held&&released,`${fps}fps completed the full hold`);view.destroy();
 }
});

test('a hit during the ground hold replaces its timer without prematurely ending the new response',async()=>{
 const f=await liveFixture('013'),{battle,view,logs}=f,attacker=battle.actor('001'),victim=battle.actor('enemy-0');
 const skill=structuredClone(f.commands.skills['001_26']);skill.actor_id=attacker.id;
 let firstDone=false;const first=battle.performSequence(attacker,victim,skill,directSequence(skill)).then(()=>{firstDone=true;});let frame=0;
 for(;frame<600;frame++){await f.draw(frame*1000/60);if(victim.reaction_special_gate_raw===5000){frame++;break;}}
 assert.equal(victim.reaction_special_gate_raw,5000);assert.ok(battle.pendingSourceEnds.has(victim.id));
 for(;!firstDone&&frame<900;frame++)await f.draw(frame*1000/60);
 await first;assert.ok(victim.reaction_special_gate_raw>0,'the next attack is queued while the victim still holds the ground pose');
 const next=f.sample.skills.yantu,task=battle.performSequence(attacker,victim,next,directSequence(next));let contact=null;
 for(;frame<1200;frame++){
  await f.draw(frame*1000/60);contact=logs.find(e=>e.type==='battle-impact'&&e.skill_id==='yantu');if(contact){frame++;break;}
 }
 assert.ok(contact);assert.equal(victim.current_skill.original_id_raw,3);assert.equal(victim.reaction_special_gate_raw,0);
 assert.equal(battle.pendingSourceEnds.has(victim.id),false,'the old source wait is retired by the new hit');
 for(let count=0;count<3;count++,frame++){await f.draw(frame*1000/60);assert.equal(victim.current_skill.original_id_raw,3);}
 for(;frame<1800;frame++){await f.draw(frame*1000/60);if(!battle.pendingPresentations.size&&!battle.hasLifecycle()&&!battle.pendingSourceEnds.size)break;}
 await task;view.destroy();
});

test('enemy and party hit recovery uses source durations and never inserts idle into knockdown/get-up handoffs',async()=>{
 for(const fps of [30,60,144])for(const [side,skillId,enemyRole,knockdown] of [['enemy',15,'013',false],['player','yantu','013',false],['player','001_26','013',true],['enemy',19,'042',true]]){
   const f=await liveFixture(enemyRole),{battle,view,drawn,logs}=f;
   const attacker=battle.actor(side==='player'?'001':'enemy-0'),victim=battle.actor(side==='player'?'enemy-0':'001'),resource=victim.resource_id??victim.id;
   const selected=structuredClone(side==='enemy'?f.ai.roles[enemyRole].skills[skillId]:skillId==='yantu'?f.sample.skills.yantu:f.commands.skills[skillId]);selected.actor_id=attacker.id;
   let ended=false;const task=battle.performSequence(attacker,victim,selected,directSequence(selected)).then(()=>ended=true);
   for(let tick=0;tick<fps*12;tick++){
     const active=victim.native_active;await f.draw(tick*1000/fps);
     if(active)assert.notEqual(drawn.get(resource).action,0,`${side}:${skillId} must retain the response pose at ${tick}/${fps}`);
      if(ended&&!battle.state.lifecycle_events.length&&!battle.pendingPresentations.size&&!battle.pendingSourceEnds.size)break;
   }
   await task;
   if(knockdown)assert.ok(logs.some(e=>e.type==='battle-source-completed'&&e.actor_id===victim.id&&e.descriptor.reason==='source-end-get-up'));
   else{
     const contact=logs.find(e=>e.type==='battle-impact'),end=logs.find(e=>e.type==='battle-source-completed'&&e.actor_id===victim.id);
     const source=life.roles.find(r=>r.id===resource).skills.find(s=>s.chr_skill_index===contact.reaction.source_skill_index);
     const duration=source.timeline.reduce((n,s)=>n+(s.interval_raw??0),0);
     const frameMs=1000/fps,sourceFrames=source.timeline.filter(s=>s.kind==='sprite');
     const expected=sourceFrames.reduce((n,s)=>n+Math.ceil((s.interval_raw-1e-7)/frameMs)*frameMs,0);
     assert.ok(Math.abs(end.at-contact.at-expected)<=frameMs+0.001,'each response interval resets at the actual native loop visit');
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
   for(let at=0;at<duration;at+=65)await f.draw(at);assert.equal(attacker.native_active,true);
   for(let at=duration;attacker.native_active&&at<duration+1000;at+=65)await f.draw(at);
   const end=logs.find(e=>e.type==='battle-source-completed'&&e.actor_id===attacker.id);
   assert.ok(end&&end.at>=duration);assert.equal(attacker.native_active,false);await f.draw(end.at+1);
   assert.equal(drawn.get(attacker.resource_id??attacker.id).action,0);assert.equal(view.run,null);await task;
 }
});

test('four compiled attacks hand off after return, retain leases and preserve source hit gates across 50/60/144 FPS',async()=>{
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
         assert.equal(f.view.run.result.actor_id,'004');assert.equal(f.view.run.main_done,false);
         assert.equal(f.battle.state.scheduler.active_actor_id,'004','return retains the global action owner');
       }
       const enemy=f.battle.actor('enemy-0');
       if(enemy.native_active&&enemy.charge.gauge>=f.battle.state.scheduler.threshold)assert.equal(isActorReady(enemy,f.battle.state.scheduler),false);
       if(f.finished)break;
     }
     const contacts=f.events.filter(e=>e.type==='battle-impact'&&e.actor_id!=='enemy-0'),hits=contacts.filter(e=>e.hit);
     assert.equal(checkedReturn,true);assert.equal(contacts.length,16);assert.ok(hits.length>=2);
     assert.ok(f.battle.state.reward_ledger.chain.maximum>=2);
     for(const hit of hits)if(hit.settled_before)assert.ok(hit.chain>=2,'only a still-settled victim extends the chain');
     const starts=f.events.filter(e=>e.type==='battle-scheduled'),second=starts.find(e=>e.actor_id==='001');
     const firstEnd=f.events.find(e=>e.type==='battle-source-completed'&&e.actor_id==='004');
     const handoff=f.events.find(e=>e.type==='battle-attack-completed'&&e.actor_id==='004');
     assert.ok(firstEnd.at>handoff.at,'attack boundary remains observable before the return ends');
     assert.ok(second.at>=firstEnd.at&&second.at-firstEnd.at<=1000/fps+0.001,'a ready teammate dispatches on the next loop after the full primary action');
     for(const next of starts.filter(e=>e.actor_id!=='004'&&e.actor_id!=='enemy-0')){
       const previous=starts[starts.indexOf(next)-1],end=f.events.find(e=>e.type==='battle-source-completed'&&e.actor_id===previous.actor_id);
       assert.ok(end&&next.at>=end.at,'primary actions never overlap');
     }
     assert.ok(starts.find(e=>e.actor_id==='enemy-0').at>hits.at(-1).at,'a full enemy waits for hit recovery');
     assert.equal(f.finished,true);assert.equal(released,1);assert.equal(f.battle.activeActions.size,0);assert.equal(f.battle.pendingPresentations.size,0);
   }finally{f.dispose();}
 }
});

test('handoff preserves ordinary-hit gaps, enemy recovery and native action ordering',async()=>{
 for(const [scenario,maximum]of [['ordinary',0],['gap',0],['natural',16]]){
   const f=await createHandoffFixture({load:read,canvas:canvas(),assetLoader:async a=>({width:a.width,height:a.height,path:a.path}),scenario});f.view._sprite=()=>{};
   try{
     for(let frame=0;frame<60*20;frame++){await f.advance(frame*1000/60);if(f.finished)break;}
     assert.equal(f.finished,true);assert.equal(f.battle.state.reward_ledger.chain.maximum,maximum,scenario);
     if(scenario==='ordinary')assert.ok(f.events.filter(e=>e.type==='battle-impact'&&e.actor_id!=='enemy-0').every(e=>e.settled_before===0));
     if(scenario==='gap'){
       const recovered=f.events.find(e=>e.type==='battle-source-completed'&&e.actor_id==='enemy-0'&&e.descriptor.reason==='source-end-idle');
       const attack=f.events.find(e=>e.type==='battle-scheduled'&&e.actor_id==='enemy-0');
       const returned=f.events.find(e=>e.type==='battle-source-completed'&&e.actor_id==='001'),readyAt=Math.max(recovered.at,returned.at);
       assert.ok(attack.at>=readyAt&&attack.at-readyAt<=40);assert.equal(f.battle.state.history.some(e=>e.actor_id==='002'),false);
     }
     if(scenario==='natural')assert.deepEqual(f.events.filter(e=>e.type==='battle-scheduled'&&e.actor_id!=='enemy-0').map(e=>e.actor_id),['004','003','002','001']);
   }finally{f.dispose();}
 }
});

test('a new hit interrupts the current return and releases its queued teammate while the old target reaction continues',async()=>{
 const f=await createHandoffFixture({load:read,canvas:canvas(),assetLoader:async a=>({width:a.width,height:a.height,path:a.path})});f.view._sprite=()=>{};
 try{
   let frame=0;
   for(;frame<500&&!f.events.some(e=>e.type==='battle-attack-completed'&&e.actor_id==='004');frame++)await f.advance(frame*20);
   const returning=f.view.run;
   assert.ok(returning&&!returning.main_done);assert.equal(returning.result.actor_id,'004');
   assert.equal(f.events.some(e=>e.type==='battle-scheduled'&&e.actor_id==='001'),false);
   const actor=f.battle.actor('004'),response=selectNativeNormalReaction({actor,ident:1,data:f.sample.reaction_data,rng:()=>50});
   Object.assign(actor,structuredClone(response.after));actor.native_sequence_token='controlled-return-hit';f.battle.queueLifecycle(actor,response);
   await f.advance(frame++*20);
   assert.equal(returning.main_done,true);assert.equal(returning.interrupted,true);assert.equal(f.battle.activeActions.has('004'),false);
   assert.ok(returning.children.some(child=>child.result.actor_id==='enemy-0'&&!child.done));
   await f.advance(frame++*20);
   assert.equal(f.view.run.result.actor_id,'001');assert.equal(f.view.run.main_done,false);assert.equal(f.battle.activeActions.has('001'),true);
   for(;frame<1500;frame++){await f.advance(frame*20);if(f.finished)break;}
   assert.equal(f.finished,true);assert.equal(f.battle.pendingPresentations.size,0);
 }finally{f.dispose();}
});

test('warm healing animates the caster idle during both source effect waits',async()=>{
 const f=await liveFixture('013',await read('/data/forest_status.json')),{battle,view,drawn,logs}=f,attacker=battle.actor('001'),target=attacker;
 const skill=f.commands.skills.yannuan,task=battle.performSequence(attacker,target,skill,directSequence(skill));
 const idleFrames=new Map();
 let castDrawn=false,now=0;
 for(;now<6000;now+=10){
   await f.draw(now);
   const pose=drawn.get('001'),step=view.run?.steps[view.run.cursor];
   castDrawn||=pose.action===24;
   if(step?.carrier_asset_id){
     assert.equal(attacker.native_active,true);
     assert.equal(pose.action,0);
     if(!idleFrames.has(step.carrier_asset_id))idleFrames.set(step.carrier_asset_id,[]);
     idleFrames.get(step.carrier_asset_id).push(pose.frame);
   }
   if(!attacker.native_active)break;
 }
 assert.equal(castDrawn,true);
 assert.deepEqual([...idleFrames.keys()],['m01Rwz01','_iReSTfr']);
 for(const frames of idleFrames.values()){
   assert.equal(frames[0],0);
   assert.ok(new Set(frames).size>1,'the caster keeps animating while the effect plays');
 }
 assert.equal(battle.state.history.at(-1).contacts.length,1);
 assert.equal(attacker.native_active,false);
 assert.ok(logs.some(e=>e.type==='battle-source-completed'&&e.actor_id==='001'&&e.at>=5050));
 await f.draw(now+10);assert.equal(drawn.get('001').action,0);assert.equal(view.run,null);await task;
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

test('contact recovery accumulates source12D, preserves native gates and converts only after the response ends',async()=>{
 // Original 50FA00 reads the attacker's current fixed+12D; 506870 instead
 // reads the victim's current fixed+12D. Controlled contact delivery keeps
 // their unmodified 45/35 source bytes distinct and does not run rendering.
 for(const scenario of ['ordinary','effect','subthreshold','guard','dodge','zero','lethal','recovering','rejected']){
   const f=await liveFixture(),{battle}=f,attacker=battle.actor('001'),victim=battle.actor('enemy-0');
   const selected=structuredClone(f.commands.skills.kai_luoyan),targetSkill=structuredClone(f.commands.skills.kai_mieyan);
   selected.actor_id=attacker.id;
   assert.equal(Buffer.from(selected.fixed_raw_hex,'hex')[0x12d],45);
   assert.equal(Buffer.from(targetSkill.fixed_raw_hex,'hex')[0x12d],35);
   const contact=selected.actions.find(action=>Buffer.from(action.raw_hex,'hex').readUInt32LE(0x49));
   const effect=scenario==='effect',damage=['zero','dodge'].includes(scenario)?0:1,reaction=scenario==='guard'?1:scenario==='dodge'?2:0;
   if(effect){selected.effect_context={effect_token:1};victim.current_skill=targetSkill;}
   victim.charge.recovery_ticks=scenario==='subthreshold'?0:70;
   victim.native_after_raw={...victim.native_after_raw,'0x0521f6a2':victim.charge.recovery_ticks};
   if(scenario==='recovering'){victim.reaction_inhibit_raw=25;victim.charge.recovery=25;}
   if(scenario==='rejected')victim.reaction_busy_raw=1;
   battle.resolveAction=({skill})=>({hit:scenario!=='dodge',damage,mp_cost:skill.mp_cost,native_return:damage,reaction,after_settled_raw:reaction?0:1});
   if(scenario==='lethal')battle.applyDamage=actor=>({...actor,hp:{...actor.hp,current:0},state_raw:4});
   const expected=scenario==='ordinary'?[115,160]:effect?[105]:scenario==='subthreshold'?[45]:[70],contacts=[];
   battle.playSequence=async(event,hooks)=>{
     for(const [index,ticks]of expected.entries()){
       const step={source:contact,source_skill_index:selected.original_skill_index,class_raw:contact.class_raw,
         action_mask_raw:effect?0:contact.action_mask_raw,effect_contact:effect,effect_token:effect?1:0,contact_key:`${event.action_id}:${index}`};
       const result=hooks.onContact(step);contacts.push(result);
       assert.equal(victim.charge.recovery_ticks,ticks,scenario);
       assert.equal(victim.native_after_raw['0x0521f6a2'],ticks,scenario);
       assert.equal(victim.charge.recovery,scenario==='recovering'?25:0,scenario);
       assert.deepEqual(hooks.onContact(step),result,'the same delivered contact must not add recovery twice');
       assert.equal(victim.charge.recovery_ticks,ticks,scenario);
     }
     return {completed:true};
   };
   await battle.performSequence(attacker,victim,selected,directSequence(selected));
   assert.equal(contacts.length,expected.length);
   if(['ordinary','effect','subthreshold'].includes(scenario)){
     assert.equal(victim.native_active,true,'recovery remains cumulative while the hit response plays');
     battle.completeNativeSource(victim,0);
     const converted=expected.at(-1)>99,recovery=converted?Math.floor(battle.state.scheduler.threshold*expected.at(-1)/100):0;
     assert.equal(victim.charge.recovery,recovery);assert.equal(victim.reaction_inhibit_raw,recovery);
     assert.equal(victim.charge.recovery_ticks,converted?0:45);assert.equal(victim.native_after_raw['0x0521f6a2'],converted?0:45);
   }
 }
});


test('painting zero or several times per update preserves contacts, RNG, recovery and handoff',async()=>{
 const results=[];
 for(const options of [{render:true},{render:false},{render:true,repaints:3}]){
  const target=canvas(),f=await createHandoffFixture({load:read,canvas:target,
    assetLoader:async asset=>({width:asset.width,height:asset.height}),scenario:'relay'});
  let draws=0;const rng=f.battle.rng;f.battle.rng=()=>{draws++;return rng();};
  try{
   let frames=0;
   for(;frames<3000&&!f.finished;frames++)await f.advance(Math.floor(frames*1000/60),options);
   assert.equal(f.finished,true);
   results.push({frames,draws,events:structuredClone(f.events),state:structuredClone(f.battle.state),world:f.world.snapshot()});
   const before=f.battle.snapshot(),lifecycle=f.view.lifecycleSnapshot();
   for(let paint=0;paint<3;paint++)f.view.draw(before,100000);
   assert.deepEqual(f.battle.snapshot(),before,'painting cannot acknowledge or advance a battle');
   assert.deepEqual(f.view.lifecycleSnapshot(),lifecycle);
  }finally{f.dispose();}
 }
 assert.deepEqual(results[1],results[0]);assert.deepEqual(results[2],results[0]);
});
