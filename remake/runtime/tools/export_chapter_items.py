"""Export the complete source item catalog and static native rule evidence.

Reads original Object.ITM and immutable GAME.exe; never edits saves/resources.
Only the existing chapter items are enabled by default. Source-only records,
random or malformed ranges, and unverified crystal/special behaviors remain
explicit. All 416 original records are retained without normalizing bytes.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys
from collections import Counter

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
RUNTIME = ROOT / 'remake/runtime'
sys.path.insert(0, str(ROOT / 'save_analysis_20261010'))
from native_item_init import initialize_existing_instance, VALUE_PAIRS

GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'
ITM_SHA = '9d38c8cda16a06549cb3d09547b7b69b6d9fec4ee03926aef862b8da25d078b8'
IDS = [1, 4, 8, 10, 11, 12, 51, 61]
SIMPLE_RESTORE_IDS = [8, 11, 12]
SLOTS = [dict(id='weapon', label='武器', group_index=0),
         dict(id='head', label='头饰／耳饰', group_index=1),
         dict(id='necklace', label='项链', group_index=2),
         dict(id='ring', label='戒指', group_index=3),
         dict(id='badge', label='徽章', group_index=4),
         dict(id='special', label='特殊饰品', group_index=5)]

def sha(raw): return hashlib.sha256(raw).hexdigest()
def i32(raw, at): return struct.unpack_from('<i', raw, at)[0]
def u32(raw, at): return struct.unpack_from('<I', raw, at)[0]

def text_field(raw, offset, size, encoding='cp936'):
    return raw[offset:offset + size].split(b'\0')[0].decode(encoding, 'strict')

def catalog_fields(raw, ident, offset):
    """Source field views; unknown blocks have no invented mechanics."""
    assert len(raw) == 0x3bf and u32(raw, 0) == ident
    name = text_field(raw, 4, 24)
    ranges = [dict(instance_offset=destination, definition_offset=source,
                   minimum=i32(raw, source), maximum=i32(raw, source + 4))
              for destination, source in VALUE_PAIRS]
    issues = [dict(kind='reversed-source-range', **r) for r in ranges if r['minimum'] > r['maximum']]
    variable = [r for r in ranges if r['minimum'] < r['maximum']]
    deterministic = all(r['minimum'] == r['maximum'] for r in ranges)
    instance = initialize_existing_instance(bytes(0xe5), raw) if deterministic else None
    type_, subtype = raw[0x24], raw[0x25]
    group = 0 if type_ == 1 else subtype if type_ == 2 else None
    slot = next((s for s in SLOTS if s['group_index'] == group), None) if type_ in (1, 2) else None
    empty = ident == 0 or not name or not any(raw)
    placeholder = name.startswith('备用')
    internal = type_ == 6
    status = 'empty' if empty else 'placeholder' if placeholder else 'internal-source' if internal else 'defined'
    equip = bool(slot and deterministic and not issues and status == 'defined')
    simple = ident in SIMPLE_RESTORE_IDS
    kind = 'equip' if equip else 'simple-restore' if simple else 'source-only'
    category = ('weapon' if type_ == 1 else 'equipment' if type_ == 2 else
                'crystal' if (type_, subtype) == (3, 1) else
                'material' if type_ == 3 and subtype in (2, 3) else
                'item' if type_ == 5 else 'internal' if type_ == 6 else 'unknown')
    reasons = []
    if ident not in IDS: reasons.append('outside-default-chapter-item-set')
    if empty: reasons.append('empty-source-record')
    if placeholder: reasons.append('source-name-marks-placeholder; actual original usage is not asserted')
    if internal: reasons.append('internal-type6 record; no player item handler recovered')
    if variable: reasons.append('random-initialization-not-ported')
    if issues: reasons.append('reversed-source-range-retained')
    if kind == 'source-only': reasons.append('usage-handler-not-recovered')
    row = dict(id=ident, name=name, raw_hex=raw.hex(),
        source=dict(path='SYSTEM/Object.ITM', sha256=ITM_SHA, record_index=ident - 1,
                    record_offset=offset, definition_file_offset=offset,
                    record_bytes=0x3bf, record_sha256=sha(raw)),
        record_status=status, category=category,
        type_raw_24=type_, subtype_raw_25=subtype,
        allowed_role_mask_raw_13e=u32(raw, 0x13e),
        description=text_field(raw, 0x26, 0x100),
        drop_rate=i32(raw, 0x158), unique_raw=raw[0x14b],
        value_ranges=ranges,
        initialization=dict(deterministic=deterministic, variable_fields=variable,
            range_issues=issues, instance_bytes=0xe5, initialized_byte_raw_176=raw[0x176],
            native_random_rule='if minimum < maximum: minimum + rand() % (maximum - minimum); otherwise assign minimum',
            native_maximum_is_exclusive=True, runtime_random_initialization_supported=False),
        validation=dict(record_id_matches_index=True, name_empty=not name, all_bytes_zero=not any(raw),
            all_value_ranges_ordered=not issues, range_issues=issues,
            deterministic_fields=sum(r['minimum'] == r['maximum'] for r in ranges),
            target_flags_are_boolean=raw[0x156] in (0, 1) and raw[0x157] in (0, 1),
            drop_rate_in_native_range=-1 <= i32(raw, 0x158) <= 100),
        behavior=dict(kind=kind, status='recovered' if kind != 'source-only' else 'unverified',
            implemented_scope=['equipment-slot-transfer', 'instance-attribute-linking'] if equip else
                              ['single-target-flat-hp-mp-restore'] if simple else [],
            unverified_scope=['special-passive', 'crystal-socketing', 'crafting', 'attack-or-state-effect'] if not simple else []),
        availability=dict(enabled=ident in IDS, chapter_enabled=ident in IDS,
            catalog_visible=True, default_enabled=ident in IDS, reasons=reasons),
        raw_fields=dict(effect_token_raw_126=text_field(raw, 0x126, 20, 'ascii'),
            animation_skill_id_raw_142=i32(raw, 0x142),
            all_targets_raw_156=raw[0x156], same_side_raw_157=raw[0x157],
            effect_kind_raw_2b3=raw[0x2b3], encounter_modifier_raw_3a7=i32(raw, 0x3a7),
            unknown_level_raw_13a=i32(raw, 0x13a),
            special_effect_block=dict(offset=0x2a8, bytes=0x117,
                raw_hex=raw[0x2a8:].hex(), sha256=sha(raw[0x2a8:]),
                interpretation='Opaque source payload; effect kind at absolute+0x2b3 is retained, other behavior is not inferred.'),
            uncopied_attribute_region=dict(offset=0x1be, bytes=0x2c, raw_hex=raw[0x1be:0x1ea].hex(),
                interpretation='Contains initialized pair+0x1ce as well as uncopied bytes; do not treat as an extra implemented stat.')),
        field_sources=dict(name=dict(offset=4, bytes=24, encoding='cp936'),
            description=dict(offset=0x26, bytes=0x100, encoding='cp936'),
            type=dict(offset=0x24, bytes=1), subtype=dict(offset=0x25, bytes=1),
            role_mask=dict(offset=0x13e, bytes=4, signed=False),
            drop_rate=dict(offset=0x158, bytes=4, signed=True), unique=dict(offset=0x14b, bytes=1),
            effect_token=dict(offset=0x126, bytes=20, encoding='ascii'),
            animation_skill_id=dict(offset=0x142, bytes=4, signed=True),
            all_targets=dict(offset=0x156, bytes=1), same_side=dict(offset=0x157, bytes=1),
            effect_kind=dict(offset=0x2b3, bytes=1)))
    if instance is not None:
        row['initialized_raw_hex'] = instance.hex()
        row['initialized_sha256'] = sha(instance)
    if slot:
        row['slot_id'], row['group_index'] = slot['id'], group
    elif group is not None:
        row['source_group_index'] = group
    if type_ == 5:
        # Raw source ranges are a field view, not permission to invoke a handler.
        row['resource_restore_raw'] = dict(
            hp=next(r for r in ranges if r['instance_offset'] == 0xd),
            mp=next(r for r in ranges if r['instance_offset'] == 0x15),
            interpretation='These raw fields alone do not imply a usable simple restore item.')
    if type_ == 3:
        row['crystal_material_source'] = dict(category=category,
            classification_source='ITM type/subtype plus retained original description',
            type_definition_offset=0x24, subtype_definition_offset=0x25,
            attributes_source='value_ranges contains all32 native initialized attributes',
            effect_payload_source=dict(offset=0x2a8, bytes=0x117),
            socketing_status='unverified', crafting_status='unverified', direct_use_status='unverified',
            extraction_status='source-fields-complete; no mechanics enabled')
    return row, instance
def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def export():
    paths = ['GAME.exe', 'SYSTEM/Object.ITM']
    original = {p: (ROOT / p).read_bytes() for p in paths}
    hashes = {p: sha(raw) for p, raw in original.items()}
    assert hashes == {'GAME.exe': GAME_SHA, 'SYSTEM/Object.ITM': ITM_SHA}
    itm = original['SYSTEM/Object.ITM']
    count = u32(itm, 0x20)
    assert count == 416 and len(itm) == 0x61c + count * 0x3bf
    proof_path = RUNTIME / 'evidence/chapter_items_native.json'
    proof = json.loads(proof_path.read_text('utf-8'))
    records = proof['records']
    assert all(r['subject']['digest']['sha256'] == GAME_SHA for r in records)
    by_proc = {r['parameters']['procedure']: r for r in records}
    required = {'initialize':'0x47b3c0', 'use':'0x47d960',
                'consume':'0x47e150', 'equip':'0x47c250',
                'remove':'0x47c760', 'recalculate':'0x47cc30',
                'refresh':'0x44c400', 'categories':'0x43b530',
                'hp_getter':'0x500350', 'mp_getter':'0x500480',
                'world_target_list':'0x45c400', 'world_target_choose':'0x45cb39',
                'battle_item_start':'0x50e808', 'battle_item_effect':'0x41b3e9',
                'battle_command_dispatch':'0x42fe40', 'battle_item_animation':'0x50e3a0'}
    evidence = {key: dict(evidence_id=by_proc[proc]['evidence_id'],
                         procedure=proc, operation=by_proc[proc]['operation'],
                         bundle=proof_path.relative_to(ROOT).as_posix())
                for key, proc in required.items()}
    scheduler_path = RUNTIME / 'evidence/forest_scheduler_native_20261011.json'
    scheduler_records = json.loads(scheduler_path.read_text('utf-8'))['records']
    dispatch_record = next(r for r in scheduler_records if r['operation'] == 'procedure_assembly'
                           and r['parameters']['procedure'] == '0x5036d0')
    assert dispatch_record['subject']['digest']['sha256'] == GAME_SHA
    evidence['battle_gauge_dispatch'] = dict(evidence_id=dispatch_record['evidence_id'],
        procedure='0x5036d0', operation='procedure_assembly',
        bundle=scheduler_path.relative_to(ROOT).as_posix())
    drop_path = RUNTIME / 'evidence/forest_rewards_native_20261011.json'
    drop_records = json.loads(drop_path.read_text('utf-8'))['records']
    drop_record = next(r for r in drop_records if r['operation'] == 'procedure_assembly'
                       and r['parameters']['procedure'] == '0x50cc20')
    assert drop_record['subject']['digest']['sha256'] == GAME_SHA
    evidence['drop_rate'] = dict(evidence_id=drop_record['evidence_id'], procedure='0x50cc20',
        operation='procedure_assembly', bundle=drop_path.relative_to(ROOT).as_posix(),
        definition_offset=0x158, unique_definition_offset=0x14b)
    definitions = {}
    for ident in range(1, count + 1):
        at = 0x61c + (ident - 1) * 0x3bf
        raw = itm[at:at + 0x3bf]
        assert struct.unpack_from('<I', raw)[0] == ident
        row, instance = catalog_fields(raw, ident, at)
        if ident in SIMPLE_RESTORE_IDS:
            assert instance is not None and raw[0x24] == 5 and raw[0x25] == 1
            fields = {at: i32(instance, at) for at in range(0xd, 0x8d, 4)}
            # This contract cannot silently enable stat growth, revival, or
            # percent effects using a similar name or an unchecked field.
            assert all(value == 0 for at, value in fields.items() if at not in [0xd, 0x15])
            assert fields[0xd] >= 0 and fields[0x15] >= 0 and fields[0xd] + fields[0x15] > 0
            assert raw[0x156] == 0 and raw[0x157] == 1 and raw[0x2a8 + 0xb] == 0
            row['effect'] = dict(restore_hp_flat=fields[0xd], restore_mp_flat=fields[0x15],
                                 restore_hp_percent=0, restore_mp_percent=0, revive=False)
            row['battle'] = dict(animation_skill_id_raw_142=i32(raw, 0x142),
                                 all_targets_raw_156=raw[0x156],
                                 same_side_raw_157=raw[0x157],
                                 effect_kind_raw_2b3=raw[0x2b3],
                                 preparation_delay_added=0,
                                 target_state_max_exclusive=4,
                                 target_immune_must_be_zero=True)
        definitions[str(ident)] = row
    forest = json.loads((RUNTIME / 'web/data/forest_rewards.json').read_text('utf-8'))['items']
    forest_checks = {}
    for key, item in forest.items():
        row = definitions[key]
        assert item['name'] == row['name'] and item['drop_rate'] == row['drop_rate']
        assert item['unique_raw'] == row['unique_raw'] and item['type_raw'] == row['type_raw_24']
        assert item['source']['definition_file_offset'] == row['source']['record_offset']
        assert item['source']['definition_raw_hex'] == row['raw_hex']
        forest_checks[key] = dict(name=row['name'], drop_rate=row['drop_rate'],
                                 raw_definition_matches=True, source_offset_matches=True)
    range_issues = {k: row['validation']['range_issues'] for k, row in definitions.items()
                    if row['validation']['range_issues']}
    variable_ids = [row['id'] for row in definitions.values() if row['initialization']['variable_fields']]
    assert range_issues == {'36': [dict(kind='reversed-source-range', instance_offset=0x7d,
                                      definition_offset=0x27a, minimum=768, maximum=0)]}
    assert variable_ids == [31]
    assert {k for k, r in definitions.items() if 'effect' in r} == {'8', '11', '12'}
    assert all(len(row['value_ranges']) == 32 and row['source']['record_sha256'] == sha(bytes.fromhex(row['raw_hex']))
               and row['validation']['drop_rate_in_native_range'] and row['validation']['target_flags_are_boolean']
               for row in definitions.values())
    output = RUNTIME / 'web/data/items.json'
    value = dict(schema='seventh-seal-chapter-items', version=1, slots=SLOTS,
                 definitions=definitions, source_hashes=hashes, evidence=evidence,
                 catalog=dict(record_count=count, header_bytes=0x61c, record_bytes=0x3bf,
                    count_field_offset=0x20, header_raw_hex=itm[:0x61c].hex(),
                    complete_source_coverage=True, empty_record_ids=[],
                    placeholder_record_ids=[r['id'] for r in definitions.values() if r['record_status']=='placeholder'],
                    default_enabled_item_ids=IDS, simple_restore_item_ids=SIMPLE_RESTORE_IDS,
                    source_value_ranges_per_record=32, source_range_issues=range_issues,
                    random_initialization_item_ids=variable_ids,
                    classification_counts=dict(Counter(r['category'] for r in definitions.values())),
                    behavior_counts=dict(Counter(r['behavior']['kind'] for r in definitions.values())),
                    compatibility='The original eight chapter IDs keep their initialized bytes/slot/effect contracts; extra definitions are source catalog entries.',
                    unknown_fields='Prices, crafting recipes, crystal insertion/removal and special effects are not assigned semantics from names; original bytes remain in raw_hex.'),
                 equipment_resource_policy='preserve-raw',
                 consumable_resource_policy='raw-add-clamp-to-raw-maximum',
                 native_rules=dict(role_mask_bit='1 << (numeric role ID - 1)',
                                   equipment_group='weapon: group 0; type 2: definition byte +0x25; entry 0',
                                   ring_slots=1, head_and_ear_share_group=True,
                                   equipment_resources='No raw HP/MP write in 0x47C250/0x47C760; 0x47CC30 replaces linked bonuses.',
                                   use='0x47D960 adds instance +0x0D to raw HP +0x30 and +0x15 to raw MP +0x38; clamps to raw maxima.',
                                   consume='0x47E150 consumes one on native success and compacts a zero stack.',
                                   consume_when_full=True,
                                   exploration_target_requires_alive=False,
                                   exploration_target_gate='0x45C400 checks only role presence; 0x45CA50 calls 0x47E150 for the selected role.',
                                   effective_resource_getters='0x500350/0x500480 return raw plus linked bonuses without a zero clamp.',
                                   battle_preparation_delay_added=0,
                                   battle_gauge='0x50E7A0 resets gauge to zero; item flag bypasses skill checks in 0x503D80/88; 0x503F38 subtracts threshold.',
                                   battle_target_gate='0x41B3C0 permits effect kind 0 only for immune byte 0 and state <4; invalid targets consume no item.',
                                   battle_consumption='Simple nonzero HP/MP restore succeeds even when full and removes exactly one instance.'),
                 source=dict(native_bundle_sha256=sha(proof_path.read_bytes()),
                             native_scheduler_bundle_sha256=sha(scheduler_path.read_bytes()),
                             native_drop_bundle_sha256=sha(drop_path.read_bytes()),
                             original_game_executed=False,
                             limitations=['Static shipped binary evidence; original execution was not observed.',
                                          'Battle item gauge and zero added preparation debt are native verified; live menu timing and animation completion remain remake adapters.',
                                          'Only the eight default chapter items are enabled. Additional valid-slot equipment declares recovered equip/linking scope; source-only records have no usable handler.',
                                          'Crystal socketing, crafting, special passive abilities, growth/revival and other item handlers remain unverified.',
                                          'ID31 has a variable range and ID36 has a reversed range in the shipped source; they are retained rather than silently repaired.',
                                          'Special slot label is a remake UI label for source category5; its catalog records are present but none is enabled by default.']))
    write(output, value)
    assert all((ROOT / p).read_bytes() == raw for p, raw in original.items())
    report = dict(schema='seventh-seal-chapter-item-export', version=1, passed=True,
                  source_bytes_unchanged=True, source_hashes=hashes,
                  output_path=output.relative_to(ROOT).as_posix(), output_sha256=sha(output.read_bytes()),
                  item_ids=list(range(1, count + 1)), enabled_item_ids=IDS,
                  record_count=count, value_range_checks=count * len(VALUE_PAIRS),
                  deterministic_initialized_records=sum('initialized_raw_hex' in r for r in definitions.values()),
                  source_range_issues=range_issues, random_initialization_item_ids=variable_ids,
                  behavior_counts=value['catalog']['behavior_counts'],
                  classification_counts=value['catalog']['classification_counts'],
                  placeholder_record_ids=value['catalog']['placeholder_record_ids'],
                  forest_drop_definition_checks=forest_checks,
                  simple_effects={k:r['effect'] for k,r in definitions.items() if 'effect' in r},
                  original_game_execution_observed=False, evidence=evidence)
    write(RUNTIME / 'evidence/chapter_items_export.json', report)
    print(json.dumps(dict(record_count=count, enabled_item_ids=IDS,
        behavior_counts=report['behavior_counts'], value_range_checks=report['value_range_checks'],
        deterministic_initialized_records=report['deterministic_initialized_records'],
        source_range_issues=range_issues, simple_effects=report['simple_effects'],
        forest_drop_definition_checks=len(forest_checks), source_bytes_unchanged=True)))

if __name__ == '__main__': export()
