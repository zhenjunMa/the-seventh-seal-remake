import {bytes, view} from '../content/native_bytes.mjs';

export function nativeMapMechanism(object, {linked = false} = {}) {
  const raw = bytes(object?.raw_hex, 0x112, '原地图机关');
  const fields = view(raw);
  const read = offset => fields.getUint32(offset, true);
  const target = read(0x4c), mapFlag = read(0xb6), keyId = read(0xf2);
  if (raw[0xcf] !== 2 || raw[0x98] > 1 || raw[0x109] || raw[0x51] || raw[0x53]
      || read(0xf6) || read(0xba) || read(0xe3) || read(0xe7)
      || raw.slice(0x54, 0x7c).some(Boolean)
      || target > 1000 || mapFlag >= 2000 || keyId > 416
      || (!linked && raw[0xe1])) {
    throw new Error('原地图机关类型或联动尚未接入');
  }
  return {keyId, reversible: raw[0x98] === 0, target: target ? {index: target - 1, mapFlag} : null};
}

// The native remote close writes state 5 before the target map is loaded.
// Project its closed pose immediately, as there is no live reverse animation.
export function restingMapMechanismState(state) {
  if (state === 1 || state === 5) return 0;
  if (state === 2 || state === 4) return 3;
  return state;
}
