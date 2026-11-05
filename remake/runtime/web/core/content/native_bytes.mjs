// 原版记录的公共字节校验；只读转换，不修改世界或来源数据。
const need = (ok, message) => {
  if (!ok) throw new Error(message);
};
export const hex = (value) => Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
export const bytes = (value, count, label) => {
  need(
    typeof value === 'string' && new RegExp(`^(?:[0-9a-f]{2}){${count}}$`).test(value),
    `${label}原始记录无效`,
  );
  return Uint8Array.from(value.match(/../g), (part) => parseInt(part, 16));
};
export const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
