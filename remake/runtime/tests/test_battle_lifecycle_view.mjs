// Real exported source timelines; synthetic clock / snapshot delivery only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BattleLifecyclePlayback,APPEARANCE_ALPHA_ADAPTER} from '../web/battle_lifecycle_view.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {AppearanceParticles} from '../web/appearance_particles.mjs';
import {createDeathParticleSurface} from '../web/death_particles.mjs';
const manifest=JSON.parse(await readFile(new URL('../web/data/battle_lifecycle.json',import.meta.url)));
const copy=structuredClone,role=id=>manifest.roles.find(row=>row.id===id),skill=(id,index)=>role(id).skills.find(row=>row.chr_skill_index===index);
const duration=s=>s.timeline.filter(step=>step.kind==='sprite').reduce((total,step)=>total+step.interval_raw,0);
const sprites=s=>s.timeline.filter(step=>step.kind==='sprite');
function fixture(){const playback=new BattleLifecyclePlayback(manifest),roster=[{id:'party-1',resource_id:'001',side:'player'},{id:'enemy-A',resource_id:'012',side:'enemy'}];const snapshot={id:'lifecycle-view-fixture',actors:roster.map(row=>({...row,life_epoch:1})),lifecycle_events:[]};return {playback,roster,snapshot};}
function event(actorId,kind,index,id,extra={}){return {token:`${actorId}:${kind}:1`,actor_id:actorId,kind,life_epoch:1,source_skill_index:index,source_id_raw:id,hold_final_frame:kind==='death'&&actorId.startsWith('party'),fade_increment_raw:null,...extra};}
test('player death follows every original frame interval, holds the final corpse pose and acknowledges once',()=>{
  const {playback,roster,snapshot}=fixture(),selected=skill('001',13),frames=sprites(selected),total=duration(selected),death=event('party-1','death',13,12);snapshot.lifecycle_events=[death];const before=copy(snapshot);
  playback.advance(snapshot,roster,0);assert.equal(playback.pose('party-1').source_frame,frames[0].source_frame);assert.deepEqual(playback.drainCompleted(),[]);
  playback.advance(snapshot,roster,frames[0].interval_raw-1);assert.equal(playback.pose('party-1').source_frame,frames[0].source_frame);
  playback.advance(snapshot,roster,frames[0].interval_raw);assert.equal(playback.pose('party-1').source_frame,frames[1].source_frame);
  playback.advance(snapshot,roster,total-1);assert.equal(playback.pose('party-1').source_frame,frames.at(-1).source_frame);assert.deepEqual(playback.drainCompleted(),[]);
  playback.advance(snapshot,roster,total);assert.deepEqual(playback.drainCompleted(),[{token:death.token,actor_id:death.actor_id,life_epoch:1}]);assert.equal(playback.hidden('party-1'),false);assert.equal(playback.snapshot().held.length,1);
  playback.advance(snapshot,roster,total+999);assert.deepEqual(playback.drainCompleted(),[]);assert.deepEqual(snapshot,before);
  snapshot.lifecycle_events=[];playback.advance(snapshot,roster,total+1000);assert.equal(playback.pose('party-1').source_frame,frames.at(-1).source_frame);
});
test('independent actor channels finish at their own source durations; enemy hides only after its last frame',()=>{
  const {playback,roster,snapshot}=fixture(),revive=event('party-1','revive',16,14),death=event('enemy-A','death',2,2);snapshot.lifecycle_events=[revive,death];const enemyDuration=duration(skill('012',2)),reviveDuration=duration(skill('001',16));assert.ok(enemyDuration<reviveDuration);
  playback.advance(snapshot,roster,0);assert.equal(playback.snapshot().active.length,2);assert.equal(playback.hidden('enemy-A'),false);
  playback.advance(snapshot,roster,enemyDuration-1);assert.equal(playback.hidden('enemy-A'),false);assert.deepEqual(playback.drainCompleted(),[]);
  playback.advance(snapshot,roster,enemyDuration);assert.equal(playback.hidden('enemy-A'),true);assert.equal(playback.snapshot().active.length,1);assert.deepEqual(playback.drainCompleted().map(row=>row.token),[death.token]);
  playback.advance(snapshot,roster,reviveDuration);assert.equal(playback.pose('party-1'),null);assert.deepEqual(playback.drainCompleted().map(row=>row.token),[revive.token]);
});

