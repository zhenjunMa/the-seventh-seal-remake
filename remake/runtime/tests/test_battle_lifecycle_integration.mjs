// Real exported source metadata; synthetic Canvas and deterministic RAF times.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BattleView} from '../web/battle_view.mjs';
import {compileNativeSequence,directSequence} from '../web/core/skill_sequence.mjs';
const base=new URL('../web/',import.meta.url),read=async p=>JSON.parse(await readFile(new URL(p.replace(/^\//,''),base),'utf8'));
const meta=await read('/data/party_battle_view.json'),life=await read('/data/battle_lifecycle.json');
function canvas(){const calls=[],c={globalAlpha:1,save(){},restore(){},setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},ellipse(){},fill(){},moveTo(){},lineTo(){},stroke(){},createLinearGradient(){return {addColorStop(){}};},drawImage(img,...args){calls.push({path:img.path,args});},fillText(){},strokeText(){}};return {width:960,height:540,getContext:()=>c,calls};}
async function fixture(){const target=canvas(),view=new BattleView({canvas:target,metadataPath:'/data/party_battle_view.json',lifecycleMetadataPath:'/data/battle_lifecycle.json',jsonLoader:read,assetLoader:async a=>({image:{width:a.width,height:a.height,path:a.path},sha256:a.sha256})});await view.prepare();view.setRoster([{id:'001',side:'player'},{id:'002',side:'player'},{id:'enemy',resource_id:'012',side:'enemy'}],{'yantu':{id:'yantu',actor_id:'001'},'001_43':{id:'001_43',actor_id:'001'},'kai_mieyan':{id:'kai_mieyan',actor_id:'002'},'enemy':{id:'enemy',actor_id:'enemy'}});return {view,target};}
const snapshot=(events=[],epoch=0)=>({actors:[{id:'001',hp:{current:900},life_epoch:0},{id:'002',hp:{current:epoch?151:0},life_epoch:epoch},{id:'enemy',hp:{current:100},life_epoch:0}],lifecycle_events:events});
test('prepared view can paint during HUD loading before the battle snapshot exists',async()=>{
 const {view}=await fixture();assert.doesNotThrow(()=>view.draw(null,0));assert.deepEqual(view.lifecycleSnapshot().active,[]);
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
 view.draw(snapshot([revive],1),4100);assert.notEqual(view.lifecycle.pose('002').source_frame,life.roles[1].skills.find(s=>s.chr_skill_index===12).last_source_pose.source_frame);
 view.draw(snapshot([revive],1),9000);assert.deepEqual(view.drainLifecycleCompleted().map(e=>e.token),['r']);assert.equal(view.lifecycle.hidden('002'),false);
});
test('source revival carrier load failure advances without wait or invented contact, then real effect contacts at frame1',async()=>{
 const {view}=await fixture(),skill=life.roles[0].skills.find(s=>s.chr_skill_index===43).source_skill;
 const plan=directSequence(skill),compiled=compileNativeSequence(view.meta,'001',plan,[view.layers,...view.alternateLayers.values()]);
 const missing=compiled.steps.find(s=>s.missing_effect==='m77Rwz01');assert.ok(missing);assert.equal(missing.duration_ms,0);assert.equal(missing.event,null);
 assert.deepEqual(compiled.steps.filter(s=>s.event).map(s=>[s.carrier_asset_id,s.logical_frame]),[['_iRelife',1]]);
 const effects=compiled.steps.filter(s=>s.carrier_asset_id==='_iRelife');assert.equal(effects.length,19);assert.ok(effects.every(s=>s.duration_ms===80));
 let contacts=0;const done=view.playSequence({actor_id:'001',target_id:'002',skill_id:'001_43',plan},{onRecord(){},onContact(){contacts++;return {hit:true,damage:0,revived:true,hp_delta:151};}});
 view.draw(snapshot(),0);view.draw(snapshot(),20000);view.draw(snapshot(),21000);await done;assert.equal(contacts,1);assert.equal(view.damageTexts.length,0);
});
