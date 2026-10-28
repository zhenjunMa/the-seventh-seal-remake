import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileNativeSequence,directSequence} from '../web/core/skill_sequence.mjs';
import {BattleView} from '../web/battle_view.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {createNativeRng,resolveAction,nativeEffectContextForTarget} from '../web/core/combat_rules.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
const source=await read('./fixtures/native_aid_skills.json');
const metadata=await read('../web/data/party_battle_view.json'),copy=structuredClone;
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const meta=copy(metadata);
 for(const role of source.roles){const target=meta.roles.find(r=>r.id===role.id);for(const action of role.actions){const old=target.actions.find(a=>a.index===action.index);if(old)assert.equal(old.native_raw_hex,action.native_raw_hex);else target.actions.push(copy(action));}}
 for(const effect of source.effects)if(!meta.effects.some(e=>e.id===effect.id))meta.effects.push(copy(effect));
 const context={};
 const view=new BattleView({canvas:{getContext:()=>context}});view.ready=true;view.meta=meta;view.layers={role_id:'001',frames:[]};
 view.roster=[{id:'001',resource_id:'001',side:'player'},{id:'enemy-0',resource_id:'032',side:'enemy'}];
 return view;
}
const skill=(id,index)=>source.skills.find(s=>s.actor_id===id&&s.original_skill_index===index);
function launch(view,s,events,label){
 const plan=directSequence(s),compiled=compileNativeSequence(view.meta,s.actor_id,plan);
 const promise=view.playSequence({actor_id:s.actor_id,target_id:'enemy-0',skill_id:s.id,plan,action_id:label},{
  onRecord(step){events.push({kind:'record',label,record:step.plan_record_index});},
  onPrimaryEnd(time){events.push({kind:'primary-end',label,time});},
  onCarrierStart({carrier_id}){events.push({kind:'spawn',label,carrier_id});},
  onCarrierEnd({carrier_id},time){events.push({kind:'carrier-end',label,carrier_id,time});},
  onEffectFrame(step){events.push({kind:'effect-frame',label,...step});},
  onContact(step){events.push({kind:'contact',label,time:step.presentation_time_ms,record:step.plan_record_index,frame:step.logical_frame,key:step.contact_key});return {hit:true,damage:1,remainingHp:1000};}});
 return {promise,compiled};
}

test('all six story learning rewards retain exact CHR bytes, native types and nonwaiting carriers',async()=>{
 assert.deepEqual(source.skills.map(s=>[s.actor_id,s.original_skill_index,s.original_id_raw,s.type_raw]),[
  ['001',35,71,3],['001',36,72,3],['002',30,71,3],['002',31,72,3],['003',33,71,3],['005',30,72,0]]);
 for(const s of source.skills){
  const bytes=await readFile(new URL('../../../'+s.source.path,import.meta.url));assert.equal(sha(bytes),s.source.sha256);
  assert.equal(bytes.subarray(s.source.fixed_record_offset,s.source.fixed_record_offset+1053).toString('hex'),s.fixed_raw_hex);
  const compiled=compileNativeSequence(fixture().meta,s.actor_id,directSequence(s));
  assert.equal(compiled.independent_carriers,true);assert.equal(compiled.steps.filter(s=>s.event).length,0);
  const launches=compiled.steps.filter(s=>s.carrier_spawn),original=s.actions.filter(a=>a.type_raw===1&&a.u32_at_0x01_raw===4);
  assert.equal(launches.length,original.length);
  for(const [i,step]of launches.entries()){
   const raw=bytes.subarray(original[i].offset,original[i].offset+176);assert.equal(raw.toString('hex'),original[i].raw_hex);
   assert.equal(raw[0x1d],0);assert.equal(step.duration_ms,0);assert.equal(step.carrier_spawn.interval_ms,80);
   assert.equal(step.source.source_raw_hex,raw.toString('hex'));
   const contacts=step.carrier_spawn.steps.filter(s=>s.event);assert.equal(contacts.length,1);
   assert.equal(contacts[0].logical_frame,raw.readUInt32LE(0x49));assert.equal(contacts[0].effect_token,1);
   assert.equal(step.carrier_spawn.steps.at(-1).carrier_end,true);
  }
 }
 for(const e of source.effects)assert.equal(sha(await readFile(new URL('../../../'+e.source.path,import.meta.url))),e.source.sha256);
});

