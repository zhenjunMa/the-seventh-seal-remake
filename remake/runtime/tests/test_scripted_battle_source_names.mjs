import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {scriptedBattleSource,nativeScriptedBattle} from '../web/core/scripted_battle.mjs';
import {hydrateStoryTable,validateCompactRecords} from '../web/core/story_packages.mjs';
import {isNativeBattleFilename} from '../web/core/native_battle_filenames.mjs';
import {auditContentFiles} from '../tools/export_content_registry.mjs';
import {compileStoryPackages} from '../tools/export_story_packages.mjs';
const copy=structuredClone;
const story=JSON.parse(await readFile(new URL('../web/data/chapter_story.json',import.meta.url),'utf8'));
const table=story.maps.M01050,record=table.records.find(row=>row.id===103);
const expected={stage_file:'stage01.scn',enemy_files:['031A1.dgp','','031B2.dgp','','','']};
// Keep the original27-map compilation baseline explicit while requiring every
// currently registered map, including source-absent direct-object packages.
const legacyMaps=['M01050','M03039','M01010','M01030','M17010','M17020','M17026','M17029','M70010','M72061',
  'M17011','M17012','M17013','M17014','M17015','M17016','M17021','M17022','M17023','M17024','M17025','M17027',
  'M17028','M17030-1','M17030-2','M17030','M17032'];

test('real M01050:r103 keeps the complete original source basenames without admitting the external battle',async()=>{
  const bytes=await readFile(new URL('../../../Map/m01050.TLK',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),table.source.sha256);
  assert.equal(bytes.subarray(record.source.offset,record.source.offset+0x66f).toString('hex'),record.raw_hex);
  assert.deepEqual(scriptedBattleSource(record),expected);
  assert.deepEqual(scriptedBattleSource({kind:5,scripted_battle:expected}),expected);
  const {content}=await auditContentFiles();
  assert.equal(content.stages.stage01,undefined);assert.equal(content.roles['031A1'],undefined);assert.equal(content.roles['031B2'],undefined);
  assert.throws(()=>nativeScriptedBattle(table,record,content),/未登记/);
  const stageOnly=copy(content);stageOnly.stages.stage01={path:'data/stages/stage01.json',schema:'seventh-seal-battle-stage',asset_prefix:'assets/stages/stage01/'};
  stageOnly.roles['031']={side:'enemy',source:{path:'Fight_Role/031.CHR',sha256:'0'.repeat(64)}};
  assert.throws(()=>nativeScriptedBattle(table,record,stageOnly),/敌人尚未登记/,'031A1 is never truncated or inferred to be registered031');
});

test('all current map packages retain the original27-map baseline and compact M01050:r103 names without admitting execution',async()=>{
  const {definition,content}=await auditContentFiles(),before=copy(content),compiled=await compileStoryPackages({definition,content});
  assert.equal(legacyMaps.length,27);
  const currentMaps=Object.keys(definition.maps).sort(),packedMaps=[...compiled.output.keys()]
    .filter(path=>/^data\/story\/maps\/[^/]+\.json$/.test(path)).map(path=>path.split('/').at(-1).slice(0,-5).toUpperCase()).sort();
  assert.equal(compiled.report.maps,currentMaps.length);assert.deepEqual(packedMaps,currentMaps);
  for(const id of legacyMaps)assert.ok(packedMaps.includes(id),`${id} legacy source package retained`);
  const pack=JSON.parse(compiled.output.get('data/story/maps/m01050.json'));
  const compact=pack.chapter.records.find(row=>row.id===103);
  assert.equal(compact.raw_hex,undefined);assert.deepEqual(compact.scripted_battle,expected);
  const hydrated=hydrateStoryTable(pack.chapter,pack.texts);validateCompactRecords(hydrated);
  assert.deepEqual(scriptedBattleSource(hydrated.records.find(row=>row.id===103)),expected);
  assert.throws(()=>nativeScriptedBattle(hydrated,hydrated.records.find(row=>row.id===103),content),/未登记/);
  assert.deepEqual(content,before,'source compilation does not admit outside stages/enemies');
});

test('source and compact filename validation share the20-byte ASCII/NUL/basename boundary',()=>{
  assert.equal(isNativeBattleFilename('a'.repeat(15)+'.dgp','dgp'),true);
  const valid=scriptedBattleSource(record),raw=Buffer.from(record.raw_hex,'hex');raw.fill(65,0x37+20,0x37+40);
  assert.throws(()=>scriptedBattleSource({...record,raw_hex:raw.toString('hex')}),/NUL边界/);
  for(const name of ['a'.repeat(16)+'.dgp','../031A1.dgp','dir/031A1.dgp','dir\\031A1.dgp','031A1.dgp\0bad','031Ａ1.dgp','031A1..dgp']){
    assert.equal(isNativeBattleFilename(name,'dgp',{allowEmpty:true}),false,name);
    const bad={...valid,enemy_files:[name,'','','','','']};assert.throws(()=>scriptedBattleSource({kind:5,scripted_battle:bad}),/文件名无效/);
    const compact={id:'M01050',records:[{id:1,text_id:'M01050:TLK:1',text_raw:'',kind:5,style:1,region_byte_raw:0,speaker:500,
      condition_type:0,condition_index:0,condition_bit:0,mutation_type:0,mutation_index:0,mutation_bit:0,if_true:0,next:0,choices:[],scripted_battle:bad}]};
    assert.throws(()=>validateCompactRecords(compact),/文件名缺失/);
    if(Buffer.byteLength(name)<20){const source=Buffer.from(record.raw_hex,'hex');source.fill(0,0x37+20,0x37+40);source.write(name,0x37+20,'utf8');
      if(!name.includes('\0'))assert.throws(()=>scriptedBattleSource({...record,raw_hex:source.toString('hex')}),/文件名无效/);}
  }
});
