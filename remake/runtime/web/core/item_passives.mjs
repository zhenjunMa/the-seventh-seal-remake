// 4451C0 -> 47A6A0 copies each equipped ITM +2A8 C6 block into 508BB0.
// This bounded capability admits mode6 immunity only. Mode6 never ticks or
// displays its status sprite; periodic payloads in that mode stay dormant.
const bytes = hex => typeof hex === 'string' && /^(?:[0-9a-f]{2}){959}$/.test(hex)
  ? Uint8Array.from(hex.match(/../g), h => parseInt(h, 16)) : null;
const hex = raw => Array.from(raw, b => b.toString(16).padStart(2, '0')).join('');

export function supportsEquipmentImmunitySource(definition) {
  const raw = bytes(definition?.raw_hex);
  if (!raw || ![1,2,3].includes(raw[0x24]) || raw[0x24] === 3 && raw[0x25] !== 1) return false;
  const block = raw.slice(0x2a8, 0x36e), view = new DataView(block.buffer);
  return definition.initialization?.deterministic === true
    && definition.validation?.all_value_ranges_ordered === true
    && block[1] !== 0 && block[0xb] === 6 && block[0x10] <= 1
    && view.getInt32(2, true) === -1 && view.getUint32(0xb8, true) === 0
    && (block[0x10] === 1 || !block.slice(0x23, 0xb8).some(Boolean))
    && !raw.slice(0x126, 0x13a).some(Boolean)
    && new DataView(raw.buffer).getInt32(0x142, true) === 0
    && new DataView(raw.buffer).getInt32(0x3a7, true) === 0;
}

export function isSupportedItemPassiveDefinition(definition) {
  const passive = definition?.equipment_passive;
  if (!supportsEquipmentImmunitySource(definition) || passive?.kind !== 'status-immunity' || passive.mode_raw !== 6) return false;
  const block = bytes(definition.raw_hex).slice(0x2a8, 0x36e);
  return passive.effect_id_raw === block[1] && passive.effect_raw_hex === hex(block)
    && passive.definition_offset === 0x2a8 && passive.effect_bytes === 0xc6;
}

export function hasEquipmentPassiveSource(definition) {
  const raw=bytes(definition?.raw_hex);
  return Boolean(raw&&raw[0x2a9]!==0);
}

export function equipmentPassiveRows(entries, itemData) {
  const result = [];
  for (const row of entries) {
    const definition = itemData?.definitions?.[String(row.item_id)];
    if (!definition) continue; // Legacy initial gear has no active C6 payload.
    const raw = bytes(definition.raw_hex);
    if (!raw || raw[0x2a9] === 0) continue;
    if (!definition.equipment_passive && definition.behavior?.kind==='equip'
      && definition.availability?.enabled===true
      && !definition.behavior.implemented_scope?.includes('battle-mode6-status-immunity')) {
      // Historical admitted gear (such as the original chapter's crown) has
      // a numeric equip/link contract only. Projecting a saved actor must not
      // silently add an unrecovered passive or a new battle-entry RNG draw.
      continue;
    }
    if (!isSupportedItemPassiveDefinition(definition)) throw new TypeError('装备被动作用尚未还原');
    result.push({item_id:row.item_id, group_index:row.group_index ?? definition.group_index,
      entry_index:row.entry_index ?? 0, ...structuredClone(definition.equipment_passive),
      source:structuredClone(definition.source)});
  }
  return result.sort((a,b) => a.group_index - b.group_index || a.entry_index - b.entry_index);
}
