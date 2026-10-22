"""Partial parser based on GAME.exe's observed read/write code.

It locates inventory dynamically and reads named character skill records.
Unparsed sections are preserved; no writes are performed by this module.
"""
from pathlib import Path
import struct
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from read_inventory import definitions

def u32(b, p):
    if p < 0 or p+4 > len(b):
        raise ValueError(f'uint32 outside file at 0x{p:X}')
    return struct.unpack_from('<I', b, p)[0]

def inventory(b):
    if u32(b, 0) != 2:
        raise ValueError('Unsupported outer save format (expected version 2).')
    preview = u32(b, 0x3C1)
    p = 0x3C5 + preview
    if p+16000 > len(b):
        raise ValueError('Preview or event header extends outside file.')
    counts = struct.unpack_from('<2000I', b, p+8000)
    p += 16000 + 14*sum(counts) + 100*0x8F2
    n = u32(b, p)
    if n > 1000 or p+4+n*0xE5 > len(b):
        raise ValueError('Invalid inventory count or record bounds.')
    names = definitions()
    items = []
    for j in range(n):
        q = p+4+j*0xE5
        id_, count = u32(b, q), u32(b, q+4)
        if id_ not in names:
            raise ValueError(f'Unknown item ID {id_} at 0x{q:X}')
        items.append({'index': j, 'record_offset': q, 'id': id_,
                      'name': names[id_], 'quantity': count,
                      'quantity_offset': q+4})
    return {'preview_length': preview, 'event_count': sum(counts),
            'count_offset': p, 'record_count': n,
            'end_offset': p+4+n*0xE5, 'items': items}

def character_skills(b, name):
    # The name is part of the 0x30B character header; validate its preceding
    # presence/version/reserved fields rather than matching header previews.
    pattern = name.encode('cp936') + b'\0'
    candidates = []
    pos = 0
    while True:
        pos = b.find(pattern, pos)
        if pos < 0:
            break
        h = pos-4
        if h >= 9 and b[h-9] == 1 and u32(b, h-8) == 8 and u32(b, h-4) == 0:
            candidates.append(h)
        pos += 1
    if len(candidates) != 1:
        raise ValueError(f'Expected one serialized character {name!r}, found {len(candidates)}.')
    h = candidates[0]
    return character_at_header(b, h)

def character_at_header(b, h):
    name = b[h+4:h+24].split(b'\0')[0].decode('cp936')
    n = u32(b, h)
    if not 0 <= n <= 255 or h+0x30B > len(b):
        raise ValueError('Invalid character header or skill count.')
    p = h+0x30B
    skills = []
    for j in range(n):
        if p+0x41D > len(b):
            raise ValueError('Skill fixed header extends outside file.')
        actions = u32(b, p+0x15)
        end = p+0x41D+actions*0xB0
        if end > len(b):
            raise ValueError('Skill action records extend outside file.')
        raw_name = b[p+1:p+0x15].split(b'\0')[0]
        skill_name = raw_name.decode('cp936')
        flag = b[p+0x23]
        flags = u32(b, p+0x32)
        skills.append({'index': j, 'record_offset': p, 'id': b[p],
                       'name': skill_name, 'learned_flag': flag,
                       'learned_flag_offset': p+0x23, 'type_flags': flags,
                       'required_role_level': u32(b, p+0x143),
                       'required_role_level_offset': p+0x143,
                       'has_menu_type': bool(flags & 0xF),
                       'action_record_count': actions, 'end_offset': end})
        p = end
    return {'name': name, 'header_offset': h, 'skill_definition_count': n,
            'end_offset': p, 'skills': skills,
            'level': u32(b,h+0x24), 'experience': u32(b,h+0x28),
            'next_level_experience': u32(b,h+0x2C),
            'experience_remaining': u32(b,h+0x64),
            'hp': {'current':u32(b,h+0x30),'maximum':u32(b,h+0x34)},
            'mp': {'current':u32(b,h+0x38),'maximum':u32(b,h+0x3C)},
            'attack': {'current':u32(b,h+0x40),'base':u32(b,h+0x44)},
            'defense': {'current':u32(b,h+0x48),'base':u32(b,h+0x4C)},
            'attribute_0x58_0x5c': {'current':u32(b,h+0x58),'base':u32(b,h+0x5C)}}

def complete_layout(b):
    """Follow the located writer's sections to EOF.

    The world n2 writer/reader discrepancy is rejected explicitly until a
    nonzero sample establishes which layout the game actually preserves.
    All ten role headers are serialized, even when their state byte is zero.
    """
    inv = inventory(b)
    sections = []
    p = 0
    def skip(section_name, size, **details):
        nonlocal p
        if size < 0 or p+size > len(b):
            raise ValueError(f'{section_name} exceeds file bounds at 0x{p:X}')
        sections.append({'section': section_name, 'offset': p, 'length': size, **details})
        p += size
    skip('header', 0x3C1)
    skip('preview_length', 4, value=inv['preview_length'])
    skip('preview', inv['preview_length'])
    skip('flags', 8000)
    skip('events', 8000+14*inv['event_count'], event_total=inv['event_count'])
    skip('equipment', 100*0x8F2)
    if p != inv['count_offset']:
        raise ValueError('Inventory locator/layout mismatch.')
    skip('inventory', 4+inv['record_count']*0xE5, count=inv['record_count'])
    small_n = u32(b, p)
    skip('small_table', 4+small_n*16, count=small_n)
    map_npcs = u32(b, p+4+10*0x4C5)
    skip('map_objects', 8+(20+map_npcs)*0x4C5, map_npc_count=map_npcs)
    skip('global_block', 472)
    n1, n2, n3 = [u32(b, p+274+i*4) for i in range(3)]
    if n2 != 0:
        raise ValueError('World table n2 is nonzero: observed writer uses 4000 bytes, reader uses n2*4. This case is not established.')
    skip('world', 274+12+2000+274*(n1+n3), counts=[n1,n2,n3])
    skip('combo_state', 12210)
    characters = []
    for j in range(10):
        role_start = p
        if p+9 > len(b) or u32(b,p+1) != 8 or u32(b,p+5) != 0:
            raise ValueError(f'Unsupported role format at 0x{p:X}')
        state_byte = b[p]
        actor = character_at_header(b, p+9)
        actor.update({'role_index': j, 'state_byte': state_byte, 'record_offset': p})
        characters.append(actor)
        skip('role', actor['end_offset']-role_start, index=j, name=actor['name'],
             state_byte=state_byte, skill_count=actor['skill_definition_count'])
    skip('last_fixed', 80)
    last_n = u32(b,p)
    skip('last_table', 4+last_n*4, count=last_n)
    if p != len(b):
        raise ValueError(f'Unparsed tail: parsed {p} of {len(b)} bytes.')
    return {'sections': sections, 'characters': characters, 'parsed_end': p,
            'actual_size': len(b), 'reaches_eof': p==len(b)}

def describe(path):
    b = Path(path).read_bytes()
    layout = complete_layout(b)
    return {'path': str(Path(path).resolve()), 'length': len(b),
            'inventory': inventory(b), 'characters': layout['characters'],
            'layout': {k:v for k,v in layout.items() if k != 'characters'}}

if __name__ == '__main__':
    import json
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) != 2:
        raise SystemExit('Usage: save_format.py SAVE_FILE')
    print(json.dumps(describe(sys.argv[1]), ensure_ascii=False, indent=2))
