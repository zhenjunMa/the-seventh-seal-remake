// Bounded socket support is derived from immutable Object.ITM fields, not IDs.
import {isSupportedItemPassiveDefinition} from './item_passives.mjs';
export function isCrystalDefinition(definition) {
  return definition?.type_raw_24 === 3 && definition?.subtype_raw_25 === 1;
}

export function isSupportedCrystalDefinition(definition) {
  if (!isCrystalDefinition(definition) || !/^(?:[0-9a-f]{2}){959}$/.test(definition.raw_hex ?? '')) return false;
  const b = Uint8Array.from(definition.raw_hex.match(/../g), h => parseInt(h, 16));
  if (b[0x24] !== 3 || b[0x25] !== 1) return false;
  // 0x47B3C0 copies +0x1CE as term4; surrounding bytes are not implemented.
  if (b.slice(0x1be, 0x1ce).some(Boolean) || b.slice(0x1d6, 0x1ea).some(Boolean)
      || b.slice(0x2a8).some(Boolean) && !isSupportedItemPassiveDefinition(definition)) return false;
  const known = new Set([0x0d,0x11,0x15,0x19,0x1d,0x21,0x25,0x29,0x2d,
    0x35,0x3d,0x41,0x45,0x49,0x4d,0x51,0x55,0x59,0x5d,0x61,
    0x65,0x69,0x6d,0x71,0x75,0x79]);
  return Array.isArray(definition.value_ranges) && definition.value_ranges.length === 32
    && definition.value_ranges.every(row => Number.isInteger(row.minimum) && Number.isInteger(row.maximum)
      && row.minimum <= row.maximum && (known.has(row.instance_offset) || row.minimum === 0 && row.maximum === 0));
}
