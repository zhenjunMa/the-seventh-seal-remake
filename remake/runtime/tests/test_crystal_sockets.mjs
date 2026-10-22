import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {WorldStore} from '../web/core/world.mjs';
import {createPartyActors} from '../web/core/party_attributes.mjs';
import {changeEquipment} from '../web/core/items.mjs';
import {migrateEquipment, withItemQuantity} from '../web/core/equipment.mjs';
import {isCrystalDefinition, isSupportedCrystalDefinition, validateCrystalSocketState,
  validateCrystalSocketDefinitions, crystalSocketCandidates, crystalSocketCount, crystalSocketRows,
  socketEquipmentRows, insertCrystal, removeCrystal} from '../web/core/crystal_sockets.mjs';

const load = name => JSON.parse(readFileSync(new URL(`../web/data/${name}.json`, import.meta.url)));
const source = load('items'), attributes = load('party_combat'), seed = load('opening_seed');
const copy = structuredClone;
const catalog = () => {
  const data = copy(source);
  for (const def of Object.values(data.definitions)) if (isCrystalDefinition(def))
    def.runtime_enabled = isSupportedCrystalDefinition(def);
  return data;
};
const instance = (id, quantity = 1, instanceId = `fixture:${id}`, data = source) => {
  const def = data.definitions[String(id)];
  assert.ok(def.initialized_raw_hex, `fixture ${id} requires a deterministic source instance`);
  return withItemQuantity({instance_id:instanceId, id, name:def.name, source_raw_hex:def.initialized_raw_hex}, quantity);
};
// This adapter exercises the isolated module before the host's optional world
// extension is connected. It enforces structural socket identity on every commit.
class AtomicStore {
  constructor(value) { this.value = copy(value); }
  snapshot() { return copy(this.value); }
  transact(change) {
    const next = this.snapshot(); change(next); next.revision++;
    if (next.crystal_sockets) validateCrystalSocketState(next.crystal_sockets, next.party,
      [...next.inventory, ...Object.values(next.equipment?.roles ?? {}).flat()].map(row => row.instance_id));
    this.value = next; return this.snapshot();
  }
}
const setup = (rows = [instance(156, 3)], Store = AtomicStore) => {
  const world = copy(seed); world.inventory = copy(rows);
  return {worldStore:new Store(world), attributes, itemData:catalog(), roleId:'001', socketIndex:1};
};

