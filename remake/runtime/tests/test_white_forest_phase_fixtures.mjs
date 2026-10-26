import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {decodeSave} from '../web/core/world.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifestURL=new URL('../evidence/white_forest_20261026/phase_fixture_manifest.json',import.meta.url);
const scriptURL=new URL('../evidence/white_forest_20261026/prepare_phase_fixtures.mjs',import.meta.url);
const missingMaterials=[];
for(const url of [manifestURL,scriptURL])if(!existsSync(url))missingMaterials.push(url.pathname);
if(existsSync(manifestURL)){
  const manifest=JSON.parse(readFileSync(manifestURL,'utf8'));
  for(const row of manifest.source_inputs)if(!existsSync(new URL(`../../../${row.path}`,import.meta.url)))missingMaterials.push(row.path);
  for(const path of Object.keys(manifest.runtime_source_inputs)){
    const url=path.startsWith('original/')?new URL(`../../../${path.slice(9)}`,import.meta.url):new URL(`../web/${path}`,import.meta.url);
    if(!existsSync(url))missingMaterials.push(path);
  }
  for(const row of manifest.files)if(!existsSync(new URL(`../evidence/white_forest_20261026/${row.path}`,import.meta.url)))missingMaterials.push(row.path);
  for(const path of ['phase_fixture_manifest.json','phase_fixtures/after_incoming.json'])if(!existsSync(new URL(`../evidence/fire_valley_20261025/${path}`,import.meta.url)))missingMaterials.push(`fire_valley_20261025/${path}`);
}
const materialOptions={skip:missingMaterials.length?`Local source/phase evidence unavailable: ${missingMaterials.slice(0,4).join(', ')}`:false};

test('the four declared White Forest handoff phases regenerate from exact sources and preserve every saved fixture byte',materialOptions,async()=>{
  const {preparePhaseFixtures}=await import(scriptURL);
  const before=await readFile(manifestURL),retained=JSON.parse(before),{manifest,worlds}=await preparePhaseFixtures({write:false});
  assert.equal(manifest.files.length,11);
  assert.deepEqual(new Set(manifest.files.map(row=>row.phase)),new Set(['ordinary-first','istan-request','pursuit','after-pursuit']));
  assert.ok(manifest.source_inputs.every(row=>row.unchanged));
  assert.equal(manifest.preparation.find(row=>row.kind==='retained-verified-source-handoff').save.sha256,
    '23652e1c24449a6c22f872856be6d6a6da56a395cc63875d3071807ea8f43c9e');
  for(const row of retained.files){
    const bytes=await readFile(new URL(`../evidence/white_forest_20261026/${row.path}`,import.meta.url));
    assert.equal(sha(bytes),row.sha256);assert.deepEqual(await decodeSave(JSON.parse(bytes)),worlds[row.name]);
  }
  assert.deepEqual(await readFile(manifestURL),before);
});

test('White Forest handoff saves preserve the source roster, empty reward guard, source trigger positions and the special marker landing',materialOptions,async()=>{
  const {preparePhaseFixtures}=await import(scriptURL);
  const {manifest,worlds}=await preparePhaseFixtures({write:false});
  assert.equal(worlds.istan_request.flags[7]&1,1);assert.equal(worlds.istan_request.flags[111]&1,0);
  assert.equal(worlds.istan_request.inventory.some(row=>row.id===170),false);
  assert.deepEqual(worlds.pursuit_camp.party.map(row=>row.id),['003','001','005']);
  assert.equal(worlds.pursuit_camp.flags[10]&2,2);assert.equal(worlds.pursuit_camp.flags[384]&1,0);
  assert.equal(worlds.post_pursuit_camp_absent.flags[384]&1,1);
  assert.deepEqual(worlds.native_marker2_landing.location,{map_id:'M70010',x:288,y:288,direction:1});
  assert.equal(manifest.files.find(row=>row.name==='pursuit_exit_m70010').setup.trigger_id,4);
  for(const name of ['normal_exit_m70060','pursuit_exit_m70060','post_pursuit_exit_m70060']){
    const row=manifest.files.find(row=>row.name===name);assert.equal(row.setup.trigger_id,2);assert.equal(typeof row.setup.key,'string');
  }
});
