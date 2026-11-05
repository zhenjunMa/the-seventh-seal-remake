// 原版剧情奖励的实例初始化；保留原缓冲区填充值、字段映射与随机调用顺序。
import {bytes, view} from '../content/native_bytes.mjs';
const need = (ok, message) => {
  if (!ok) throw new Error(message);
};
const VALUE_PAIRS = [
  [0x0d, 0x17e],
  [0x11, 0x186],
  [0x15, 0x18e],
  [0x19, 0x196],
  [0x1d, 0x19e],
  [0x21, 0x1a6],
  [0x25, 0x1ae],
  [0x29, 0x1b6],
  [0x2d, 0x1ce],
  [0x31, 0x1ea],
  [0x35, 0x1f2],
  [0x39, 0x1fa],
  [0x3d, 0x202],
  [0x41, 0x20a],
  [0x45, 0x212],
  [0x49, 0x21a],
  [0x4d, 0x222],
  [0x51, 0x29a],
  [0x55, 0x22a],
  [0x59, 0x232],
  [0x5d, 0x23a],
  [0x61, 0x242],
  ...Array.from({length: 10}, (_, i) => [0x65 + i * 4, 0x24a + i * 8]),
];

export function validateChapterItemDefinition(definition, {allowWeapon = false} = {}) {
  const b = bytes(definition?.raw_hex, 0x3bf, '剧情道具定义'),
    v = view(b);
  need(
    v.getUint32(0, true) === definition.id && (allowWeapon ? [1, 2, 3, 5] : [2, 3, 5]).includes(b[0x24]),
    '剧情道具类别尚未接入',
  );
  return b;
}
export function initializeChapterItem(definition, {allowWeapon = false, rng} = {}) {
  const b = validateChapterItemDefinition(definition, {allowWeapon}),
    v = view(b);
  // TLK case5 uses the 0xCC-filled 0x461780 local buffer, not a fabricated
  // zeroed native instance. 0x47B3C0 only overwrites the fields below;
  // 0x47BDC0 writes quantity when the buffer enters inventory.
  // ev_bf9af000fbc18c6f6eac561f0f48cc7069f26b2dea7441564896eb1ba836a96f
  // ev_fe1630510a8718f8ab0965c11e9be770980ccad78da2fa07cb2a796be29da761.
  const instance = new Uint8Array(0xe5).fill(0xcc),
    out = view(instance);
  instance.set(b.slice(0, 4));
  instance[9] = b[0x176];
  instance.fill(0, 10, 13);
  for (const [to, from] of VALUE_PAIRS) {
    const minimum = v.getInt32(from, true),
      maximum = v.getInt32(from + 4, true);
    const span = maximum - minimum;
    if (span > 0) need(typeof rng === 'function', '随机道具初始化需要原CRT随机源');
    out.setInt32(to, minimum + (span > 0 ? rng() % span : 0), true);
  }
  return instance;
}
