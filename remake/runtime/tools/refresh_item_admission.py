"""Re-admit source acquisitions using the checked-in fixed item rule catalog.

This maintenance path does not recover missing historical native queries or
regenerate their Evidence IDs. It verifies every current ITM byte, rebuilds
source-derived field views, and applies the same admission functions as the
full exporter. Editable config files and player saves are never written.
"""
from collections import Counter
from copy import deepcopy
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_chapter_items as items
from incremental import write_json

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'


def refresh():
    output = WEB / 'data/items.json'
    previous_bytes = output.read_bytes()
    previous = json.loads(previous_bytes)
    executable = (ROOT / 'GAME.exe').read_bytes()
    raw_itm = (ROOT / 'SYSTEM/Object.ITM').read_bytes()
    if items.sha(executable) != items.GAME_SHA or items.sha(raw_itm) != items.ITM_SHA:
        raise ValueError('Item admission requires the exact verified GAME.exe and Object.ITM')
    if previous.get('schema') != 'seventh-seal-chapter-items' or previous.get('version') != 1:
        raise ValueError('Fixed item catalog schema is incompatible')
    if (previous['catalog']['header_raw_hex'] != raw_itm[:0x61c].hex()
            or set(previous['definitions']) != {str(i) for i in range(1, 417)}
            or len(raw_itm) != 0x61c + 416 * 0x3bf):
        raise ValueError('Fixed item catalog is not the complete original 416-record baseline')
    definitions = {}
    for ident in range(1, 417):
        offset = 0x61c + (ident - 1) * 0x3bf
        raw = raw_itm[offset:offset + 0x3bf]
        retained = previous['definitions'][str(ident)]
        if (retained.get('raw_hex') != raw.hex()
                or retained.get('source', {}).get('record_offset') != offset
                or retained['source'].get('record_sha256') != items.sha(raw)
                or retained['source'].get('sha256') != items.ITM_SHA):
            raise ValueError(f'Fixed item {ident} differs from the supplied original ITM')
        row, instance = items.catalog_fields(raw, ident, offset)
        if ident in items.SIMPLE_RESTORE_IDS:
            values = {at: items.i32(instance, at) for at in range(0xd, 0x8d, 4)}
            expected = dict(restore_hp_flat=values[0xd], restore_mp_flat=values[0x15],
                            restore_hp_percent=0, restore_mp_percent=0, revive=False)
            if retained.get('effect') != expected or raw[0x24:0x26] != b'\x05\x01':
                raise ValueError(f'Fixed simple-restore rule {ident} differs from its source fields')
            row['effect'] = expected
            row['battle'] = deepcopy(retained['battle'])
        definitions[str(ident)] = row

    registration = items.content_definition()
    input_names = ['opening_seed.json', 'chapter_story.json', 'runtime_content.json']
    inputs = {name: (WEB / 'data' / name).read_bytes() for name in input_names}
    if json.loads(inputs['runtime_content.json']) != registration:
        raise ValueError('Registration changed during item admission')
    admission = items.admit_registered_equipment(definitions, json.loads(inputs['opening_seed.json']),
                                                json.loads(inputs['chapter_story.json']), registration)
    capabilities = items.admit_registered_status_cures(definitions, admission)
    items.admit_registered_equipment_passives(definitions, admission, capabilities)
    admission['generated_input_hashes'] = {f'data/{name}': items.sha(raw) for name, raw in inputs.items()}
    enabled = sorted(int(ident) for ident, row in definitions.items() if row['availability']['enabled'])
    result = deepcopy(previous)
    result.update(definitions=definitions, indexes=items.catalog_indexes(definitions),
                  source_hashes=admission['source_hashes'])
    result['catalog'].update(default_enabled_item_ids=enabled, equipment_admission=admission,
        item_capability_admission=capabilities,
        simple_restore_item_ids=sorted(int(i) for i, row in definitions.items()
                                       if row['behavior']['kind'] == 'simple-restore'),
        classification_counts=dict(Counter(row['category'] for row in definitions.values())),
        behavior_counts=dict(Counter(row['behavior']['kind'] for row in definitions.values())))
    result['source']['admission_refresh'] = dict(
        policy='all-416-source-bytes-verified; fixed-native-rules-retained',
        original_game_executed=False,
        historical_native_queries='retained references only; not rerun by this maintenance path')
    for path, expected in admission['source_hashes'].items():
        if items.sha((ROOT / path).read_bytes()) != expected:
            raise ValueError(f'Original input changed during item admission: {path}')
    for name, original in inputs.items():
        if (WEB / 'data' / name).read_bytes() != original:
            raise ValueError(f'Generated input changed during item admission: {name}')
    write_json(output, result)
    report = dict(schema='seventh-seal-item-admission-refresh', version=1, passed=True,
        source_bytes_unchanged=True, original_game_executed=False,
        baseline_catalog_sha256=items.sha(previous_bytes),
        output_path='data/items.json', output_sha256=items.sha(output.read_bytes()),
        source_hashes=admission['source_hashes'],
        generated_input_hashes=admission['generated_input_hashes'],
        source_record_count=416, enabled_item_ids=enabled,
        newly_enabled_item_ids=sorted(set(enabled) - set(previous['catalog']['default_enabled_item_ids'])),
        admitted_tlk_root_count=len(admission['admitted_tlk_roots']),
        fixed_native_rule_sections_retained=['native_rules', 'evidence'],
        unavailable_historical_bundles=sorted({row['bundle'] for row in previous['evidence'].values()
            if isinstance(row, dict) and row.get('bundle') and not (ROOT / row['bundle']).is_file()}),
        limitations=['Only fixed original field/rule views and current source acquisition admission were checked.',
                     'Missing historical REA query archives were not recovered or rerun.',
                     'No editable parameters, player saves, inventory or progress were changed.'])
    (RUNTIME / 'evidence').mkdir(parents=True, exist_ok=True)
    write_json(RUNTIME / 'evidence/item_admission_refresh.json', report)
    print(json.dumps({key: report[key] for key in ['passed', 'source_record_count', 'admitted_tlk_root_count',
                                                   'newly_enabled_item_ids']}, ensure_ascii=False))


if __name__ == '__main__':
    refresh()
