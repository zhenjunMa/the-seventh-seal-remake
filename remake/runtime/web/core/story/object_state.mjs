// 当前剧情草稿中的原版物件状态；写入仍由外层剧情事务提交。
import {bytes, hex} from '../content/native_bytes.mjs';
const need = (ok, message) => {
  if (!ok) throw new Error(message);
};
const ZERO_EVENT = '00'.repeat(14);

export function chapterObjectState(world, mapId, objectIndex, data) {
  const table = data.maps?.[mapId],
    object = table?.objects?.find((row) => row.index === objectIndex);
  need(object, '剧情物件来源缺失');
  const record = world.event_records[table.map_flag_index]?.[objectIndex];
  return record ? bytes(record, 14, '剧情物件事件')[0] : bytes(object.raw_hex, 0x112, '剧情物件')[0xd0];
}

export function setObjectEventState(draft, mapFlagIndex, objectIndex, state) {
  const records = draft.event_records[mapFlagIndex];
  while (records.length <= objectIndex) records.push(ZERO_EVENT);
  const old = bytes(records[objectIndex], 14, '剧情物件事件');
  old[0] = state;
  records[objectIndex] = hex(old);
}
