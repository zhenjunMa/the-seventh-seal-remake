// Real ID17 and _iReSTfz PNG/source bytes; synthetic RAF/canvas and item
// acceptance callbacks isolate presentation from state mutation and movies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {BattleView} from '../web/battle_view.mjs';
const web=new URL('../web/',import.meta.url),isolated=process.env.SEVENTH_SEAL_ITEM_TEST_PRESENTATION;
async function file(path){
  if(isolated){const candidate=join(isolated,path.replace(/^\//,''));try{await access(candidate);return candidate;}catch{}}
  return new URL(path.replace(/^\//,''),web);
}
const jsonLoader=async path=>JSON.parse(await readFile(await file(path),'utf8'));
const assetLoader=async asset=>{const bytes=await readFile(await file(asset.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);assert.equal(bytes.readUInt32BE(16),asset.width);assert.equal(bytes.readUInt32BE(20),asset.height);
  return {image:{width:asset.width,height:asset.height,path:asset.path},sha256:asset.sha256};};
function canvas(){const context={globalAlpha:1,globalCompositeOperation:'source-over',createLinearGradient:()=>({addColorStop(){}})};
  for(const key of ['setTransform','clearRect','fillRect','beginPath','rect','clip','moveTo','lineTo','stroke','ellipse','fill','save','restore','drawImage','fillText'])context[key]=()=>{};
  return {width:960,height:540,getContext:()=>context};}

test('actual cure effect plays all19 native80ms frames after ID17 even when508BB0 returns0; invalid contact targets spawn no effect',async()=>{
  const view=new BattleView({canvas:canvas(),jsonLoader,assetLoader,metadataPath:'/data/party_battle_view.json',itemMetadataPath:'/data/item_presentation.json'});await view.prepare();
  const meta=view.itemMeta,effect=meta.effects.find(effect=>effect.id==='_iReSTfz');
  assert.equal(meta.items['272'].effect_id,effect.id);assert.equal(effect.frame_count,19);assert.equal(effect.interval_raw,80);assert.deepEqual(effect.anchor,{x:221,y:269});
  const source=await readFile(new URL('../../../Fight_Role/Effect/_iReSTfz.dgp',import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'),effect.source_sha256);assert.equal(source.subarray(67,67+172).toString('hex'),effect.native_raw_hex);
  const actors=['001','002','013'].map(id=>({id,resource_id:id,side:id==='013'?'enemy':'player',hp:{current:100,maximum:100},mp:{current:0,maximum:100}}));
  view.setRoster(actors,{a:{id:'yantu',actor_id:'001'},b:{id:'kai_mieyan',actor_id:'002'},c:{id:'hawk_attack',actor_id:'013'}});
  for(const [used,requested]of [[true,true],[false,true],[false,false]]){
    let contacts=0;const actorFrames=[],effectFrames=[];
    const running=view.playItem({action_id:`cure-${used}-${requested}`,actor_id:'001',target_id:'002',item_id:272,skill_id:'item:272'},
      {onUse:()=>{contacts++;return {hit:true,damage:0,item_used:used,item_effect:requested,native_return:Number(used),...(!requested?{skipped:'item-target-unavailable'}:{})};},
        onFrame:step=>actorFrames.push(step.logical_frame),onEffectFrame:step=>effectFrames.push(step.logical_frame)});
    view.draw({phase:'action',actors},0);view.draw({phase:'action',actors},1699);assert.equal(contacts,0);
    view.draw({phase:'action',actors},1700);assert.equal(contacts,1);view.draw({phase:'action',actors},1900);view.draw({phase:'action',actors},4000);
    const result=await running;assert.equal(contacts,1);assert.equal(result.contact_count,1);assert.deepEqual(actorFrames,Array.from({length:18},(_,index)=>index));
    assert.deepEqual(effectFrames,requested?Array.from({length:19},(_,index)=>index):[]);
    assert.equal(result.observations.effect_ids.includes('_iReSTfz'),requested);assert.equal(view.damageTexts.length,0,'medicine failure does not invent damage0 text');
  }
  view.destroy();
});
