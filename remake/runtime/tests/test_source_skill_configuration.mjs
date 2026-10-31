import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {deriveRuntimeConfiguration,compileRuntimeConfiguration,compactRuntimeConfiguration} from '../web/core/runtime_config.mjs';
import {createSkillRegistry,deriveSkillConfiguration,upgradeSkillConfiguration} from '../web/core/skill_registry.mjs';
import {compactParameterConfiguration} from '../web/core/config_overrides.mjs';
import {exportRuntimeConfiguration,inspectRuntimeConfiguration} from '../tools/export_runtime_config.mjs';

const copy=structuredClone,read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const names={combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'forest_rewards',party_skills:'party_skills',items:'items'};
const original=Object.fromEntries(await Promise.all(Object.entries(names).map(async([key,file])=>[key,await read(file)])));
function catalogFixture(){
  assert.equal(original.ai.roles.eagle,undefined,'source-only fixture must remain unregistered');
  const template=original.party_skills.skills.yantu;
  const source=(actor,index)=>{
    const s=copy(template);s.actor_id=actor;s.id=`${actor}_${index}`;s.index=s.original_skill_index=index;
    const sourcePath=`Fight_Role/${actor}.CHR`;
    s.source={path:sourcePath,sha256:original.party_skills.source_hashes[sourcePath]??'a'.repeat(64),fixed_record_offset:1000+index*1053,fixed_bytes:1053};
    const raw=Buffer.from(s.fixed_raw_hex,'hex');raw.writeInt32LE(40,0x14f);raw.writeInt32LE(20,0xcb);raw.writeInt32LE(10,0xcf);raw.writeInt32LE(-1,0x2e);s.fixed_raw_hex=raw.toString('hex');
    delete s.mp_cost;return s;
  };
  const alias={...copy(template),id:`${template.actor_id}_${template.original_skill_index}`};
  const records=[alias,source('004',7),source('eagle',5),source('E01',0)];
  return {schema:'seventh-seal-source-skills',version:1,source_hashes:Object.fromEntries(records.map(s=>[s.source.path,s.source.sha256])),skills:Object.fromEntries(records.map(s=>[s.id,s]))};
}
function fixture(){return {...copy(original),source_skills:catalogFixture()};}

test('admitting a source-catalog enemy promotes only the verified owner and preserves every existing numeric edit',async()=>{
  const data={...copy(original),source_skills:await read('library/skills')};
  assert.ok(data.ai.roles['032']);
  const oldData=copy(data);delete oldData.ai.roles['032'];
  const previous=compactParameterConfiguration(deriveSkillConfiguration(oldData));
  assert.equal(previous.entries['032_7'].owner.side,'source');
  previous.entries['032_7'].parameters.element_power=[1300,0,0,0,0,0];
  previous.entries['032_7'].parameters.mp_delta_raw=-9;
  previous.entries.yantu.parameters.mp_cost=7;
  const before=copy(previous),upgraded=upgradeSkillConfiguration(data,previous);
  assert.deepEqual(upgraded.entries['032_7'].owner,{role_id:'032',skill_index:7,side:'enemy'});
  assert.deepEqual(upgraded.entries['032_7'].parameters.element_power,[1300,0,0,0,0,0]);
  assert.equal(upgraded.entries['032_7'].parameters.mp_cost,9);
  assert.equal(upgraded.entries.yantu.parameters.mp_cost,7);assert.deepEqual(previous,before);
  assert.equal(Object.hasOwn(upgraded.entries['032_7'].parameters,'enabled'),false);
  assert.equal(Object.hasOwn(upgraded.entries['032_7'].parameters,'mp_delta_raw'),false);
  for(const mutate of [c=>c.entries['032_7'].owner.role_id='031',c=>c.entries['032_7'].owner.side='player',
    c=>c.entries['032_7'].parameters.enabled=true,c=>c.entries['032_7'].parameters.mp_cost=2,
    c=>c.source_hashes['Fight_Role/032.CHR']='0'.repeat(64),c=>c.entries['032_7'].parameters.mp_delta_raw=5]){
    const bad=copy(previous);mutate(bad);assert.throws(()=>upgradeSkillConfiguration(data,bad),/配置|技能/);
  }
});

