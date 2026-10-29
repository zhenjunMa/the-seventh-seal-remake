"""Export the complete source item catalog and static native rule evidence.

Reads original Object.ITM and immutable GAME.exe; never edits saves/resources.
Source-owned, registered plain equipment is enabled with source provenance.
Source-only records,
random or malformed ranges, and unverified crystal/special behaviors remain
explicit. All 416 original records are retained without normalizing bytes.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys
from copy import deepcopy
from collections import Counter
from collections import deque

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
RUNTIME = ROOT / 'remake/runtime'
# Embedded/isolated Python excludes the script directory from sys.path. Resolve
# sibling tools explicitly, just as the other standalone runtime exporters do.
sys.path.insert(0, str(RUNTIME / 'tools'))
from source.native_item_init import initialize_existing_instance, VALUE_PAIRS
from content_registration import definition as content_definition, map_ids
from export_source_catalog import exe_bytes_at_va

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


def catalog_indexes(definitions):
    """Exact source lookups: names may collide; every lookup returns native IDs.

    ``definitions[str(item_id)]`` is the by-ID index. These indexes describe
    source fields only; membership never grants runtime support or enables an
    item. Role membership follows the recovered native bit rule, including
    source records whose behavior has not been implemented.
    """
    indexes = dict(ids=[], by_name={}, by_category={}, by_record_status={},
                   by_type_subtype={}, by_slot={}, by_role_mask={}, by_allowed_role={})
    for ident, row in sorted(definitions.items(), key=lambda pair: int(pair[0])):
        assert str(row['id']) == ident
        item_id = row['id']
        indexes['ids'].append(item_id)
        for index, key in [('by_name', row['name']), ('by_category', row['category']),
                           ('by_record_status', row['record_status']),
                           ('by_type_subtype', f"{row['type_raw_24']}:{row['subtype_raw_25']}"),
                           ('by_role_mask', str(row['allowed_role_mask_raw_13e']))]:
            indexes[index].setdefault(key, []).append(item_id)
        if 'slot_id' in row:
            indexes['by_slot'].setdefault(row['slot_id'], []).append(item_id)
        for bit in range(32):
            if row['allowed_role_mask_raw_13e'] & (1 << bit):
                indexes['by_allowed_role'].setdefault(f'{bit + 1:03}', []).append(item_id)
    return indexes


def source_files(registration=None):
    registration = content_definition() if registration is None else registration
    return ('GAME.exe', 'SYSTEM/Object.ITM',
            *tuple(f'Fight_Role/{ident}.CHR' for ident in registration['roles']),
            *tuple(f'Map/{ident.lower()}.dat' for ident in map_ids('story-data', registration)),
            *tuple(f'Map/{ident.lower()}.TLK' for ident in map_ids('story-data', registration)
                   if (ROOT/f'Map/{ident.lower()}.TLK').is_file()),
            *tuple(f'Animate/{ident}.anm' for ident in registration['programs']))


def registered_tlk_reachability(story, registration, original, hashes, require):
    """Both source branches, limited to admitted entrances, never an entire TLK.

    ANM uses source opcode10 map changes and opcode20 one-based branch targets;
    no filename/map-ID guessing or current-world flag assumptions are used.
    """
    roots = []
    def add(map_id, record_id, kind, **fields):
        if record_id:
            require(map_id in story['maps'], f'{map_id} admitted TLK root')
            roots.append(dict(map_id=map_id, record_id=record_id, kind=kind, **fields))
    for map_id in map_ids('story', registration):
        table, binding = story['maps'][map_id], registration['maps'][map_id]
        path = f'Map/{map_id.lower()}.dat'; data = original[path]
        require(table.get('map_source', {}).get('path') == path and table['map_source'].get('sha256') == hashes[path], f'{map_id} DAT')
        require(table['header_entry_tlk_raw'] == u32(data, 0x13a)
                and table['header_setup_tlk_raw'] == u32(data, 0x8a), f'{map_id} DAT entrances')
        if binding.get('entry'): add(map_id, u32(data, 0x13a), 'entry')
        if binding.get('setup'): add(map_id, u32(data, 0x8a), 'setup')
        tlk = original[f'Map/{map_id.lower()}.TLK']
        slots = {slot: u32(tlk, 0x1a + slot * 4) for slot in range(u32(tlk, 2))}
        npc_slots = binding.get('npcs', [npc['slot_zero_based'] for npc in table['npc_records']])
        for slot in npc_slots:
            require(slot in slots, f'{map_id} NPC {slot} TLK index')
            add(map_id, slots[slot], 'npc', npc_slot=slot)
        for index in binding.get('objects', []):
            if index['handler'] == 'keyed-chest':
                continue  # Direct DAT rewards have no fabricated TLK root.
            obj = next((row for row in table['objects'] if row['index'] == index['index']), None)
            require(obj is not None, f'{map_id} object {index}')
            at = obj['source']['offset']; raw = data[at:at + 0x112]
            require(raw.hex() == obj['raw_hex'] and raw[0xcf] == (1 if index['handler'] == 'tlk-object' else 3), f'{map_id} object source')
            add(map_id, u32(raw, 0xf6), 'object', object_index=index['index'])
        descriptors = {row['id']: row for row in table['descriptors']}
        selected = [(ident, 'trigger') for ident in binding.get('triggers', [])]
        selected += [(row['descriptor_id'], 'rest') for row in binding.get('rests', [])]
        for route in binding.get('routes', []):
            descriptor_id = route.get('descriptor_id')
            if descriptor_id is None:
                descriptor_id = next((row['id'] for row in table['descriptors'] if row['state_raw'] == 2
                                      and row['field_26_raw'] == route.get('record_id')), None)
            selected.append((descriptor_id, 'route'))
            add(map_id, route.get('denial_record_id'), 'route-denial')
        for ident, kind in selected:
            descriptor = descriptors.get(ident)
            require(descriptor is not None, f'{map_id} descriptor {ident}')
            at = descriptor['source']['offset']; size = descriptor['record_bytes']; raw = data[at:at + size]
            require(raw.hex() == descriptor['raw_hex'] and raw[0] == 2 and size in (0x2b, 0x42), f'{map_id} descriptor source')
            record_id = raw[0x26] if size == 0x2b else u32(raw, 0x26)
            require(record_id == descriptor['field_26_raw'], f'{map_id} descriptor TLK')
            add(map_id, record_id, kind, descriptor_id=ident)
    for ident in registration['programs']:
        program = story.get('programs', {}).get(ident, {})
        path = f'Animate/{ident}.anm'; data = original[path]; count = u32(data, 2)
        require(program.get('source', {}).get('sha256') == hashes[path] and len(data) == 67 + count * 74
                and len(program.get('commands', [])) == count, f'{ident} ANM')
        raws = []
        for index, command in enumerate(program['commands']):
            at = 67 + index * 74; raw = data[at:at + 74]
            require(command.get('raw_hex') == raw.hex() and command.get('index') == index
                    and command.get('source', {}).get('offset') == at, f'{ident} ANM command {index}')
            raws.append(raw)
        callers = set()
        for map_id, table in story['maps'].items():
            if map_id not in registration['maps']: continue
            if any(row['kind'] == 1 and row['text_raw'].lower() == ident.lower() + '.anm' for row in table['records']): callers.add(map_id)
            if any(row['state_raw'] == 1 and row['filename_raw'].lower() == ident.lower() + '.anm' for row in table['descriptors']): callers.add(map_id)
        queue, seen = deque((0, map_id) for map_id in sorted(callers) or [None]), set()
        while queue:
            index, map_id = queue.popleft()
            if index >= count or (index, map_id) in seen: continue
            require(index >= 0, f'{ident} ANM branch'); seen.add((index, map_id)); raw = raws[index]
            if raw[0] == 10:
                require(u32(raw, 5) == 0, f'{ident} ANM map mode')
                map_id = raw[54:74].split(b'\0')[0].decode('ascii').removesuffix('.DAT').removesuffix('.dat').upper()
                require(map_id in registration['maps'], f'{ident} ANM map')
            elif raw[0] == 14:
                add(map_id, u32(raw, 5), 'anm-talk', program_id=ident, command_index=index)
            if raw[0] == 20 and raw[29] >= 2 and (u32(raw, 5) or story['maps'][map_id]['map_flag_index']):
                targets = [u32(raw, 13)] if u32(raw, 25) == 0 else [u32(raw, 13), u32(raw, 17)]
                require(u32(raw, 25) != 0 or targets[0] > 0, f'{ident} ANM unconditional branch')
                for target in targets:
                    require(0 <= target <= count, f'{ident} ANM branch target')
                    queue.append((target - 1 if target else index + 1, map_id))
            else: queue.append((index + 1, map_id))
    queue, reachable = deque((row['map_id'], row['record_id'], row) for row in roots), {}
    while queue:
        map_id, record_id, origin = queue.popleft(); key = f'{map_id}:{record_id}'
        if not record_id or key in reachable: continue
        table = story['maps'][map_id]
        require(0 < record_id <= len(table['records']), f'{key} reachable record')
        row = table['records'][record_id - 1]; raw = bytes.fromhex(row['raw_hex']); reachable[key] = origin
        if raw[0] != 2 and (raw[0] == 4 or u32(raw, 0x17) or u32(raw, 0x1f)):
            queue.append((map_id, u32(raw, 0x2f), origin))
        queue.append((map_id, u32(raw, 0x33), origin))
        if raw[0] == 0 and raw[1] == 1:
            for index in range(3):
                at = 0x537 + index * 104
                if raw[at]: queue.append((map_id, u32(raw, at + 100), origin))
    return reachable, roots


def plain_equipment_supported(row):
    """Admission is narrower than an equip slot: no unrecovered passive payload."""
    fields = row.get('raw_fields', {})
    block = fields.get('special_effect_block', {})
    try:
        payload = bytes.fromhex(block.get('raw_hex', ''))
    except ValueError:
        return False
    return bool(row.get('behavior', {}).get('kind') == 'equip'
                and row.get('record_status') == 'defined'
                and row.get('slot_id') in {slot['id'] for slot in SLOTS}
                and row.get('initialization', {}).get('deterministic') is True
                and row.get('validation', {}).get('all_value_ranges_ordered') is True
                and len(payload) == 0x117 and not any(payload[:0xea]) and not any(payload[0xff:])
                and payload[0xea] <= 5
                and all(1 <= u32(payload, 0xeb + index * 4) <= 416 for index in range(payload[0xea]))
                and fields.get('effect_kind_raw_2b3') == 0
                and fields.get('encounter_modifier_raw_3a7') == 0
                and fields.get('animation_skill_id_raw_142') == 0
                and fields.get('effect_token_raw_126') == '')


def admit_registered_equipment(definitions, seed, story, registration):
    """Verify original ownership/grants before changing any catalog availability.

    This admits a recovered menu capability, never inventory or party members.
    Existing save instances and editable parameters are not inputs to admission.
    """
    def require(ok, label):
        if not ok:
            raise ValueError(f'Equipment admission source mismatch: {label}')

    original = {path: (ROOT / path).read_bytes() for path in source_files(registration)}
    hashes = {path: sha(raw) for path, raw in original.items()}
    require(hashes['GAME.exe'] == GAME_SHA and hashes['SYSTEM/Object.ITM'] == ITM_SHA, 'GAME/ITM')
    source = seed.get('source', {})
    require(source.get('kind') == 'native-new-game' and source.get('sha256') == GAME_SHA, 'opening seed')
    require(source.get('source_hashes', {}).get('SYSTEM/Object.ITM') == ITM_SHA, 'seed ITM')
    require(story.get('source_hashes', {}).get('SYSTEM/Object.ITM') == ITM_SHA, 'story ITM')
    # 47AE20's six actual x86 MOV [EBP+disp8],imm32 instructions. Values are
    # read from the pinned original executable rather than a second item-ID list.
    bootstrap_offset, bootstrap = exe_bytes_at_va(original['GAME.exe'], 0x47af06, 6 * 7)
    require(all(bootstrap[i * 7:i * 7 + 3] == bytes([0xc7, 0x45, 0xdc + i * 4])
                for i in range(6)), '47AE20 initial equipment instructions')
    initial_ids = [u32(bootstrap, i * 7 + 3) for i in range(6)]
    sources = {}

    def item(ident):
        row = definitions.get(str(ident))
        require(row is not None, f'item {ident}')
        at = 0x61c + (ident - 1) * 0x3bf
        raw = original['SYSTEM/Object.ITM'][at:at + 0x3bf]
        require(row.get('id') == ident and row.get('raw_hex') == raw.hex()
                and row.get('source', {}).get('record_offset') == at
                and row['source'].get('record_sha256') == sha(raw)
                and row['source'].get('sha256') == ITM_SHA, f'item {ident} definition')
        return row, raw, at

    player_ids = {ident for ident, role in registration['roles'].items() if role['side'] == 'player'}
    seen = set()
    for entry in source.get('initial_equipment', []):
        role_id = entry.get('role_id')
        if role_id not in player_ids:
            continue
        slot = int(role_id) - 1
        require(role_id not in seen and 0 <= slot < len(initial_ids), f'role {role_id} initial slot')
        seen.add(role_id)
        ident = initial_ids[slot]
        row, raw, at = item(ident)
        require(entry.get('item_id') == ident and entry.get('group_index') == entry.get('entry_index') == 0,
                f'role {role_id} native bootstrap item')
        expected = initialize_existing_instance(bytes(0xe5), raw)
        require(entry.get('source_raw_hex') == expected.hex() and entry.get('instance_sha256') == sha(expected)
                and entry.get('initialization_rng_calls') == 0, f'role {role_id} initialized instance')
        require(entry.get('definition_source') == dict(path='SYSTEM/Object.ITM', record_offset=at,
                    record_bytes=0x3bf, sha256=sha(raw)), f'role {role_id} ITM provenance')
        path = f'Fight_Role/{role_id}.CHR'
        role, story_role = source.get('role_definitions', {}).get(role_id, {}), story.get('role_definitions', {}).get(role_id, {})
        require(role.get('path') == path and role.get('sha256') == hashes[path]
                and source.get('source_hashes', {}).get(path) == hashes[path]
                and role.get('header_file_offset') == 8
                and role.get('header_raw_hex') == original[path][8:8 + 779].hex(), f'role {role_id} CHR')
        require(story_role.get('source', {}).get('path') == path
                and story_role['source'].get('sha256') == hashes[path]
                and story.get('source_hashes', {}).get(path) == hashes[path], f'role {role_id} story CHR')
        sources.setdefault(str(ident), []).append(dict(kind='registered-player-native-initial-equipment',
            role_id=role_id, group_index=0, entry_index=0, instance_sha256=sha(expected),
            source=dict(path='GAME.exe', sha256=GAME_SHA, address=hex(0x47af06 + slot * 7),
                        offset=bootstrap_offset + slot * 7, bytes=7, raw_hex=bootstrap[slot * 7:slot * 7 + 7].hex()),
            role_source=dict(path=path, sha256=hashes[path])))
    # A registered native opening role must retain its source bootstrap entry.
    require({f'{i + 1:03}' for i in range(len(initial_ids))} & player_ids == seen, 'missing initial equipment')
    grants = []
    for map_id in map_ids('story', registration):
        table = story.get('maps', {}).get(map_id, {})
        path = f'Map/{map_id.lower()}.TLK'
        data = original[path]
        require(table.get('source', {}).get('path') == path and table['source'].get('sha256') == hashes[path]
                and story.get('source_hashes', {}).get(path) == hashes[path], f'{map_id} TLK fingerprint')
        index_count, count = struct.unpack_from('<II', data, 2)
        base = 0x1a + index_count * 4
        require(table.get('record_count') == count and len(table.get('records', [])) == count
                and table.get('record_base') == base and table.get('record_bytes') == 0x66f, f'{map_id} TLK table')
        for index, record in enumerate(table['records']):
            at = base + index * 0x66f
            raw = data[at:at + 0x66f]
            require(record.get('id') == index + 1 and u32(raw, 0x13) == index + 1
                    and record.get('offset') == at and record.get('raw_hex') == raw.hex()
                    and record.get('source') == dict(path=path, sha256=hashes[path], offset=at,
                         record_id=index + 1, record_bytes=0x66f), f'{map_id}:{index + 1} record')
            require(all(record.get(key) == u32(raw, off) for key, off in
                        [('mutation_type', 0x23), ('mutation_index', 0x27), ('mutation_bit', 0x2b)]),
                    f'{map_id}:{index + 1} mutation')
            # mutation5 index0 adds an item. index1 removes; mutation6 unlocks
            # a recipe and must never be interpreted as owned equipment.
            if record['mutation_type'] == 5 and record['mutation_index'] == 0:
                ident = record['mutation_bit']
                item(ident)
                grants.append(dict(kind='registered-story-item-grant',
                    map_id=map_id, record_id=record['id'], source=deepcopy(record['source']),
                    mutation_type=5, mutation_index=0, mutation_bit=ident))
    reachable, roots = registered_tlk_reachability(story, registration, original, hashes, require)
    for grant in grants:
        origin = reachable.get(f"{grant['map_id']}:{grant['record_id']}")
        if origin:
            sources.setdefault(str(grant['mutation_bit']), []).append(dict(**grant, entrance=deepcopy(origin)))
    # A shop's exact 32 WORD slots and an unlocked recipe are acquisition
    # sources. Admission still inspects the item's recovered use below.
    for key, entrance in reachable.items():
        map_id, record_id = key.rsplit(':', 1)
        record = story['maps'][map_id]['records'][int(record_id) - 1]
        raw = bytes.fromhex(record['raw_hex'])
        if record['kind'] == 5:
            # 4FF480 derives CHR names from the literal six DGP slots. Only
            # registered enemies in a reachable battle can admit their loot.
            for enemy_slot in range(6):
                token = text_field(raw, 0x4b + enemy_slot * 20, 20, 'ascii')
                if not token:
                    continue
                ident = Path(token).stem
                if registration['roles'].get(ident, {}).get('side') != 'enemy':
                    continue
                path = f'Fight_Role/{ident}.CHR'
                role = original[path]
                require(u32(role, 0) == 8 and len(role) >= 8 + 0x30b, f'{ident} reward header')
                for reward_slot in range(6):
                    at = 8 + 0xe8 + reward_slot * 4
                    reward_id = u32(role, at)
                    if not reward_id:
                        continue
                    item(reward_id)
                    sources.setdefault(str(reward_id), []).append(dict(kind='registered-enemy-reward',
                        map_id=map_id, record_id=record['id'], enemy_id=ident, enemy_slot=enemy_slot,
                        reward_slot=reward_slot, entrance=deepcopy(entrance),
                        battle_source=deepcopy(record['source']),
                        source=dict(path=path, sha256=hashes[path], offset=at, bytes=4,
                            raw_hex=role[at:at + 4].hex())))
        if record['kind'] == 8:
            for slot in range(32):
                ident = struct.unpack_from('<H', raw, 0x37 + slot * 2)[0]
                if not ident:
                    continue
                item(ident)
                sources.setdefault(str(ident), []).append(dict(kind='tlk-shop-item', map_id=map_id,
                    record_id=record['id'], slot=slot, entrance=deepcopy(entrance),
                    source=dict(path=record['source']['path'], sha256=record['source']['sha256'],
                        offset=record['offset'] + 0x37 + slot * 2, bytes=2,
                        raw_hex=raw[0x37 + slot * 2:0x39 + slot * 2].hex())))
        if record['mutation_type'] == 17 and record['mutation_bit']:
            ident = record['mutation_bit']
            item(ident)
            sources.setdefault(str(ident), []).append(dict(kind='registered-recipe-product', map_id=map_id,
                record_id=record['id'], source=deepcopy(record['source']), entrance=deepcopy(entrance)))
    for map_id in map_ids('story-data', registration):
        table = story['maps'][map_id]
        path = f'Map/{map_id.lower()}.dat'
        for selected in registration['maps'][map_id].get('objects', []):
            if selected['handler'] != 'keyed-chest':
                continue
            obj = next((row for row in table['objects'] if row['index'] == selected['index']), None)
            require(obj is not None, f'{map_id} keyed chest {selected["index"]}')
            at = obj['source']['offset']; raw = original[path][at:at + 0x112]
            require(raw.hex() == obj['raw_hex'] and obj['source']['sha256'] == hashes[path]
                    and table['map_source']['sha256'] == hashes[path]
                    and raw[0xCF] == 4 and u32(raw, 0xF6) == 0, f'{map_id} keyed chest source')
            for slot in range(10):
                ident = u32(raw, 0x54 + slot * 4)
                if not ident:
                    continue
                item(ident)
                sources.setdefault(str(ident), []).append(dict(kind='registered-map-chest-grant',
                    map_id=map_id, object_index=selected['index'], reward_slot=slot,
                    source=dict(path=path, sha256=hashes[path], offset=at + 0x54 + slot * 4,
                                bytes=4, raw_hex=raw[0x54 + slot * 4:0x58 + slot * 4].hex())))
    promoted, previous, rejected = [], {}, []
    for ident in sorted(sources, key=int):
        row = definitions[ident]
        if not plain_equipment_supported(row):
            rejected.append(dict(item_id=int(ident), behavior=row['behavior']['kind'],
                                 reason='not-recovered-plain-numeric-equipment'))
            continue
        if not row['availability']['enabled']:
            promoted.append(int(ident))
            previous[ident] = deepcopy(row['availability'])
            row['availability'] = dict(enabled=True, chapter_enabled=True, catalog_visible=True,
                default_enabled=True, reasons=['registered-source-equipment; pure-numeric-equip-and-linking-recovered'])
    return dict(policy='registered-source-plain-equipment-v1', promoted_item_ids=promoted,
        sources=sources, previous_availability=previous, rejected_sources=rejected,
        admitted_tlk_roots=roots, reachable_tlk_record_count=len(reachable),
        source_hashes=hashes, native_bootstrap=dict(procedure='0x47ae20', address='0x47af06',
            offset=bootstrap_offset, raw_hex=bootstrap.hex(), item_ids=initial_ids),
        scope='Menu equip/link capability only; no inventory grant, party ownership or special passive is inferred.')


def status_cure_supported(row):
    """Single allied mode1 removal with no field, stat-growth or other payload."""
    raw = bytes.fromhex(row['raw_hex'])
    block = raw[0x2a8:0x2a8 + 0xc6]
    return bool(row['record_status'] == 'defined' and raw[0x24:0x26] == b'\x05\x01'
        and row['initialization']['deterministic'] and row['validation']['all_value_ranges_ordered']
        and all(pair['minimum'] == pair['maximum'] == 0 for pair in row['value_ranges'])
        and raw[0x156] == 0 and raw[0x157] == 1 and i32(raw, 0x142) == 17
        and block[1] != 0 and block[0xb] == 1 and not any(raw[0x2a8 + 0xc6:])
        and row['raw_fields']['effect_token_raw_126'] != '')


def simple_restore_supported(row):
    """The same proven47D960 branch as8/11/12, selected by source fields."""
    raw = bytes.fromhex(row['raw_hex'])
    values = {pair['instance_offset']: pair['minimum'] for pair in row['value_ranges']}
    return bool(row['record_status'] == 'defined' and raw[0x24:0x26] == b'\x05\x01'
        and row['initialization']['deterministic'] and row['validation']['all_value_ranges_ordered']
        and all(value == 0 for at, value in values.items() if at not in (0xd, 0x15))
        and values[0xd] >= 0 and values[0x15] >= 0 and values[0xd] + values[0x15] > 0
        and raw[0x156:0x158] == b'\x00\x01' and i32(raw, 0x142) == 17
        and not any(raw[0x2a8:]) and row['raw_fields']['effect_token_raw_126'] != '')


def status_attack_supported(row):
    raw = bytes.fromhex(row['raw_hex'])
    block = raw[0x2a8:0x36e]
    return bool(row['record_status'] == 'defined' and raw[0x24:0x26] == b'\x05\x03'
        and row['initialization']['deterministic']
        and all(pair['minimum'] == pair['maximum'] == 0 for pair in row['value_ranges'])
        and raw[0x156:0x158] == b'\x00\x00' and i32(raw, 0x142) == 17
        and 0 < block[1] <= 100 and block[0xb] in (0, 2) and block[0x10] <= 1
        and not any(raw[0x36e:]))


def revival_item_supported(row):
    raw = bytes.fromhex(row['raw_hex'])
    block = raw[0x2a8:0x36e]
    values = {pair['instance_offset']: pair['minimum'] for pair in row['value_ranges']}
    return bool(row['record_status'] == 'defined' and raw[0x24:0x26] == b'\x05\x01'
        and row['initialization']['deterministic'] and row['validation']['all_value_ranges_ordered']
        and all(value == 0 for at, value in values.items() if at not in (0xd, 0x15, 0x31, 0x39))
        and all(values[at] >= 0 for at in (0xd, 0x15, 0x31, 0x39))
        and raw[0x156:0x158] == b'\x00\x01' and i32(raw, 0x142) == 17
        and block[0xb] == 3 and not any(block[0xc:]) and not any(raw[0x36e:])
        and row['raw_fields']['effect_token_raw_126'] != '')


def status_clear_supported(row):
    raw = bytes.fromhex(row['raw_hex'])
    block = raw[0x2a8:0x36e]
    return bool(row['record_status'] == 'defined' and raw[0x24:0x26] == b'\x05\x04'
        and row['initialization']['deterministic']
        and all(pair['minimum'] == pair['maximum'] == 0 for pair in row['value_ranges'])
        and raw[0x156:0x158] == b'\x00\x00' and i32(raw, 0x142) == 17
        and block[1] == 0 and block[0xb] == 5 and not any(raw[0x36e:]))


def admit_registered_status_cures(definitions, equipment_admission):
    # Provenance has already passed the original-byte checks above. Do not
    # enable all cure records merely because the interpreter supports mode1.
    sources, previous = {}, {}
    for ident, provenance in equipment_admission['sources'].items():
        row = definitions[ident]
        raw = bytes.fromhex(row['raw_hex'])
        if (row['record_status'] == 'defined' and raw[0x24:0x26] == b'\x03\x02'
                and row['initialization']['deterministic']
                and all(pair['minimum'] == pair['maximum'] == 0 for pair in row['value_ranges'])
                and not any(raw[0x126:0x13a]) and i32(raw, 0x142) == 0
                and not any(raw[0x2a8:0x392]) and not any(raw[0x3a7:])
                and raw[0x392] <= 5
                and all(1 <= u32(raw, 0x393 + index * 4) <= 416 for index in range(raw[0x392]))):
            sources[ident] = deepcopy(provenance)
            previous[ident] = {key: deepcopy(row[key]) for key in ('availability', 'behavior')}
            row['behavior'] = dict(kind='crafting-material', status='recovered',
                implemented_scope=['inventory-stack', 'native-service-material-input-output'], unverified_scope=[])
            row['availability'] = dict(enabled=True, chapter_enabled=True, catalog_visible=True, default_enabled=True,
                reasons=['registered-source-acquisition; native-material-exchange-recovered'])
            continue
        if simple_restore_supported(row):
            if row['availability']['enabled'] and row['behavior']['kind'] == 'simple-restore':
                continue
            sources[ident] = deepcopy(provenance)
            previous[ident] = {key: deepcopy(row[key]) for key in ('availability', 'behavior')}
            values = {pair['instance_offset']: pair['minimum'] for pair in row['value_ranges']}
            row['behavior'] = dict(kind='simple-restore', status='recovered',
                implemented_scope=['single-target-flat-hp-mp-restore'], unverified_scope=[])
            row['availability'] = dict(enabled=True, chapter_enabled=True, catalog_visible=True,
                default_enabled=True, reasons=['registered-source-acquisition; native-flat-resource-restoration-recovered'])
            row['effect'] = dict(restore_hp_flat=values[0xd], restore_mp_flat=values[0x15],
                restore_hp_percent=0, restore_mp_percent=0, revive=False)
            row['use_in_field'], row['use_in_battle'] = True, True
            row['battle'] = dict(animation_skill_id_raw_142=17, all_targets_raw_156=0, same_side_raw_157=1,
                effect_kind_raw_2b3=0, preparation_delay_added=0, target_state_max_exclusive=4,
                target_immune_must_be_zero=True, consume_only_on_native_success=True)
            continue
        attack, revival, clear = status_attack_supported(row), revival_item_supported(row), status_clear_supported(row)
        if attack or revival or clear:
            raw = bytes.fromhex(row['raw_hex'])
            sources[ident] = deepcopy(provenance)
            previous[ident] = {key: deepcopy(row[key]) for key in ('availability', 'behavior')}
            row['behavior'] = dict(kind='status-attack' if attack else 'status-clear' if clear else 'revival-item', status='recovered',
                implemented_scope=['battle-single-enemy-source-status'] if attack else ['battle-mode5-all-status-removal'] if clear else ['battle-mode3-revival', 'field-resource-restoration'],
                unverified_scope=[])
            row['availability'] = dict(enabled=True, chapter_enabled=True, catalog_visible=True, default_enabled=True,
                reasons=['registered-source-acquisition; native-item-status-or-revival-recovered'])
            values = {pair['instance_offset']: pair['minimum'] for pair in row['value_ranges']}
            row['effect'] = dict(restore_hp_flat=values[0xd], restore_mp_flat=values[0x15],
                restore_hp_percent=values[0x31], restore_mp_percent=values[0x39], revive=revival)
            if revival:
                row['revival'] = dict(effect_raw_hex=raw[0x2a8:0x36e].hex(), effect_id_raw=raw[0x2a9], mode_raw=3,
                    definition_offset=0x2a8, effect_bytes=0xc6)
            elif clear:
                row['status_clear'] = dict(effect_raw_hex=raw[0x2a8:0x36e].hex(), effect_id_raw=0, mode_raw=5,
                    definition_offset=0x2a8, effect_bytes=0xc6)
            else:
                row['status_attack'] = dict(effect_raw_hex=raw[0x2a8:0x36e].hex(), effect_id_raw=raw[0x2a9], mode_raw=raw[0x2b3],
                    definition_offset=0x2a8, effect_bytes=0xc6)
            row['use_in_field'], row['use_in_battle'] = revival, True
            row['battle'] = dict(animation_skill_id_raw_142=17, all_targets_raw_156=0, same_side_raw_157=raw[0x157],
                effect_kind_raw_2b3=raw[0x2b3], preparation_delay_added=0,
                target_state_max_exclusive=8 if revival else 4, target_immune_must_be_zero=True,
                consume_only_on_native_success=True)
            continue
        if not status_cure_supported(row):
            continue
        sources[ident] = deepcopy(provenance)
        previous[ident] = {key: deepcopy(row[key]) for key in ('availability', 'behavior')}
        row['behavior'] = dict(kind='status-cure', status='recovered',
            implemented_scope=['battle-single-allied-first-matching-status-removal'],
            unverified_scope=[])
        row['availability'] = dict(enabled=True, chapter_enabled=True, catalog_visible=True,
            default_enabled=True, reasons=['registered-source-grant; native-mode1-status-removal-recovered'])
        row['status_cure'] = dict(effect_id_raw=bytes.fromhex(row['raw_hex'])[0x2a9], mode_raw=1,
            effect_raw_hex=bytes.fromhex(row['raw_hex'])[0x2a8:0x36e].hex(),
            definition_offset=0x2a8, effect_bytes=0xc6,
            evidence='ev_4ee7cc8d9c675c3b1405324f30fb85a23397d5d5af06c75462626bf4fab5b54e')
        row['effect'] = dict(restore_hp_flat=0, restore_mp_flat=0, restore_hp_percent=0,
                             restore_mp_percent=0, revive=False)
        row['use_in_field'], row['use_in_battle'] = False, True
        row['battle'] = dict(animation_skill_id_raw_142=i32(bytes.fromhex(row['raw_hex']), 0x142),
            all_targets_raw_156=0, same_side_raw_157=1, effect_kind_raw_2b3=1,
            preparation_delay_added=0, target_state_max_exclusive=4,
            target_immune_must_be_zero=True, consume_only_on_native_success=True)
    return dict(policy='registered-source-item-capabilities-v1', promoted_item_ids=sorted(map(int, sources)),
        sources=sources, previous_definitions=previous,
        field_scope='47D960 restores admitted deterministic HP/MP fields; zero-field status cures cannot succeed or consume in the field.',
        battle_scope='41B3C0 calls 508BB0 then displays the source effect; consumes only on successful status removal or recovery.')


def equipment_immunity_supported(row):
    """47A6A0/508BB0 mode6 only; 509E10 skips its periodic and visual payload."""
    raw = bytes.fromhex(row['raw_hex'])
    block = raw[0x2a8:0x36e]
    return bool(row['record_status'] == 'defined'
        and (raw[0x24] in (1, 2) or raw[0x24:0x26] == b'\x03\x01')
        and row['initialization']['deterministic'] and row['validation']['all_value_ranges_ordered']
        and block[1] != 0 and block[0xb] == 6 and block[0x10] <= 1
        and i32(block, 2) == -1 and u32(block, 0xb8) == 0
        and (block[0x10] == 1 or not any(block[0x23:0xb8]))
        and not any(raw[0x126:0x13a]) and i32(raw, 0x142) == 0 and i32(raw, 0x3a7) == 0)


def admit_registered_equipment_passives(definitions, equipment_admission, capabilities):
    sources = {}
    for ident, provenance in equipment_admission['sources'].items():
        row = definitions[ident]
        if not equipment_immunity_supported(row):
            continue
        sources[ident] = deepcopy(provenance)
        capabilities['previous_definitions'][ident] = {
            key: deepcopy(row[key]) for key in ('availability', 'behavior')}
        raw = bytes.fromhex(row['raw_hex'])
        crystal = raw[0x24:0x26] == b'\x03\x01'
        row['behavior'] = dict(kind='status-immunity-crystal' if crystal else 'equip', status='recovered',
            implemented_scope=(['crystal-socketing', 'instance-attribute-linking'] if crystal
                else ['equipment-slot-transfer', 'instance-attribute-linking']) + ['battle-mode6-status-immunity'],
            unverified_scope=['crafting'] if crystal else [])
        row['availability'] = dict(enabled=True, chapter_enabled=True, catalog_visible=True,
            default_enabled=True, reasons=['registered-source-grant; native-equipment-mode6-immunity-recovered'])
        row['equipment_passive'] = dict(kind='status-immunity', effect_id_raw=raw[0x2a9], mode_raw=6,
            effect_raw_hex=raw[0x2a8:0x36e].hex(), definition_offset=0x2a8, effect_bytes=0xc6,
            application_chance_raw=raw[0x2b9],
            evidence='ev_3896095f57f082ad42c4995b1b3ba73f5f5609d82426b7ab65f7767e8e10445b')
    capabilities['passive_sources'] = sources
    capabilities['passive_item_ids'] = sorted(map(int, sources))
    capabilities['promoted_item_ids'] = sorted(set(capabilities['promoted_item_ids']) | set(map(int, sources)))
    capabilities['passive_scope'] = ('4451C0 -> 47A6A0 scans equipment and retained sockets in native group/entry order; '
        '508BB0 preserves duplicate-before-RNG and inclusive chance. Mode6 blocks only matching incoming status IDs, '
        'never ticks or renders, and does not revive or apply its dormant numeric payload.')
    return capabilities


def export():
    registration = content_definition()
    paths = source_files(registration)
    original = {p: (ROOT / p).read_bytes() for p in paths}
    hashes = {p: sha(raw) for p, raw in original.items()}
    assert hashes['GAME.exe'] == GAME_SHA and hashes['SYSTEM/Object.ITM'] == ITM_SHA
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
    status_path = RUNTIME / 'evidence/fire_valley_20261024/stage12_status_apply.json'
    status_proof = json.loads(status_path.read_text('utf-8'))
    assert status_proof['subject']['digest']['sha256'] == GAME_SHA
    assert status_proof['parameters']['procedure'] == '0x508bb0'
    evidence['status_removal'] = dict(evidence_id=status_proof['evidence_id'], procedure='0x508bb0',
        operation=status_proof['operation'], bundle=status_path.relative_to(ROOT).as_posix(),
        branch='0x508c45..0x508d11 mode1 first matching ID removal; success1/no-match0; no RNG')
    passive_path = RUNTIME / 'evidence/white_forest_20261026/reward_passives/native_bundle.json'
    passive_records = json.loads(passive_path.read_text('utf-8'))['records']
    for label, procedure in [('equipment_passive_load', '0x47a6a0'), ('equipment_passive_apply', '0x508bb0'),
                             ('equipment_passive_tick', '0x509e10')]:
        record = next(r for r in passive_records if r['operation'] == 'procedure_assembly'
                      and r['parameters']['procedure'] == procedure)
        assert record['subject']['digest']['sha256'] == GAME_SHA
        evidence[label] = dict(evidence_id=record['evidence_id'], procedure=procedure,
            operation=record['operation'], bundle=passive_path.relative_to(ROOT).as_posix())
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
    input_paths = ('opening_seed.json', 'chapter_story.json', 'runtime_content.json')
    inputs = {name: (RUNTIME / 'web/data' / name).read_bytes() for name in input_paths}
    assert json.loads(inputs['runtime_content.json']) == registration, 'Content authoring changed during item export'
    admission = admit_registered_equipment(definitions, json.loads(inputs['opening_seed.json']),
        json.loads(inputs['chapter_story.json']), registration)
    capabilities = admit_registered_status_cures(definitions, admission)
    admit_registered_equipment_passives(definitions, admission, capabilities)
    admission['generated_input_hashes'] = {f'data/{name}': sha(raw) for name, raw in inputs.items()}
    enabled_ids = [row['id'] for row in definitions.values() if row['availability']['enabled']]
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
    assert {k for k, r in definitions.items() if 'effect' in r} == {'8', '11', '12'} | {
        ident for ident in capabilities['sources'] if definitions[ident]['behavior']['kind'] != 'crafting-material'}
    assert all(len(row['value_ranges']) == 32 and row['source']['record_sha256'] == sha(bytes.fromhex(row['raw_hex']))
               and row['validation']['drop_rate_in_native_range'] and row['validation']['target_flags_are_boolean']
               for row in definitions.values())
    indexes = catalog_indexes(definitions)
    duplicate_names = {name: ids for name, ids in indexes['by_name'].items() if len(ids) > 1}
    reconstructed = itm[:0x61c] + b''.join(bytes.fromhex(definitions[str(ident)]['raw_hex'])
                                        for ident in indexes['ids'])
    assert reconstructed == itm and sha(reconstructed) == ITM_SHA
    output = RUNTIME / 'web/data/items.json'
    value = dict(schema='seventh-seal-chapter-items', version=1, slots=SLOTS,
                 definitions=definitions, indexes=indexes, source_hashes=hashes, evidence=evidence,
                 catalog=dict(record_count=count, header_bytes=0x61c, record_bytes=0x3bf,
                    count_field_offset=0x20, header_raw_hex=itm[:0x61c].hex(),
                    complete_source_coverage=True, empty_record_ids=[],
                    placeholder_record_ids=[r['id'] for r in definitions.values() if r['record_status']=='placeholder'],
                    internal_record_ids=indexes['by_record_status'].get('internal-source', []),
                    unknown_category_item_ids=indexes['by_category'].get('unknown', []),
                    duplicate_names=duplicate_names,
                    index_policy=dict(by_id='definitions[str(original item ID)]; no renumbering',
                        lookup_values='Original numeric IDs, ascending; all records retained, including placeholders and internal records.',
                        by_name='Exact cp936-decoded source name; values are lists because names are not unique. Reference by ID after choosing a record.',
                        by_type_subtype='Original type and subtype bytes joined with a colon; categories do not assign unrecovered mechanics.',
                        by_allowed_role='Three-digit numeric role ID for each set bit in the raw uint32 role mask. This source lookup does not enable items or assert usable behavior.',
                        availability='Source indexes are independent of runtime activation. config/items.json remains the only editable parameter catalog.'),
                    default_enabled_item_ids=enabled_ids, original_chapter_item_ids=IDS,
                    equipment_admission=admission, item_capability_admission=capabilities,
                    simple_restore_item_ids=sorted(int(ident) for ident, row in definitions.items() if row['behavior']['kind'] == 'simple-restore'),
                    source_value_ranges_per_record=32, source_range_issues=range_issues,
                    random_initialization_item_ids=variable_ids,
                    classification_counts=dict(Counter(r['category'] for r in definitions.values())),
                    behavior_counts=dict(Counter(r['behavior']['kind'] for r in definitions.values())),
                    compatibility='The original eight chapter IDs retain their contracts. Registered source grants enable verified numeric equipment, native mode1 cures, and mode6 equipment/crystal immunity. Admission never grants inventory.',
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
                                   battle_target_gate='0x41B3C0 permits recovered mode0/1 for immune byte0 and state<4; displayed HP is not an additional gate. Invalid targets consume no item.',
                                   battle_consumption='41B3C0 consumes only if 508BB0 or 47D960 returns success. Nonzero HP/MP restore succeeds even when full; mode1 no-match fails without consumption.',
                                   status_removal='508BB0 mode1 rejects duplicate id/mode1, otherwise clears the first matching ID and calls508300; no RNG or 508A90 contact-removal pass.'),
                 source=dict(native_bundle_sha256=sha(proof_path.read_bytes()),
                             native_scheduler_bundle_sha256=sha(scheduler_path.read_bytes()),
                             native_drop_bundle_sha256=sha(drop_path.read_bytes()),
                             native_status_bundle_sha256=sha(status_path.read_bytes()),
                             original_game_executed=False,
                             limitations=['Static shipped binary evidence; original execution was not observed.',
                                          'Battle item gauge and zero added preparation debt are native verified; live menu timing and animation completion remain remake adapters.',
                                          'Default capability includes the original chapter set, registered source plain equipment, and registered native mode1 cure grants. Other records remain disabled by default unless an independent recovered handler admits them.',
                                          'Only registered-source mode6 immunity passives and stat crystals are recovered; crafting, other passives and growth/revival item handlers remain unverified.',
                                          'ID31 has a variable range and ID36 has a reversed range in the shipped source; they are retained rather than silently repaired.',
                                          'Special slot label is a remake UI label for source category5; each enabled definition requires registered source provenance.']))
    write(output, value)
    assert all((ROOT / p).read_bytes() == raw for p, raw in original.items())
    assert all((RUNTIME / 'web/data' / name).read_bytes() == raw for name, raw in inputs.items())
    report = dict(schema='seventh-seal-chapter-item-export', version=1, passed=True,
                  source_bytes_unchanged=True, source_hashes=hashes,
                  output_path=output.relative_to(ROOT).as_posix(), output_sha256=sha(output.read_bytes()),
                  item_ids=list(range(1, count + 1)), enabled_item_ids=enabled_ids,
                  equipment_admission=admission,
                  item_capability_admission=capabilities,
                  generated_input_hashes=admission['generated_input_hashes'],
                  record_count=count, value_range_checks=count * len(VALUE_PAIRS),
                  source_reconstruction_exact=True, reconstructed_source_bytes=len(reconstructed),
                  reconstructed_source_sha256=sha(reconstructed),
                  duplicate_names=duplicate_names,
                  index_key_counts={key: len(rows) for key, rows in indexes.items()},
                  internal_record_ids=value['catalog']['internal_record_ids'],
                  unknown_category_item_ids=value['catalog']['unknown_category_item_ids'],
                  deterministic_initialized_records=sum('initialized_raw_hex' in r for r in definitions.values()),
                  source_range_issues=range_issues, random_initialization_item_ids=variable_ids,
                  behavior_counts=value['catalog']['behavior_counts'],
                  classification_counts=value['catalog']['classification_counts'],
                  placeholder_record_ids=value['catalog']['placeholder_record_ids'],
                  forest_drop_definition_checks=forest_checks,
                  simple_effects={k:r['effect'] for k,r in definitions.items() if r['behavior']['kind']=='simple-restore'},
                  status_cures={k:r['status_cure'] for k,r in definitions.items() if r['behavior']['kind']=='status-cure'},
                  original_game_execution_observed=False, evidence=evidence)
    write(RUNTIME / 'evidence/chapter_items_export.json', report)
    print(json.dumps(dict(record_count=count, enabled_item_ids=enabled_ids,
        behavior_counts=report['behavior_counts'], value_range_checks=report['value_range_checks'],
        deterministic_initialized_records=report['deterministic_initialized_records'],
        source_range_issues=range_issues, simple_effects=report['simple_effects'],
        forest_drop_definition_checks=len(forest_checks), source_bytes_unchanged=True)))

if __name__ == '__main__': export()