test('all six party resources finish their own type10 escape path before acknowledging disappearance',()=>{
 for(const source of manifest.roles.filter(r=>r.side==='player')){
  const playback=new BattleLifecyclePlayback(manifest),selected=source.skills.find(s=>s.original_id_raw===10);
  const roster=[{id:'member',resource_id:source.id,side:'player'}],escape=event('member','escape',selected.chr_skill_index,10);
  const snapshot={id:'escape-'+source.id,actors:[{...roster[0],life_epoch:1,native_x_raw:140}],lifecycle_events:[escape]};
  playback.advance(snapshot,roster,0);assert.equal(playback.hidden('member'),false);assert.deepEqual(playback.drainCompleted(),[]);
  const poses=[];
  for(let now=0;now<=5000&&!playback.hidden('member');now+=1000/60){
    playback.advance(snapshot,roster,now);const pose=playback.pose('member');if(pose)poses.push(pose);
    assert.equal(playback.snapshot().active[0]?.blocked??null,null);
  }
  assert.ok(poses.length>1,source.id);assert.ok(poses.at(-1).offset_x>poses[0].offset_x+300,source.id);
  assert.equal(playback.hidden('member'),true,source.id);assert.deepEqual(playback.drainCompleted(),[{token:escape.token,actor_id:'member',life_epoch:1}]);
 }
});
test('life epoch cancels held death and queued old acknowledgements before a revive channel starts',()=>{
  const {playback,roster,snapshot}=fixture(),death=event('party-1','death',13,12),total=duration(skill('001',13));snapshot.lifecycle_events=[death];playback.advance(snapshot,roster,0);playback.advance(snapshot,roster,total);assert.equal(playback.snapshot().completed_count,1);
  snapshot.actors[0].life_epoch=2;const revive=event('party-1','revive',16,14,{token:'party-1:revive:2',life_epoch:2});snapshot.lifecycle_events=[death,revive];playback.advance(snapshot,roster,total);
  assert.equal(playback.snapshot().held.length,0);assert.deepEqual(playback.drainCompleted(),[]);assert.equal(playback.pose('party-1').source_frame,sprites(skill('001',16))[0].source_frame);
  playback.advance(snapshot,roster,total+duration(skill('001',16)));assert.deepEqual(playback.drainCompleted(),[{token:revive.token,actor_id:'party-1',life_epoch:2}]);assert.equal(playback.hidden('party-1'),false);
});
test('a newer event token cancels prior playback without acknowledging or restarting stale tokens',()=>{
  const {playback,roster,snapshot}=fixture(),first=event('party-1','death',13,12),second={...first,token:'replacement-death'};snapshot.lifecycle_events=[first];playback.advance(snapshot,roster,0);playback.advance(snapshot,roster,140);
  snapshot.lifecycle_events=[second];playback.advance(snapshot,roster,140);assert.equal(playback.pose('party-1').source_frame,sprites(skill('001',13))[0].source_frame);
  snapshot.lifecycle_events=[first];playback.advance(snapshot,roster,5000);assert.equal(playback.snapshot().active.length,0);assert.deepEqual(playback.drainCompleted(),[]);
});
test('the legacy fade increment selects particles; render completion does not wait thirty220ms steps',()=>{
  const {playback,roster,snapshot}=fixture(),death=event('enemy-A','death',null,null,{fade_increment_raw:7});snapshot.lifecycle_events=[death];playback.advance(snapshot,roster,100);assert.equal(playback.pose('enemy-A'),null);assert.equal(playback.alpha('enemy-A'),1);
  assert.equal(role('012').death_policy.enemy_fade_fields.clock_raw,220);playback.advance(snapshot,roster,320);assert.equal(playback.alpha('enemy-A'),1);assert.equal(playback.hidden('enemy-A'),false);assert.deepEqual(playback.drainCompleted(),[]);
  assert.equal(playback.snapshot().active[0].fade.mode,7);playback.advance(snapshot,roster,700);assert.equal(playback.hidden('enemy-A'),false);
  playback.advance(snapshot,roster,850);assert.equal(playback.alpha('enemy-A'),0);assert.equal(playback.hidden('enemy-A'),true);assert.deepEqual(playback.drainCompleted().map(row=>row.token),[death.token]);
});
test('absent death source and absent fade do not create guessed fade or early acknowledgement',()=>{
  const {playback,roster,snapshot}=fixture();snapshot.lifecycle_events=[event('enemy-A','death',null,null)];playback.advance(snapshot,roster,0);playback.advance(snapshot,roster,100000);
  assert.equal(playback.hidden('enemy-A'),false);assert.equal(playback.alpha('enemy-A'),1);assert.equal(playback.pose('enemy-A'),null);assert.deepEqual(playback.drainCompleted(),[]);assert.equal(playback.snapshot().active[0].blocked,'missing-source-lifecycle-presentation');
});
test('a fade increment without its source clock cannot create an invented duration',()=>{
  const bounded=copy(manifest);delete bounded.roles.find(row=>row.id==='012').death_policy.enemy_fade_fields.clock_raw;
  const playback=new BattleLifecyclePlayback(bounded),{roster,snapshot}=fixture();snapshot.lifecycle_events=[event('enemy-A','death',null,null,{fade_increment_raw:3})];playback.advance(snapshot,roster,0);playback.advance(snapshot,roster,100000);
  assert.equal(playback.snapshot().active[0].blocked,'missing-source-fade-clock');assert.deepEqual(playback.drainCompleted(),[]);assert.equal(playback.hidden('enemy-A'),false);
});
test('source skill index is exact and a nonexistent choice never falls back to another same-ID candidate',()=>{
  const {playback,roster,snapshot}=fixture();snapshot.lifecycle_events=[event('party-1','entry',12,11)];playback.advance(snapshot,roster,0);
  assert.equal(playback.pose('party-1').action_index,sprites(skill('001',12))[0].action_index);assert.notEqual(playback.pose('party-1').action_index,sprites(skill('001',11))[0].action_index);
  snapshot.lifecycle_events=[event('party-1','entry',999,11,{token:'invalid-source'})];assert.throws(()=>playback.advance(snapshot,roster,10),/Exact selected/);assert.deepEqual(playback.drainCompleted(),[]);
});
test('reset and a changed battle identity clear all visual channels, hidden actors and pending acknowledgements',()=>{
  const {playback,roster,snapshot}=fixture();snapshot.lifecycle_events=[event('enemy-A','death',2,2)];playback.advance(snapshot,roster,0);playback.advance(snapshot,roster,100000);assert.equal(playback.hidden('enemy-A'),true);
  playback.reset();assert.deepEqual(playback.snapshot(),{active:[],held:[],hidden:[],completed_count:0});assert.equal(playback.alpha('enemy-A'),1);
  playback.advance(snapshot,roster,0);playback.advance(snapshot,roster,100000);snapshot.id='second-battle';snapshot.lifecycle_events=[];playback.advance(snapshot,roster,0);assert.deepEqual(playback.snapshot(),{active:[],held:[],hidden:[],completed_count:0});
});
test('source mode1 appearance blocks subsequent sprites for seven original60ms clock steps',()=>{
  const {playback,roster,snapshot}=fixture(),entry=event('enemy-A','entry',11,11),selected=skill('012',11),frames=sprites(selected),prefix=frames[0].interval_raw,total=duration(selected)+7*60;
  snapshot.lifecycle_events=[entry];playback.advance(snapshot,roster,0);assert.equal(playback.alpha('enemy-A'),0);playback.advance(snapshot,roster,prefix-1);assert.equal(playback.alpha('enemy-A'),0);
  playback.advance(snapshot,roster,prefix);assert.equal(playback.pose('enemy-A').source_frame,frames[0].source_frame);assert.equal(playback.alpha('enemy-A'),0);
  playback.advance(snapshot,roster,prefix+60);assert.equal(playback.alpha('enemy-A'),1/7);assert.equal(playback.pose('enemy-A').source_frame,frames[0].source_frame);
  playback.advance(snapshot,roster,prefix+7*60);assert.equal(playback.alpha('enemy-A'),1);assert.equal(playback.pose('enemy-A').source_frame,frames[1].source_frame);assert.deepEqual(playback.drainCompleted(),[]);
  playback.advance(snapshot,roster,total-1);assert.deepEqual(playback.drainCompleted(),[]);playback.advance(snapshot,roster,total);assert.equal(playback.pose('enemy-A'),null);assert.deepEqual(playback.drainCompleted().map(row=>row.token),[entry.token]);
});
test('mode5 uses source pixel geometry and actual renderer calls; elapsed0 resets initialization',()=>{
  const {roster,snapshot}=fixture(),playback=new BattleLifecyclePlayback(manifest,{appearanceBounds:(id,pose)=>{assert.equal(id,'001');assert.equal(pose.source_frame,170);return {min_x:261,max_y:350,empty:false};}});
  snapshot.lifecycle_events=[event('party-1','entry',11,11)];playback.advance(snapshot,roster,0);playback.advance(snapshot,roster,120);
  assert.equal(playback.snapshot().active[0].appearance.render_limit,43);assert.equal(playback.snapshot().active[0].appearance.render_calls,1);
  playback.advance(snapshot,roster,120);assert.equal(playback.snapshot().active[0].appearance.render_calls,1);assert.equal(playback.pose('party-1').source_frame,170);
  for(let calls=2;calls<43;calls++){playback.advance(snapshot,roster,180);assert.equal(playback.snapshot().active[0].appearance.render_calls,calls);assert.equal(playback.pose('party-1').source_frame,170);}
  playback.advance(snapshot,roster,180);assert.equal(playback.snapshot().active[0].appearance,null);assert.equal(playback.pose('party-1').source_frame,171);assert.equal(playback.alpha('party-1'),1);assert.deepEqual(playback.drainCompleted(),[]);
});
test('mode5 strict plus8 boundary and empty source main finish without an invented wait',()=>{
  for(const geometry of [{min_x:248,max_y:1,empty:false},{empty:true}]){
    const {snapshot}=fixture(),roster=[{id:'party-1',resource_id:'002',side:'player'}],playback=new BattleLifecyclePlayback(manifest,{appearanceBounds:()=>geometry});snapshot.actors=snapshot.actors.slice(0,1);snapshot.lifecycle_events=[event('party-1','entry',11,11)];playback.advance(snapshot,roster,0);
    assert.equal(playback.snapshot().active[0].appearance,null);assert.equal(playback.pose('party-1').source_frame,sprites(skill('002',11))[0].source_frame);assert.deepEqual(playback.drainCompleted(),[]);
  }
  const {snapshot}=fixture(),roster=[{id:'party-1',resource_id:'002',side:'player'}],idle={action_index:0,action_frame:0,source_frame:0};
  const playback=new BattleLifecyclePlayback(manifest,{appearanceBounds:()=>({min_x:247,max_y:1,empty:false,pose:idle})});snapshot.actors=snapshot.actors.slice(0,1);snapshot.lifecycle_events=[event('party-1','entry',11,11)];playback.advance(snapshot,roster,0);assert.equal(playback.snapshot().active[0].appearance.render_limit,2);assert.equal(playback.pose('party-1').source_frame,0);
  playback.advance(snapshot,roster,60);assert.equal(playback.snapshot().active[0].appearance,null);assert.equal(playback.pose('party-1').source_frame,sprites(skill('002',11))[0].source_frame);
});
test('all connected original entry variants finish with source mode RNG owned by the controller',()=>{
  const random=Math.random;Math.random=()=>assert.fail('Lifecycle playback must not select native randomness');
  try{
    for(const sourceRole of manifest.roles)for(const index of sourceRole.entry_skill_indices){
      const control=new BattleController({});control.state={actors:[{id:'member',immune_raw:1,native_x_raw:-146,native_y_raw:152,native_z_raw:0,native_home_y_raw:152}]};let draws=0;control.rng=()=>{draws++;return 2;};
      const playback=new BattleLifecyclePlayback(manifest,{nativeBridge:()=>({record:raw=>control.nativeSourceRecord('member',raw),appearance:raw=>control.beginNativeAppearance('member',raw),appearanceComplete:()=>control.completeNativeAppearance('member'),
        entry:(raw,width)=>control.beginNativeEntry('member',raw,width),entryPoint:x=>control.advanceNativeEntry('member',x)})}),roster=[{id:'member',resource_id:sourceRole.id,side:sourceRole.side}],entry=event('member','entry',index,11,{life_epoch:0});
      const snapshot={id:`entry-${sourceRole.id}-${index}`,actors:[{id:'member',side:sourceRole.side,life_epoch:0}],lifecycle_events:[entry]};playback.advance(snapshot,roster,0);
      let now=0;for(;playback.snapshot().active.length&&now<20000;){now+=20;playback.advance(snapshot,roster,now);}
      assert.ok(now<20000,`${sourceRole.id}:${index} entry completed`);assert.equal(playback.pose('member'),null);assert.deepEqual(playback.drainCompleted(),[{token:entry.token,actor_id:'member',life_epoch:0}]);
      const source=skill(sourceRole.id,index);assert.equal(draws,source.timeline.filter(step=>step.kind==='command'&&step.command_raw===7&&step.mode_raw_0x47===0).length);
    }
  }finally{Math.random=random;}
});

