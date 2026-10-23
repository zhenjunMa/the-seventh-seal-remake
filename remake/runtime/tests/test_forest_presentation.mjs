// Real exported PNGs and CHR timelines, synthetic canvas/clock and hit result.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BattleView,compileActionTimeline,validateBattleViewMetadata} from '../web/battle_view.mjs';
const root=new URL('../../../',import.meta.url),base=new URL('../',import.meta.url);
const read=async p=>JSON.parse(await readFile(new URL('web/data/'+p,base)));
const meta=await read('forest_battle_view.json'),yantu=await read('yantu_layers.json'),xuanying=await read('xuanying_layers.json');
const clone=v=>structuredClone(v);
function canvas(){
 const calls=[],stack=[];
 const ctx={globalAlpha:1,globalCompositeOperation:'source-over',setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},fillText(){},createLinearGradient:()=>({addColorStop(){}}),
 save(){stack.push({globalAlpha:this.globalAlpha,globalCompositeOperation:this.globalCompositeOperation});},restore(){Object.assign(this,stack.pop());},
 drawImage(image,...coordinates){calls.push({path:image.path,blend:this.globalCompositeOperation,coordinates});}};
 return {width:960,height:540,calls,getContext:()=>ctx};
}
async function assets(a){
 const p=new URL('web/'+a.path.slice(1),base);
 const b=await readFile(p);assert.equal(createHash('sha256').update(b).digest('hex'),a.sha256);
 assert.equal(b.readUInt32BE(16),a.width);assert.equal(b.readUInt32BE(20),a.height);
 return {image:{path:a.path,width:a.width,height:a.height},sha256:a.sha256};
}
const roster=[{id:'001',side:'player'}, {id:'enemy-0',resource_id:'012',side:'enemy'},{id:'enemy-1',resource_id:'013',side:'enemy'},{id:'enemy-2',resource_id:'013',side:'enemy'}];
const skills={yantu:{id:'yantu',actor_id:'001'},yanci:{id:'yanci',actor_id:'001'},snow:{id:'snow',actor_id:'enemy-0'},hunter1:{id:'hunter1',actor_id:'enemy-1'},hunter2:{id:'hunter2',actor_id:'enemy-2'}};
const snapshot={actors:roster.map(a=>({...a,hp:{current:1000},alive:true}))};
async function fixture(extra={}){
 const target=canvas(),view=new BattleView({canvas:target,metadataPath:'/data/forest_battle_view.json',jsonLoader:async p=>clone(p.includes('forest_battle_view')?meta:p.includes('xuanying')?xuanying:yantu),assetLoader:assets,...extra});
 await view.prepare();view.setRoster(roster,skills);return {view,target};
}
const result=(actor_id='001',target_id='enemy-1',skill_id='yanci',hit=true)=>({actor_id,target_id,skill_id,hit,damage:hit?200:0,remainingHp:800});
const position=(call,role)=>[call.coordinates[4]+role.anchor.x*meta.policy.sprite_scale,call.coordinates[5]+role.anchor.y*meta.policy.sprite_scale];
test('Xuanyingzhan binds 36 source pairs, nine intrinsic frames and one source326 contact',()=>{
 const t=compileActionTimeline(meta,yantu,'001','yanci',xuanying);
 assert.equal(t.length,36);assert.equal(t.filter(s=>s.pair.intrinsic.active).length,9);
 assert.deepEqual(t.filter(s=>s.pair.intrinsic.active).map(s=>s.source_frame),[323,324,325,326,327,328,329,330,331]);
 assert.equal(t.find(s=>s.event).source_frame,326);
 const wrong=clone(xuanying);wrong.frames[17].source_frame++;
 assert.throws(()=>compileActionTimeline(meta,yantu,'001','yanci',wrong),/同一个源帧/);
});
test('actual renderer draws Xuanying main/intrinsic together and target fire only at source contact',async()=>{
 const {view,target}=await fixture();let impacts=0;const done=view.playAction(result(),{onImpact:()=>impacts++});
 view.draw(snapshot,0);view.draw(snapshot,1104);assert.equal(impacts,0);
 assert.ok(!target.calls.some(c=>c.path.includes('BFr01_Nd')));
 target.calls.length=0;view.draw(snapshot,1105);
 const main=target.calls.find(c=>c.path.endsWith('frame_0326_main.png')),intrinsic=target.calls.find(c=>c.path.endsWith('frame_0326_intrinsic.png'));
 assert.ok(main&&intrinsic);assert.deepEqual(main.coordinates,intrinsic.coordinates);assert.equal(intrinsic.blend,'lighter');
 assert.ok(target.calls.some(c=>c.path.includes('BFr01_Nd')&&c.blend==='lighter'));assert.equal(impacts,1);
 view.draw(snapshot,2600);await done;assert.equal(impacts,1);
});
test('miss suppresses target fire while Xuanying actor intrinsic still renders',async()=>{
 const {view,target}=await fixture();const done=view.playAction(result('001','enemy-1','yanci',false),{onImpact(){}});
 view.draw(snapshot,0);view.draw(snapshot,1105);
 assert.ok(target.calls.some(c=>c.path.endsWith('frame_0326_intrinsic.png')));
 assert.ok(!target.calls.some(c=>c.path.includes('BFr01_Nd')));view.draw(snapshot,2600);await done;
});
test('hunter approaches player in both axes, attacks in front and returns to own slot',async()=>{
 const {view,target}=await fixture();let impacts=0;const done=view.playAction(result('enemy-1','001','hunter1'),{onImpact:()=>impacts++});
 view.draw(snapshot,0);target.calls.length=0;view.draw(snapshot,1105);
 const hunter=meta.roles.find(r=>r.id==='013'),attack=target.calls.find(c=>c.path.includes('/013/action_18'));
 assert.deepEqual(position(attack,hunter),[572.8,351.15]);assert.equal(impacts,1);
 assert.ok(target.calls.some(c=>c.path.includes('_DutyEg'))); // source record2 actor event remains active
 target.calls.length=0;view.draw(snapshot,2015);
 const returned=target.calls.find(c=>c.path.includes('/013/action_10'));
 assert.deepEqual(position(returned,hunter),[385,287.5]);view.draw(snapshot,2470);await done;
});
test('player approaches the selected living hunter row rather than a fixed x-only offset',async()=>{
 const {view,target}=await fixture();const done=view.playAction(result('001','enemy-2'),{onImpact(){}});
 view.draw(snapshot,0);target.calls.length=0;view.draw(snapshot,1105);
 const player=meta.roles.find(r=>r.id==='001'),main=target.calls.find(c=>c.path.endsWith('frame_0326_main.png'));
 assert.deepEqual(position(main,player),[387.2,413.65]);view.draw(snapshot,2600);await done;
});
test('Xuanying layer asset failure leaves no ready command or partial impact',async()=>{
 const target=canvas(),view=new BattleView({canvas:target,metadataPath:'/data/forest_battle_view.json',jsonLoader:async p=>clone(p.includes('forest_battle_view')?meta:p.includes('xuanying')?xuanying:yantu),assetLoader:async a=>{if(a.path.includes('xuanying/frame_0326_intrinsic'))throw Error('missing intrinsic');return assets(a);}});
 await assert.rejects(view.prepare(),/missing intrinsic/);assert.equal(view.ready,false);
 await assert.rejects(view.playAction(result(),{onImpact(){}}),/准备好/);
 const invalid=clone(meta);invalid.roles[0].alternate_skills[0].segments[3].effects[0].asset_id='missing';assert.throws(()=>validateBattleViewMetadata(invalid),/效果事件/);
});
test('slow RAF visits Xuanying source event once and cancelled frames never replay it',async()=>{
 const {view}=await fixture();let impacts=0;const done=view.playAction(result(),{onImpact:()=>impacts++});
 view.draw(snapshot,0);view.draw(snapshot,2400);assert.equal(impacts,1);view.draw(snapshot,2600);await done;assert.equal(impacts,1);
 const second=view.playAction(result(),{onImpact:()=>impacts++});const aborted=assert.rejects(second,{name:'AbortError'});
 view.draw(snapshot,3000);view.stop();await aborted;view.draw(snapshot,8000);assert.equal(impacts,1);
});
test('same signed movement records also place eagle at selected target with one retained contact',async()=>{
 const {view,target}=await fixture();view.setRoster([{id:'001',side:'player'},{id:'eagle',side:'enemy',resource_id:'011'}],{yantu:skills.yantu,yanci:skills.yanci,claw:{id:'claw',actor_id:'eagle'}});
 const done=view.playAction(result('eagle','001','claw'),{onImpact(){}});view.draw(snapshot,0);target.calls.length=0;
 view.draw(snapshot,1040);const eagle=meta.roles.find(r=>r.id==='011'),attack=target.calls.find(c=>c.path.includes('/011/action_14'));
 assert.deepEqual(position(attack,eagle),[572.8,351.15]);view.draw(snapshot,4000);await done;
});
