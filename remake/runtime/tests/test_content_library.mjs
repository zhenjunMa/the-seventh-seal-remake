import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildContentLibrary,resolveContentReference,searchContentLibrary} from '../web/core/content_library.mjs';
import {createSkillRegistry} from '../web/core/skill_registry.mjs';
const json=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}`,import.meta.url),'utf8'));
const runtimeSkillIds=Object.keys(createSkillRegistry({party_skills:await json('party_skills.json'),ai:await json('forest_ai.json')}));
const data={roles:await json('library/roles.json'),skills:await json('library/skills.json'),magic:await json('library/magic.json'),items:await json('items.json'),runtimeSkillIds,
  registration:await json('runtime_content.json'),skillConfiguration:await json('config/skills.json'),itemConfiguration:await json('config/items.json')};
const library=buildContentLibrary(data);
test('all source roles, skills and items have stable references and unified configuration',()=>{
  assert.equal(library.counts.companions,6);assert.equal(library.counts.roles,Object.keys(data.roles.roles).length);
  assert.equal(library.counts.chr_skills,Object.keys(data.skills.skills).length);assert.equal(library.counts.system_magic,41);assert.equal(library.counts.items,416);
  for(const id of library.indexes.roles.companions){
    const role=resolveContentReference(library,{kind:'roles',id});
    for(const skillId of role.skills)assert.equal(resolveContentReference(library,{kind:'skills',id:skillId}).role_id,id);
  }
  assert.ok(resolveContentReference(library,{kind:'skills',id:'031A_0'}));
  assert.equal(resolveContentReference(library,{kind:'skills',id:'system_magic_0'}).runtime_registered,false);
  assert.equal(resolveContentReference(library,{kind:'skills',id:'system_magic_27'}).source_id,28);
  assert.equal(resolveContentReference(library,{kind:'skills',id:'system_magic_28'}).source_id,28);
});
test('runtime aliases resolve to their source owner without registering source-only skills',()=>{
  const yantu=resolveContentReference(library,{kind:'skills',id:'yantu'});
  assert.equal(yantu.role_id,'001');assert.equal(yantu.configuration_id,'yantu');assert.ok(yantu.runtime_registered);
  const rows=searchContentLibrary(library,{kind:'skills',roleId:'014'});assert.ok(rows.length);
  assert.ok(rows.every(row=>row.runtime_registered===false));
  assert.ok(library.counts.skills>library.counts.runtime_skills);
});
test('duplicate names never silently select the wrong original record',()=>{
  const name=data.items.definitions['125'].name;
  assert.equal(name,data.items.definitions['393'].name);
  assert.throws(()=>resolveContentReference(library,{kind:'items',name}),/多个编号/);
  assert.equal(resolveContentReference(library,{kind:'items',id:125}).id,125);
  assert.equal(resolveContentReference(library,{kind:'items',id:393}).id,393);
  assert.throws(()=>resolveContentReference(library,{kind:'roles',id:'999'}),/未知/);
});
test('incomplete configuration or wrong skill ownership cannot produce an index',()=>{
  const changed=structuredClone(data);delete changed.skillConfiguration.entries.yantu;
  assert.throws(()=>buildContentLibrary(changed),/没有.*配置/);
  const broken=structuredClone(data);broken.skills.skills['001_0'].actor_id='002';
  assert.throws(()=>buildContentLibrary(broken),/技能身份/);
});