test('actual024 command-only mode3 entry releases immunity after its source column particles finish, without combat RNG',()=>{
  const selected=skill('024',11);assert.equal(selected.timeline.length,1);
  assert.equal(selected.timeline[0].mode_raw_0x47,3);assert.equal(Buffer.from(selected.timeline[0].raw_hex,'hex')[0x47],3);
  const control=new BattleController({});control.state={actors:[{id:'armor',immune_raw:1}]};control.rng=()=>assert.fail('fixed appearance must not draw combat RNG');
  const effect=new AppearanceParticles({pixels:[{x:0,y:20,rgb:[255,255,255]}],random:()=>0});let draws=0;effect.draw=()=>draws++;
  const playback=new BattleLifecyclePlayback(manifest,{appearanceEffect:()=>effect,nativeBridge:()=>({
    record:raw=>control.nativeSourceRecord('armor',raw),appearance:raw=>control.beginNativeAppearance('armor',raw),appearanceComplete:()=>control.completeNativeAppearance('armor')})}),
    roster=[{id:'armor',resource_id:'024',side:'enemy'}],entry=event('armor','entry',11,11,{life_epoch:0}),
    snapshot={id:'024-source-entry',actors:[{id:'armor',life_epoch:0}],lifecycle_events:[entry]};
  playback.advance(snapshot,roster,0);assert.equal(control.actor('armor').immune_raw,1);
  assert.equal(playback.drawParticles('armor',{},0,0),true);assert.equal(draws,1);
  let now=0;while(playback.snapshot().active.length&&now<1800){now+=20;playback.advance(snapshot,roster,now);}
  assert.ok(now<1800);assert.equal(control.actor('armor').immune_raw,0);assert.equal(control.actor('armor').native_after_raw['0x0521f666'],0);
  assert.deepEqual(playback.drainCompleted(),[{token:entry.token,actor_id:'armor',life_epoch:0}]);
});

