import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {admitPartyMember,deactivatePartyMember} from '../web/core/party_members.mjs';
import {allPartyRoles} from '../web/core/party_roster.mjs';
import {restoreNativeStoryResources,restorePartyAfterRest} from '../web/core/recovery.mjs';
import {applyNativeStoryMutation,validateNativeStoryMutation} from '../web/core/native_story_mutations.mjs';
const copy=structuredClone;
const [seed,tlk,game]=await Promise.all([
  readFile(new URL('../web/data/opening_seed.json',import.meta.url),'utf8').then(JSON.parse),
  readFile(new URL('../../../Map/m03039.TLK',import.meta.url)),readFile(new URL('../../../GAME.exe',import.meta.url))]);
const base=0x1a+tlk.readUInt32LE(2)*4;
function sourceRecord(id){
  const bytes=tlk.subarray(base+(id-1)*0x66f,base+id*0x66f);
  assert.equal(bytes.readUInt32LE(0x13),id);
  return {id,mutation_type:bytes.readUInt32LE(0x23),mutation_index:bytes.readUInt32LE(0x27),
    mutation_bit:bytes.readUInt32LE(0x2b),raw_hex:bytes.toString('hex')};
}
const hpRecord=sourceRecord(10),mpRecord=sourceRecord(11);
function vaBytes(address,size){
  const pe=game.readUInt32LE(0x3c),count=game.readUInt16LE(pe+6),optional=pe+24;
  const imageBase=game.readUInt32LE(optional+28),sections=optional+game.readUInt16LE(pe+20),rva=address-imageBase;
  for(let i=0;i<count;i++){const at=sections+i*40,start=game.readUInt32LE(at+12),length=Math.max(game.readUInt32LE(at+8),game.readUInt32LE(at+16));
    if(start<=rva&&rva<start+length){const file=game.readUInt32LE(at+20)+rva-start;return game.subarray(file,file+size);}}
  throw Error('source VA outside mapped sections');
}
function fixture(){
  const value=copy(seed);value.opening.status='complete';admitPartyMember(value,'005');
  const reserve=value.party.find(role=>role.id==='005');reserve.skill_progress={version:1,learned_indices:[30]};
  deactivatePartyMember(value,'005');
  for(const [index,role]of allPartyRoles(value).entries()){role.hp.current=index?42:0;role.mp.current=index?3:1;}
  return new WorldStore(value);
}

test('real M03039 records10/11 dispatch to separate native HP/MP loops and the same linked-attribute recomputation',()=>{
  assert.equal(hpRecord.mutation_type,10);assert.equal(mpRecord.mutation_type,11);
  const table=vaBytes(0x461d0d,72);assert.equal(table.readUInt32LE(10*4),0x46196a);assert.equal(table.readUInt32LE(11*4),0x4619d1);
  const hp=vaBytes(0x46196a,103),mp=vaBytes(0x4619d1,103);
  assert.ok(hp.includes(Buffer.from('8b90b5d85d058991b1d85d05','hex')),'HP max/current global stored fields');
  assert.ok(mp.includes(Buffer.from('8b8abdd85d058988b9d85d05','hex')),'MP max/current global stored fields');
  for(const [bytes,address]of [[hp,0x46196a],[mp,0x4619d1]]){
    const at=bytes.indexOf(0xe8);assert.equal(address+at+5+bytes.readInt32LE(at+1),0x402527);
    assert.ok(bytes.includes(Buffer.from('837df80a','hex')),'ten native map actors');
  }
  const thunk=vaBytes(0x402527,5);assert.equal(thunk[0],0xe9);assert.equal(0x402527+5+thunk.readInt32LE(1),0x47cc30);
});

