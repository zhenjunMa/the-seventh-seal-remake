// Original ITM cure, literal 508BB0/508300 x86, and real regional gift.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {initializeNativeStatuses,removeNativeStatus} from '../web/core/battle_status.mjs';
import {restoreActorWithItem,usableItems,useWorldItem} from '../web/core/items.mjs';
import {compileItemConfiguration} from '../web/core/item_registry.mjs';
import {withItemQuantity} from '../web/core/equipment.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {preparePhaseFixtures,headlessRunner} from '../evidence/fire_valley_20261025/prepare_phase_fixtures.mjs';
const json=async path=>JSON.parse(await readFile(new URL(`../${path}`,import.meta.url),'utf8'));
const [published,statusData,sample,instructions,proof,overrides,attributes]=await Promise.all([
  'web/data/items.json','web/data/forest_status.json','web/data/combat_sample.json',
  'evidence/forest_status_instructions_20261011.json','evidence/fire_valley_20261024/stage12_status_apply.json',
  'web/data/config/items.json','web/data/party_combat.json'].map(json));
const source=process.env.SEVENTH_SEAL_ITEM_TEST_CATALOG?JSON.parse(await readFile(process.env.SEVENTH_SEAL_ITEM_TEST_CATALOG,'utf8')):published;
const itemData=compileItemConfiguration(source,overrides,'original').data,copy=structuredClone,ZERO='00'.repeat(0xc6);
const itm=await readFile(new URL('../../../SYSTEM/Object.ITM',import.meta.url)),rawItem=itm.subarray(0x61c+271*959,0x61c+272*959),cure=rawItem.subarray(0x2a8,0x36e).toString('hex');
const frozenSource=await readFile(new URL('../../../Fight_Role/022.CHR',import.meta.url));
assert.equal(createHash('sha256').update(frozenSource).digest('hex'),'1d993fbcd562db44c2f515f3b9e3e1bfa4d2ad99924ad543b62ca8226b3f4455');
let at=8+779;
for(let index=0;index<19;index++)at+=0x41d+frozenSource.readUInt32LE(at+0x15)*0xb0;
const frozenBlock=frozenSource.subarray(at+0x16b,at+0x231);
assert.equal(frozenBlock[1],5);assert.equal(frozenBlock[0xb],0);
const functions={...instructions.instructions,'0x508bb0':proof.normalized_result.assembly};
function args(block){const raw=Buffer.alloc(200);Buffer.from(block,'hex').copy(raw);return [0,...Array.from({length:50},(_,i)=>raw.readInt32LE(i*4))];}
class Oracle extends NativeAssemblyOracle{
  constructor(actor){
    super(functions,[actor],()=>{throw Error('Mode1 must not consume CRT RNG');});this.cancellations=0;
    actor.native_status_slots.forEach((row,index)=>Buffer.from(row.raw_hex,'hex').forEach((value,offset)=>this.write(0x521a7d2+index*0xc6+offset,value,1)));
    this.write(0x521f52a,actor.status_flags_raw);
  }
  regRead(name){return name==='BL'?this.reg.EBX&255:super.regRead(name);}
  regWrite(name,value){if(name==='BL')this.reg.EBX=(this.reg.EBX&~255)|(value&255);else super.regWrite(name,value);}
  external(target){const arg=i=>this.read(this.reg.ESP+i*4);
    if(target===0x570a40){for(let i=0;i<arg(2);i++)this.write(arg(0)+i,arg(1),1);this.reg.EAX=arg(0);return;}
    if(target===0x507c60){this.write(arg(0),(this.read(arg(0))|(arg(1)&0x3ff))>>>0);return;}
    if(target===0x401609){this.cancellations++;assert.equal(this.read(0x521a7c6,1),6);return;}
    return super.external(target);
  }
  aggregate(actor){
    this.run(0x508300,[0]);actor.status_flags_raw=this.read(0x521f52a)>>>0;
    for(const field of Object.keys(actor.status_by_address))actor.status_by_address[field]=this.read(Number(field));
    actor.status_by_address['0x0521f52a']=actor.status_flags_raw;
    actor.native_status_aggregate_raw_hex=Buffer.from(Array.from({length:0xc6},(_,i)=>this.read(0x521f52e+i,1))).toString('hex');
    return actor;
  }
  compare(actor){
    assert.equal(this.read(0x521f52a)>>>0,actor.status_flags_raw);
    for(const field of statusData.aggregation)assert.equal(this.read(Number(field.address),field.bits===8?1:4),actor.status_by_address[field.address],field.address);
    for(let slot=0;slot<100;slot++)assert.equal(Buffer.from(Array.from({length:0xc6},(_,i)=>this.read(0x521a7d2+slot*0xc6+i,1))).toString('hex'),actor.native_status_slots[slot].raw_hex,`slot ${slot}`);
  }
}
function actor(entries=[]){
  const a=initializeNativeStatuses(copy(sample.actors[0]),statusData);
  for(const [index,raw_hex]of entries)a.native_status_slots[index]={raw_hex};
  return new Oracle(a).aggregate(a);
}
function compare(entries,expected){
  const target=actor(entries),before=copy(target),oracle=new Oracle(target);
  const result=removeNativeStatus({actor:target,effect_raw_hex:cure,data:statusData});
  oracle.run(0x508bb0,args(cure));oracle.compare(result.actor);
  assert.equal(result.native_return,oracle.reg.EAX);assert.equal(result.native_return,expected);assert.deepEqual(oracle.rng_calls,[]);
  assert.equal(result.cancel_command,oracle.cancellations>0);assert.deepEqual(target,before);return result;
}