test('exported018 command-only mode2 falls through the shared source-pixel renderer and clears immunity only at completion',()=>{
  const selected=skill('018',5),step=selected.timeline[0];assert.equal(selected.timeline.length,1);
  assert.equal(Buffer.from(step.raw_hex,'hex')[0x47],2);
  for(const hz of [30,60,144]){
    const control=new BattleController({});control.state={actors:[{id:'demon',immune_raw:1}]};control.rng=()=>assert.fail('fixed mode2 must not draw combat RNG');
    const effect=createDeathParticleSurface({rgba:new Uint8Array([255,255,255,255]),width:1,height:1,anchor:{x:0,y:0},mode:2,appearance:true,seed:'018-entry'});
    const playback=new BattleLifecyclePlayback(manifest,{appearanceEffect:(_actor,_role,mode)=>{assert.equal(mode,2);return effect;},nativeBridge:()=>({
      record:raw=>control.nativeSourceRecord('demon',raw),appearance:raw=>control.beginNativeAppearance('demon',raw),appearanceComplete:()=>control.completeNativeAppearance('demon')})});
    const roster=[{id:'demon',resource_id:'018',side:'enemy'}],entry=event('demon','entry',5,11,{life_epoch:0}),
      snapshot={id:'018-source-entry',actors:[{id:'demon',life_epoch:0}],lifecycle_events:[entry]};
    playback.advance(snapshot,roster,0);assert.equal(control.actor('demon').immune_raw,1);assert.ok(effect.particles[0].y<0);
    let draws=0;assert.equal(playback.drawParticles('demon',{save(){},restore(){},drawImage(){draws++;}},0,0),true);assert.equal(draws,2);
    let now=0;while(playback.snapshot().active.length&&now<1800){
      assert.equal(control.actor('demon').immune_raw,1);now+=1000/hz;playback.advance(snapshot,roster,now);
    }
    assert.ok(now<1800);assert.equal(effect.particles[0].y,0);assert.equal(control.actor('demon').immune_raw,0);
    assert.equal(control.actor('demon').native_after_raw['0x0521f666'],0);assert.deepEqual(playback.drainCompleted(),[{token:entry.token,actor_id:'demon',life_epoch:0}]);
  }
});