test('complete extracted CHR catalog has exactly one configuration binding for every source record while execution remains unchanged',async()=>{
  const catalog=await read('library/skills'),data={...original,source_skills:catalog},config=deriveRuntimeConfiguration(data),registry=createSkillRegistry(data);
  assert.equal(Object.keys(config.skills.entries).length,Object.keys(catalog.skills).length);
  const byOwner=new Map(Object.entries(config.skills.entries).map(([id,row])=>[`${row.owner.role_id}:${row.owner.skill_index}`,id]));
  assert.equal(byOwner.size,Object.keys(catalog.skills).length);
  for(const source of Object.values(catalog.skills)){
    const id=byOwner.get(`${source.actor_id}:${source.original_skill_index}`),row=config.skills.entries[id];assert.ok(row,source.id);
    assert.deepEqual(row.source,source.source);assert.equal(row.name,source.name);
    if(!Object.hasOwn(registry,id)){const raw=Buffer.from(source.fixed_raw_hex,'hex');assert.equal(row.original.enabled,false);assert.equal(row.original.mp_delta_raw,raw.readInt32LE(0x14f));assert.equal(row.original.preparation_delay_raw,raw.readInt32LE(0x2e));}
  }
  for(const actor of ['001','002','003','004','005','006','031A','E01','eagle','slime','wolf'])assert.ok(Object.values(config.skills.entries).some(row=>row.owner.role_id===actor),actor);
  const compiled=compileRuntimeConfiguration(data,config);
  assert.deepEqual(Object.keys(compiled.skill_registry),Object.keys(registry));assert.equal(Object.hasOwn(compiled,'source_skills'),false);
  assert.equal(Object.keys(compiled.audit.parameters.skills).length,Object.keys(registry).length);
});

test('full source catalog shares stable bindings with implemented commands and retains uninterpreted numeric defaults',()=>{
  const data=fixture(),before=copy(data),config=deriveRuntimeConfiguration(data),implemented=createSkillRegistry(data),plain=deriveRuntimeConfiguration(original);
  assert.equal(Object.keys(config.skills.entries).length,Object.keys(plain.skills.entries).length+3);
  assert.equal(config.skills.entries['001_22'],undefined);assert.deepEqual(config.skills.entries.yantu,plain.skills.entries.yantu);
  const row=config.skills.entries['004_7'];assert.deepEqual(row.owner,{role_id:'004',skill_index:7,side:'player'});
  assert.deepEqual(config.skills.entries['eagle_5'].owner,{role_id:'eagle',skill_index:5,side:'source'});
  assert.equal(row.original.enabled,false);assert.equal(row.original.mp_delta_raw,40);assert.equal(Object.hasOwn(row.original,'mp_cost'),false);
  assert.deepEqual(row.original.physical_multiplier_percent,{minimum:20,maximum_exclusive:10});assert.equal(row.original.preparation_delay_raw,-1);
  const compiled=compileRuntimeConfiguration(data,config);
  assert.deepEqual(Object.keys(compiled.skill_registry),Object.keys(implemented));
  assert.equal(compiled.source_skills,undefined);assert.equal(compiled.audit.parameters.skills['004_7'],undefined);
  assert.equal(compiled.skill_registry.yantu.fixed_raw_hex,original.party_skills.skills.yantu.fixed_raw_hex);
  assert.deepEqual(data,before);
});

test('source-only tuning stays disabled and cannot bypass source identity, unknown-field or original-mode validation',()=>{
  const data=fixture(),config=deriveRuntimeConfiguration(data);config.manifest.mode='debug';
  config.skills.entries.yantu.parameters.mp_cost=5;config.skills.entries['004_7'].parameters.mp_delta_raw=-20;
  const compiled=compileRuntimeConfiguration(data,config);assert.equal(compiled.skill_registry.yantu.mp_cost,5);assert.equal(compiled.skill_registry['004_7'],undefined);
  const compact=compactRuntimeConfiguration(data,config);
  assert.deepEqual(compact.skills.entries['004_7'].parameters,{mp_delta_raw:-20});
  assert.equal(upgradeSkillConfiguration(data,compact.skills).entries['004_7'].parameters.mp_delta_raw,-20);
  for(const mutate of [c=>c.skills.entries['004_7'].parameters.enabled=true,c=>c.skills.entries['004_7'].parameters.mp_cost=3,c=>c.skills.entries['004_7'].owner.role_id='005',c=>c.skills.source_hashes['Fight_Role/E01.CHR']='0'.repeat(64)]){
    const invalid=copy(compact);mutate(invalid);assert.throws(()=>compileRuntimeConfiguration(data,invalid),/配置/);
  }
  const normal=copy(config);normal.manifest.mode='original';assert.throws(()=>compileRuntimeConfiguration(data,normal),/原版模式/);
  const drift=copy(data);drift.source_skills.skills['001_22'].fixed_raw_hex='00'+drift.source_skills.skills['001_22'].fixed_raw_hex.slice(2);
  assert.throws(()=>deriveRuntimeConfiguration(drift),/全量来源/);
  const source=data.source_skills.skills['004_7'],raw=Buffer.from(source.fixed_raw_hex,'hex');raw.writeInt32LE(77,0x14f);source.fixed_raw_hex=raw.toString('hex');
  assert.equal(deriveRuntimeConfiguration(data).skills.entries['004_7'].original.mp_delta_raw,77);
  assert.throws(()=>compileRuntimeConfiguration(data,config),/基线/);
});