test('nonwaiting source carriers outlive CHR completion and let the next command start before their contacts',async()=>{
 const view=fixture(),events=[],first=launch(view,skill('001',36),events,'first');
 view._advance(0);view._advance(1280);
 const result=await first.promise;assert.equal(result.carriers_pending,true);assert.equal(view.run,null);assert.equal(view.detachedRuns.length,1);
 assert.equal(events.filter(e=>e.kind==='contact').length,0);assert.equal(events.filter(e=>e.kind==='primary-end')[0].time,1280);
 const second=launch(view,skill('001',35),events,'second');view._advance(1300);assert.ok(view.run);
 view._advance(10000);await second.promise;
 const hits=events.filter(e=>e.kind==='contact');
 assert.deepEqual(hits.map(e=>[e.label,e.record,e.frame,e.time]),[
  ['first',3,7,1760],['first',4,10,2000],['first',5,12,2160],['second',3,7,3060],['second',4,13,3540]]);
 assert.equal(new Set(hits.map(e=>`${e.label}:${e.key}`)).size,hits.length);
 assert.equal(events.filter(e=>e.kind==='carrier-end').length,5);assert.equal(view.detachedRuns.length,0);assert.equal(view.run,null);
});

test('a carrier retains its source contact after an external owner response interrupts unvisited CHR records',async()=>{
 const view=fixture(),events=[],started=launch(view,skill('001',36),events,'interrupted');
 view._advance(0);view._advance(1280);
 await started.promise;
 const detached=view.detachedRuns[0];detached.interrupted=true;detached.main_done=true;
 view._advance(5000);assert.deepEqual(events.filter(e=>e.kind==='contact').map(e=>e.frame),[7,10,12]);
 assert.equal(events.filter(e=>e.kind==='spawn').length,3);
});

test('aid sound callbacks retain every independent carrier frame and instance after a slow RAF without replaying',async()=>{
 const view=fixture(),events=[],started=launch(view,skill('001',36),events,'audio');
 view._advance(0);view._advance(1280);await started.promise;
 view._advance(10000);
 const frames=events.filter(e=>e.kind==='effect-frame');
 for(const id of ['BFr01_Nm','BFr01_Nd','BFr01_Dn','cvt_p002'])assert.ok(frames.some(e=>e.asset_id===id&&e.logical_frame===1),id);
 assert.equal(new Set(frames.map(e=>`${e.channel_id}:${e.effect_index}:${e.logical_frame}`)).size,frames.length);
 const count=events.length;view._advance(10000);view._advance(20000);assert.equal(events.length,count);
});

test('carrier scheduling merges equal-time allocations before a new action contact and cancels every detached callback on stop',async()=>{
 const view=fixture(),events=[],first=launch(view,skill('001',36),events,'first');view._advance(0);view._advance(1280);await first.promise;
 const old=view.detachedRuns[0],steps=old.carriers.map(c=>c.steps.find(s=>s.event));
 // This synthetic timing perturbation checks the scheduler merge only; the
 // previous tests retain every unmodified source action and timing above.
 for(const [i,c]of old.carriers.entries()){c.steps=[steps[i]];c.visited=-1;c.next_at=1400;c.done=false;}
 view._advance(1400);assert.deepEqual(events.filter(e=>e.kind==='contact').map(e=>e.record),[3,4,5]);
 const before=events.length;view.stop();view._advance(20000);assert.equal(events.length,before);assert.equal(view.detachedRuns.length,0);
});

test('native terminal locking rolls rewards before a remaining carrier is retired and never repeats its RNG',async()=>{
 const evidence=await read('./fixtures/native_carrier_terminal.json');
 const end=evidence.records.find(r=>r.parameters.procedure==='0x4ffa30').normalized_result,
  reward=evidence.records.find(r=>r.parameters.procedure==='0x50d1c0').normalized_result;
 assert.ok(end.indexOf('DAT_055edffc = 1')<end.indexOf('FUN_0050d1c0();',end.indexOf('DAT_055edffc = 1')));
 assert.ok(end.includes("= 9;"));assert.ok(reward.includes('FUN_0050cc20();'));assert.ok(!reward.includes('055eaf80'));
 const core=Object.create(BattleController.prototype),events=[];
 Object.assign(core,{state:{phase:'charging',actors:[{id:'001',side:'player',hp:{current:1000},state_raw:0},{id:'enemy-0',side:'enemy',hp:{current:0},state_raw:7}],
  scheduler:{pending:null,queued_commands:[]}},running:false,lifecycleEnabled:false,lockedOutcome:null,pendingCarriers:new Set(['remaining']),rewardData:{},
  prepareRewards(){if(!this.rewardPlan){events.push('reward-rng');this.rewardPlan={};}return this.rewardPlan;}});
 core.refreshCommandState();assert.deepEqual(events,['reward-rng']);assert.equal(core.lockedOutcome,'victory');
 assert.equal(core.state.actors[0].state_raw,9);assert.equal(core.state.phase,'charging');assert.equal(core.state.pending_outcome,'victory');
 core.refreshCommandState();assert.deepEqual(events,['reward-rng']);
 core.pendingCarriers.clear();core.refreshCommandState();assert.equal(core.state.phase,'victory');assert.equal(core.state.pending_outcome,null);assert.deepEqual(events,['reward-rng']);
 // In production prepareRewards is idempotent through rewardPlan. No new
 // random decision is made when the result becomes returnable.
});

