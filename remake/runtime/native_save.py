"""Original v2 saves at the file boundary; the browser uses ordinary world objects.

Layout: GAME.exe 4789D0/478C80, retained in rea_format_evidence.json.
Unmapped native bytes travel with a loaded world and are written back verbatim.
Fresh games are built from the shipped runtime resource definitions, not a save.
"""
from base64 import b64decode, b64encode
from copy import deepcopy
from datetime import datetime, timedelta, timezone
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
SAVE_TIME_ZONE = timezone(timedelta(hours=8))


def native_saved_at(raw):
    """The remake stores its save date in the header's SYSTEMTIME words.

    This is a remake convention, not a verified claim about the original game.
    Legacy zero/elapsed-time words have no valid calendar date.
    """
    year, month, weekday, day, hour, minute, second, millisecond = struct.unpack_from('<8H', raw, 0x6D)
    if not 1601 <= year <= 9999 or weekday > 6 or millisecond > 999:
        return None
    try:
        value = datetime(year, month, day, hour, minute, second, millisecond * 1000, SAVE_TIME_ZONE)
    except ValueError:
        return None
    return value.isoformat(timespec='milliseconds')


@cache
def resources():
    seed = json.loads((DATA / 'opening_seed.json').read_bytes())
    skills = json.loads((DATA / 'party_skills.json').read_bytes())['roles']
    items = json.loads((DATA / 'items.json').read_bytes())['definitions']
    story = json.loads((DATA / 'chapter_story.json').read_bytes())['maps']
    # Retain only the native map records used by save serialization.
    maps = {key: {k: value.get(k) for k in ('name', 'header_raw_hex', 'npc_records', 'objects', 'native_camera_extent_cells')}
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
    return {key: {a['index']: a for a in role['actions']} for key, role in roles.items()}


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


def initialize_map_npc(raw_actor, map_header):
    """DAT -> live actor: 4B4A80/4B3AA0/4B4F10/469F50/483550."""
    actor = bytearray(raw_actor)
    shift = map_header[0x142]
    coordinate_offsets = [0x6F, 0x73]
    for index in range(u32(actor, 0x14B)):
        coordinate_offsets.extend((0x14F + index * 0x15, 0x153 + index * 0x15))
    for offset in coordinate_offsets:
        value = (u32(actor, offset) << (shift + 2)) & 0xFFFFFFFF
        put(actor, offset, (value - 0x100000000 if value & 0x80000000 else value) >> 5)
    actor[0xC5] = actor[0xF5]
    actor[0x2D:0x2F] = bytes(2)
    actor[0xD5] = actor[0x4BD] = actor[0x4BE] = 0
    actor[0xE0] = 1
    if actor[0x2AC]:
        actor[0x97] = 1
    for offset, value in ((0x93, u32(map_header, 0x92)), (0x5B, u32(actor, 0x6F)),
                          (0x5F, u32(actor, 0x73)), (0x30, u32(actor, 0x6F)),
                          (0x34, u32(actor, 0x73)), (0x83, 0), (0xD6, 80), (0xEA, 0),
                          (0x4BF, 0), (0x495, int(7 < actor[0x2C] < 128))):
        put(actor, offset, value)
    # Shipped NPCs have equal min/max values in all six ranges (4B3AA0).
    for offset in (0x2C7, 0x2D3, 0x2DF, 0x2EF, 0x2FF, 0x30F, 0x485, 0x489):
        put(actor, offset, 0)
    put(actor, 0x2CB, u32(actor, 0x2C3))
    put(actor, 0x2D7, u32(actor, 0x2CF))
    if not u32(actor, 0x30B):
        put(actor, 0x30B, 10)
    actions = map_actions().get(f'{u32(actor, 0x28):03}', {})
    actor[0x46:0x5A] = bytes([255] * 20)
    for action in actions.values():
        channel = bytes.fromhex(action['raw_hex'])[0x7E]
        if channel < 20 and actor[0x46 + channel] == 255:
            actor[0x46 + channel] = action['index']
    if actor[0x47] == 255:
        actor[0x47] = actor[0x46]
    actor[0x2F] = actor[0x47]
    actor[0xFA:0xFA + len(actions) * 4] = bytes(len(actions) * 4)
    action = actions.get(0)
    if action:
        frame = action['sequence_raw'][0] if action['uses_sequence'] else 0
        put(actor, 0x7B, 0)
        put(actor, 0x7F, actor[0x45])
        put(actor, 0x8B, action['first_frame'] + frame +
            (actor[0x45] * action['frame_count'] if action['directions'] == 8 else 0))
    return actor


def native_camera_position(map_header, extent_cells, x, y):
    """640x480 viewport: 4A0500 dimensions, 4A18F0 bounds, 4A4E50 follow."""
    if not u32(map_header, 0x88):
        return x, y
    shift, step = map_header[0x142], 1 << map_header[0x145]
    tile_height = 32 >> map_header[0x145]
    result = []
    for position, extent, screen_size in zip((x, y), extent_cells, (640, 480)):
        cells = screen_size // tile_height + step + (step if screen_size % tile_height else 0)
        half = (cells // 2) << shift
        maximum = max(0, (extent - cells) << shift)
        result.append(min(maximum, max(0, position - half)) // step * step)
    return tuple(result)


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


def native_save_summary(raw):
    """Read only the native list header and its stored RGB565 thumbnail."""
    if len(raw) < 0x3C5 or u32(raw) != 2:
        raise ValueError('原版存档头无效')
    count = u32(raw, 0x85)
    if not 1 <= count <= 10:
        raise ValueError('原版存档队伍摘要无效')
    map_id = text(raw, 0x39, 20, 'ascii').upper().removesuffix('.DAT')
    if not map_id:
        raise ValueError('原版存档地图摘要无效')
    thumbnail = None
    size = u32(raw, 0x3C1)
    if size == 104 * 76 * 2 and len(raw) >= 0x3C5 + size:
        # A top-down BI_BITFIELDS bitmap wraps the saved pixels unchanged.
        # No scene rendering, RGB conversion or PNG compression is needed.
        bitmap = (struct.pack('<2sIHHI', b'BM', 66 + size, 0, 0, 66)
                  + struct.pack('<IiiHHIIiiII', 40, 104, -76, 1, 16, 3, size, 0, 0, 0, 0)
                  + struct.pack('<III', 0xF800, 0x07E0, 0x001F)
                  + raw[0x3C5:0x3C5 + size])
        thumbnail = 'data:image/bmp;base64,' + b64encode(bitmap).decode('ascii')
    return dict(schema='seventh-seal-save-summary', version=1,
                sha256=hashlib.sha256(raw).hexdigest(),
                party=[dict(name=text(raw, 0x89 + index * 80, 20)) for index in range(count)],
                location=dict(map_id=map_id, map_name=text(raw, 0x4D, 20).strip()),
                play_time_ms=u32(raw, 0x7D) * 100,
                saved_at=native_saved_at(raw),
                thumbnail=thumbnail)


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
                 # 479D70 displays +7D through 469D60/469CA0, in 100ms ticks.
                 play_time_ms=u32(header, 0x7D) * 100,
                 game_settings=dict(audio={key: dict(volume=header[0x3A9 + i] / 64,
                     muted=not bool(header[0x3AD + i]))
                     for i, key in enumerate(('master', 'music', 'effects'))},
                     battle_cursor='memory' if header[0x3AC] else 'initial'),
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
    #4785C0/478C80 preserve4B4ECA4's remaining100ms ticks and4B4ECAC's
    # signed chance modifier at the real native header offsets. +3B5 is a
    # separate global whose bytes remain in the retained native header.
    if u32(header, 0x3B1):
        world['encounters']['modifier'] = dict(value=struct.unpack_from('<i', header, 0x3B9)[0],
            expires_at_ms=world['play_time_ms'] + u32(header, 0x3B1) * 100)
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
        definition = map_actions().get(f'{u32(actor, 0x28):03}', {}).get(action)
        sequence = definition['sequence_raw'][:definition['logical_count']] if definition and definition['uses_sequence'] else None
        frame = sequence[logical % len(sequence)] if sequence else logical
        world['map_npc_state']['actors'].append(dict(slot=slot, x=u32(actor, 0x6F) * 2,
            y=u32(actor, 0x73) * 2, direction=actor[0x45], hidden=bool(actor[0x97]),
            action=action, frame=frame, layer=u32(actor, 0x93)))
    world['recipe_unlock_indices'] = list(struct.unpack_from(f'<{u32(sections["last_table"])}I', sections['last_table'], 4))
    payload = json.dumps(world, ensure_ascii=False, separators=(',', ':'))
    digest = hashlib.sha256(payload.encode('utf-8')).hexdigest()
    envelope = dict(schema='seventh-seal-save', version=1, payload=payload, sha256=digest, saved_at=native_saved_at(raw))
    if len(sections['preview']) == 104 * 76 * 2:
        envelope['preview'] = dict(version=1, width=104, height=76, payload_sha256=digest,
                                   png=image_png(sections['preview']))
    return envelope


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


def encode_native_save(envelope, *, saved_at=None):
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
    # 4785C0 sums ten section progress getters: 2048 plus current NPC count.
    put(header, 0x34, 2048 + len(current_map['npc_records']))
    same_map = bool(base and text(header, 0x39, 20, 'ascii').upper() == map_id + '.DAT')
    leader = int(world['leader_id']) - 1
    map_header = bytes.fromhex(current_map['header_raw_hex'])
    native_x, native_y = round(world['location']['x'] / 2), round(world['location']['y'] / 2)
    previous_actors = sections.get('map_objects')
    previous_leader = 8 + (10 + leader) * ACTOR_BYTES
    if not same_map or u32(previous_actors) != leader or any(
            u32(previous_actors, previous_leader + offset) != value
            for offset, value in ((0x6F, native_x), (0x73, native_y))):
        camera = native_camera_position(map_header, current_map['native_camera_extent_cells'], native_x, native_y)
        put(header, 0x61, camera[0])
        put(header, 0x65, camera[1])
    header[0x39:0x4D] = (map_id + '.DAT').encode('ascii').ljust(20, b'\0')
    header[0x4D:0x61] = current_map['name'].encode('cp936').ljust(20, b'\0')
    put(header, 0x69, leader)
    put(header, 0x81, world.get('money', seed['money']))
    if saved_at is not None:
        if not isinstance(saved_at, datetime) or saved_at.utcoffset() is None or saved_at.year < 1601:
            raise ValueError('保存日期必须是带时区的有效日期')
        saved_at = saved_at.astimezone(SAVE_TIME_ZONE)
        struct.pack_into('<8H', header, 0x6D, saved_at.year, saved_at.month, (saved_at.weekday() + 1) % 7,
                         saved_at.day, saved_at.hour, saved_at.minute, saved_at.second, saved_at.microsecond // 1000)
    if 'play_time_ms' in world:
        put(header, 0x7D, world['play_time_ms'] // 100)
    modifier = world.get('encounters', {}).get('modifier')
    remaining = max(0, modifier['expires_at_ms'] - world.get('play_time_ms', 0)) if modifier else 0
    put(header, 0x3B1, (remaining + 99) // 100)
    put(header, 0x3B9, modifier['value'] if remaining else 0)
    settings = world.get('game_settings')
    if settings:
        for index, key in enumerate(('master', 'music', 'effects')):
            channel = settings['audio'][key]
            header[0x3A9 + index] = round(channel['volume'] * 64)
            header[0x3AD + index] = int(not channel['muted'])
        header[0x3AC] = int(settings['battle_cursor'] == 'memory')
    elif not base:
        header[0x3A9:0x3B1] = bytes((64, 64, 64, 1, 1, 1, 1, 0))
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
            shift = map_header[0x142] or 3
            for index in range(6):
                at = 4 + index * ACTOR_BYTES
                map_objects[at:at + ACTOR_BYTES] = initial_map_actor(index + 1, map_header, 20 << shift)
                at = dynamic + index * ACTOR_BYTES
                map_objects[at:at + ACTOR_BYTES] = initial_map_actor(index + 1, map_header, 0)
        for npc in current_map['npc_records']:
            at = dynamic + npc['slot_zero_based'] * ACTOR_BYTES
            map_objects[at:at + ACTOR_BYTES] = initialize_map_npc(bytes.fromhex(npc['raw_hex']), map_header)
    for role in world['party']:
        index = int(role['id']) - 1
        at = dynamic + index * ACTOR_BYTES
        if not u32(map_objects, at + 0x28):
            put(map_objects, at + 0x28, index + 1)
        map_objects[at + 0xC2] = world.get('encounters', {}).get('counters', {}).get(role['id'], 0)
        if not same_map:
            put(map_objects, at + 0x93, u32(map_header, 0x92))
        if index == leader:
            put(map_objects, at + 0x6F, round(world['location']['x'] / 2))
            put(map_objects, at + 0x73, round(world['location']['y'] / 2))
            map_objects[at + 0x45] = world['location']['direction']
            map_objects[at + 0x97] = 0
            if not same_map:
                map_objects[at + 0xEF] = 1
                put(map_objects, at + 0x30, u32(map_objects, at + 0x6F))
                put(map_objects, at + 0x34, u32(map_objects, at + 0x73))
    if world.get('map_npc_state', {}).get('map_id') == map_id:
        for npc in world['map_npc_state']['actors']:
            at = dynamic + npc['slot'] * ACTOR_BYTES
            for offset, key in ((0x6F, 'x'), (0x73, 'y')):
                put(map_objects, at + offset, round(npc[key] / 2))
            old_direction = map_objects[at + 0x45]
            map_objects[at + 0x45] = npc['direction']
            map_objects[at + 0x97] = int(npc['hidden'])
            if 'layer' in npc:
                put(map_objects, at + 0x93, npc['layer'])
            old_action, logical = u32(map_objects, at + 0x83), u32(map_objects, at + 0x7B)
            definition = map_actions().get(f'{u32(map_objects, at + 0x28):03}', {}).get(npc['action'])
            sequence = definition['sequence_raw'][:definition['logical_count']] if definition and definition['uses_sequence'] else None
            old_frame = sequence[logical % len(sequence)] if sequence else logical
            changed = old_action != npc['action'] or old_direction != npc['direction'] or old_frame != npc['frame']
            if sequence:
                if old_action != npc['action'] or sequence[logical % len(sequence)] != npc['frame']:
                    logical = sequence.index(npc['frame'])
            else:
                logical = npc['frame']
            put(map_objects, at + 0x83, npc['action'])
            put(map_objects, at + 0x7B, logical)
            if definition and (changed or not same_map):
                put(map_objects, at + 0x7F, npc['direction'])
                put(map_objects, at + 0x8B, definition['first_frame'] + npc['frame'] +
                    (npc['direction'] * definition['frame_count'] if definition['directions'] == 8 else 0))
            if not same_map:
                put(map_objects, at + 0x30, u32(map_objects, at + 0x6F))
                put(map_objects, at + 0x34, u32(map_objects, at + 0x73))
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
            if role_id in formation:
                put(head, 0x303, formation.index(role_id))
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
        # 4FDD00 populates the CHR cache identity; 4FF480 rejects an empty cache.
        if source and not u32(head, 0x2FF):
            put(head, 0x2FF, index + 1)
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
