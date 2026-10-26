// Equipped instances are mutable world state. The original initial equipment
// remains immutable provenance and supplies a fallback for legacy v1 saves.
import {configuredEquipmentHex} from './item_registry.mjs';
import {allPartyRoles} from './party_roster.mjs';
const copy = structuredClone;
const need = (ok, message) => { if (!ok) throw new Error(message); };
const bytes = raw => {
  need(typeof raw === 'string' && /^(?:[0-9a-f]{2}){229}$/.test(raw), '装备实例无效');
  return Uint8Array.from(raw.match(/../g), h => parseInt(h, 16));
};
const hex = b => Array.from(b, n => n.toString(16).padStart(2, '0')).join('');
export const ITEM_VALUE_PAIRS = [[0x0d,0x17e],[0x11,0x186],[0x15,0x18e],[0x19,0x196],
  [0x1d,0x19e],[0x21,0x1a6],[0x25,0x1ae],[0x29,0x1b6],[0x2d,0x1ce],
  [0x31,0x1ea],[0x35,0x1f2],[0x39,0x1fa],[0x3d,0x202],[0x41,0x20a],
  [0x45,0x212],[0x49,0x21a],[0x4d,0x222],[0x51,0x29a],[0x55,0x22a],
  [0x59,0x232],[0x5d,0x23a],[0x61,0x242], ...Array.from({length:10}, (_,i)=>[0x65+i*4,0x24a+i*8])];

export function withItemQuantity(item, quantity) {
  need(Number.isInteger(quantity) && quantity >= 0 && quantity <= 99, '道具数量无效');
  const b = bytes(item.source_raw_hex); new DataView(b.buffer).setUint32(4, quantity, true);
  return {...copy(item), quantity, source_raw_hex:hex(b)};
}

export function validateItemInstance(item, definition) {
  need(definition && item.id === definition.id && item.name === definition.name, '道具定义或名称不一致');
  const b = bytes(item.source_raw_hex), v = new DataView(b.buffer);
  need(v.getUint32(0, true) === item.id, '道具编号与实例不一致');
  need(Number.isInteger(item.quantity)&&item.quantity>=1&&item.quantity<=99&&v.getUint32(4,true)===item.quantity,'道具数量与原实例不一致');
  need(/^(?:[0-9a-f]{2}){959}$/.test(definition.raw_hex), '道具定义记录无效');
  const d = Uint8Array.from(definition.raw_hex.match(/../g), h=>parseInt(h,16)), dv = new DataView(d.buffer);
  need(dv.getUint32(0,true) === item.id && b[9] === d[0x176], '道具实例与来源不同');
  for (const [at, from] of ITEM_VALUE_PAIRS) {
    const n = v.getInt32(at,true), lo = dv.getInt32(from,true), hi = dv.getInt32(from+4,true);
    need(lo<hi?n>=lo&&n<hi:n===lo, '道具属性超出原定义范围');
  }
  return item;
}

export function validateEquipmentState(state, party) {
  need(state && state.version === 1 && Object.keys(state).every(k=>['version','roles'].includes(k))
    && state.roles && typeof state.roles === 'object' && !Array.isArray(state.roles), '装备存档版本无效');
  const seen = new Set();
  for (const [roleId, rows] of Object.entries(state.roles)) {
    need(party.some(r=>r.id===roleId) && Array.isArray(rows) && rows.length <= 10, '装备角色或部位无效');
    const slots = new Set();
    for (const row of rows) {
      need(row && Object.keys(row).every(k=>['instance_id','id','name','quantity','source_raw_hex','slot_id','source_definition','initialization_source'].includes(k))
        && typeof row.instance_id === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(row.instance_id)
        && !seen.has(row.instance_id) && typeof row.slot_id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(row.slot_id)
        && !slots.has(row.slot_id) && row.quantity === 1 && Number.isInteger(row.id) && row.id > 0
        && typeof row.name === 'string' && row.name.length <= 150, '装备实例或部位重复');
      const v = new DataView(bytes(row.source_raw_hex).buffer);
      need(v.getUint32(0,true) === row.id && v.getUint32(4,true) === 1, '装备原始编号或数量不一致');
      seen.add(row.instance_id); slots.add(row.slot_id);
    }
  }
  return copy(state);
}

export function equipmentRows(world, attributes, itemData, roleId) {
  const expected = attributes.initial_equipment.filter(row=>row.role_id===roleId);
  const retained = world.source.initial_equipment?.filter(row=>row.role_id===roleId);
  need(expected.length === 1 && Array.isArray(retained) && retained.length === expected.length, '新游戏初始装备来源缺失');
  for (let n=0;n<expected.length;n++) {
    const a=retained[n], b=expected[n];
    for (const k of ['role_id','group_index','entry_index','item_id','source_raw_hex','instance_sha256','native_storage_address'])
      need(a[k]===b[k], '当前装备实例与初始来源不同，换装尚未接入');
    need(a.definition_source?.path===b.definition_source.path && a.definition_source.sha256===b.definition_source.sha256
      && a.definition_source.record_offset===b.definition_source.record_offset, '初始装备定义来源不同');
  }
  if (world.equipment?.roles?.[roleId]) {
    need(itemData?.schema === 'seventh-seal-chapter-items', '当前装备定义缺失');
    return world.equipment.roles[roleId].map(row=> {
      const definition = itemData.definitions[String(row.id)];
      validateItemInstance(row, definition);
      need(definition.slot_id === row.slot_id, '装备部位与原定义不同');
      const mask = definition.allowed_role_mask_raw_13e;
      need(mask === 0 || (mask & (1 << (Number(roleId)-1))) !== 0, '角色不能装备此物品');
      return {role_id:roleId, item_id:row.id, source_raw_hex:row.source_raw_hex,
        effective_raw_hex:configuredEquipmentHex(row.source_raw_hex,definition),slot_id:row.slot_id,
        group_index:definition.group_index,entry_index:0};
    });
  }
  return retained.map(row=>({...copy(row),effective_raw_hex:configuredEquipmentHex(row.source_raw_hex,itemData?.definitions[String(row.item_id)])}));
}

export function migrateEquipment(draft, attributes, itemData) {
  need(draft.source.kind === 'native-new-game', '当前样本不支持换装');
  draft.equipment ??= {version:1,roles:{}};
  for (const role of draft.party) {
    if (draft.equipment.roles[role.id]) continue;
    draft.equipment.roles[role.id] = equipmentRows(draft, attributes, itemData, role.id).map(row=> {
      const def = itemData.definitions[String(row.item_id)]; need(def?.slot_id, '初始装备部位来源缺失');
      return withItemQuantity({instance_id:`initial:${role.id}:${row.group_index}:${row.entry_index}`,
        id:row.item_id,name:def.name,source_raw_hex:row.source_raw_hex,slot_id:def.slot_id},1);
    });
  }
  validateEquipmentState(draft.equipment, allPartyRoles(draft));
  return draft.equipment;
}
