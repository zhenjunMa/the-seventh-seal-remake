import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {BattleResources,drawBattleImage} from '../web/core/battle_resources.mjs';
import {BattleView} from '../web/battle_view.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture({budgetBytes=128,failOnce=false}={}){
  const bytes=[new Uint8Array([1,2]),new Uint8Array([3,4])],calls=[],closed=[];
  const data={schema:'seventh-seal-battle-packs',version:1,pages:bytes.map((b,i)=>({path:`/assets/battle_packs/${String(i).repeat(24)}.png`,sha256:hash(b),width:4,height:4})),
    images:{'/a.png':{sha256:'a'.repeat(64),width:10,height:8,regions:[[2,3,2,2,0,1,1]]},'/b.png':{sha256:'b'.repeat(64),width:4,height:4,regions:[[0,0,4,4,1,0,0]]},'/empty.png':{sha256:'c'.repeat(64),width:2,height:2,regions:[]}},
    manifests:{'/data/test.json':{sha256:'d'.repeat(64),value:{roles:[]}}}};
  const pool=new BattleResources({budgetBytes,read:async(path,options)=>{calls.push({path,options});if(path.endsWith('.json'))return {ok:true,json:async()=>structuredClone(data)};
    const index=data.pages.findIndex(p=>p.path===path);return {ok:true,arrayBuffer:async()=>bytes[index].slice().buffer};},
    decode:async blob=>{const index=new Uint8Array(await blob.arrayBuffer())[0]===1?0:1;if(failOnce&&index===1){failOnce=false;throw Error('decode failed');}return {width:4,height:4,close:()=>closed.push(index)};}});
  return {pool,calls,closed,data};
}
test('concurrent views coalesce one verified bitmap and preserve independent source geometry',async()=>{
  const {pool,calls}=fixture();const [a,b]=await Promise.all([pool.preparePaths(['/a.png','/empty.png'],{scope:'actors'}),pool.preparePaths(['/a.png'],{scope:'hud'})]);
  assert.equal(pool.snapshot().page_requests,1);assert.equal(pool.snapshot().page_decodes,1);
  assert.equal(a.get('/a.png').width,10);assert.equal(b.get('/a.png').pool,pool);
  await pool.preparePaths(['/a.png'],{scope:'actors'});assert.equal(pool.snapshot().page_requests,1);
  assert.equal(calls.filter(c=>c.path.endsWith('.png')).length,1);
});
test('packed draw clips a trimmed region in original coordinates, with correct scaled destination',async()=>{
  const {pool}=fixture(),images=await pool.preparePaths(['/a.png','/empty.png']);const calls=[],context={drawImage:(...args)=>calls.push(args)};
  drawBattleImage(context,images.get('/a.png'),3,3,4,4,100,200,8,12);
  assert.deepEqual(calls[0].slice(1),[2,1,1,2,100,200,2,6]);
  drawBattleImage(context,images.get('/empty.png'),0,0);assert.equal(calls.length,1);
  drawBattleImage(context,{native:true},1,2);assert.deepEqual(calls[1],[{native:true},1,2]);
});
test('unused pages obey the decoded LRU budget; required pages stay alive and evicted pages can reload',async()=>{
  const {pool,closed}=fixture({budgetBytes:64});await pool.preparePaths(['/a.png'],{scope:'actors'});
  await pool.preparePaths(['/b.png'],{scope:'actors'});assert.deepEqual(closed,[0]);assert.equal(pool.snapshot().decoded_bytes,64);
  await pool.preparePaths(['/a.png'],{scope:'actors'});assert.deepEqual(closed,[0,1]);assert.equal(pool.snapshot().page_requests,3);
});
test('failed decoding leaves no prepared scope and is retryable; source/hash mismatches fail closed',async()=>{
  const {pool,data}=fixture({failOnce:true});await assert.rejects(pool.preparePaths(['/a.png','/b.png']),/decode failed/);assert.equal(pool.scopes.has('battle'),false);
  await pool.preparePaths(['/b.png']);assert.equal(pool.snapshot().page_decodes,2);
  await assert.rejects(pool.prepare([{path:'/a.png',width:10,height:8,sha256:'e'.repeat(64)}]),/来源图片/);
  const another=fixture();another.data.pages[0].sha256='0'.repeat(64);await assert.rejects(another.pool.preparePaths(['/a.png']),/指纹/);
  const json=await pool.json('/data/test.json','d'.repeat(64));json.roles.push('mutation');assert.deepEqual((await pool.json('/data/test.json')).roles,[]);
  await assert.rejects(pool.json('/data/test.json','0'.repeat(64)),/来源清单/);
});
test('cancelled preparation and a throwing progress callback cannot take scope ownership or leak leases',async()=>{
  const {pool}=fixture();await pool.preparePaths(['/a.png'],{scope:'actors'});const before=pool.scopes.get('actors');
  await assert.rejects(pool.preparePaths(['/b.png'],{scope:'actors',isCurrent:()=>false}),/取消/);assert.equal(pool.scopes.get('actors'),before);assert.equal(pool.leases.size,0);
  await assert.rejects(pool.preparePaths(['/b.png'],{onProgress:()=>{throw Error('progress cancelled');}}),/progress cancelled/);assert.equal(pool.leases.size,0);
});
test('prepared BattleView switches actor sets without re-reading metadata or loading absent roles',async()=>{
  let jsonReads=0;const selections=[],scopes=new Map();
  const view=new BattleView({canvas:{getContext:()=>({})},metadataPath:'/data/party_battle_view.json',lifecycleMetadataPath:'/data/battle_lifecycle.json',
    jsonLoader:async path=>{jsonReads++;return JSON.parse(await readFile(new URL('../web'+path,import.meta.url),'utf8'));},assetLoader:async()=>{throw Error('individual PNG path should not run');}});
  view.resourcePool={scopes,prepare:async descriptors=>{selections.push(descriptors);scopes.set('battle-actors',new Set());return new Map(descriptors.map(a=>[a.path,{width:a.width,height:a.height}]));}};
  await view.prepare({actors:[{id:'001'},{id:'enemy',resource_id:'012'}]});const count=jsonReads;
  assert.ok(selections[0].some(a=>a.owners.includes('001')));assert.ok(selections[0].some(a=>a.owners.includes('012')));
  assert.ok(!selections[0].some(a=>a.owners.length===1&&['002','011','013'].includes(a.owners[0])));
  await view.prepare({actors:[{id:'002'},{id:'enemy',resource_id:'013'}]});assert.equal(jsonReads,count);
  assert.ok(selections[1].some(a=>a.owners.includes('013')));
});