test('lifecycle sound visits use source logical cursors, survive slow RAF and retire on reset without replay',()=>{
 const frames=[],{roster,snapshot}=fixture(),playback=new BattleLifecyclePlayback(manifest,{onFrame:step=>frames.push(step)});
 snapshot.lifecycle_events=[event('party-1','death',13,12)];playback.advance(snapshot,roster,0);playback.advance(snapshot,roster,100000);
 const selected=skill('001',13),expected=[];
 for(const record of selected.source_skill.actions){
  const raw=Buffer.from(record.raw_hex,'hex');if(raw[0]!==0)continue;
  const start=raw.readUInt32LE(0x26),end=raw.readUInt32LE(0x2a),range=Array.from({length:end-start},(_,i)=>start+i);
  expected.push(...(raw[0x1d]?range.reverse():range));
 }
 assert.deepEqual(frames.map(f=>f.logical_frame),expected);assert.equal(frames.length,sprites(selected).length);
 assert.ok(frames.every(f=>f.resource_id==='001'&&f.lifecycle_token===snapshot.lifecycle_events[0].token&&f.battle_id===snapshot.id));
 const count=frames.length;playback.advance(snapshot,roster,100001);assert.equal(frames.length,count);
 playback.reset();snapshot.lifecycle_events=[];playback.advance(snapshot,roster,100002);assert.equal(frames.length,count);
});

test('entry audio observes live immunity clearing at appearance completion before visiting the following source frames',()=>{
 const control=new BattleController({});control.state={actors:[{id:'member',immune_raw:1}]};control.rng=()=>2;
 const frames=[],playback=new BattleLifecyclePlayback(manifest,{onFrame:step=>frames.push({...step,inhibited:Boolean(control.actor('member').immune_raw)}),
  nativeBridge:()=>({record:raw=>control.nativeSourceRecord('member',raw),appearance:raw=>control.beginNativeAppearance('member',raw),appearanceComplete:()=>control.completeNativeAppearance('member')})});
 const roster=[{id:'member',resource_id:'001',side:'player'}],snapshot={id:'entry-sounds',actors:[{id:'member',life_epoch:0}],lifecycle_events:[event('member','entry',11,11,{life_epoch:0})]};
 for(let now=0;now<=10000;now+=20)playback.advance(snapshot,roster,now);
 assert.equal(frames[0].inhibited,true);assert.ok(frames.some(f=>!f.inhibited));
 assert.equal(frames.find(f=>f.plan_record_index===2&&f.logical_frame===1).inhibited,false);
 assert.equal(playback.snapshot().active.length,0);
});