test('a late native carrier uses its captured skill after owner idle without restoring the old source record',async()=>{
 const [party,enemies,scheduler]=await Promise.all(['../web/data/party_combat.json','../web/data/forest_combat.json','../web/data/battle_scheduler.json'].map(read));
 const selected=copy(skill('001',36));selected.effect_context={effect_token:1};
 const actor={...copy(party.actors['001']),state_raw:0,native_active:false,current_skill:copy(selected),current_target_id:'enemy-0',native_z_raw:0},
  target={...copy(enemies.actors['032']),id:'enemy-0',resource_id:'032',state_raw:0,reaction_busy_raw:0,immune_raw:0,status_flags_raw:0};
 const calls=[],core=Object.create(BattleController.prototype),plan=directSequence(selected),step=compileNativeSequence(fixture().meta,'001',plan).steps.find(s=>s.carrier_spawn).carrier_spawn.steps.find(s=>s.event);
 Object.assign(core,{state:{id:'late-carrier',action_count:0,round:1,history:[],actors:[actor,target]},schedulerData:scheduler,pendingCarriers:new Set(),testMode:false,
  now:()=>0,checkWorld(){},publish(){},log(){},rng(){throw Error('presentation scheduling must not draw RNG');},
  consumeResources:(actor,cost)=>({...actor,mp:{...actor.mp,current:actor.mp.current-cost}}),
  resolveAction:input=>{calls.push({skill:input.skill.original_skill_index,current:Buffer.from(input.attacker.current_skill.fixed_raw_hex,'hex')[0]});return {hit:true,damage:1,reaction:0,native_return:0,after_settled_raw:1};},
  applyDamage:(actor,result)=>({...actor,hp:{...actor.hp,current:actor.hp.current-result.damage}}),
  playSequence:async(_event,hooks)=>{
   hooks.onCarrierStart({carrier_id:'carrier-0'});hooks.onPrimaryEnd(100);
   assert.equal(Buffer.from(actor.current_skill.fixed_raw_hex,'hex')[0],0);
   hooks.onContact({...copy(step),contact_key:'late',presentation_time_ms:560});
   assert.equal(Buffer.from(actor.current_skill.fixed_raw_hex,'hex')[0],0,'carrier contact must not restore source index36 on the owner');
   // Leave the carrier alive: its lifetime belongs to the independent view.
   return {completed:true,carriers_pending:true};
  }});
 await core.performSequence(actor,target,selected,plan);
 assert.deepEqual(calls,[{skill:36,current:0}]);assert.equal(core.state.history[0].contacts.length,1);assert.equal(core.pendingCarriers.size,1);
});

test('reusing a view cannot deliver an old detached source contact to the new controller',async()=>{
 const view=fixture(),events=[],oldControl={nextNativeVerticalAt:()=>Infinity};
 view.nativeControl=oldControl;view.nativeControlIsCurrent=()=>true;
 const started=launch(view,skill('001',36),events,'old-owner');view._advance(0);view._advance(1280);await started.promise;
 assert.equal(view.detachedRuns.length,1);
 view.nativeControl={nextNativeVerticalAt:()=>Infinity};view.nativeControlIsCurrent=()=>true;
 view._advance(20000);assert.equal(events.filter(event=>event.kind==='contact').length,0);assert.equal(view.detachedRuns.length,0);
});

