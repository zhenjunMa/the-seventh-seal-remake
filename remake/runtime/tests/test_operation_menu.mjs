import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {operationStatus,operationItemCard,operationWeaponDetails} from '../web/core/operation_menu.mjs';
const load=name=>JSON.parse(readFileSync(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const world=JSON.parse(JSON.parse(readFileSync(new URL('../evidence/chapter_systems_home_save.json',import.meta.url),'utf8')).payload);
const attributes=load('party_combat'),items=load('items'),manifest=load('operation_menu');
test('operation status reads stored progress and equipment without mutating world; NEXT is remaining EXP',()=>{
  const before=JSON.stringify(world),status=operationStatus(world,attributes,items,'001');
  assert.equal(status.experience,5950);assert.equal(status.nextLevelExperience,1500);
  assert.deepEqual([status.attack,status.defense,status.speed],[57,42,71]);
  assert.deepEqual(status.elements,[285,0,50,0,0,0]);assert.equal(JSON.stringify(world),before);
});
test('item cards bind native category and one-based definition frame, without a fallback bank',()=>{
  const tea=operationItemCard(items.definitions['12'],manifest);
  assert.equal(tea.image,'assets/menu/cards/_item/frame_002.png');
  const crown=operationItemCard(items.definitions['51'],manifest);
  assert.equal(crown.image,'assets/menu/cards/_equip/frame_024.png');
  const unsupported={...items.definitions['12'],type_raw_24:99};assert.equal(operationItemCard(unsupported,manifest),null);
  const zero={...items.definitions['12'],raw_hex:items.definitions['12'].raw_hex.slice(0,64)+'00000000'+items.definitions['12'].raw_hex.slice(72)};
  assert.equal(operationItemCard(zero,manifest),null);
});

test('weapon detail keeps six actor socket records while reporting the original weapon visible count',()=>{
  const before=JSON.stringify(world),details=operationWeaponDetails(world,attributes,items,'001');
  assert.equal(details.weapon.id,1);assert.equal(details.socketCount,4);assert.deepEqual(details.sockets,Array(6).fill(null));
  assert.deepEqual([details.status.attack,details.status.defense,details.status.speed],[57,42,71]);
  assert.equal(operationItemCard(details.weapon.definition,manifest).image,'assets/menu/cards/_arms/frame_000.png');
  const kai=operationWeaponDetails(world,attributes,items,'002');assert.equal(kai.weapon.id,10);assert.equal(kai.socketCount,3);
  assert.deepEqual(kai.sockets,Array(6).fill(null));
  assert.equal(JSON.stringify(world),before);
});
