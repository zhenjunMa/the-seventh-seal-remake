// Native category0 entry0 is the weapon; entries1..6 are actor-owned crystals.
// 47C250 copies the full 229-byte selected record, including its stack count;
// only one crystal is consumed/returned. The stored count is not a multiplier.
import {equipmentRows, validateItemInstance, withItemQuantity} from './equipment.mjs';
import {configuredEquipmentHex} from './item_registry.mjs';
import {isCrystalDefinition, isSupportedCrystalDefinition} from './crystal_catalog.mjs';
export {isCrystalDefinition, isSupportedCrystalDefinition} from './crystal_catalog.mjs';

export const CRYSTAL_SOCKET_COUNT = 6;
const copy = structuredClone;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const need = (ok, message) => { if (!ok) throw new Error(message); };
const key = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(v)
  && !['__proto__', 'constructor', 'prototype'].includes(v);
const bytes = raw => {
  need(/^(?:[0-9a-f]{2}){229}$/.test(raw ?? ''), '晶石原始实例无效');
  return Uint8Array.from(raw.match(/../g), h => parseInt(h, 16));
};
const slotsFor = (world, roleId) => world.crystal_sockets?.roles?.[roleId] ?? Array(6).fill(null);
const definitionFor = (data, row) => data?.definitions?.[String(row.id)];

// Saved state remains valid after a configuration disables a crystal. Definition
// provenance and the runtime-enabled admission gate are deliberately separate.
export function validateCrystalSocketState(state, party, occupiedInstanceIds = []) {
  need(object(state) && state.version === 1 && Object.keys(state).every(k => ['version','roles'].includes(k))
    && object(state.roles), '晶石孔位存档版本无效');
  const seen = new Set(occupiedInstanceIds);
  for (const [roleId, slots] of Object.entries(state.roles)) {
    need(party.some(role => role.id === roleId) && Array.isArray(slots) && slots.length === 6, '晶石角色或孔位无效');
    for (const row of slots) {
      if (row === null) continue;
      need(object(row) && Object.keys(row).every(k => ['instance_id','id','name','quantity','source_raw_hex',
        'source_definition','initialization_source'].includes(k)) && key(row.instance_id) && !seen.has(row.instance_id)
        && Number.isInteger(row.id) && row.id > 0 && row.id <= 0xffffffff
        && typeof row.name === 'string' && row.name.length <= 150
        && Number.isInteger(row.quantity) && row.quantity >= 1 && row.quantity <= 99, '晶石实例无效或重复');
      const v = new DataView(bytes(row.source_raw_hex).buffer);
      need(v.getUint32(0, true) === row.id && v.getUint32(4, true) === row.quantity, '晶石原始编号或数量不一致');
      seen.add(row.instance_id);
    }
  }
  return copy(state);
}

export function validateCrystalSocketDefinitions(state, itemData) {
  for (const slots of Object.values(state?.roles ?? {})) for (const row of slots) {
    if (!row) continue;
    const def = definitionFor(itemData, row);
    need(isCrystalDefinition(def), '孔位中不是原版晶石');
    validateItemInstance(row, def);
  }
  return state;
}

export function canSocketCrystal(definition) {
  return isSupportedCrystalDefinition(definition)
    && (definition.runtime_enabled ?? definition.availability?.enabled ?? false) === true;
}

export function crystalSocketCandidates(inventory, itemData, {includeDisabled = false} = {}) {
  return inventory.filter(row => row.id !== 0 && row.quantity > 0
    && (includeDisabled ? isCrystalDefinition(definitionFor(itemData, row)) : canSocketCrystal(definitionFor(itemData, row))))
    .map(row => ({...copy(row), socket_enabled:canSocketCrystal(definitionFor(itemData, row))}));
}

export function crystalSocketCount(world, attributes, itemData, roleId) {
  need(world.party.some(role => role.id === roleId), '角色不在队伍中');
  const weapon = equipmentRows(world, attributes, itemData, roleId).find(row => {
    const def = itemData?.definitions?.[String(row.item_id)];
    return def?.type_raw_24 === 1;
  });
  if (!weapon) return 0;
  const def = itemData.definitions[String(weapon.item_id)];
  need(/^(?:[0-9a-f]{2}){959}$/.test(def.raw_hex ?? ''), '法器定义无效');
  const count = parseInt(def.raw_hex.slice(0x155 * 2, 0x156 * 2), 16);
  need(count <= 6, '法器孔数超出原界面范围');
  return count;
}

export function crystalSocketRows(world, attributes, itemData, roleId, {visibleOnly = false} = {}) {
  if (world.crystal_sockets) {
    validateCrystalSocketState(world.crystal_sockets, world.party);
    validateCrystalSocketDefinitions(world.crystal_sockets, itemData);
  }
  const count = crystalSocketCount(world, attributes, itemData, roleId);
  return slotsFor(world, roleId).slice(0, visibleOnly ? count : 6).map((row, i) => ({socket_index:i + 1,
    visible:i < count, logical_quantity:row ? 1 : 0, item:row ? copy(row) : null}));
}

export function socketEquipmentRows(world, attributes, itemData, roleId) {
  if (!slotsFor(world, roleId).some(Boolean)) return [];
  need(itemData?.schema === 'seventh-seal-chapter-items', '已镶嵌晶石的原始定义缺失');
  // 47CC30 skips the entire category when entry0 is empty. When entry0 exists,
  // every retained crystal contributes, including sockets hidden by a new weapon.
  const weapon = equipmentRows(world, attributes, itemData, roleId).some(row =>
    itemData?.definitions?.[String(row.item_id)]?.type_raw_24 === 1);
  if (!weapon) return [];
  return crystalSocketRows(world, attributes, itemData, roleId).filter(row => row.item).map(({socket_index, item}) => ({
    role_id:roleId, item_id:item.id, source_raw_hex:item.source_raw_hex,
    effective_raw_hex:configuredEquipmentHex(item.source_raw_hex, definitionFor(itemData, item)),
    group_index:0, entry_index:socket_index, socket_index, instance_id:item.instance_id,
  }));
}

