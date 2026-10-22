// Real exported skill records, timelines, PNG hashes and dimensions. Canvas
// calls and the RAF clock are fixtures; this does not replay original GAME.exe.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BattleView} from '../web/battle_view.mjs';
import {compileNativeSequence,directSequence} from '../web/core/skill_sequence.mjs';

const web=new URL('../web/',import.meta.url),root=new URL('../../../',import.meta.url);
const read=async name=>JSON.parse(await readFile(new URL('data/'+name,web)));
const [meta,ai,reactions,base]=await Promise.all(['forest_full_battle_view.json','forest_ai.json','forest_reactions.json','combat_sample.json'].map(read));
const copy=structuredClone,images=new Map(),eagle=ai.roles['011'].skills[14],counter=reactions.roles['001'].skills.find(s=>s.original_id_raw===19);
const plan=directSequence(eagle),compiled=compileNativeSequence(meta,'011',plan),contactTimes=[];
let duration=0;for(const step of compiled.steps){if(step.event)contactTimes.push(duration);duration+=step.duration_ms===0?0:meta.policy.frame_ms;}
const endTime=duration+meta.policy.tail_ms;
const hit=(damage=37)=>({hit:true,damage,remainingHp:963,death:false});
const skipped=()=>({hit:false,damage:0,remainingHp:963,skipped:'native-contact-gate'});
async function assetLoader(asset){
  if(images.has(asset.path))return images.get(asset.path);
  const path=asset.path.startsWith('/prototype/')?new URL('remake/prototype/web/'+asset.path.slice(11),root):new URL(asset.path.slice(1),web),bytes=await readFile(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256,asset.path);
  assert.equal(bytes.readUInt32BE(16),asset.width);assert.equal(bytes.readUInt32BE(20),asset.height);
  const loaded={image:{width:asset.width,height:asset.height,path:asset.path},sha256:asset.sha256};images.set(asset.path,loaded);return loaded;
}
async function fixture(){
  const calls=[],stack=[],ctx={globalAlpha:1,globalCompositeOperation:'source-over',
    setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},
    createLinearGradient:()=>({addColorStop(){}}),
    save(){stack.push({globalAlpha:this.globalAlpha,globalCompositeOperation:this.globalCompositeOperation});},
    restore(){Object.assign(this,stack.pop());},drawImage(){},
    fillText(value,x,y){calls.push({text:String(value),x,y,alpha:this.globalAlpha});},strokeText(){}};
  const view=new BattleView({canvas:{width:1280,height:960,getContext:()=>ctx},metadataPath:'/data/forest_full_battle_view.json',assetLoader,jsonLoader:p=>read(p.slice('/data/'.length))});await view.prepare();
  const actors=[{id:'001',resource_id:'001',side:'player',hp:{current:1000,maximum:1000},alive:true},{id:'enemy-0',resource_id:'011',side:'enemy',hp:{current:1000,maximum:1000},alive:true}];
  view.setRoster(actors,{yantu:base.skills.yantu,eagle:{...copy(eagle),id:'eagle',actor_id:'enemy-0'}});
  return {view,draw(now){calls.length=0;view.draw({actors},now);return copy(calls);},texts:()=>calls.map(c=>c.text)};
}
function start(view,responses=[hit(),skipped(),skipped()],extra={}){
  let contacts=0;const done=view.playSequence({actor_id:'enemy-0',target_id:'001',skill_id:'eagle',action_id:'damage-text-fixture',plan:copy(plan)},
    {onRecord(){},onContact:detail=>{const response=responses[Math.min(contacts++,responses.length-1)];return typeof response==='function'?response(detail):copy(response);},...extra});
  return {done,count:()=>contacts};
}

test('One RAF visiting a hit followed by a skipped contact still draws the committed damage',async()=>{
  const {view,draw}=await fixture(),run=start(view);draw(0);
  const calls=draw(contactTimes[1]);assert.equal(run.count(),2);assert.ok(calls.some(c=>c.text==='37'&&c.alpha>0));
  draw(endTime+1);await run.done;
});

test('A skipped contact cannot suppress a later valid hit on the same channel',async()=>{
  const {view,draw}=await fixture(),run=start(view,[skipped(),hit(55),skipped()]);draw(0);
  assert.ok(draw(contactTimes[1]).some(c=>c.text==='55'));draw(endTime+1);await run.done;
});

test('Distinct hits processed in one RAF retain separate visible values and positions',async()=>{
  const {view,draw}=await fixture(),run=start(view,[hit(17),hit(23),skipped()]);draw(0);
  const calls=draw(contactTimes[1]),first=calls.find(c=>c.text==='17'),second=calls.find(c=>c.text==='23');
  assert.ok(first);assert.ok(second);assert.notDeepEqual([first.x,first.y],[second.x,second.y]);
  draw(endTime+1);await run.done;
});

test('A RAF crossing both contact and run completion presents damage for 900ms after processing it',async()=>{
  const {view,draw}=await fixture(),run=start(view);draw(0);
  assert.ok(draw(endTime+5000).some(c=>c.text==='37'));await run.done;assert.equal(view.run,null);
  assert.ok(draw(endTime+5899).some(c=>c.text==='37'&&c.alpha>0));assert.ok(!draw(endTime+5901).some(c=>c.text==='37'));
});

test('Starting the next action retains still-live numbers from the completed action',async()=>{
  const {view,draw}=await fixture(),first=start(view);draw(0);draw(endTime+5000);await first.done;
  const next=start(view,[skipped()]);assert.ok(draw(endTime+5001).some(c=>c.text==='37'));
  draw(endTime+5001+endTime+1);await next.done;
});

test('MISS and a legitimate zero hit each produce feedback while skipped contacts produce none',async()=>{
  const {view,draw}=await fixture(),run=start(view,[{hit:false,damage:0,remainingHp:1000},hit(0),skipped()]);draw(0);
  const texts=draw(contactTimes[1]).map(c=>c.text);assert.ok(texts.includes('MISS'));assert.ok(texts.includes('0'));assert.ok(!texts.includes(''));
  draw(endTime+1);await run.done;
});

test('Parent and counter contacts retain independent damage feedback for both targets',async()=>{
  const {view,draw}=await fixture(),descriptor={actor_id:'001',target_id:'enemy-0',skill:copy(counter),plan:{...directSequence(counter),allow_no_contacts:true}};
  const reaction=compileNativeSequence(meta,'001',descriptor.plan);let offset=0;for(const step of reaction.steps){if(step.event)break;offset+=step.duration_ms===0?0:meta.policy.frame_ms;}
  const run=start(view,[{...hit(37),reaction_descriptor:descriptor},skipped(),skipped()],{onReactionRecord(){},onReactionContact:()=>hit(19),onReactionEnd(){}});
  draw(0);const calls=draw(contactTimes[0]+offset),parent=calls.find(c=>c.text==='37'),child=calls.find(c=>c.text==='19');
  assert.ok(parent);assert.ok(child);assert.notEqual(parent.x,child.x);
  draw(endTime+5000);await run.done;
});

test('Stopping or destroying the view clears feedback remaining after an action completes',async()=>{
  for(const stop of ['stop','destroy']){
    const {view,draw}=await fixture(),run=start(view);draw(0);assert.ok(draw(endTime+5000).some(c=>c.text==='37'));await run.done;
    view[stop]();assert.ok(!draw(endTime+5001).some(c=>c.text==='37'));
  }
});
