import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {availableFieldSkills,fieldSkillAvailability,applyFieldSkill,useWorldSkill} from '../web/core/field_skills.mjs';
import {chapterRoleFromDefinition} from '../web/core/chapter.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {createPartyActors} from '../web/core/party_attributes.mjs';
import {deriveRuntimeConfiguration,compileRuntimeConfiguration} from '../web/core/runtime_config.mjs';
globalThis.crypto??=webcrypto;
const copy=structuredClone,read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));
const data=Object.fromEntries(await Promise.all(Object.entries({combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'party_rewards',party_skills:'party_skills',items:'items'}).map(async([id,file])=>[id,await read(file)])));
const attributes=await read('party_combat'),skills=data.party_skills,items=data.items;
const options={casterId:'001',skillId:'yannuan',targetId:'002'};
async function fixture(){const seed=await read('opening_seed');seed.opening.status='complete';seed.party.push(chapterRoleFromDefinition(seed.source.role_definitions['002']));seed.party[1].hp.current=0;return new WorldStore(seed,['M72061','M70010']);}

test('Field skill eligibility follows learned flag bit13, level10, MP and full HP gates',async()=>{
  const world=await fixture(),before=world.snapshot();
  assert.deepEqual(availableFieldSkills(before,skills,'001').map(s=>s.original_skill_index),[41]);
  assert.deepEqual(availableFieldSkills(before,skills,'002'),[]);
  assert.deepEqual(fieldSkillAvailability(before,attributes,skills,items,options),{available:true,hp_delta:300,mp_delta:0,mp_cost:6});
  const full=copy(before);full.party[1].hp.current=full.party[1].hp.maximum;
  assert.match(fieldSkillAvailability(full,attributes,skills,items,options).reason,/HP已满/);
  const poor=copy(before);poor.party[0].mp.current=(-7)>>>0;
  assert.match(fieldSkillAvailability(poor,attributes,skills,items,options).reason,/MP不足/);
  const low=copy(skills),raw=Buffer.from(low.field_skills.yannuan.fixed_raw_hex,'hex');raw.writeInt32LE(before.party[0].level+1,0x143);low.field_skills.yannuan.fixed_raw_hex=raw.toString('hex');
  assert.match(fieldSkillAvailability(before,attributes,low,items,options).reason,/等级不足/);
  low.field_skills.yannuan.learned_raw=0;assert.deepEqual(availableFieldSkills(before,low,'001'),[]);
  assert.deepEqual(world.snapshot(),before);
});

test('Source #41 restores300 HP including fallen targets, costs6 MP once and persists without inventory/RNG changes',async()=>{
  const world=await fixture(),before=world.snapshot(),source=copy(skills);
  const result=useWorldSkill(world,attributes,skills,items,options),after=world.snapshot();
  assert.deepEqual(result.target_hp,{before:0,after:300});assert.equal(result.caster_mp.before-result.caster_mp.after,6);
  assert.equal(after.party[0].mp.current,before.party[0].mp.current-6);
  assert.deepEqual(after.inventory,before.inventory);assert.deepEqual(after.encounters,before.encounters);assert.deepEqual(skills,source);
  assert.deepEqual(await decodeSave(await encodeSave(after),world.mapIds),after);
  const stale=world.snapshot();assert.throws(()=>useWorldSkill(world,attributes,skills,items,{...options,expectedRevision:0}),/进度已变化/);assert.deepEqual(world.snapshot(),stale);
});

test('Self recovery occurs before caster cost and source raw max clamps; rejection is atomic',async()=>{
  const world=await fixture();world.transact(draft=>{draft.party[0].hp.current=10;});
  const actors=createPartyActors(world.snapshot(),attributes,{},items),initial=actors[0];
  const result=useWorldSkill(world,attributes,skills,items,{...options,targetId:'001'});
  assert.equal(result.target_hp.after,Math.min(initial.raw_hp+300,initial.raw_hp_maximum)+initial.resource_bonuses.hp_current);
  assert.equal(result.caster_mp.after,initial.mp.current-6);
  world.transact(draft=>{draft.party[0].hp.current=draft.party[0].hp.maximum;});
  const full=world.snapshot();assert.throws(()=>useWorldSkill(world,attributes,skills,items,{...options,targetId:'001'}),/HP已满/);assert.deepEqual(world.snapshot(),full);
});

test('Unified owner001/index41 debug HP and MP parameters are used by the field handler',async()=>{
  const cfg=deriveRuntimeConfiguration(data);assert.equal(cfg.skills.entries.yannuan.owner.skill_index,41);
  assert.equal(cfg.skills.entries.yannuan.original.hp_term_bonus,300);assert.equal(cfg.skills.entries.yannuan.original.mp_cost,6);
  cfg.manifest.mode='debug';cfg.skills.entries.yannuan.parameters.hp_term_bonus=50;cfg.skills.entries.yannuan.parameters.mp_cost=2;
  const compiled=compileRuntimeConfiguration(data,cfg),world=await fixture(),before=world.snapshot();
  const applied=applyFieldSkill(before,attributes,compiled.party_skills,compiled.items,options);
  assert.equal(applied.result.target_hp.after,50);assert.equal(applied.result.caster_mp.before-applied.result.caster_mp.after,2);
  assert.equal(applied.result.configuration.mode,'debug');assert.deepEqual(world.snapshot(),before);
  assert.deepEqual(skills.field_skills.yannuan.fixed_raw_hex,skills.roles['001'].skills[41].fixed_raw_hex);
});
