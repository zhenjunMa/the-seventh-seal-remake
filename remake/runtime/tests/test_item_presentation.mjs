// Audited original PNGs and source frames, driven by a synthetic RAF/canvas.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BattleView} from '../web/battle_view.mjs';
const root=new URL('../../../',import.meta.url),web=new URL('../web/',import.meta.url);
const jsonLoader=async path=>JSON.parse(await fs.readFile(new URL(path.slice(1),web),'utf8'));
const assetLoader=async a=>{const file=new URL(a.path.slice(1),web),b=await fs.readFile(file);
  assert.equal(createHash('sha256').update(b).digest('hex'),a.sha256);assert.equal(b.readUInt32BE(16),a.width);assert.equal(b.readUInt32BE(20),a.height);
  return {image:{width:a.width,height:a.height,path:a.path},sha256:a.sha256};};
function canvas(){const ctx={globalAlpha:1,globalCompositeOperation:'source-over',createLinearGradient:()=>({addColorStop(){}})};
  for(const key of ['setTransform','clearRect','fillRect','beginPath','rect','clip','moveTo','lineTo','stroke','ellipse','fill','save','restore','drawImage','fillText'])ctx[key]=()=>{};
  return {width:960,height:540,getContext:()=>ctx};}
test('Both original item actions commit once at logical17, draw audited recovery effects, and retain every slow-RAF audio frame',async()=>{
  const view=new BattleView({canvas:canvas(),jsonLoader,assetLoader,metadataPath:'/data/party_battle_view.json',itemMetadataPath:'/data/item_presentation.json'});await view.prepare();
  const actors=['001','002','012'].map(id=>({id,resource_id:id,side:id==='012'?'enemy':'player',hp:{current:100,maximum:100},mp:{current:0,maximum:100}}));
  const skills={a:{id:'yantu',actor_id:'001'},b:{id:'kai_mieyan',actor_id:'002'},c:{id:'snow_attack',actor_id:'012'}};view.setRoster(actors,skills);
  for(const id of ['001','002']){
    let commits=0;const actorFrames=[],effectFrames=[];
    const pending=view.playItem({action_id:'item-'+id,actor_id:id,target_id:'001',item_id:12,skill_id:'item:12'},{onUse:()=>{commits++;return{item_used:true,hit:true,damage:0};},onFrame:s=>actorFrames.push(s.logical_frame),onEffectFrame:s=>effectFrames.push(s.logical_frame)});
    view.draw({phase:'action',actors},0);view.draw({phase:'action',actors},1699);assert.equal(commits,0);
    view.draw({phase:'action',actors},1700);assert.equal(commits,1);view.draw({phase:'action',actors},1900);
    view.draw({phase:'action',actors},4000);const result=await pending;
    assert.equal(commits,1);assert.equal(result.contact_count,1);assert.deepEqual(actorFrames,Array.from({length:18},(_,i)=>i));assert.deepEqual(effectFrames,Array.from({length:19},(_,i)=>i));
    assert.ok(result.observations.effect_ids.includes('_iReMP'));
  }
});