test('System.MAG records share the unique skill configuration without inventing CHR fields or opening execution',()=>{
  const data=fixture();data.source_magic={schema:'seventh-seal-source-magic',version:1,source_hashes:{'SYSTEM/System.MAG':'b'.repeat(64)},magic:{'0':{id:0,name:'原魔法',source:{path:'SYSTEM/System.MAG',sha256:'b'.repeat(64),record_offset:18,record_bytes:542}}}};
  const config=deriveRuntimeConfiguration(data),row=config.skills.entries.system_magic_0;
  assert.deepEqual(row.owner,{source_kind:'system-magic',magic_index:0});assert.deepEqual(row.original,{enabled:false});
  assert.equal(row.source.path,'SYSTEM/System.MAG');assert.equal(row.source.record_bytes,542);
  const compiled=compileRuntimeConfiguration(data,config);assert.equal(compiled.source_magic,undefined);assert.equal(compiled.skill_registry.system_magic_0,undefined);
  config.manifest.mode='debug';row.parameters.enabled=true;assert.throws(()=>compileRuntimeConfiguration(data,config),/不能启用/);
});

test('export adds the full source catalog while preserving implemented edits; reference marks execution support and malformed sources write nothing',async()=>{
  const temporary=await mkdtemp(path.join(tmpdir(),'seventh-seal-source-config-')),directory=pathToFileURL(temporary+path.sep),output=new URL('config/',directory),data=fixture();
  try{
    for(const [key,file]of Object.entries(names))await writeFile(new URL(file+'.json',directory),JSON.stringify(data[key]));
    await exportRuntimeConfiguration({dataDirectory:directory,outputDirectory:output});
    const readConfig=async file=>JSON.parse(await readFile(new URL(file+'.json',output),'utf8'));
    const previous=await readConfig('skills'),manifest=await readConfig('index');previous.entries.yantu.parameters.mp_cost=7;manifest.mode='debug';
    await writeFile(new URL('skills.json',output),JSON.stringify(previous));await writeFile(new URL('index.json',output),JSON.stringify(manifest));
    await mkdir(new URL('library/',directory));await writeFile(new URL('library/skills.json',directory),JSON.stringify(data.source_skills));
    const result=await exportRuntimeConfiguration({dataDirectory:directory,outputDirectory:output});assert.deepEqual(result.written,['skills.json']);
    const config=await readConfig('skills');assert.equal(config.entries.yantu.parameters.mp_cost,7);assert.deepEqual(config.entries['004_7'].parameters,{});
    assert.equal(config.entries['001_22'],undefined);assert.equal(result.skills,Object.keys(previous.entries).length+3);
    const reference=await inspectRuntimeConfiguration({dataDirectory:directory,outputDirectory:output,section:'skills'});
    assert.equal(reference.entries.yantu.runtime_registered,true);assert.equal(reference.entries['004_7'].runtime_registered,false);assert.equal(reference.entries['004_7'].parameters.enabled,false);
    assert.deepEqual((await exportRuntimeConfiguration({dataDirectory:directory,outputDirectory:output})).written,[]);
    const before=await readFile(new URL('skills.json',output),'utf8');await writeFile(new URL('library/skills.json',directory),'{broken');
    await assert.rejects(exportRuntimeConfiguration({dataDirectory:directory,outputDirectory:output}));assert.equal(await readFile(new URL('skills.json',output),'utf8'),before);
  }finally{assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir())+path.sep));await rm(temporary,{recursive:true,force:true});}
});
