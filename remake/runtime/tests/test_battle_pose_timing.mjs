// Exercise the real renderer with each registered role's source pose timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BattleView} from '../web/battle_view.mjs';
import {directSequence} from '../web/core/skill_sequence.mjs';

const read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name,import.meta.url),'utf8'));
const [commands,ai]=await Promise.all(['party_skills.json','forest_ai.json'].map(read));
async function fixture(){
  const drawn=new Map(),ctx={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},ellipse(){},fill(){},save(){},restore(){},fillText(){},drawImage(){}};
  const view=new BattleView({canvas:{width:960,height:540,getContext:()=>ctx},metadataPath:'/data/party_battle_view.json',stageMetadataPath:'/data/forest_stage.json',
    jsonLoader:path=>read(path.slice('/data/'.length)),assetLoader:async a=>({width:a.width,height:a.height,path:a.path})});
  await view.prepare();
  const roster=[...['001','002','003'].map((id,i)=>({id,resource_id:id,side:'player',party_slot_zero_based:i})),{id:'enemy',resource_id:'013',side:'enemy'}];
  view.setRoster(roster,{...commands.skills,enemy:{id:'hunter',actor_id:'enemy'}});
  view._sprite=(role,action,frame)=>drawn.set(role.id,{action,frame});
  return {view,drawn,snapshot:{actors:roster.map(a=>({...a,alive:true,hp:{current:1000,maximum:1000}}))}};
}

test('Idle poses follow 70/90/40ms source intervals instead of a shared 130ms delay, including slow RAF and wraparound',async()=>{
  const {view,drawn,snapshot}=await fixture();
  for(const now of [0,39,40,69,70,89,90,130,280,1540,1600,10047]){
    view.draw(snapshot,now);
    for(const id of ['001','002','003']){
      const pose=view.meta.roles.find(r=>r.id===id).idle;
      assert.equal(drawn.get(id).frame,pose.frames[Math.floor(now/pose.interval_raw)%pose.frames.length],`${id} idle at ${now}ms`);
    }
  }
});

test('Defending uses its own source interval and holds the final pose',async()=>{
  const {view,drawn,snapshot}=await fixture();snapshot.actors.find(a=>a.id==='003').defending=true;
  const pose=view.meta.roles.find(r=>r.id==='003').response_skills.find(s=>s.chr_skill_index===9).segments[0];
  view.draw(snapshot,0);
  for(const now of [pose.interval_raw-1,pose.interval_raw,pose.interval_raw*2,10000]){
    view.draw(snapshot,now);
    assert.deepEqual(drawn.get('003'),{action:pose.action_index,frame:pose.frames[Math.min(pose.frames.length-1,Math.floor(now/pose.interval_raw))]});
  }
});

test('Surviving hit reactions use source timing, then return to source-timed idle',async()=>{
  const {view,drawn,snapshot}=await fixture(),pose=view.meta.roles.find(r=>r.id==='003').reaction;
  const done=view.playSequence({actor_id:'enemy',target_id:'003',skill_id:'hunter',plan:directSequence(ai.roles['013'].skills[15])},
    {onRecord(){},onContact:()=>({hit:true,damage:1,remainingHp:999})});
  let now=0;
  while(!view.run?.impact_called){assert.ok(now<10000);view.draw(snapshot,now);now+=65;}
  const at=view.run.impact_elapsed;
  view.draw(snapshot,at+pose.interval_raw-1);assert.deepEqual(drawn.get('003'),{action:pose.action_index,frame:pose.frames[0]});
  view.draw(snapshot,at+pose.interval_raw);assert.deepEqual(drawn.get('003'),{action:pose.action_index,frame:pose.frames[1]});
  for(;view.run;now+=65){assert.ok(now<20000);view.draw(snapshot,now);}
  await done;
});