test('native HP and MP recovery affect injured active and departed owned members independently and synchronize only the selected header field',()=>{
  const store=fixture(),draft=store.snapshot(),before=copy(draft);
  const result=applyNativeStoryMutation(draft,hpRecord);assert.equal(result.resource,'hp');
  assert.deepEqual(result.updates.map(row=>row.role_id),['001','005']);
  for(const role of allPartyRoles(draft)){
    const old=allPartyRoles(before).find(row=>row.id===role.id);assert.equal(role.hp.current,role.hp.maximum);assert.deepEqual(role.mp,old.mp);
    const a=Buffer.from(old.combat_progress.header_raw_hex,'hex'),b=Buffer.from(role.combat_progress.header_raw_hex,'hex');
    a.writeUInt32LE(role.hp.maximum,0x30);assert.deepEqual(b,a);
  }
  const afterHp=copy(draft);applyNativeStoryMutation(draft,mpRecord);
  for(const role of allPartyRoles(draft)){
    const old=allPartyRoles(afterHp).find(row=>row.id===role.id);assert.deepEqual(role.hp,old.hp);assert.equal(role.mp.current,role.mp.maximum);
    const a=Buffer.from(old.combat_progress.header_raw_hex,'hex'),b=Buffer.from(role.combat_progress.header_raw_hex,'hex');
    a.writeUInt32LE(role.mp.maximum,0x38);assert.deepEqual(b,a);
    for(const key of ['level','attributes_stored','skill_progress'])assert.deepEqual(role[key],old[key]);
  }
  for(const key of ['source','inventory','equipment','crystal_sockets','flags','event_records','location','leader_id','formation_slots','encounters'])assert.deepEqual(draft[key],before[key]);
  assert.deepEqual(draft.party.map(role=>role.id),['001']);assert.deepEqual(draft.reserve_party.map(entry=>entry.role.id),['005']);
});

test('native resource branches ignore unused DWORD parameters and never materialize exported but unowned templates',async()=>{
  const store=fixture(),expected=store.snapshot(),actual=store.snapshot();
  applyNativeStoryMutation(expected,hpRecord);applyNativeStoryMutation(expected,mpRecord);
  for(const original of [hpRecord,mpRecord]){
    const bytes=Buffer.from(original.raw_hex,'hex');bytes.writeUInt32LE(0xffffffff,0x27);bytes.writeUInt32LE(0x80000000,0x2b);
    const command={...original,mutation_index:0xffffffff,mutation_bit:0x80000000,raw_hex:bytes.toString('hex')};
    assert.doesNotThrow(()=>validateNativeStoryMutation(command));applyNativeStoryMutation(actual,command);
  }
  assert.deepEqual(actual,expected);assert.deepEqual(allPartyRoles(actual).map(role=>role.id),['001','005']);
  assert.ok(actual.source.role_definitions['004']);assert.equal(allPartyRoles(actual).some(role=>role.id==='004'),false);
  assert.deepEqual(await decodeSave(await encodeSave(actual)),actual);
});

test('failed later story work and corrupt owned headers cannot partially heal the transaction or earlier roles',()=>{
  const store=fixture(),before=store.snapshot();
  assert.throws(()=>store.transact(draft=>{applyNativeStoryMutation(draft,hpRecord);applyNativeStoryMutation(draft,mpRecord);throw Error('incoming animation failed');}),/incoming animation failed/);
  assert.deepEqual(store.snapshot(),before);
  const bad=copy(before);bad.reserve_party[0].role.hp.maximum++;
  const malformed=copy(bad);assert.throws(()=>restoreNativeStoryResources(bad,'hp'),/保存头与资源上限不一致/);assert.deepEqual(bad,malformed);
});

test('legacy rest retains its existing active-and-both scope; legacy records acquire no new progress or reserve fields',()=>{
  const store=fixture(),draft=store.snapshot(),reserve=copy(draft.reserve_party),active=draft.party[0];
  restorePartyAfterRest(draft);assert.equal(active.hp.current,active.hp.maximum);assert.equal(active.mp.current,active.mp.maximum);
  assert.deepEqual(draft.reserve_party,reserve);
  const legacy=copy(seed);delete legacy.party[0].combat_progress;const source=copy(legacy.source);
  restoreNativeStoryResources(legacy,'hp');assert.equal(legacy.party[0].combat_progress,undefined);
  assert.equal(legacy.reserve_party,undefined);assert.deepEqual(legacy.source,source);
});
