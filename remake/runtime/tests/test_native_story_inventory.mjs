import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {removeNativeStoryItem} from '../web/core/native_story_inventory.mjs';
import {ChapterRunner} from '../web/core/chapter.mjs';
import {admitPartyMember,deactivatePartyMember} from '../web/core/party_members.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {withItemQuantity} from '../web/core/equipment.mjs';
const read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [seed,items,story]=await Promise.all(['opening_seed','items','chapter_story'].map(read)),copy=structuredClone;
const instance=(id,quantity=1,instance_id=`source:${id}`)=>withItemQuantity({id,name:items.definitions[id].name,
  instance_id,source_raw_hex:items.definitions[id].initialized_raw_hex},quantity);

test('real M01050 record23 and the native case5 bytes dispatch every nonzero index to 47C8E0(-1,id)',async()=>{
  const game=await readFile(new URL('../../../GAME.exe',import.meta.url));
  assert.equal(createHash('sha256').update(game).digest('hex'),'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18');
  const pe=game.readUInt32LE(0x3c),sections=pe+24+game.readUInt16LE(pe+20),base=game.readUInt32LE(pe+24+28);
  const at=address=>{for(let i=0;i<game.readUInt16LE(pe+6);i++){const s=sections+i*40,rva=game.readUInt32LE(s+12),n=game.readUInt32LE(s+16);
    if(address-base>=rva&&address-base<rva+n)return game.readUInt32LE(s+20)+address-base-rva;}throw Error('source VA missing');};
  assert.equal(game.readUInt32LE(at(0x461d0d)+5*4),0x4618ff);
  const raw=game.subarray(at(0x4618ff),at(0x46196a));
  assert.equal(raw.toString('hex'),'837d2f00754c837d330074448b4d3383e90169c9bf0300008b15e8b7030503d1528d8510ffffff50e86105faff81c420ffffffb9390000008db510ffffff8bfcf3a5a46affe8f701faff81c4ec000000eb14837d3300740e8b4d33516affe89009faff83c408e98f030000');
  const call=raw.lastIndexOf(0xe8),thunk=0x4618ff+call+5+raw.readInt32LE(call+1),jump=game.subarray(at(thunk),at(thunk)+5);
  assert.equal(jump[0],0xe9);assert.equal(thunk+5+jump.readInt32LE(1),0x47c8e0);
  const tlk=await readFile(new URL('../../../Map/m01050.TLK',import.meta.url)),offset=0x1a+tlk.readUInt32LE(2)*4+22*0x66f;
  assert.deepEqual([0x23,0x27,0x2b].map(o=>tlk.readUInt32LE(offset+o)),[5,1,299]);
});

test('native removal consumes only the first same-ID inventory slot and compacts its final unit',()=>{
  const value=copy(seed);value.inventory=[instance(299,2,'first'),instance(299,3,'second'),instance(8)];
  const before=copy(value);assert.deepEqual(removeNativeStoryItem(value,299),{changed:true,storage:'inventory',instance_id:'first'});
  assert.deepEqual(value.inventory.map(row=>[row.instance_id,row.quantity]),[['first',1],['second',3],['source:8',1]]);
  assert.equal(Buffer.from(value.inventory[0].source_raw_hex,'hex').readUInt32LE(4),1);
  removeNativeStoryItem(value,299);assert.deepEqual(value.inventory.map(row=>row.instance_id),['second','source:8']);
  assert.deepEqual(value.party,before.party);assert.deepEqual(value.encounters,before.encounters);
});

test('native removal falls back to category0 crystals before category3 gear and preserves raw resources',()=>{
  const value=copy(seed),gear={...instance(4,1,'worn'),slot_id:'ring'};
  value.inventory=[];value.equipment={version:1,roles:{'001':[gear]}};
  value.crystal_sockets={version:1,roles:{'001':[instance(4,1,'socket-contract'),null,null,null,null,null]}};
  // An artificial storage arrangement tests native category/entry order only;
  // it is not an equip/socket admission claim for the ring.
  const before=copy(value.party);
  assert.equal(removeNativeStoryItem(value,4).storage,'crystal');assert.equal(value.equipment.roles['001'].length,1);
  assert.equal(removeNativeStoryItem(value,4).storage,'equipment');assert.equal(value.equipment.roles['001'].length,0);
  assert.deepEqual(value.party,before);assert.deepEqual(removeNativeStoryItem(value,4),{changed:false});
});

test('initial weapon removal for a departed owned role persists without changing source provenance or growth',async()=>{
  const value=copy(seed);admitPartyMember(value,'005');deactivatePartyMember(value,'005');value.inventory=[];
  const before=copy(value),result=removeNativeStoryItem(value,41);assert.equal(result.role_id,'005');
  assert.deepEqual(value.equipment.roles['005'],[]);assert.deepEqual(value.reserve_party,before.reserve_party);
  assert.deepEqual(value.source,before.source);assert.deepEqual(await decodeSave(await encodeSave(value)),value);
});

test('ChapterRunner nonzero source mode preserves absence and atomically rejects a corrupt retained quantity',()=>{
  const world=new WorldStore(seed),runner=new ChapterRunner({world,data:story,say:async()=>{}}),draft=world.snapshot();
  draft.inventory=[instance(299)];const table={id:'M01050'},record={id:23,mutation_type:5,mutation_index:1,mutation_bit:299};
  runner.applyMutation(draft,table,record);assert.deepEqual(draft.inventory,[]);
  const before=copy(draft);runner.applyMutation(draft,table,{...record,mutation_index:99});assert.deepEqual(draft,before);
  draft.inventory=[instance(299)];draft.inventory[0].quantity=2;const corrupt=copy(draft);
  assert.throws(()=>runner.applyMutation(draft,table,record),/数量与原实例不同/);assert.deepEqual(draft,corrupt);
});
