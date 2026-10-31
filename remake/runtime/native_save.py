"""Original v2 saves at the file boundary; the browser uses ordinary world objects.

Layout: GAME.exe 4789D0/478C80, retained in rea_format_evidence.json.
Unmapped native bytes travel with a loaded world and are written back verbatim.
Fresh games are built from the shipped runtime resource definitions, not a save.
"""
from base64 import b64decode, b64encode
from copy import deepcopy
from functools import cache
from io import BytesIO
from pathlib import Path
import hashlib
import json
import struct

from PIL import Image
from tools.source.save_format import complete_layout

DATA = Path(__file__).resolve().parent / 'web' / 'data'
U32 = struct.Struct('<I')
ROLE_BYTES = 0x30B
ACTOR_BYTES = 0x4C5
ITEM_BYTES = 0xE5


@cache
def resources():
    seed = json.loads((DATA / 'opening_seed.json').read_bytes())
    skills = json.loads((DATA / 'party_skills.json').read_bytes())['roles']
    items = json.loads((DATA / 'items.json').read_bytes())['definitions']
    story = json.loads((DATA / 'chapter_story.json').read_bytes())['maps']
    # Retain only the native map records used by save serialization.
    maps = {key: {k: value.get(k) for k in ('name', 'header_raw_hex', 'npc_records', 'objects')}
            for key, value in story.items()}
    areas = json.loads((DATA / 'world_map.json').read_bytes())['areas']
    return seed, skills, items, maps, areas


def u32(raw, offset=0):
    return U32.unpack_from(raw, offset)[0]


def put(raw, offset, value):
    U32.pack_into(raw, offset, int(value) & 0xFFFFFFFF)


def text(raw, offset, length, encoding='cp936'):
    return raw[offset:offset + length].split(b'\0', 1)[0].decode(encoding)


@cache
def map_actions():
    roles = json.loads((DATA / 'chapter_map_resources.json').read_bytes())['roles']
    return {key: {a['index']: (a['sequence_raw'][:a['logical_count']] if a['uses_sequence'] else None)
                  for a in role['actions']} for key, role in roles.items()}


@cache
def player_action_channels():
    roles = json.loads((DATA / 'chapter_map_resources.json').read_bytes())['roles']
    result = {}
    for index in range(1, 7):
        channels = bytearray([255] * 20)
        for action in roles[f'{index:03}']['actions']:
            channel = bytes.fromhex(action['raw_hex'])[0x7E]
            if channel < 20 and channels[channel] == 255:
                channels[channel] = action['index']
        if channels[1] == 255:
            channels[1] = channels[0]
        result[index] = channels
    return result


def initial_map_actor(index, map_header, position):
    # 4B5E80/4B62E0/4B5EF0/49D7E0/469F50, native_actor_init.json.
    actor = bytearray(ACTOR_BYTES)
    actor[0x46:0x5A] = player_action_channels()[index]
    actor[0x2F] = actor[0x47]
    for offset, value in ((0x28, index), (0xD6, 50), (0x2B6, 1), (0x2BF, 75),
                          (0x3B3, 2), (0x3B7, 1), (0x93, u32(map_header, 0x92))):
        put(actor, offset, value)
    actor[0x97], actor[0xF3], actor[0xF6] = 1, 2, 15
    for offset in (0x30, 0x34, 0x6F, 0x73):
        put(actor, offset, position)
    return actor