test('actual ITM272 is single allied mode1/id5 with zero initialized recovery fields and retained original presentation token',()=>{
  const definition=itemData.definitions[272];
  assert.equal(rawItem[0x24],5);assert.equal(rawItem[0x25],1);assert.equal(rawItem[0x156],0);assert.equal(rawItem[0x157],1);
  assert.equal(definition.status_cure.effect_raw_hex,cure);assert.equal(definition.raw_fields.effect_token_raw_126,'_iReSTfz.dgp');
  assert.equal(definition.raw_fields.animation_skill_id_raw_142,17);assert.equal(definition.status_cure.effect_id_raw,5);
  assert.ok(definition.value_ranges.every(pair=>pair.minimum===0&&pair.maximum===0));
  assert.equal(proof.subject.digest.sha256,'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18');
});

test('mode1 first-match removal, duplicate guard and no RNG match native instructions across all source slot positions',()=>{
  compare([],0);
  for(const slot of [0,1,49,99])for(const mode of [0,2,6,7]){
    const raw=Buffer.from(frozenBlock);raw[0xb]=mode;
    const result=compare([[slot,raw.toString('hex')]],1);assert.equal(result.actor.native_status_slots[slot].raw_hex,ZERO);
  }
  const double=compare([[0,frozenBlock.toString('hex')],[99,frozenBlock.toString('hex')]],1);
  assert.equal(double.actor.native_status_slots[99].raw_hex,frozenBlock.toString('hex'));
  compare([[0,frozenBlock.toString('hex')],[99,cure]],0);
  const other=Object.values(statusData.skills).find(skill=>skill.effect_id_raw===6).effect_raw_hex;
  const mixed=compare([[0,other],[3,frozenBlock.toString('hex')]],1);
  assert.equal(mixed.actor.native_status_slots[0].raw_hex,other);assert.equal(mixed.actor.status_flags_raw,0x10);
});

test('normal item helper cures frozen target without HP/MP changes; absent status requests visual but does not consume',()=>{
  const def=itemData.definitions[272],item=withItemQuantity({id:272,name:def.name,instance_id:'cure',source_raw_hex:def.initialized_raw_hex},3);
  const frozen=actor([[2,frozenBlock.toString('hex')]]),before=copy(frozen);
  const result=restoreActorWithItem(frozen,item,itemData,{statusData});
  assert.equal(result.applied,true);assert.equal(result.native_return,1);assert.equal(result.effect_requested,true);
  assert.equal(result.actor.native_status_slots[2].raw_hex,ZERO);assert.deepEqual(result.actor.hp,before.hp);assert.deepEqual(result.actor.mp,before.mp);
  assert.equal(result.actor.raw_hp,before.raw_hp);assert.equal(result.actor.raw_mp,before.raw_mp);assert.deepEqual(frozen,before);
  const miss=restoreActorWithItem(actor(),item,itemData,{statusData});assert.equal(miss.native_return,0);assert.equal(miss.applied,false);assert.equal(miss.effect_requested,true);
  const displayZero=actor();displayZero.raw_hp=-displayZero.resource_bonuses.hp_current;displayZero.raw_by_address['0x0524a701']=displayZero.raw_hp;displayZero.hp.current=0;
  assert.doesNotThrow(()=>restoreActorWithItem(displayZero,item,itemData,{statusData}),'native target gate is state<4, not displayed HP');
  for(const state_raw of [4,5,7,11])assert.throws(()=>restoreActorWithItem({...frozen,state_raw},item,itemData,{statusData}),/倒下或免疫/);
  assert.throws(()=>restoreActorWithItem({...frozen,immune_raw:1},item,itemData,{statusData}),/倒下或免疫/);
});

test('actual M17027 gift grants three cure instances, field scope cannot consume them, and save/load preserves source bytes',async()=>{
  const {worlds}=await preparePhaseFixtures({write:false}),world=new WorldStore(worlds.after_incoming),runner=headlessRunner(world).runner;
  const result=await runner.runTlk({mapId:'M17027',recordId:7,context:{explicitInteraction:true,steps:0}});
  assert.deepEqual(result.traversed,[7,8,9,10,11,12]);const item=world.value.inventory.find(row=>row.id===272);assert.equal(item.quantity,3);
  const before=world.snapshot();assert.equal(usableItems(world.value.inventory,itemData,'battle').some(row=>row.id===272),true);
  assert.equal(usableItems(world.value.inventory,itemData,'field').some(row=>row.id===272),false);
  assert.throws(()=>useWorldItem(world,attributes,itemData,{instanceId:item.instance_id,targetId:'001'}),/配置禁用/);assert.deepEqual(world.snapshot(),before);
  assert.deepEqual(await decodeSave(await encodeSave(world.snapshot())),world.snapshot());
});