test('catalog support is the proven 21 stat-only crystals, with immutable ITM source bytes', () => {
  assert.deepEqual(Object.values(source.definitions).filter(isSupportedCrystalDefinition).map(d => d.id),
    [7,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,201,204,206]);
  assert.equal(Object.values(source.definitions).filter(isCrystalDefinition).length, 66);
  const bytes = readFileSync(new URL('../../../SYSTEM/Object.ITM', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.source_hashes['SYSTEM/Object.ITM']);
  const ruby = source.definitions['156'];
  assert.equal(bytes.subarray(ruby.source.record_offset, ruby.source.record_offset + 959).toString('hex'), ruby.raw_hex);
});

test('new game exposes four original holes and admits crystals in physical inventory order', () => {
  const o = setup([instance(157), instance(2), instance(156), instance(162)]);
  assert.equal(crystalSocketCount(o.worldStore.value, attributes, o.itemData, '001'), 4);
  assert.deepEqual(crystalSocketRows(o.worldStore.value, attributes, o.itemData, '001').map(row => row.visible), [true,true,true,true,false,false]);
  assert.deepEqual(crystalSocketCandidates(o.worldStore.value.inventory, o.itemData).map(row => row.id), [157,156]);
  assert.deepEqual(crystalSocketCandidates(o.worldStore.value.inventory, o.itemData, {includeDisabled:true}).map(row => row.id), [157,156,162]);
  o.itemData.definitions['156'].allowed_role_mask_raw_13e = 2;
  insertCrystal({...o, instanceId:'fixture:156'}); // Role masks apply to type2 gear only.
});

test('insert copies all229 bytes and source quantity while consuming exactly one', () => {
  const o = setup(), before = o.worldStore.snapshot(), selected = before.inventory[0];
  const result = insertCrystal({...o, instanceId:selected.instance_id});
  const row = o.worldStore.value.crystal_sockets.roles['001'][0];
  assert.equal(row.source_raw_hex, selected.source_raw_hex);
  assert.equal(row.quantity, 3); assert.equal(result.installed.quantity, 3);
  assert.equal(o.worldStore.value.inventory[0].quantity, 2);
  assert.notEqual(row.instance_id, selected.instance_id);
  assert.deepEqual(o.worldStore.value.party, before.party);
  const links = socketEquipmentRows(o.worldStore.value, attributes, o.itemData, '001');
  assert.equal(links.length, 1); assert.equal(links[0].entry_index, 1);
  assert.equal(Buffer.from(links[0].source_raw_hex,'hex').readInt32LE(0x65), 30);
  assert.equal(Buffer.from(links[0].source_raw_hex,'hex').readInt32LE(0x69), -10);
});

test('replacement returns one old crystal and preserves the new source record', () => {
  const o = setup([instance(156,3), instance(157,2)]);
  insertCrystal({...o, instanceId:'fixture:156'});
  const selected = copy(o.worldStore.value.inventory.find(row => row.id === 157));
  const result = insertCrystal({...o, instanceId:'fixture:157'});
  assert.equal(result.returned.id, 156);
  assert.deepEqual(o.worldStore.value.inventory.map(row => [row.id,row.quantity]), [[156,3],[157,1]]);
  assert.equal(o.worldStore.value.crystal_sockets.roles['001'][0].source_raw_hex, selected.source_raw_hex);
});

test('same-ID replacement follows native return-before-consume without multiplying socket quantity', () => {
  const o = setup(); insertCrystal({...o,instanceId:'fixture:156'});
  const before = o.worldStore.value.inventory[0].quantity;
  insertCrystal({...o,instanceId:'fixture:156'});
  assert.equal(o.worldStore.value.inventory[0].quantity, before);
  assert.equal(socketEquipmentRows(o.worldStore.value, attributes, o.itemData, '001').length, 1);
});

test('unequip returns one unit, clears the slot, and an empty slot is a no-op', () => {
  const o = setup([instance(156)]), resources = copy(o.worldStore.value.party);
  insertCrystal({...o, instanceId:'fixture:156'});
  assert.equal(o.worldStore.value.inventory.length, 0);
  removeCrystal(o);
  assert.equal(o.worldStore.value.inventory[0].quantity, 1);
  assert.equal(o.worldStore.value.crystal_sockets.roles['001'][0], null);
  assert.equal(socketEquipmentRows(o.worldStore.value, attributes, o.itemData, '001').length, 0);
  assert.deepEqual(o.worldStore.value.party, resources);
  const revision = o.worldStore.value.revision; removeCrystal(o);
  assert.equal(o.worldStore.value.revision, revision);
});

test('native first same-ID record is consumed even when a later instance is selected', () => {
  const o = setup([instance(156,2,'earlier'), instance(156,4,'selected')]);
  insertCrystal({...o,instanceId:'selected'});
  assert.deepEqual(o.worldStore.value.inventory.map(row => row.quantity), [1,4]);
  assert.equal(o.worldStore.value.crystal_sockets.roles['001'][0].quantity, 4);
});

test('disabled configuration blocks new insertion but retains saved state, links, and removal', () => {
  const o = setup(); insertCrystal({...o,instanceId:'fixture:156'});
  o.itemData.definitions['156'].runtime_enabled = false;
  const restored = JSON.parse(JSON.stringify(o.worldStore.snapshot()));
  validateCrystalSocketState(restored.crystal_sockets, restored.party);
  validateCrystalSocketDefinitions(restored.crystal_sockets, o.itemData);
  assert.equal(socketEquipmentRows(restored, attributes, o.itemData, '001').length, 1);
  const before = o.worldStore.snapshot();
  assert.throws(() => insertCrystal({...o,instanceId:'fixture:156'}), /配置禁用/);
  assert.deepEqual(o.worldStore.snapshot(), before);
  removeCrystal(o); assert.equal(o.worldStore.value.inventory[0].quantity, 3);
});

test('configuration adjusts a linked calculation copy without rewriting original saved rolls', () => {
  const o = setup(); insertCrystal({...o,instanceId:'fixture:156'});
  const def = o.itemData.definitions['156'], raw = o.worldStore.value.crystal_sockets.roles['001'][0].source_raw_hex;
  // configuredEquipmentHex accepts the unified public attribute names.
  const names = ['hp_current_flat','hp_maximum_flat','mp_current_flat','mp_maximum_flat','attack_flat','defense_flat',
    'term3_flat','speed_flat','term4_flat','hp_percent','mp_percent','attack_percent','defense_percent','term3_percent',
    'speed_percent','term4_percent','native_55','native_59','native_5d','native_61', ...Array.from({length:6},(_,i)=>`element_${i}`)];
  const offsets = [13,17,21,25,29,33,37,41,45,53,61,65,69,73,77,81,85,89,93,97,101,105,109,113,117,121];
  def.runtime_attributes = Object.fromEntries(names.map((name,i) => {
    const row = def.value_ranges.find(row => row.instance_offset === offsets[i]);
    return [name,{minimum:row.minimum,maximum_exclusive:row.maximum}];
  }));
  def.runtime_attributes.element_0 = {minimum:60,maximum_exclusive:60};
  const [linked] = socketEquipmentRows(o.worldStore.value, attributes, o.itemData, '001');
  assert.equal(Buffer.from(linked.effective_raw_hex,'hex').readInt32LE(0x65), 60);
  assert.equal(linked.source_raw_hex, raw);
  assert.equal(o.worldStore.value.crystal_sockets.roles['001'][0].source_raw_hex, raw);
});

test('invalid holes, stale revisions, unsupported passives and tampered instances are atomic', () => {
  const o = setup([instance(156), instance(162)]), before = o.worldStore.snapshot();
  for (const attempt of [
    {...o,socketIndex:0,instanceId:'fixture:156'}, {...o,socketIndex:5,instanceId:'fixture:156'},
    {...o,expectedRevision:999,instanceId:'fixture:156'}, {...o,instanceId:'fixture:162'},
  ]) assert.throws(() => insertCrystal(attempt));
  assert.deepEqual(o.worldStore.snapshot(), before);
  o.worldStore.value.inventory[0].source_raw_hex = o.worldStore.value.inventory[0].source_raw_hex.slice(0,0x65*2)
    + '1f000000' + o.worldStore.value.inventory[0].source_raw_hex.slice(0x69*2);
  assert.throws(() => insertCrystal({...o,instanceId:'fixture:156'}), /属性超出/);
});

test('full inventory and saturated native stacks reject loss without changing any save bytes', () => {
  const o = setup([instance(156)]); insertCrystal({...o,instanceId:'fixture:156'});
  o.worldStore.value.inventory = Array.from({length:1000}, (_,i) => instance(157,1,`full:${i}`));
  const full = o.worldStore.snapshot(); assert.throws(() => removeCrystal(o), /背包已满/);
  assert.deepEqual(o.worldStore.snapshot(), full);
  o.worldStore.value.inventory = [instance(156,99)];
  const saturated = o.worldStore.snapshot(); assert.throws(() => removeCrystal(o), /堆叠已满/);
  assert.deepEqual(o.worldStore.snapshot(), saturated);
  assert.throws(() => insertCrystal({...o,instanceId:'fixture:156'}), /堆叠已满/);
  assert.deepEqual(o.worldStore.snapshot(), saturated);
});

test('socket state rejects duplicate identities and definition mismatches but permits retained hidden holes', () => {
  const o = setup(); insertCrystal({...o,instanceId:'fixture:156'});
  const state = copy(o.worldStore.value.crystal_sockets);
  state.roles['001'][5] = {...copy(state.roles['001'][0]),instance_id:'hidden'};
  validateCrystalSocketState(state, o.worldStore.value.party);
  o.worldStore.value.crystal_sockets = state;
  assert.equal(socketEquipmentRows(o.worldStore.value, attributes, o.itemData, '001').length, 2);
  assert.equal(crystalSocketRows(o.worldStore.value, attributes, o.itemData, '001',{visibleOnly:true}).length, 4);
  state.roles['001'][5].instance_id = state.roles['001'][0].instance_id;
  assert.throws(() => validateCrystalSocketState(state, o.worldStore.value.party), /重复/);
  state.roles['001'][5] = instance(2,1,'not-crystal');
  assert.throws(() => validateCrystalSocketDefinitions(state, o.itemData), /不是原版晶石/);
});

test('weapon removal retains actor sockets, excludes links, and prevents hidden socket edits', () => {
  const o = setup(); insertCrystal({...o,instanceId:'fixture:156'});
  migrateEquipment(o.worldStore.value, attributes, o.itemData);
  o.worldStore.value.equipment.roles['001'] = [];
  assert.equal(crystalSocketCount(o.worldStore.value, attributes, o.itemData, '001'), 0);
  assert.equal(socketEquipmentRows(o.worldStore.value, attributes, o.itemData, '001').length, 0);
  assert.equal(o.worldStore.value.crystal_sockets.roles['001'][0].id, 156);
  assert.throws(() => removeCrystal(o), /没有此孔位/);
});

test('host WorldStore persists installed crystal records and validates duplicate inventory ownership', () => {
  const o = setup([instance(156,2)], WorldStore);
  insertCrystal({...o,instanceId:'fixture:156'});
  const restored = new WorldStore(JSON.parse(JSON.stringify(o.worldStore.snapshot())));
  assert.deepEqual(restored.value.crystal_sockets, o.worldStore.value.crystal_sockets);
  const duplicate = restored.snapshot(); duplicate.inventory.push(copy(duplicate.crystal_sockets.roles['001'][0]));
  assert.throws(() => new WorldStore(duplicate));
});

test('linked actor adds ruby attributes once and percentage crystals use raw maxima without refilling resources', () => {
  const o = setup([instance(156,3),instance(201)], WorldStore), before = copy(o.worldStore.value.party);
  const baseline = createPartyActors(o.worldStore.snapshot(),attributes,{},o.itemData)[0];
  insertCrystal({...o,instanceId:'fixture:156'});
  const ruby = createPartyActors(o.worldStore.snapshot(),attributes,{},o.itemData)[0];
  assert.equal(baseline.linked_by_address['0x04f990e0'],110);
  assert.equal(ruby.linked_by_address['0x04f990e0'],140);
  assert.equal(ruby.linked_by_address['0x04f990e4'],baseline.linked_by_address['0x04f990e4']-10);
  insertCrystal({...o,socketIndex:2,instanceId:'fixture:201'});
  const actor = createPartyActors(o.worldStore.snapshot(),attributes,{},o.itemData)[0];
  // Weapon10% + crystal20% =30%, applied to raw880/66, with native truncation.
  assert.deepEqual(actor.hp,{current:1144,maximum:1144});
  assert.deepEqual(actor.mp,{current:85,maximum:85});
  assert.deepEqual(o.worldStore.value.party,before);
  const restored = new WorldStore(JSON.parse(JSON.stringify(o.worldStore.snapshot())));
  assert.deepEqual(createPartyActors(restored.snapshot(),attributes,{},o.itemData)[0].linked_by_address,actor.linked_by_address);
  removeCrystal({...o,socketIndex:2});
  assert.deepEqual(createPartyActors(o.worldStore.snapshot(),attributes,{},o.itemData)[0].hp,baseline.hp);
  assert.deepEqual(o.worldStore.value.party,before);
});

test('native actor-owned crystal survives a weapon change to fewer holes and keeps its linked attribute', () => {
  const o = setup([instance(259,1),instance(156,2)], WorldStore);
  // Actual source weapon259 has6 holes, original weapon1 has4; both fit role001.
  changeEquipment(o.worldStore,attributes,o.itemData,{roleId:'001',slotId:'weapon',instanceId:'fixture:259'});
  insertCrystal({...o,socketIndex:6,instanceId:'fixture:156'});
  const saved = copy(o.worldStore.value.crystal_sockets);
  const original = o.worldStore.value.inventory.find(row => row.id === 1);
  changeEquipment(o.worldStore,attributes,o.itemData,{roleId:'001',slotId:'weapon',instanceId:original.instance_id});
  assert.equal(crystalSocketCount(o.worldStore.value,attributes,o.itemData,'001'),4);
  assert.deepEqual(o.worldStore.value.crystal_sockets,saved);
  assert.equal(crystalSocketRows(o.worldStore.value,attributes,o.itemData,'001')[5].visible,false);
  assert.equal(socketEquipmentRows(o.worldStore.value,attributes,o.itemData,'001')[0].entry_index,6);
  const actor = createPartyActors(o.worldStore.snapshot(),attributes,{},o.itemData)[0];
  const equipped = o.worldStore.snapshot(); delete equipped.crystal_sockets;
  const plain = createPartyActors(equipped,attributes,{},o.itemData)[0];
  assert.equal(actor.linked_by_address['0x04f990e0'],plain.linked_by_address['0x04f990e0']+30);
});