def image_png(raw):
    if len(raw) != 104 * 76 * 2:
        raise ValueError('原版存档缩略图长度无效')
    pixels = bytearray()
    for (value,) in struct.iter_unpack('<H', raw):
        r, g, b = value >> 11, value >> 5 & 63, value & 31
        pixels.extend(((r * 255 + 15) // 31, (g * 255 + 31) // 63, (b * 255 + 15) // 31))
    output = BytesIO()
    Image.frombytes('RGB', (104, 76), bytes(pixels)).save(output, format='PNG')
    return 'data:image/png;base64,' + b64encode(output.getvalue()).decode('ascii')


def native_preview(envelope, fallback):
    preview = envelope.get('preview', {})
    if not preview or preview.get('payload_sha256') != envelope['sha256']:
        return fallback
    image = Image.open(BytesIO(b64decode(preview['png'].split(',', 1)[1]))).convert('RGB')
    if image.size != (104, 76):
        raise ValueError('存档截图应为104×76')
    out = bytearray()
    for r, g, b in struct.iter_unpack('BBB', image.tobytes()):
        out.extend(struct.pack('<H', ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)))
    return bytes(out)


def decode_native_save(raw):
    """Validate an external native file once and restore its playable state."""
    seed, skills, items, maps, areas = resources()
    layout = complete_layout(raw, {int(k): v['name'] for k, v in items.items()})
    sections = {row['section']: raw[row['offset']:row['offset'] + row['length']]
                for row in layout['sections'] if row['section'] != 'role'}
    header = sections['header']
    map_id = text(header, 0x39, 20, 'ascii').upper().removesuffix('.DAT')
    map_actors = sections['map_objects']
    leader = u32(header, 0x69)
    if leader >= 10:
        raise ValueError('原版存档领队编号无效')
    dynamic = 8 + 10 * ACTOR_BYTES
    actor = map_actors[dynamic + leader * ACTOR_BYTES:dynamic + (leader + 1) * ACTOR_BYTES]
    world = dict(schema='seventh-seal-world', version=1, revision=0,
                 location=dict(map_id=map_id, x=u32(actor, 0x6F) * 2,
                               y=u32(actor, 0x73) * 2, direction=actor[0x45]),
                 leader_id=f'{leader + 1:03}', party=[], reserve_party=[], inventory=[],
                 flags=list(struct.unpack('<2000I', sections['flags'])),
                 event_records=[], object_states={}, money=u32(header, 0x81), reward_records=[],
                 source={**deepcopy(seed['source']), 'kind': 'native-save',
                         'path': 'native-save', 'sha256': hashlib.sha256(raw).hexdigest()},
                 native_save={'raw': b64encode(raw).decode('ascii')},
                 equipment={'version': 1, 'roles': {}}, crystal_sockets={'version': 1, 'roles': {}},
                 technique_bindings={'version': 1, 'roles': {}},
                 technique_combinations={'version': 1, 'roles': {}})
    counts = struct.unpack_from('<2000I', sections['events'])
    at = 8000
    for count in counts:
        world['event_records'].append([sections['events'][at + i * 14:at + (i + 1) * 14].hex()
                                       for i in range(count)])
        at += count * 14
    equipment = sections['equipment']
    combo = sections['combo_state']
    counters = {}
    for saved in layout['characters']:
        if not saved['name']:
            continue
        index = saved['role_index']
        role_id = f'{index + 1:03}'
        head = raw[saved['header_offset']:saved['header_offset'] + ROLE_BYTES]
        progress = {'version': 2, 'learned_indices': [], 'records': []}
        for entry in saved['skills']:
            fixed = raw[entry['record_offset']:entry['record_offset'] + 0x41D]
            if fixed[0x23]:
                progress['learned_indices'].append(entry['index'])
            initial = bytes.fromhex(skills[role_id]['skills'][entry['index']]['fixed_raw_hex'])
            if fixed[0x2D] != initial[0x2D] or fixed[0x2FB:0x2FF] != initial[0x2FB:0x2FF]:
                progress['records'].append(dict(index=entry['index'], level=fixed[0x2D],
                                               experience=struct.unpack_from('<i', fixed, 0x2FB)[0]))
        role = dict(id=role_id, name=saved['name'], level=saved['level'], hp=saved['hp'], mp=saved['mp'],
                    attributes_stored=dict(attack=saved['attack'], defense=saved['defense']),
                    combat_progress=dict(header_raw_hex=head.hex()), skill_progress=progress)
        counter = map_actors[dynamic + index * ACTOR_BYTES + 0xC2]
        if saved['state_byte']:
            world['party'].append(role)
            counters[role_id] = counter
        else:
            world['reserve_party'].append({'role': role,
                'encounter_progress': {'counter': counter, 'remainder': 0}})
        worn, sockets = [], [None] * 6
        for group in range(10):
            for entry in range(10):
                at = (index * 100 + group * 10 + entry) * ITEM_BYTES
                record = equipment[at:at + ITEM_BYTES]
                ident = u32(record)
                if not ident:
                    continue
                definition = items[str(ident)]
                item = dict(instance_id=f'native-equip:{index}:{group}:{entry}', id=ident,
                            name=definition['name'], quantity=u32(record, 4), source_raw_hex=record.hex())
                if entry == 0 and definition.get('slot_id'):
                    item.update(slot_id=definition['slot_id'], quantity=1)
                    worn.append(item)
                elif group == 0 and 1 <= entry <= 6:
                    sockets[entry - 1] = item
        world['equipment']['roles'][role_id] = worn
        world['crystal_sockets']['roles'][role_id] = sockets
        base = index * ACTOR_BYTES
        bindings = []
        for slot in range(7):
            at = base + 0x22 + slot * 10
            bindings.append(dict(type=u32(combo, at), index_one_based=u32(combo, at + 4),
                                 icon=combo[at + 8], color=combo[at + 9]))
        world['technique_bindings']['roles'][role_id] = bindings
        combinations = []
        for number in range(u32(combo, base)):
            fixed = combo[base + 0x8D + number * 36:base + 0x8D + (number + 1) * 36]
            combinations.append(dict(icon=u32(fixed), name_codes=list(fixed[4:24].split(b'\0', 1)[0]),
                                     total_units=fixed[24], indices=list(fixed[26:26 + fixed[25]]),
                                     native_raw_hex=fixed.hex()))
        world['technique_combinations']['roles'][role_id] = combinations
    if not world['party'] or not any(r['id'] == world['leader_id'] for r in world['party']):
        raise ValueError('原版存档没有有效的当前队伍')
    world['encounters'] = dict(rng_state=0x20261011, counters=counters,
                              remainders={key: 0 for key in counters})
    inventory = sections['inventory']
    for index in range(u32(inventory)):
        record = inventory[4 + index * ITEM_BYTES:4 + (index + 1) * ITEM_BYTES]
        ident = u32(record)
        world['inventory'].append(dict(instance_id=f'native-bag:{index}', id=ident,
                                       name=items[str(ident)]['name'], quantity=u32(record, 4),
                                       source_raw_hex=record.hex()))
    world['formation_slots'] = [f'{u32(sections["last_fixed"], slot * 20):03}'
                                if u32(sections['last_fixed'], slot * 20) else None for slot in range(4)]
    world['world_map'] = {'areas': [dict(id=index, selected_index=sections['global_block'][index * 0xEC + 4],
                                        statuses=[sections['global_block'][index * 0xEC + 6 + i * 0x17]
                                                  for i in range(7)]) for index in range(2)]}
    world['map_npc_state'] = dict(map_id=map_id, actors=[])
    for slot in range(10, 10 + u32(map_actors, 4 + 10 * ACTOR_BYTES)):
        actor = map_actors[dynamic + slot * ACTOR_BYTES:dynamic + (slot + 1) * ACTOR_BYTES]
        action, logical = u32(actor, 0x83), u32(actor, 0x7B)
        sequence = map_actions().get(f'{u32(actor, 0x28):03}', {}).get(action)
        frame = sequence[logical % len(sequence)] if sequence else logical
        world['map_npc_state']['actors'].append(dict(slot=slot, x=u32(actor, 0x6F) * 2,
            y=u32(actor, 0x73) * 2, direction=actor[0x45], hidden=bool(actor[0x97]),
            action=action, frame=frame))
    world['recipe_unlock_indices'] = list(struct.unpack_from(f'<{u32(sections["last_table"])}I', sections['last_table'], 4))
    payload = json.dumps(world, ensure_ascii=False, separators=(',', ':'))
    digest = hashlib.sha256(payload.encode('utf-8')).hexdigest()
    return dict(schema='seventh-seal-save', version=1, payload=payload, sha256=digest, saved_at=None,
                preview=dict(version=1, width=104, height=76, payload_sha256=digest,
                             png=image_png(sections['preview'])))


def upgrade_skill(fixed):
    """GAME.exe 50C000; used to fold saved remake rank progress into CHR bytes."""
    fixed[0x23] = 1
    if fixed[0x2D] >= 7:
        return
    fixed[0x2D] += 1
    get = lambda at: struct.unpack_from('<i', fixed, at)[0]
    signed = lambda n: (n + 0x80000000) % 0x100000000 - 0x80000000
    for pair in range(8):
        for side in range(2):
            at = 0xAB + pair * 8 + side * 4
            value = signed(get(at) + get(0x303 + pair * 4))
            put(fixed, at, value + int(signed(value * get(0x327 + pair * 4)) / 100))
    for at, increment in ((0x14B, 0x327), (0x14F, 0x32F), (0x153, 0x337),
                          (0x157, 0x33B), (0x15B, 0x33F), (0x15F, 0x343)):
        put(fixed, at, get(at) + get(increment))
    for index in range(5):
        fixed[0xFB + index] = (fixed[0xFB + index] + fixed[0x34B + index]) & 255
        fixed[0x100 + index] = (fixed[0x100 + index] + fixed[0x350 + index]) & 255
    for index in range(10):
        increment = fixed[0x355 + index]
        put(fixed, 0x105 + index * 4, get(0x105 + index * 4) + (increment - 256 if increment > 127 else increment))
    fixed[0x12D] = (fixed[0x12D] + fixed[0x35F]) & 255


def encode_native_save(envelope):
    """Turn one validated browser world into the original sequential v2 format."""
    if not isinstance(envelope, dict) or envelope.get('schema') != 'seventh-seal-save' or envelope.get('version') != 1:
        raise ValueError('存档封装版本不兼容')
    payload = envelope.get('payload')
    if not isinstance(payload, str) or hashlib.sha256(payload.encode('utf-8')).hexdigest() != envelope.get('sha256'):
        raise ValueError('存档校验失败，原存档已保留')
    world = json.loads(payload)
    if world.get('schema') != 'seventh-seal-world' or world.get('version') != 1:
        raise ValueError('存档世界格式不兼容')
    seed, skills, items, maps, areas = resources()
    base = b64decode(world['native_save']['raw']) if world.get('native_save') else None
    layout = complete_layout(base, {int(k): v['name'] for k, v in items.items()}) if base else None
    sections = {row['section']: bytearray(base[row['offset']:row['offset'] + row['length']])
                for row in layout['sections'] if row['section'] != 'role'} if base else {}
    header = sections.get('header', bytearray(0x3C1))
    put(header, 0, 2)
    header[8:33] = b'Copyright 2002 SoftWorld\0'.ljust(25, b'\0')
    put(header, 0x30, 0x2002)
    header[0x38] = 1
    map_id = world['location']['map_id']
    current_map = maps[map_id]
    same_map = bool(base and text(header, 0x39, 20, 'ascii').upper() == map_id + '.DAT')
    header[0x39:0x4D] = (map_id + '.DAT').encode('ascii').ljust(20, b'\0')
    header[0x4D:0x61] = current_map['name'].encode('cp936').ljust(20, b'\0')
    leader = int(world['leader_id']) - 1
    put(header, 0x69, leader)
    put(header, 0x81, world.get('money', seed['money']))
    preview = native_preview(envelope, bytes(sections.get('preview', bytes(104 * 76 * 2))))
    flags = struct.pack('<2000I', *world['flags'])
    records = world['event_records']
    events = struct.pack('<2000I', *(len(rows) for rows in records)) + b''.join(bytes.fromhex(r) for rows in records for r in rows)
    owned = {r['id']: r for r in world['party']}
    owned.update({r['role']['id']: r['role'] for r in world.get('reserve_party', [])})
    formation = world.get('formation_slots', [r['id'] for r in world['party']] + [None] * (4 - len(world['party'])))
    equipment = sections.get('equipment', bytearray(100 * 0x8F2))
    for role_id in skills:
        index = int(role_id) - 1
        rows = world.get('equipment', {}).get('roles', {}).get(role_id)
        if rows is None:
            rows = [dict(id=row['item_id'], source_raw_hex=row['source_raw_hex'],
                         slot_id=items[str(row['item_id'])]['slot_id'])
                    for row in seed['source']['initial_equipment'] if row['role_id'] == role_id]
        for group in range(6):
            at = (index * 100 + group * 10) * ITEM_BYTES
            equipment[at:at + ITEM_BYTES] = bytes(ITEM_BYTES)
        for row in rows:
            definition = items[str(row['id'])]
            at = (index * 100 + definition['group_index'] * 10) * ITEM_BYTES
            equipment[at:at + ITEM_BYTES] = bytes.fromhex(row['source_raw_hex'])
        if role_id in world.get('crystal_sockets', {}).get('roles', {}):
            for number, row in enumerate(world['crystal_sockets']['roles'][role_id], 1):
                at = (index * 100 + number) * ITEM_BYTES
                equipment[at:at + ITEM_BYTES] = bytes.fromhex(row['source_raw_hex']) if row else bytes(ITEM_BYTES)
    inventory = bytearray(U32.pack(len(world['inventory'])))
    for item in world['inventory']:
        record = bytearray.fromhex(item['source_raw_hex'])
        put(record, 0, item['id'])
        put(record, 4, item['quantity'])
        inventory.extend(record)
    map_objects = sections['map_objects'] if same_map else bytearray(8 + (20 + len(current_map['npc_records'])) * ACTOR_BYTES)
    put(map_objects, 0, leader)
    put(map_objects, 4 + 10 * ACTOR_BYTES, len(current_map['npc_records']))
    dynamic = 8 + 10 * ACTOR_BYTES
    if not same_map:
        if base:
            old = sections['map_objects']
            map_objects[4:4 + 10 * ACTOR_BYTES] = old[4:4 + 10 * ACTOR_BYTES]
            map_objects[dynamic:dynamic + 10 * ACTOR_BYTES] = old[4:4 + 10 * ACTOR_BYTES]
        else:
            map_header = bytes.fromhex(current_map['header_raw_hex'])
            shift = map_header[0x142] or 3
            for index in range(6):
                at = 4 + index * ACTOR_BYTES
                map_objects[at:at + ACTOR_BYTES] = initial_map_actor(index + 1, map_header, 20 << shift)
                at = dynamic + index * ACTOR_BYTES
                map_objects[at:at + ACTOR_BYTES] = initial_map_actor(index + 1, map_header, 0)
        for npc in current_map['npc_records']:
            at = dynamic + npc['slot_zero_based'] * ACTOR_BYTES
            map_objects[at:at + ACTOR_BYTES] = bytes.fromhex(npc['raw_hex'])
    for role in world['party']:
        index = int(role['id']) - 1
        at = dynamic + index * ACTOR_BYTES
        if not u32(map_objects, at + 0x28):
            put(map_objects, at + 0x28, index + 1)
        map_objects[at + 0xC2] = world.get('encounters', {}).get('counters', {}).get(role['id'], 0)
        if index == leader:
            put(map_objects, at + 0x6F, round(world['location']['x'] / 2))
            put(map_objects, at + 0x73, round(world['location']['y'] / 2))
            map_objects[at + 0x45] = world['location']['direction']
            map_objects[at + 0x97] = 0
            if not same_map:
                map_objects[at + 0xEF] = 1
    if world.get('map_npc_state', {}).get('map_id') == map_id:
        for npc in world['map_npc_state']['actors']:
            at = dynamic + npc['slot'] * ACTOR_BYTES
            for offset, key in ((0x6F, 'x'), (0x73, 'y')):
                put(map_objects, at + offset, round(npc[key] / 2))
            map_objects[at + 0x45] = npc['direction']
            map_objects[at + 0x97] = int(npc['hidden'])
            old_action, logical = u32(map_objects, at + 0x83), u32(map_objects, at + 0x7B)
            sequence = map_actions().get(f'{u32(map_objects, at + 0x28):03}', {}).get(npc['action'])
            if sequence:
                if old_action != npc['action'] or sequence[logical % len(sequence)] != npc['frame']:
                    logical = sequence.index(npc['frame'])
            else:
                logical = npc['frame']
            put(map_objects, at + 0x83, npc['action'])
            put(map_objects, at + 0x7B, logical)
    global_block = sections.get('global_block', bytearray(472))
    if not base:
        for area in areas:
            for destination in area['destinations']:
                at = area['id'] * 0xEC + 6 + destination['index'] * 0x17
                global_block[at:at + 0x17] = bytes.fromhex(destination['source']['raw_hex'])
    for area in world.get('world_map', {'areas': areas})['areas']:
        at = area['id'] * 0xEC
        global_block[at + 4] = area['selected_index']
        global_block[at + 5] = 7
        for number, status in enumerate(area['statuses']):
            global_block[at + 6 + number * 0x17] = status
    scene_world = sections.get('world', bytearray(274 + 12 + 2000))
    combo = sections.get('combo_state', bytearray(12210))
    roles = []
    for index in range(10):
        role_id = f'{index + 1:03}'
        role = owned.get(role_id)
        source = skills.get(role_id)
        original = layout['characters'][index] if layout else None
        if original:
            head = bytearray(base[original['header_offset']:original['header_offset'] + ROLE_BYTES])
            skill_records = [bytearray(base[s['record_offset']:s['end_offset']]) for s in original['skills']]
        elif source:
            head = bytearray.fromhex(source['header_raw_hex'])
            skill_records = [bytearray.fromhex(s['fixed_raw_hex'] + ''.join(a['raw_hex'] for a in s['actions'])) for s in source['skills']]
        else:
            head, skill_records = bytearray(ROLE_BYTES), []
        if role:
            if role.get('combat_progress'):
                head = bytearray.fromhex(role['combat_progress']['header_raw_hex'])
            put(head, 0x24, role['level'])
            for key, offset in (('hp', 0x30), ('mp', 0x38)):
                put(head, offset, role[key]['current'])
                put(head, offset + 4, role[key]['maximum'])
            for key, offset in (('attack', 0x40), ('defense', 0x48)):
                put(head, offset, role['attributes_stored'][key]['current'])
                put(head, offset + 4, role['attributes_stored'][key]['base'])
            old_formation = [f'{u32(sections["last_fixed"], n * 20):03}'
                             if u32(sections['last_fixed'], n * 20) else None for n in range(4)] if base else None
            if role_id in formation and formation != old_formation:
                put(head, 0x2B3, formation.index(role_id))
            progress = role.get('skill_progress', {})
            for entry in progress.get('records', []):
                record = skill_records[entry['index']]
                for _ in range(max(0, entry['level'] - max(1, record[0x2D]))):
                    upgrade_skill(record)
                record[0x2D] = entry['level']
                put(record, 0x2FB, entry['experience'])
            for number in progress.get('learned_indices', []):
                skill_records[number][0x23] = 1
        for pending in world.get('native_pending_skill_unlocks', []):
            if pending['role_id'] == role_id:
                match = next((s for s in skill_records if s[0] == pending['source_skill_id']), None)
                if match is not None:
                    match[0x23] = 1
        put(head, 0, len(skill_records))
        roles.append(bytes([int(any(r['id'] == role_id for r in world['party']))]) + struct.pack('<II', 8, 0) + head + b''.join(skill_records))
        at = index * ACTOR_BYTES
        if source and not base:
            default_indices = source['default_hotkey_indices']
            for number, skill_index in enumerate(default_indices):
                skill = bytes.fromhex(source['skills'][skill_index]['fixed_raw_hex'])
                start = at + 0x22 + number * 10
                struct.pack_into('<II2B', combo, start, 0, skill_index + 1, (u32(skill, 0x32) >> 4) & 15, u32(skill, 0x36) & 255)
            for number in range(4):
                struct.pack_into('<II2B', combo, at + 0x22 + (number + 3) * 10, 2, number + 1, number, 0)
        combinations = world.get('technique_combinations', {}).get('roles', {}).get(role_id)
        if combinations is not None:
            put(combo, at, len(combinations))
            for number, entry in enumerate(combinations):
                combo[at + 0x8D + number * 36:at + 0x8D + (number + 1) * 36] = bytes.fromhex(entry['native_raw_hex'])
        bindings = world.get('technique_bindings', {}).get('roles', {}).get(role_id)
        if bindings:
            for number, entry in enumerate(bindings):
                struct.pack_into('<II2B', combo, at + 0x22 + number * 10, entry['type'], entry['index_one_based'], entry['icon'], entry['color'])
        elif role_id in world.get('skill_shortcuts', {}).get('roles', {}):
            for number, skill_index in enumerate(world['skill_shortcuts']['roles'][role_id]):
                skill = skill_records[skill_index]
                struct.pack_into('<II2B', combo, at + 0x22 + number * 10, 0, skill_index + 1, (u32(skill, 0x32) >> 4) & 15, u32(skill, 0x36) & 255)
    formation_bytes = sections.get('last_fixed', bytearray(80))
    for index, role_id in enumerate(formation):
        put(formation_bytes, index * 20, int(role_id) if role_id else 0)
    unlocked = world.get('recipe_unlock_indices')
    last_table = struct.pack('<I', len(unlocked)) + struct.pack(f'<{len(unlocked)}I', *unlocked) if unlocked is not None else sections.get('last_table', bytes(4))
    put(header, 0x85, len(world['party']))
    header[0x89:0x3A9] = bytes(800)
    for index, role in enumerate(world['party']):
        at = 0x89 + index * 80
        header[at:at + 20] = role['name'].encode('cp936').ljust(20, b'\0')
        for offset, value in ((20, int(role['id']) - 1), (24, role['level']),
                              (28, role['hp']['current']), (32, role['hp']['maximum']),
                              (36, role['mp']['current']), (40, role['mp']['maximum'])):
            put(header, at + offset, value)
    return b''.join((header, U32.pack(len(preview)), preview, flags, events, equipment, inventory,
                     sections.get('small_table', bytes(4)), map_objects, global_block, scene_world,
                     combo, *roles, formation_bytes, last_table))
