import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {evaluateNativeStoryCondition,nativeConditionByte,validateNativeStoryCondition} from '../web/core/native_story_conditions.mjs';

async function sourceRecord(mapId,id){
  const bytes=await readFile(new URL(`../../../Map/${mapId}.TLK`,import.meta.url));
  const base=0x1a+bytes.readUInt32LE(2)*4,raw=bytes.subarray(base+(id-1)*0x66f,base+id*0x66f);
  assert.equal(raw.readUInt32LE(0x13),id);
  return {id,raw_hex:raw.toString('hex'),condition_type:raw.readUInt32LE(0x17),
    condition_index:raw.readUInt32LE(0x1b),condition_bit:raw.readUInt32LE(0x1f)};
}
const world=()=>({party:[{id:'001'}],inventory:[],event_records:Array.from({length:2000},()=>[]),source:{initial_equipment:[]}});

test('real departure condition checks saved object10 state with the source inversion byte',async()=>{
  const record=await sourceRecord('m17010',47),value=world(),table={map_flag_index:10};
  assert.equal(record.condition_type,1);assert.equal(nativeConditionByte(record),0);
  assert.equal(evaluateNativeStoryCondition(record,value,table),false);
  for(let state=0;state<=6;state++){
    value.event_records[10][9]=state.toString(16).padStart(2,'0')+'00'.repeat(13);
    assert.equal(evaluateNativeStoryCondition(record,value,table),![0,5,6].includes(state));
    const inverse={...record,raw_hex:undefined,condition_byte_raw_0b:1};
    assert.equal(evaluateNativeStoryCondition(inverse,value,table),[0,5,6].includes(state));
  }
  const remote={...record,condition_index:11};
  assert.equal(evaluateNativeStoryCondition(remote,value,table),false);
});

test('real storage condition sees item8 in inventory, equipment and sockets without stale source fallback',async()=>{
  const record=await sourceRecord('m17012',6),value=world();
  assert.deepEqual([record.condition_type,record.condition_index,record.condition_bit],[4,0,8]);
  assert.equal(evaluateNativeStoryCondition(record,value,{}),false);
  value.inventory.push({id:8,quantity:0});assert.equal(evaluateNativeStoryCondition(record,value,{}),true);
  value.inventory=[];value.source.initial_equipment=[{role_id:'005',item_id:8}];
  assert.equal(evaluateNativeStoryCondition(record,value,{}),true);
  value.equipment={roles:{'005':[]}};assert.equal(evaluateNativeStoryCondition(record,value,{}),false);
  value.equipment.roles['005'].push({id:8});assert.equal(evaluateNativeStoryCondition(record,value,{}),true);
  value.equipment.roles['005']=[];value.crystal_sockets={roles:{'001':[{id:8}]}};
  assert.equal(evaluateNativeStoryCondition(record,value,{}),true);
});

test('source condition10 uses header+0B role slot even when condition_bit is zero',async()=>{
  const [jute,warrior,rest]=await Promise.all([sourceRecord('m17014',17),sourceRecord('m17025',1),sourceRecord('m17026',9)]);
  const value=world();
  for(const record of [jute,warrior]){
    assert.equal(record.condition_type,10);assert.equal(record.condition_bit,0);assert.equal(nativeConditionByte(record),4);
    assert.equal(evaluateNativeStoryCondition(record,value,{}),false);
  }
  assert.equal(nativeConditionByte(rest),0);assert.equal(evaluateNativeStoryCondition(rest,value,{}),true);
  value.party.push({id:'005'});
  assert.equal(evaluateNativeStoryCondition(jute,value,{}),true);assert.equal(evaluateNativeStoryCondition(warrior,value,{}),true);
  const compact={...jute,raw_hex:undefined,condition_byte_raw_0b:4};
  assert.equal(evaluateNativeStoryCondition(compact,value,{}),true);
  assert.throws(()=>validateNativeStoryCondition({...compact,condition_byte_raw_0b:10},{}),/角色槽/);
  assert.throws(()=>validateNativeStoryCondition({...jute,condition_byte_raw_0b:0},{}),/来源不同/);
  assert.throws(()=>validateNativeStoryCondition({...rest,condition_type:9},{}),/尚未接入/);
});

test('original ticket counter condition8 tests the controlled actor, independently of party presence',async()=>{
  const record=await sourceRecord('m03023',25),value=world();
  assert.equal(record.condition_type,8);const slot=nativeConditionByte(record),id=String(slot+1).padStart(3,'0');
  value.party=[{id:'001'},{id}];value.leader_id=id;
  assert.equal(evaluateNativeStoryCondition(record,value,{}),true);
  const wide=Buffer.from(record.raw_hex,'hex');wide[0x0c]=1;
  assert.equal(evaluateNativeStoryCondition({...record,raw_hex:wide.toString('hex')},value,{}),false,'the native DWORD comparison never truncates to byte0B');
  value.leader_id=id==='001'?'003':'001';
  assert.equal(evaluateNativeStoryCondition(record,value,{}),false);
  const before=structuredClone(value);evaluateNativeStoryCondition(record,value,{});assert.deepEqual(value,before);
});