test('all five menu-eligible aid rewards match original token1 arithmetic and every CRT draw at each source carrier contact',async()=>{
 const [attributes,enemies,reactions,instructions,native]=await Promise.all([
  '../web/data/party_combat.json','../web/data/forest_combat.json','../web/data/party_reactions.json','../evidence/turn_rules_assembly_20261011.json','../evidence/party_magic_native.json'].map(read));
 const getter=native.records.find(r=>r.operation==='procedure_assembly'&&r.parameters.procedure==='0x501930'),
  functions={...instructions.functions,'0x501930':getter.normalized_result.trim().split('\n')};let comparisons=0;
 for(const original of source.skills.filter(skill=>skill.type_raw===3)){
  const selected={...copy(original),effect_context:{effect_token:1,effect_source_skill_index:original.original_skill_index,effect_lookup:'same-index-source-table'}};
  for(const record of selected.actions.filter(action=>action.type_raw===1&&action.u32_at_0x01_raw===4))for(const id of ['011','012','013','032'])for(let n=0;n<8;n++){
   const attacker={...copy(attributes.actors[selected.actor_id]),current_skill:copy(selected),state_raw:0,settled_raw:0,immune_raw:0,class_raw:record.class_raw,
    defense_half_raw:0,reaction_inhibit_raw:0,stance_raw:1,action_mask_raw:record.action_mask_raw},target=copy(enemies.actors[id]);
   const context=nativeEffectContextForTarget(selected,target,reactions.roles),seed=(n*747796405)>>>0,
    actual=resolveAction({attacker,target,skill:selected,rng:createNativeRng(seed),context}),oracle=new NativeAssemblyOracle(functions,[attacker,target],createNativeRng(seed));
   assert.ok(selected.original_skill_index>=reactions.roles[id].skill_count,'fresh target slot is proven by its actual full CHR table');
   oracle.write(0x55e3fec,selected.original_skill_index);
   for(const [index,actor]of [attacker,target].entries()){
    const table=0x23000000+index*0x100000;oracle.write(0x524a9dc+index*0x30274,table);
    const fixed=index===0?Buffer.from(selected.fixed_raw_hex,'hex'):Buffer.alloc(0x41d);
    for(let offset=0;offset<fixed.length;offset++)oracle.write(table+selected.original_skill_index*0x421+offset,fixed[offset],1);
   }
   const result=oracle.run(0x41d990,[0,1,0x20000000,1]);
   assert.equal(actual.native_return,result.eax,`${selected.actor_id}:${selected.original_skill_index}/${record.index}/${id}/${n}`);
   assert.equal(actual.reaction,oracle.read(0x20000000));assert.equal(actual.after_settled_raw,oracle.read(0x521f69d+0x30274,1));
   assert.deepEqual(actual.trace.filter(row=>row.kind==='rng').map(row=>row.raw),result.rng_calls);comparisons++;
  }
 }
 assert.equal(comparisons,480);
});

test('actual carrier draws keep native shadow main and intrinsic layers in that blend order',async()=>{
 const view=fixture(),calls=[],stack=[],ctx={globalAlpha:1,globalCompositeOperation:'source-over',
  setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},fillText(){},
  createLinearGradient:()=>({addColorStop(){}}),save(){stack.push({globalAlpha:this.globalAlpha,globalCompositeOperation:this.globalCompositeOperation});},restore(){Object.assign(this,stack.pop());},
  drawImage(image){calls.push([image.path,this.globalCompositeOperation]);}};
 Object.assign(view,{canvas:{width:960,height:540},context:ctx});
 for(const role of view.meta.roles)for(const action of role.actions){action.sheet??=`/assets/test/${role.id}_${action.index}.png`;view.images.set(action.sheet,{path:action.sheet});}
 const asset=view.meta.effects.find(e=>e.id==='cvt_p002');
 Object.assign(asset,{layer_order:['shadow','main','intrinsic'],shadow_sheet:'/assets/test/aid_shadow.png',main_sheet:'/assets/test/aid_main.png',intrinsic_sheet:'/assets/test/aid_intrinsic.png',shadow_blend:'source-over',main_blend:'source-over',intrinsic_blend:'lighter'});
 for(const path of [asset.shadow_sheet,asset.main_sheet,asset.intrinsic_sheet])view.images.set(path,{path});
 const events=[],started=launch(view,skill('001',36),events,'layers');view.draw({actors:[]},0);calls.length=0;view.draw({actors:[]},1280);await started.promise;
 const drawn=calls.filter(([path])=>path.startsWith('/assets/test/aid_'));
 assert.deepEqual(drawn,Array.from({length:3},()=>[[asset.shadow_sheet,'source-over'],[asset.main_sheet,'source-over'],[asset.intrinsic_sheet,'lighter']]).flat());
 assert.equal(events.filter(event=>event.kind==='contact').length,0,'body layers are already drawn before each original contact');
 view.stop();
});
