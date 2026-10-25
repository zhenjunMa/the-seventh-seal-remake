// Source-backed atlas admission, independent of the unified build's timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BattleView,mergeNativeActionAtlases} from '../web/battle_view.mjs';

const web=new URL('../web/',import.meta.url),root=new URL('../../../',import.meta.url);
const json=async path=>JSON.parse(await readFile(new URL(path.replace(/^\//,''),web)));
const party=await json('/data/party_battle_view.json'),lifecycle=await json('/data/battle_lifecycle.json');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pools=new Map();
for(const role of lifecycle.roles){
  const bytes=await readFile(new URL(role.source_dgp,root));
  assert.equal(hash(bytes),role.source_dgp_sha256);
  const geometry=0x43+bytes[2]*(bytes[0]===9?0xac:0x90),count=bytes.readUInt32LE(geometry+4);
  if(role.source_frame_pool_count!==undefined)assert.equal(role.source_frame_pool_count,count);
  pools.set(role.id,count);
}
// During a stopped build older manifests may lack the new geometry field. The
// test supplies it from the real DGP header; production requires the exporter
// field and the independent Python export test verifies that declaration.
function withSourcePool(value){
  if(value.schema==='seventh-seal-battle-lifecycle')for(const role of value.roles)role.source_frame_pool_count=pools.get(role.id);
  if(value.schema==='seventh-seal-native-layer-bank'&&value.frames[0]?.main?.path.startsWith('assets/battle_lifecycle/')){
    if(value.source_frame_pool_count!==undefined)assert.equal(value.source_frame_pool_count,pools.get(value.role_id));
    value.source_frame_pool_count=pools.get(value.role_id);
  }
  return value;
}
const life=withSourcePool(structuredClone(lifecycle));
const role=(meta,id)=>meta.roles.find(row=>row.id===id);

test('actual 004/005 cross-group references select complete atlases without changing native action identity',()=>{
  for(const [id,expected]of [['004',[[10,1,3]]],['005',[[9,5,6],[12,1,2]]]]){
    const ordinary=structuredClone(role(party,id)),source=role(life,id),before=structuredClone(ordinary);
    const required=mergeNativeActionAtlases(ordinary,source,party.source_hashes);
    for(const [index,nominal,expanded]of expected){
      const previous=before.actions.find(action=>action.index===index),action=ordinary.actions.find(action=>action.index===index),native=source.actions.find(action=>action.index===index);
      assert.equal(previous.frame_count,nominal);assert.equal(action.frame_count,expanded);
      assert.equal(action.source_frame_count,nominal);assert.equal(action.native_raw_hex,previous.native_raw_hex);
      assert.equal(action.first_frame,previous.first_frame);assert.equal(action.sheet,native.sheet);assert.equal(action.sha256,native.sha256);
      for(let frame=0;frame<expanded;frame++)assert.ok(required.has(action.first_frame+frame));
    }
    assert.deepEqual(role(party,id),before);
  }
});

test('atlas union keeps a larger proven ordinary atlas and rejects changed source identity, raw fields and frame mappings',()=>{
  const source=structuredClone(role(life,'005')),ordinary=structuredClone(role(party,'005'));
  const action=ordinary.actions.find(action=>action.index===9),native=source.actions.find(action=>action.index===9);
  // Reversing the real export roles exercises both sides of the union using
  // actual CHR frame references, rather than inventing an unreferenced column.
  const large=structuredClone(role(party,'005'));
  Object.assign(large.actions.find(action=>action.index===9),native);
  large.response_skills.push({segments:source.skills.flatMap(skill=>skill.segments).filter(segment=>segment.action_index===9)});
  const oldSheet=large.actions.find(action=>action.index===9).sheet;
  const ordinarySegments=[ordinary.skill,...ordinary.alternate_skills,...ordinary.response_skills].flatMap(skill=>skill.segments).filter(segment=>segment.action_index===9);
  const smaller={...structuredClone(source),actions:[{...action,interval_raw:native.interval_raw}],skills:[{segments:ordinarySegments,timeline:[]}]};
  mergeNativeActionAtlases(large,smaller,party.source_hashes);
  assert.equal(large.actions.find(action=>action.index===9).sheet,oldSheet);
  const mutations=[
    row=>{row.source_dgp_sha256='0'.repeat(64);},
    row=>{row.source_chr_sha256='0'.repeat(64);},
    row=>{delete row.source_frame_pool_count;},
    row=>{row.source_frame_pool_count=1;},
    row=>{row.actions.find(action=>action.index===9).source_frame_count++;},
    row=>{row.actions.find(action=>action.index===9).first_frame++;},
    row=>{row.actions.find(action=>action.index===9).directions=2;},
    row=>{row.actions.find(action=>action.index===9).interval_raw++;},
    row=>{row.actions.find(action=>action.index===9).native_raw_hex='ff'+native.native_raw_hex.slice(2);},
    row=>{row.actions.find(action=>action.index===9).frame_count++;},
    row=>{row.skills.flatMap(skill=>skill.timeline).find(step=>step.kind==='sprite').source_frame++;},
  ];
  for(const mutate of mutations){const altered=structuredClone(source);mutate(altered);assert.throws(()=>mergeNativeActionAtlases(structuredClone(ordinary),altered,party.source_hashes),/原始动作或帧池/);}
});

async function prepare(mutate=()=>{}){
  let imageLoads=0;
  const view=new BattleView({canvas:{getContext:()=>({})},metadataPath:'/data/party_battle_view.json',lifecycleMetadataPath:'/data/battle_lifecycle.json',
    jsonLoader:async(path,expected)=>{
      const bytes=await readFile(new URL(path.replace(/^\//,''),web));if(expected)assert.equal(hash(bytes),expected);
      const value=withSourcePool(JSON.parse(bytes));mutate(path,value);return value;
    },assetLoader:async asset=>{imageLoads++;return {image:{width:asset.width,height:asset.height},sha256:asset.sha256};}});
  return {view,run:()=>view.prepare(),loads:()=>imageLoads};
}

test('full current roster prepares expanded source atlases and binds every lifecycle physical layer',async()=>{
  const {view,run,loads}=await prepare();await run();assert.ok(loads()>0);
  for(const source of life.roles){
    const merged=role(view.meta,source.id);
    for(const skill of source.skills)for(const step of skill.timeline)if(step.kind==='sprite'){
      const action=merged.actions.find(action=>action.index===step.action_index);
      assert.ok(step.action_frame<action.frame_count);assert.equal(action.first_frame+step.action_frame,step.source_frame);
      assert.ok(view.lifecyclePairs.has(`${source.id}:${step.source_frame}`));
    }
  }
});

test('missing, shifted or conflicting lifecycle layers reject preparation before image resources load',async()=>{
  const mutations=[
    bank=>{bank.frames.shift();},
    bank=>{bank.source_hashes['Fight_Role/004.dgp']='0'.repeat(64);},
    bank=>{bank.source_frame_pool_count--;},
    bank=>{bank.frames[0].main.width++;},
    bank=>{bank.frames[0].main.sha256='0'.repeat(64);},
  ];
  for(const mutate of mutations){
    const {run,loads}=await prepare((path,value)=>{if(path==='/data/battle_lifecycle_layers_004.json')mutate(value);});
    await assert.rejects(run(),/图层|源帧/);assert.equal(loads(),0);
  }
});