export function migrateCrystalSockets(draft) {
  need(draft.source.kind === 'native-new-game', '当前样本未提供晶石孔位来源');
  draft.crystal_sockets ??= {version:1, roles:{}};
  for (const role of draft.party) draft.crystal_sockets.roles[role.id] ??= Array(6).fill(null);
  validateCrystalSocketState(draft.crystal_sockets, draft.party);
  return draft.crystal_sockets;
}

function occupiedIds(world) {
  return [...world.inventory.map(row => row.instance_id),
    ...Object.values(world.equipment?.roles ?? {}).flat().map(row => row.instance_id)];
}
function freshId(world, base) {
  const seen = new Set([...occupiedIds(world), ...Object.values(world.crystal_sockets?.roles ?? {}).flat()
    .filter(Boolean).map(row => row.instance_id)]);
  let n = 0, id = base;
  while (seen.has(id)) id = `${base}:${++n}`;
  return id;
}
function returnCrystal(inventory, item, itemData) {
  const value = withItemQuantity(item, 1), stackable = bytes(value.source_raw_hex)[0x0c] === 0;
  const target = stackable ? inventory.find(row => row.id === 0 || row.id === item.id && bytes(row.source_raw_hex)[0x0c] === 0) : null;
  if (target?.id === item.id) {
    validateItemInstance(target, definitionFor(itemData, target));
    // Native 47BDC0 silently clamps to99; the atomic remake rejects item loss.
    need(target.quantity < 99, '晶石堆叠已满，无法退回旧晶石');
    inventory[inventory.indexOf(target)] = withItemQuantity(target, target.quantity + 1);
  } else if (target) inventory[inventory.indexOf(target)] = {...value, instance_id:target.instance_id};
  else {
    need(inventory.length < 1000, '背包已满，无法退回旧晶石');
    inventory.push(value);
  }
}
function consumeFirstMatchingId(inventory, id, itemData) {
  // 47C8E0(-1,id) consumes the first same-ID record, while the copied socket
  // payload comes from the selected record. This preserves the original order.
  const i = inventory.findIndex(row => row.id === id), row = inventory[i];
  need(row && row.quantity > 0, '晶石数量不足');
  validateItemInstance(row, definitionFor(itemData, row));
  if (row.quantity === 1) inventory.splice(i, 1);
  else inventory[i] = withItemQuantity(row, row.quantity - 1);
}
function preflight({worldStore, attributes, itemData, roleId, socketIndex, expectedRevision = worldStore.value.revision}) {
  need(worldStore.value.revision === expectedRevision, '操作期间进度已变化');
  need(Number.isInteger(socketIndex) && socketIndex >= 1
    && socketIndex <= crystalSocketCount(worldStore.value, attributes, itemData, roleId), '当前法器没有此孔位');
  if (worldStore.value.crystal_sockets) {
    validateCrystalSocketState(worldStore.value.crystal_sockets, worldStore.value.party, occupiedIds(worldStore.value));
    validateCrystalSocketDefinitions(worldStore.value.crystal_sockets, itemData);
  }
}

export function insertCrystal(options) {
  preflight(options);
  const {worldStore, attributes, itemData, roleId, socketIndex, instanceId} = options;
  const selected = worldStore.value.inventory.find(row => row.instance_id === instanceId);
  need(selected && selected.quantity > 0, '晶石数量不足');
  const def = definitionFor(itemData, selected);
  need(canSocketCrystal(def), '此晶石作用未还原或被配置禁用');
  validateItemInstance(selected, def);
  let returned = null, installed = null;
  worldStore.transact(draft => {
    const slots = migrateCrystalSockets(draft).roles[roleId];
    returned = slots[socketIndex - 1] ? copy(slots[socketIndex - 1]) : null;
    installed = {...copy(selected), instance_id:freshId(draft, `crystal:${roleId}:${socketIndex}:${draft.revision}`)};
    // Native copy precedes return; same-ID return may change the source stack.
    if (returned) returnCrystal(draft.inventory, returned, itemData);
    consumeFirstMatchingId(draft.inventory, selected.id, itemData);
    slots[socketIndex - 1] = installed;
    validateCrystalSocketState(draft.crystal_sockets, draft.party, occupiedIds(draft));
    validateCrystalSocketDefinitions(draft.crystal_sockets, itemData);
    socketEquipmentRows(draft, attributes, itemData, roleId);
  });
  return {role_id:roleId, socket_index:socketIndex, installed:copy(installed), returned,
    world_revision:worldStore.value.revision};
}

export function removeCrystal(options) {
  preflight(options);
  const {worldStore, attributes, itemData, roleId, socketIndex} = options;
  const old = slotsFor(worldStore.value, roleId)[socketIndex - 1];
  // Native 47C760 does nothing for an empty socket; don't mutate save revision.
  if (!old) return {role_id:roleId, socket_index:socketIndex, removed:null, world_revision:worldStore.value.revision};
  worldStore.transact(draft => {
    const slots = migrateCrystalSockets(draft).roles[roleId];
    returnCrystal(draft.inventory, old, itemData);
    slots[socketIndex - 1] = null;
    validateCrystalSocketState(draft.crystal_sockets, draft.party, occupiedIds(draft));
    socketEquipmentRows(draft, attributes, itemData, roleId);
  });
  return {role_id:roleId, socket_index:socketIndex, removed:copy(old), world_revision:worldStore.value.revision};
}
