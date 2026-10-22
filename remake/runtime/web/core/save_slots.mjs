export const SAVE_SLOT_COUNT = 20;
export const MANUAL_SAVE_SLOTS = Object.freeze(Array.from({length:SAVE_SLOT_COUNT},(_,index)=>String(index).padStart(2,'0')));

export function normalizeSaveSlot(slot='00') {
  if(slot==='manual')return '00';
  if(slot==='quick'||MANUAL_SAVE_SLOTS.includes(slot))return slot;
  throw new Error('存档槽不存在');
}

export function saveSlotLabel(slot) {
  const normalized=normalizeSaveSlot(slot);
  return normalized==='quick'?'快速存档':normalized;
}
