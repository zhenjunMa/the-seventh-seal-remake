// 原版 TLK 来源校验与选项解码；不执行剧情，也不修改进度。
import {bytes, view} from '../content/native_bytes.mjs';
import {runtimeContent} from '../content/content_registry.mjs';
import {isNativeMapId} from '../exploration/native_map_identity.mjs';
import {validateCompactRecords} from './story_packages.mjs';
const copy = (value) => structuredClone(value);
const need = (ok, message) => {
  if (!ok) throw new Error(message);
};
export const flagIndex = (value) => Number.isInteger(value) && value >= 0 && value < 2000;
const FIELD_OFFSETS = {
  speaker: 0x0f,
  id: 0x13,
  condition_type: 0x17,
  condition_index: 0x1b,
  condition_bit: 0x1f,
  mutation_type: 0x23,
  mutation_index: 0x27,
  mutation_bit: 0x2b,
  if_true: 0x2f,
  next: 0x33,
};

export function validateChapterStory(data) {
  need(
    data?.schema === 'seventh-seal-chapter-story' && [1, 2].includes(data.version) && data.maps,
    '剧情版本不兼容',
  );
  for (const [mapId, table] of Object.entries(data.maps)) {
    if (table.dialogue_status === 'source-file-absent') {
      need(
        isNativeMapId(mapId) &&
          flagIndex(table.map_flag_index) &&
          table.source === null &&
          Array.isArray(table.records) &&
          table.records.length === 0 &&
          table.record_count === 0 &&
          table.index_count === 0 &&
          table.header_setup_tlk_raw === 0 &&
          table.header_entry_tlk_raw === 0 &&
          table.map_source?.path?.toLowerCase() === `map/${mapId.toLowerCase()}.dat` &&
          /^[0-9a-f]{64}$/.test(table.map_source.sha256) &&
          data.source_hashes?.[table.map_source.path] === table.map_source.sha256,
        '无对白地图来源无效',
      );
      continue;
    }
    need(
      isNativeMapId(mapId) &&
        flagIndex(table.map_flag_index) &&
        Array.isArray(table.records) &&
        table.records.length > 0 &&
        table.records.length <= 10000,
      '原剧情对白表无效',
    );
    need(
      table.source?.path?.toLowerCase() === `map/${mapId.toLowerCase()}.tlk` &&
        /^[0-9a-f]{64}$/.test(table.source.sha256) &&
        data.source_hashes?.[table.source.path] === table.source.sha256,
      '原剧情对白来源缺失',
    );
    if (data.version === 2) {
      validateCompactRecords(table);
      continue;
    }
    const ids = new Set();
    for (const record of table.records) {
      const b = bytes(record.raw_hex, 0x66f, '对白'),
        v = view(b);
      need(
        Number.isInteger(record.id) &&
          record.id > 0 &&
          record.offset === table.record_base + (record.id - 1) * 0x66f &&
          !ids.has(record.id),
        '原剧情对白编号无效',
      );
      ids.add(record.id);
      for (const [field, offset] of Object.entries(FIELD_OFFSETS))
        need(
          record[field] === v.getUint32(offset, true),
          `对白 ${mapId}:${record.id} 字段 ${field} 与原始记录不同`,
        );
      need(
        record.kind === b[0] && record.style === b[1] && (record.region_byte_raw ?? b[7]) === b[7],
        '原剧情对白类型与原始记录不同',
      );
      const rawText = b.slice(0x37, 0x137),
        end = rawText.indexOf(0);
      // kind8 overlays the text area with ushort goods IDs; its retained text
      // projection uses the source exporter's replacement decoding.
      const text = new TextDecoder('gbk', {fatal: record.kind !== 8}).decode(
        end < 0 ? rawText : rawText.slice(0, end),
      );
      need(record.text_raw === text, '原剧情对白文字与原始记录不同');
      if (record.source)
        need(
          record.source.path === table.source.path &&
            record.source.offset === record.offset &&
            record.source.sha256 === table.source.sha256 &&
            record.source.record_id === record.id,
          '原剧情对白记录来源不一致',
        );
    }
    // kind2 +2F names a destination DAT entry marker, not a TLK record.
    for (const record of table.records)
      for (const target of [...(record.kind === 2 ? [] : [record.if_true]), record.next])
        need(target === 0 || ids.has(target), `对白 ${mapId}:${record.id} 跳转目标缺失`);
  }
  return data;
}

// Native style1 stores three 100-byte GBK labels followed by DWORD TLK targets.
export function chapterChoices(record) {
  need(record?.kind === 0 && record.style === 1, '剧情选择记录无效');
  if (record.raw_hex === undefined && Array.isArray(record.choices)) return copy(record.choices);
  const b = bytes(record.raw_hex, 0x66f, '剧情选择'),
    v = view(b),
    choices = [];
  for (let index = 0; index < 3; index++) {
    const offset = 0x537 + index * 104,
      textBytes = b.slice(offset, offset + 100),
      end = textBytes.indexOf(0);
    const text = new TextDecoder('gbk', {fatal: true}).decode(end < 0 ? textBytes : textBytes.slice(0, end));
    const target = v.getUint32(offset + 100, true);
    if (text) choices.push({index, text, recordId: target});
    else need(target === 0, '剧情空选择含未支持的跳转');
  }
  return choices;
}
export function chapterRestChoices(record, binding = null) {
  const choices = chapterChoices(record);
  binding ??= Object.entries(runtimeContent.maps)
    .find(
      ([id, row]) =>
        record.source?.path?.toLowerCase() === `map/${id.toLowerCase()}.tlk` &&
        row.rests.some((rest) => rest.record_id === record.id),
    )?.[1]
    .rests.find((rest) => rest.record_id === record.id);
  need(
    choices.length >= 1 &&
      choices.length <= 3 &&
      binding?.choices?.length === choices.length &&
      choices.every((choice, index) => {
        const expected = binding.choices[index];
        return (
          choice.index === expected.index &&
          choice.text === expected.text &&
          choice.recordId === expected.record_id
        );
      }),
    '休息原始选择不兼容',
  );
  return choices;
}
