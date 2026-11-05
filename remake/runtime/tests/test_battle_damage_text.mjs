// Real exported skill records, timelines, PNG hashes and dimensions. Canvas
// calls and the RAF clock are fixtures; this does not replay original GAME.exe.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BattleView} from '../web/battle_view.mjs';
import {directSequence} from '../web/core/battle/skill_sequence.mjs';

const web=new URL('../web/',import.meta.url);
const read=async name=>JSON.parse(await readFile(new URL('data/'+name,web)));
const [ai,reactions,base]=await Promise.all(['forest_ai.json','forest_reactions.json','combat_sample.json'].map(read));
const copy=structuredClone,images=new Map(),eagle=ai.roles['011'].skills[14],counter=reactions.roles['001'].skills.find(s=>s.original_id_raw===19);
const plan=directSequence(eagle);
const hit=(damage=37)=>({hit:true,damage,remainingHp:963,death:false});
const skipped=()=>({hit:false,damage:0,remainingHp:963,skipped:'native-contact-gate'});
async function assetLoader(asset){
  if(images.has(asset.path))return images.get(asset.path);
  const path=new URL(asset.path.slice(1),web),bytes=await readFile(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256,asset.path);
  assert.equal(bytes.readUInt32BE(16),asset.width);assert.equal(bytes.readUInt32BE(20),asset.height);
  const loaded={image:{width:asset.width,height:asset.height,path:asset.path},sha256:asset.sha256};images.set(asset.path,loaded);return loaded;
}
async function fixture(){
  const calls=[],stack=[],ctx={globalAlpha:1,globalCompositeOperation:'source-over',
    setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},ellipse(){},fill(){},
    createLinearGradient:()=>({addColorStop(){}}),
    save(){stack.push({globalAlpha:this.globalAlpha,globalCompositeOperation:this.globalCompositeOperation});},
    restore(){Object.assign(this,stack.pop());},
    drawImage(image,x,y,width,height){
      const match=image.path?.match(/\/(fight_var_textb?|fight_miss_text)\/frame_(\d+)\.png$/);if(!match)return;
      const text=match[1]==='fight_miss_text'?'MISS':String(Number(match[2])),last=calls.at(-1);
      if(last&&last.asset===match[1]&&last.y===y&&last.x+last.width===x&&last.alpha===this.globalAlpha){last.text+=text;last.width+=width;}
      else calls.push({text,asset:match[1],x,y,width,height,alpha:this.globalAlpha});
    },
    fillText(){assert.fail('Damage and MISS must use source sprites');}};
  const view=new BattleView({canvas:{width:1280,height:960,getContext:()=>ctx},metadataPath:'/data/enemy_battle_view.json',assetLoader,jsonLoader:p=>read(p.slice('/data/'.length))});await view.prepare();
  const actors=[{id:'001',resource_id:'001',side:'player',hp:{current:1000,maximum:1000},alive:true},{id:'enemy-0',resource_id:'011',side:'enemy',hp:{current:1000,maximum:1000},alive:true}];
  view.setRoster(actors,{yantu:base.skills.yantu,eagle:{...copy(eagle),id:'eagle',actor_id:'enemy-0'}});
  let now=0;
  const draw=at=>{now=at;calls.length=0;view.draw({actors},now);return copy(calls);};
  const until=predicate=>{for(let frame=0;frame<500;frame++){if(predicate())return copy(calls);draw(now+65);}assert.fail('Source frame driver exceeded its action bound');};
  return {view,draw,until,get now(){return now;},finish:()=>until(()=>!view.run&&!view.detachedRuns.length)};
}
function start(view,responses=[hit(),skipped(),skipped()],extra={}){
  let contacts=0;const done=view.playSequence({actor_id:'enemy-0',target_id:'001',skill_id:'eagle',action_id:'damage-text-fixture',plan:copy(plan)},
    {onRecord(){},onContact:detail=>{const response=responses[Math.min(contacts++,responses.length-1)];return typeof response==='function'?response(detail):copy(response);},...extra});
  return {done,count:()=>contacts};
}

