import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {nativeLoadedSkillCodes} from '../web/core/native_skill_loading.mjs';
import {selectNativeSkills} from '../web/core/forest_ai.mjs';
import {loadedSkillCodeOracle,nativeSkillCodeSource} from './helpers/native_skill_code_oracle.mjs';
const data=JSON.parse(await readFile(new URL('../web/data/forest_ai.json',import.meta.url),'utf8'));
const skill=(flags,code=0)=>{const b=Buffer.alloc(0x41d);b[0x19]=code;b.writeUInt32LE(flags>>>0,0x32);return {fixed_raw_hex:b.toString('hex')};};
const actor={side_raw:0,status_flags_raw:0};
function scripted(values){let calls=0;const rng=()=>{assert.ok(calls<values.length,'Unexpected extra selection RNG');return values[calls++];};Object.defineProperty(rng,'calls',{get:()=>calls});return rng;}

test('real gameplay loader mode, immutable source flags and original instruction block agree',async()=>{
  const game=await readFile(new URL('../../../GAME.exe',import.meta.url));assert.equal(createHash('sha256').update(game).digest('hex'),nativeSkillCodeSource.artifact_sha256);
  assert.equal(game.readUInt32LE(nativeSkillCodeSource.source_image_mode.file_offset),1,'PE initial1 differs from actual battle-entry write0');
  for(const id of ['011','012','013','032']){
    const role=data.roles[id],before=structuredClone(role);
    for(const modeRaw of [0,1,0xffffffff]){
      const oracle=loadedSkillCodeOracle(role.skills,{modeRaw});assert.deepEqual(nativeLoadedSkillCodes(role.skills,{modeRaw}),oracle.codes);assert.deepEqual(oracle.rng_calls,[]);
      if(modeRaw===0)assert.ok(oracle.codes.every(code=>code===0));else assert.deepEqual(oracle.codes,role.skills.map(row=>Buffer.from(row.fixed_raw_hex,'hex')[0x19]));
    }assert.deepEqual(role,before,'Source CHR/config bytes are never rewritten');
  }
});

test('type and bit8, zero source codes, skipped rows and a..y/A rollover match original assembly',()=>{
  const table=[skill(0,99),skill(0x100,97),skill(1,98),skill(0x101,0),skill(0x102,255),skill(0x103,97),skill(0x10001,100),...Array.from({length:90},(_,i)=>skill(i%7===0?0:0x101,i%256))];
  const before=structuredClone(table);
  for(const modeRaw of [0,1,3,0xffffffff])assert.deepEqual(nativeLoadedSkillCodes(table,{modeRaw}),loadedSkillCodeOracle(table,{modeRaw}).codes);
  const codes=nativeLoadedSkillCodes(Array.from({length:85},()=>skill(0x101)));
  assert.equal(codes[0],97);assert.equal(codes[24],121);assert.equal(codes[25],65);assert.equal(codes[81],121);assert.equal(codes[82],65);
  assert.deepEqual(table,before);
});

test('actual032 normal battle never attempts a markerless combination or spends combination-member RNG',()=>{
  const role=data.roles['032'];assert.ok(role.skills.filter(s=>s.learned_raw_0x23).every(s=>s.actions.every(a=>Buffer.from(a.raw_hex,'hex')[0x2e]===0)));
  for(const gate of [0,19,20,99])for(const roll of [0,34,35,64,65,79,80,94,95,99]){
    const rng=scripted([gate,roll]),selection=selectNativeSkills({actor,role,rng});assert.equal(selection.kind,'single');assert.equal(rng.calls,2);
    assert.deepEqual(selection.trace.filter(r=>r.kind==='rng').map(r=>r.label),['combination-gate','single-weight']);
    assert.ok(role.learned_indices.includes(selection.skill_indices[0]));
  }
  const rng=scripted([0,0,0,1,2]);const retained=selectNativeSkills({actor,role,rng,load_mode_raw:1});assert.equal(retained.kind,'combination');assert.deepEqual(retained.skill_indices,[7,8,9]);assert.equal(rng.calls,5);
});

test('a source bit8 combination remains selectable, and malformed inputs fail before RNG',()=>{
  const role=structuredClone(data.roles['013']);for(const row of role.skills){const b=Buffer.from(row.fixed_raw_hex,'hex');if(row.learned_raw_0x23)b.writeUInt32LE(b.readUInt32LE(0x32)|0x100,0x32);row.fixed_raw_hex=b.toString('hex');}
  const rng=scripted([0,0,0,1,0]),selection=selectNativeSkills({actor,role,rng});assert.equal(selection.kind,'combination');assert.deepEqual(selection.skill_codes,[97,98,97]);assert.deepEqual(selection.skill_indices,[15,16,15]);assert.equal(rng.calls,5);
  let calls=0;assert.throws(()=>selectNativeSkills({actor,role,rng:()=>calls++,load_mode_raw:-1}),/load mode/);assert.equal(calls,0);
  assert.throws(()=>nativeLoadedSkillCodes([{fixed_raw_hex:'00'}]),/fixed bytes/);assert.throws(()=>nativeLoadedSkillCodes(Array(201).fill(skill(1))),/table/);
});