test('A hit followed by a skipped source contact still draws the committed damage',async()=>{
  const f=await fixture(),run=start(f.view);f.draw(0);
  const calls=f.until(()=>run.count()===2);assert.ok(calls.some(c=>c.text==='37'&&c.alpha>0));
  f.finish();await run.done;
});

test('A skipped contact cannot suppress a later valid hit on the same channel',async()=>{
  const f=await fixture(),run=start(f.view,[skipped(),hit(55),skipped()]);f.draw(0);
  assert.ok(f.until(()=>run.count()===2).some(c=>c.text==='55'));f.finish();await run.done;
});

test('Distinct source hits retain separate visible values and positions',async()=>{
  const f=await fixture(),run=start(f.view,[hit(17),hit(23),skipped()]);f.draw(0);
  const calls=f.until(()=>run.count()===2),first=calls.find(c=>c.text==='17'),second=calls.find(c=>c.text==='23');
  assert.ok(first);assert.ok(second);assert.notDeepEqual([first.x,first.y],[second.x,second.y]);
  f.finish();await run.done;
});

test('A late RAF starts the 900ms feedback lifetime when the source contact is processed',async()=>{
  const f=await fixture(),run=start(f.view);f.draw(0);
  const contact=f.view.run.steps.findIndex(step=>step.event);
  f.until(()=>f.view.run.visited===contact-1);
  const at=f.now+5000;assert.ok(f.draw(at).some(c=>c.text==='37'));assert.equal(run.count(),1);
  assert.ok(f.draw(at+899).some(c=>c.text==='37'&&c.alpha>0));assert.ok(!f.draw(at+901).some(c=>c.text==='37'));
  f.finish();await run.done;
});

test('Starting the next action retains late feedback from the completed action',async()=>{
  const f=await fixture(),first=start(f.view,[skipped()]);f.draw(0);f.finish();await first.done;
  f.view._queueDamageText({main_done:true,result:{target_id:'001'}},hit(),f.now);
  const next=start(f.view,[skipped()]);assert.ok(f.draw(f.now+1).some(c=>c.text==='37'));
  f.finish();await next.done;
});

test('MISS and a legitimate zero hit each produce feedback while skipped contacts produce none',async()=>{
  const f=await fixture(),run=start(f.view,[{hit:false,damage:0,remainingHp:1000},hit(0),skipped()]);f.draw(0);
  const calls=f.until(()=>run.count()===2),miss=calls.find(c=>c.text==='MISS'),zero=calls.find(c=>c.text==='0');
  assert.equal(miss.asset,'fight_miss_text');assert.equal(miss.width,61*1.5);assert.equal(miss.height,23*1.125);
  assert.equal(zero.asset,'fight_var_text');assert.equal(zero.width,18*1.5);assert.equal(zero.height,18*1.125);
  f.finish();await run.done;
});

test('Parent and counter contacts retain independent damage feedback for both targets',async()=>{
  const f=await fixture(),descriptor={actor_id:'001',target_id:'enemy-0',skill:copy(counter),plan:{...directSequence(counter),allow_no_contacts:true}};
  let reacted=false;const run=start(f.view,[{...hit(37),reaction_descriptor:descriptor},skipped(),skipped()],{onReactionRecord(){},onReactionContact:()=>{reacted=true;return hit(19);},onReactionEnd(){}});
  f.draw(0);const calls=f.until(()=>reacted),parent=calls.find(c=>c.text==='37'),child=calls.find(c=>c.text==='19');
  assert.ok(parent);assert.ok(child);assert.notEqual(parent.x,child.x);
  assert.equal(parent.asset,'fight_var_text');assert.equal(child.asset,'fight_var_text');
  f.finish();await run.done;
});

test('Stopping or destroying the view clears feedback remaining after an action completes',async()=>{
  for(const stop of ['stop','destroy']){
    const f=await fixture(),run=start(f.view,[skipped()]);f.draw(0);f.finish();await run.done;
    f.view._queueDamageText({main_done:true,result:{target_id:'001'}},hit(),f.now);assert.ok(f.draw(f.now).some(c=>c.text==='37'));
    f.view[stop]();assert.ok(!f.draw(f.now+1).some(c=>c.text==='37'));
  }
});
