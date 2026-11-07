"""从原DAT/TLK/ANM独立盘点入口和静态分支；不以运行登记决定来源全集。

只读原安装和运行数据。--output 显式保存新报告；--check-runtime 复用已有
能力与剧情包检查。正常源入口闭包不等于旗标自然可满足或动态实玩验收。
"""
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
import argparse
import hashlib
import json
import struct
import subprocess

RUNTIME = Path(__file__).resolve().parents[1]
GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'
CONTRACT = Path(__file__).parent / 'native_entry_contract.json'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def u32(raw, at):
    return struct.unpack_from('<I', raw, at)[0]


def text(raw, encoding='ascii'):
    return raw.split(b'\0', 1)[0].decode(encoding, errors='replace')


def filename_id(name, extension):
    name = name.replace('\\', '/').rsplit('/', 1)[-1]
    return name[:-len(extension)].upper() if name.lower().endswith(extension) else None


class Sources:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.files = {}
        self.hashes = {}
        for path in sorted(self.directory.rglob('*')):
            if not path.is_file():
                continue
            name = path.relative_to(self.directory).as_posix()
            key = name.casefold()
            if key in self.files:
                raise ValueError('原目录存在大小写冲突：' + name)
            self.files[key] = path

    def read(self, name):
        path = self.files[name.casefold()]
        raw = path.read_bytes()
        self.hashes[path.relative_to(self.directory).as_posix()] = sha(raw)
        return raw

    def names(self, folder, extension):
        return sorted(name for name in self.files
                      if name.startswith(folder.casefold() + '/')
                      and name.endswith(extension.casefold()))


def read_map(source, name):
    raw = source.read(name)
    if len(raw) < 0x172 or u32(raw, 0x14) != 6:
        raise ValueError('不支持的原DAT：' + name)
    width, height = struct.unpack_from('<II', raw, 0x146)
    grid_end = 0x172 + width * height * 64
    if not width or not height or grid_end > len(raw):
        raise ValueError('原DAT格表越界：' + name)
    cells = defaultdict(list)
    for index in range(width * height):
        at = 0x172 + index * 64
        ident = u32(raw, at + 0x38)
        if ident:
            if ident > 32:
                raise ValueError(f'{name} 未支持的原描述符号 {ident}')
            cells[ident].append(dict(x=index % width, y=index // width,
                                     offset=at, terrain=raw[at + 0x20]))
    descriptor_size = 0x42 if u32(raw, 0x18) == 1 else 0x2b
    descriptor_base = grid_end + 32 * 0x2a
    descriptors = []
    for index in range(32):
        at = descriptor_base + index * descriptor_size
        entry = raw[at:at + descriptor_size]
        if len(entry) != descriptor_size:
            raise ValueError('原描述符截断：' + name)
        if not any(entry) and index + 1 not in cells:
            continue
        descriptors.append(dict(id=index + 1, state=entry[0],
            filename=text(entry[0x11:0x26]),
            target=entry[0x26] if descriptor_size == 0x2b else u32(entry, 0x26),
            offset=at, raw_hex=entry.hex(), cells=cells[index + 1]))
    object_base = grid_end + 32 * (0x2a + descriptor_size + 0x1b + 0x110)
    objects = []
    for index in range(u32(raw, 0x82)):
        at = object_base + index * 0x112
        entry = raw[at:at + 0x112]
        if len(entry) != 0x112:
            raise ValueError('原物件截断：' + name)
        objects.append(dict(index=index, offset=at, raw_hex=entry.hex(),
            cf=entry[0xcf], disabled=entry[0xe1], state_type=entry[0x109],
            record=u32(entry, 0xf6), completion_record=u32(entry, 0xba),
            rewards=[u32(entry, 0x54 + slot * 4) for slot in range(10)]))
    npc_base = object_base + len(objects) * 0x112
    if npc_base + raw[0x86] * 0x4c5 > len(raw):
        raise ValueError('原NPC截断：' + name)
    npc_callbacks = [dict(slot=index + 10, record=struct.unpack_from('<b', raw, npc_base + index * 0x4c5 + 0x4a2)[0],
                          source_offset=npc_base + index * 0x4c5 + 0x4a2)
                     for index in range(raw[0x86]) if raw[npc_base + index * 0x4c5 + 0x4a2]]
    route_callbacks, route_points = [], 0
    for index in range(raw[0x86]):
        at = npc_base + index * 0x4c5
        count = struct.unpack_from('<i', raw, at + 0x14b)[0]
        if count < 0 or count > (0x4c5 - 0x15a - 4) // 21 + 1:
            raise ValueError('原NPC路线表越界：' + name)
        route_points += count
        for point in range(count):
            offset = at + 0x15a + point * 21
            if u32(raw, offset):
                route_callbacks.append(dict(slot=index + 10, point=point,
                    record=u32(raw, offset), source_offset=offset))
    return dict(id=filename_id(name, '.dat'), name=text(raw[0x1c:0x7c], 'gbk'),
        path=name, sha256=sha(raw), header_raw_hex=raw[:0x172].hex(),
        setup=u32(raw, 0x8a), entry=u32(raw, 0x13a), flag_index=u32(raw, 0x92), descriptors=descriptors,
        objects=objects, npc_slots=list(range(10, 10 + raw[0x86])),
        npc_callbacks=npc_callbacks, route_callbacks=route_callbacks, route_points=route_points,
        npc_base=npc_base, width=width, height=height)


def read_tlk(source, name):
    raw = source.read(name)
    index_count, count = struct.unpack_from('<II', raw, 2)
    base = 0x1a + index_count * 4
    if index_count > 500 or base + count * 0x66f > len(raw):
        raise ValueError('原TLK越界：' + name)
    records = {}
    for index in range(count):
        at = base + index * 0x66f
        entry = raw[at:at + 0x66f]
        if u32(entry, 0x13) != index + 1:
            raise ValueError('原TLK记录号不一致：' + name)
        options = []
        if entry[0] == 0 and entry[1] == 1:
            for option in range(3):
                start = 0x537 + option * 104
                if entry[start]:
                    options.append(u32(entry, start + 100))
        random = []
        if entry[0] == 3:
            for option in range(15):
                target, weight = struct.unpack_from('<HH', entry, 0x37 + option * 4)
                if not target or not weight:
                    break
                random.append((target, weight))
        records[index + 1] = dict(id=index + 1, offset=at, raw_hex=entry.hex(),
            kind=entry[0], style=entry[1], condition_type=u32(entry, 0x17),
            condition_bit=u32(entry, 0x1f), if_true=u32(entry, 0x2f),
            next=u32(entry, 0x33), text=text(entry[0x37:0x137], 'gbk'),
            options=options, random=random)
    return dict(id=filename_id(name, '.tlk'), path=name, sha256=sha(raw),
        records=records, loader_end=base + count * 0x66f,
        trailing_bytes=len(raw) - base - count * 0x66f,
        index={index: u32(raw, 0x1a + index * 4)
            for index in range(index_count) if u32(raw, 0x1a + index * 4)})


def read_anm(source, name):
    raw = source.read(name)
    if len(raw) < 0x43 or raw[:2] != b'\x03\x00' or 0x43 + u32(raw, 2) * 74 != len(raw):
        raise ValueError('原ANM分区不一致：' + name)
    commands = []
    for index in range(u32(raw, 2)):
        at = 0x43 + index * 74
        entry = raw[at:at + 74]
        commands.append(dict(index=index, offset=at, opcode=entry[0],
            actor=u32(entry, 5), bit=u32(entry, 25), mode=entry[29],
            yes=u32(entry, 13), no=u32(entry, 17),
            filename=text(entry[54:74]), raw_hex=entry.hex()))
    return dict(id=filename_id(name, '.anm').lower(), path=name,
                sha256=sha(raw), commands=commands, header_raw_hex=raw[:0x43].hex())


def roots_for(table, tlk, binding):
    """源入口先独立产生，再标运行登记；原禁用对象另留明细。"""
    roots = []
    def add(kind, ident, node, selected, offset):
        roots.append(dict(map_id=table['id'], kind=kind, id=ident,
                          node=node, registered=selected, source_offset=offset))
    for kind, offset in [('setup', 0x8a), ('entry', 0x13a)]:
        if table[kind]:
            add(kind, table[kind], ('tlk', table['id'], table[kind]),
                bool(binding.get(kind) or binding.get(kind + '_record')), offset)
    for slot in table['npc_slots']:
        target = tlk.get('index', {}).get(slot, 0)
        if target:
            add('npc', slot, ('tlk', table['id'], target),
                slot in binding.get('npcs', table['npc_slots']), 0x1a + slot * 4)
    for callback in table['npc_callbacks']:
        add('npc-callback', callback['slot'], ('tlk', table['id'], callback['record']),
            False, callback['source_offset'])
    for callback in table['route_callbacks']:
        add('npc-route-callback', f"{callback['slot']}:{callback['point']}",
            ('tlk', table['id'], callback['record']), False, callback['source_offset'])
    objects = {row['index']: row for row in binding.get('objects', [])}
    for obj in table['objects']:
        if obj['record'] and not obj['disabled'] and obj['cf'] in [1, 2, 3, 4, 7, 9]:
            add('object-tlk', obj['index'], ('tlk', table['id'], obj['record']),
                obj['index'] in objects, obj['offset'] + 0xf6)
        if obj['completion_record']:
            add('object-completion', obj['index'], ('tlk', table['id'], obj['completion_record']),
                obj['index'] in objects, obj['offset'] + 0xba)
        if obj['cf'] in [3, 4] and not obj['record'] and any(obj['rewards']):
            add('direct-reward', obj['index'], None,
                obj['index'] in objects, obj['offset'] + 0x54)
        if obj['cf'] == 7 and not obj['disabled'] and not obj['record']:
            add('direct-activation', obj['index'], None,
                obj['index'] in objects, obj['offset'] + 0xcf)
    for descriptor in table['descriptors']:
        if not any(cell['terrain'] == 0 for cell in descriptor['cells']):
            continue
        selected = (descriptor['id'] in binding.get('triggers', [])
            or any(row['descriptor_id'] == descriptor['id'] for row in binding.get('rests', []))
            or any(row.get('descriptor_id') == descriptor['id']
                   or descriptor['state'] == 2 and row.get('record_id') == descriptor['target']
                   for row in binding.get('routes', [])))
        if descriptor['state'] == 1:
            ident = filename_id(descriptor['filename'], '.anm')
            node = ('anm', ident.lower() if ident else '', table['id'], 0)
            add('dat-anm', descriptor['id'], node, selected, descriptor['offset'])
        elif descriptor['state'] == 2 and descriptor['target']:
            add('grid-tlk', descriptor['id'], ('tlk', table['id'], descriptor['target']),
                selected, descriptor['offset'])
    return roots


def walk(starts, tlks, programs, maps):
    """图节点保留ANM指令位置及当前地图，避免把别图回调串错。"""
    queue = deque(tuple(node) for node in starts if node)
    seen, invalid, transfers = set(), set(), set()
    while queue:
        node = queue.popleft()
        if node in seen:
            continue
        seen.add(node)
        if node[0] == 'tlk':
            _, mid, ident = node
            record = tlks.get(mid, {}).get('records', {}).get(ident)
            if not record:
                invalid.add(node)
                continue
            def add(target):
                if target:
                    queue.append(('tlk', mid, target))
            kind = record['kind']
            if kind == 3:
                for target, weight in record['random']:
                    add(target)
                continue
            if kind == 4:
                add(record['if_true'])
                add(record['next'])
                continue
            conditional = bool(record['condition_type'] or record['condition_bit'])
            if conditional:
                add(record['if_true'])
            if kind == 0 and record['options']:
                for target in record['options']:
                    add(target)
            elif kind == 1:
                ident = filename_id(record['text'], '.anm')
                queue.append(('anm', ident.lower() if ident else '', mid, 0))
            else:
                if kind == 2:
                    transfers.add((mid, filename_id(record['text'], '.dat'), record['id']))
                add(record['next'])
        else:
            _, pid, mid, index = node
            program = programs.get(pid)
            if not program or not 0 <= index < len(program['commands']):
                invalid.add(node)
                continue
            command = program['commands'][index]
            if command['opcode'] == 10:
                target = filename_id(command['filename'], '.dat')
                transfers.add((mid, target, f'{pid}:{index}'))
                mid = target
            if command['opcode'] == 14 and command['actor']:
                queue.append(('tlk', mid, command['actor']))
            next_indices = [index + 1]
            flag_index = command['actor'] or maps.get(mid, {}).get('flag_index', 0)
            if command['opcode'] == 20 and command['mode'] >= 2 and flag_index:
                # Native flag index0 is a no-op; bit0 is an unconditional jump.
                # Map-local index substitution is nonzero for normal maps.
                targets = [command['yes']] if command['bit'] == 0 else [command['yes'], command['no']]
                next_indices = [target - 1 if target else index + 1 for target in targets]
            for target in next_indices:
                if target < len(program['commands']):
                    queue.append(('anm', pid, mid, target))
    return seen, invalid, transfers


def verify_contract(game):
    if not CONTRACT.is_file():
        return dict(verified=False, reason='缺少正常入口分派核实清单')
    contract = json.loads(CONTRACT.read_text('utf-8'))
    if sha(game) != contract['game_sha256']:
        raise ValueError('原程序已变化，不能复用正常入口判定')
    for anchor in contract['byte_assertions']:
        raw = bytes.fromhex(anchor['bytes_hex'])
        if game[anchor['file_offset']:anchor['file_offset'] + len(raw)] != raw:
            raise ValueError('原程序入口依据不一致：' + anchor['id'])
    return dict(verified=True, contract_sha256=sha(CONTRACT.read_bytes()),
                claims=contract['claims'], boundary=contract['boundary'])


def runtime_sources(runtime, maps, tlks, programs, content):
    story = json.loads((runtime / 'web/data/chapter_story.json').read_text('utf-8'))
    errors = []
    for mid in content['maps']:
        table, original = story['maps'].get(mid), maps.get(mid)
        if not table or not original:
            errors.append(f'{mid}: 缺少原DAT或运行来源表')
            continue
        if table['map_source']['sha256'] != original['sha256'] or table['header_raw_hex'] != original['header_raw_hex']:
            errors.append(f'{mid}: DAT头或SHA不同')
        if table['header_setup_tlk_raw'] != original['setup'] or table['header_entry_tlk_raw'] != original['entry']:
            errors.append(f'{mid}: 加载或到达入口不同')
        for field, source_rows, key in [('descriptors', original['descriptors'], 'id'), ('objects', original['objects'], 'index')]:
            rows = {row[key]: row for row in table[field]}
            for row in source_rows:
                if field == 'descriptors' and not any(bytes.fromhex(row['raw_hex'])) and row[key] not in rows:
                    # The exporter omits zero records; their referenced grid
                    # cells still need the separate runtime passage audit.
                    continue
                if rows.get(row[key], {}).get('raw_hex') != row['raw_hex']:
                    errors.append(f'{mid}: {field}:{row[key]}字节不同')
                if field == 'descriptors' and row[key] in rows:
                    actual = rows[row[key]]
                    if (actual['state_raw'], actual['filename_raw'], actual['field_26_raw']) != (row['state'], row['filename'], row['target']):
                        errors.append(f'{mid}: 描述符{row[key]}分派字段不同')
        source_tlk = tlks.get(mid)
        if source_tlk:
            rows = {row['id']: row for row in table['records']}
            if table['source']['sha256'] != source_tlk['sha256'] or len(rows) != len(source_tlk['records']):
                errors.append(f'{mid}: TLK来源或记录数不同')
            if {row['slot']: row['record'] for row in table['index_nonzero']} != source_tlk['index']:
                errors.append(f'{mid}: 原TLK索引不同')
            for ident, row in source_tlk['records'].items():
                if rows.get(ident, {}).get('raw_hex') != row['raw_hex']:
                    errors.append(f'{mid}: TLK:{ident}字节不同')
        elif table['records'] or table['dialogue_status'] != 'source-file-absent':
            errors.append(f'{mid}: 原版无TLK，运行表却有记录')
    for pid in content['programs']:
        actual, original = story['programs'].get(pid), programs.get(pid)
        if not actual or not original or actual['source']['sha256'] != original['sha256']:
            errors.append(f'{pid}: ANM来源不同')
            continue
        if [row['raw_hex'] for row in actual['commands']] != [row['raw_hex'] for row in original['commands']]:
            errors.append(f'{pid}: ANM指令字节不同')
    opening = json.loads((runtime / 'web/data/opening_program.json').read_text('utf-8'))
    if (opening['source']['sha256'] != programs['resurrect']['sha256']
            or [row['raw_hex'] for row in opening['commands']]
            != [row['raw_hex'] for row in programs['resurrect']['commands']]):
        errors.append('独立序章Resurrect的原字节不同')
    return errors


def runtime_empty_gates(runtime, entries):
    """调用正式共用通行规则，核原空描述符有无被覆盖守卫额外阻挡。"""
    code = r'''
import fs from 'node:fs/promises';
import {MovementMap} from './web/core/exploration/movement.mjs';
import {nativeEmptyEventCells,chapterRouteExits} from './web/core/exploration/map_connections.mjs';
import {runtimeContentDefinition,storyBindings} from './web/core/content/content_registry.mjs';
let input='';for await(const chunk of process.stdin)input+=chunk;
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
if(JSON.stringify(await read('web/data/runtime_content.json'))!==JSON.stringify(runtimeContentDefinition))
  throw Error('编辑登记与编译登记不一致，请先重建内容');
const story=await read('web/data/chapter_story.json'),resources=await read('web/data/chapter_map_resources.json');
const result=[];
for(const row of JSON.parse(input)){
  const data=await read(`web/data/maps/${row.map_id.toLowerCase()}.json`),binding=storyBindings(row.map_id);
  const extra=[...(resources.exits_by_map[row.map_id]??[]),...chapterRouteExits(row.map_id,story,resources)];
  const exits=[...(data.exits??[]).filter(e=>!extra.some(x=>x.id===e.id)),...extra];
  const triggers=(resources.trigger_regions[row.map_id]??[]).filter(t=>binding.triggers.includes(t.id));
  const ready=new Set([...exits.filter(e=>e.state==='ready').flatMap(e=>e.cells.map(c=>`${c.x},${c.y}`)),
    ...triggers.flatMap(t=>t.cells.map(c=>`${c.x},${c.y}`)),...nativeEmptyEventCells(data.movement,story.maps[row.map_id])]);
  const movement=new MovementMap({...data.movement,triggers:data.movement.triggers.map(t=>({...t,path_gate:!ready.has(`${t.x},${t.y}`)}))});
  const blocked=row.cells.filter(c=>c.terrain===0&&movement.cell(c.x,c.y).blocked)
    .map(c=>({...c,runtime_reason:movement.cell(c.x,c.y).reason}));
  result.push({...row,blocked_cells:blocked,blocked_count:blocked.length});
}
process.stdout.write(JSON.stringify(result));
'''
    result = subprocess.run(['node', '--input-type=module', '-e', code], cwd=runtime,
                            input=json.dumps(entries), capture_output=True, text=True)
    if result.returncode:
        raise ValueError('正式空事件通行规则检查失败：' + result.stderr[-3000:])
    return json.loads(result.stdout)


def audit(original_dir, runtime):
    source = Sources(original_dir)
    game = source.read('game.exe')
    if sha(game) != GAME_SHA:
        raise ValueError('审计规则只适用于已核实的原GAME SHA')
    contract = verify_contract(game)
    maps = {row['id']: row for row in (read_map(source, name) for name in source.names('map', '.dat'))}
    tlks = {row['id']: row for row in (read_tlk(source, name) for name in source.names('map', '.tlk'))}
    programs = {row['id']: row for row in (read_anm(source, name) for name in source.names('animate', '.anm'))}
    chr_dialogue = []
    for name in source.names('fight_role', '.chr'):
        raw = source.read(name)
        if len(raw) < 8 + 0x30b:
            raise ValueError('原CHR头截断：' + name)
        chr_dialogue.append(dict(source=name, sha256=sha(raw),
            embedded_record_count=u32(raw, 8 + 0x1ce),
            post_battle_record=u32(raw, 8 + 0x20a)))
    additional_sources = [row for row in chr_dialogue if row['embedded_record_count'] or row['post_battle_record']]
    content_path = runtime / 'web/data/runtime_content.json'
    content = json.loads(content_path.read_text('utf-8'))
    excluded_maps = {'MTEST'}
    incoming_maps, incoming_anm = defaultdict(list), defaultdict(list)
    for mid, table in maps.items():
        for d in table['descriptors']:
            if d['state'] == 0 and filename_id(d['filename'], '.dat'):
                incoming_maps[filename_id(d['filename'], '.dat')].append(dict(map=mid, descriptor=d['id'], cells=len(d['cells'])))
            if d['state'] == 1 and filename_id(d['filename'], '.anm'):
                incoming_anm[filename_id(d['filename'], '.anm').lower()].append(dict(map=mid, descriptor=d['id'], cells=len(d['cells'])))
    for mid, table in tlks.items():
        for record in table['records'].values():
            if record['kind'] == 1 and filename_id(record['text'], '.anm'):
                incoming_anm[filename_id(record['text'], '.anm').lower()].append(dict(map=mid, record=record['id']))
            if record['kind'] == 2 and filename_id(record['text'], '.dat'):
                incoming_maps[filename_id(record['text'], '.dat')].append(dict(map=mid, record=record['id']))
    for pid, program in programs.items():
        for command in program['commands']:
            if command['opcode'] == 10 and filename_id(command['filename'], '.dat'):
                incoming_maps[filename_id(command['filename'], '.dat')].append(dict(program=pid, command=command['index']))
    # The two seven-entry native world-menu tables use full filenames, not IDs.
    native_entries = []
    for base in [57342, 57578]:
        for index in range(7):
            at = base + index * 23
            name = text(game[at + 1:at + 21])
            mid = filename_id(name, '.dat')
            if mid in maps:
                incoming_maps[mid].append(dict(native_world_menu_offset=at))
                native_entries.append(mid)
    incoming_maps['M72061'].append(dict(native_new_game=True))
    roots, inactive, empty, disabled = [], [], [], []
    for mid, table in maps.items():
        binding = content['maps'].get(mid, {})
        for row in roots_for(table, tlks.get(mid, {}), binding):
            row.update(map_registered=mid in content['maps'], excluded=mid in excluded_maps)
            roots.append(row)
        for d in table['descriptors']:
            if d['state'] in [1, 2] and not d['cells']:
                inactive.append(dict(map_id=mid, id=d['id'], state=d['state'], target=d['target'], filename=d['filename'], source_offset=d['offset']))
            if d['cells'] and (d['state'] == 2 and d['target'] == 0
                               or d['state'] == 0 and not d['filename']):
                empty.append(dict(map_id=mid, id=d['id'], state=d['state'],
                                  source_offset=d['offset'], cells=d['cells']))
        disabled.extend(dict(map_id=mid, index=obj['index'], record=obj['record'], cf=obj['cf'])
                        for obj in table['objects'] if obj['disabled'] and obj['record'])
    formal_roots = [r for r in roots if r['map_registered'] and not r['excluded']]
    dangling = [r for r in formal_roots if r['node'] and r['node'][0] == 'tlk'
                and r['node'][2] not in tlks.get(r['map_id'], {}).get('records', {})]
    valid_roots = [r for r in formal_roots if r not in dangling]
    missing = [r for r in valid_roots if not r['registered']]
    opening_root = ('anm', 'resurrect', 'M72061', 0)
    full, invalid, transfers = walk([opening_root, *[r['node'] for r in valid_roots]], tlks, programs, maps)
    selected, selected_invalid, _ = walk([opening_root, *[r['node'] for r in valid_roots if r['registered']]], tlks, programs, maps)
    reachable_programs = {node[1] for node in full if node[0] == 'anm'}
    unregistered_programs = sorted(reachable_programs - set(content['programs']) - {'resurrect'})
    secondary = []
    for mid, table in tlks.items():
        for slot, target in table['index'].items():
            if mid in excluded_maps or slot in maps[mid]['npc_slots']:
                continue
            secondary.append(dict(map_id=mid, slot=slot, record_id=target,
                source=table['path'], source_offset=0x1a + slot * 4,
                selector=('player-slot' if slot < 10 else 'out-of-signed-byte-domain'
                          if slot >= 128 else 'absent-npc-slot'),
                independent_npc_root=False, root_path_discovered=('tlk', mid, target) in full))
    unregistered_maps = [dict(id=mid, name=table['name'], callers=incoming_maps[mid],
        excluded_test=mid in excluded_maps, same_name_tlk_present=mid in tlks,
        normal_source_entry=bool(incoming_maps[mid]),
        status=('excluded-test' if mid in excluded_maps else 'no-normal-source-entry'
                if contract['verified'] and not incoming_maps[mid] else 'source-investigation-required'))
        for mid, table in maps.items() if mid not in content['maps']]
    unregistered_anm = [dict(id=pid, callers=incoming_anm[pid], reachable=pid in reachable_programs,
        excluded_test=bool(incoming_anm[pid]) and all(row.get('map') == 'MTEST' for row in incoming_anm[pid]),
        status=('excluded-test' if incoming_anm[pid] and all(row.get('map') == 'MTEST' for row in incoming_anm[pid]) else
                'source-entry-reachable' if pid in reachable_programs else
                'no-normal-source-entry' if contract['verified'] else 'no-discovered-root-path'))
        for pid in programs if pid not in content['programs'] and pid != 'resurrect']
    physical_gaps, physical = [], []
    resources = json.loads((runtime / 'web/data/chapter_map_resources.json').read_text('utf-8'))
    for mid, table in maps.items():
        if mid not in content['maps']:
            continue
        for d in table['descriptors']:
            if d['state'] != 0 or not d['cells'] or not d['filename']:
                continue
            target = filename_id(d['filename'], '.dat')
            actual = next((r for r in resources['exits_by_map'].get(mid, []) if r['id'] == d['id']), None)
            row = dict(map_id=mid, id=d['id'], target=target,
                       registered=target in content['maps'], ready=bool(actual and actual['state'] == 'ready'))
            physical.append(row)
            if not row['registered'] or not row['ready']:
                physical_gaps.append(row)
    mismatches = runtime_sources(runtime, maps, tlks, programs, content)
    empty_runtime = runtime_empty_gates(runtime, [row for row in empty if row['map_id'] in content['maps']])
    guard_gaps = [row for row in empty_runtime if row['blocked_count']]
    unrooted_records = [dict(map_id=mid, record_id=record['id'], kind=record['kind'],
        source=table['path'], source_offset=record['offset'],
        status='excluded-test' if mid in excluded_maps else 'no-normal-source-entry'
            if contract['verified'] else 'no-discovered-root-path')
        for mid, table in tlks.items() for record in table['records'].values()
        if ('tlk', mid, record['id']) not in full]
    by_map = [dict(id=mid, name=table['name'], source=table['path'], source_sha256=table['sha256'],
        registered=mid in content['maps'], tlk_records=len(tlks.get(mid, {}).get('records', {})),
        tlk_unloaded_trailing_bytes=tlks.get(mid, {}).get('trailing_bytes', 0),
        npc_instances=len(table['npc_slots']), object_instances=len(table['objects']),
        roots=[dict(kind=r['kind'], id=r['id'], registered=r['registered']) for r in roots if r['map_id'] == mid],
        missing_roots=[dict(kind=r['kind'], id=r['id']) for r in missing if r['map_id'] == mid])
        for mid, table in maps.items()]
    return dict(schema='seventh-seal-source-content-coverage', version=1,
        created_utc=datetime.now(timezone.utc).isoformat(),
        scope='原文件全集及正常入口静态闭包；自然剧情阶段和动态实玩另验收',
        native_contract=contract,
        summary=dict(dat=len(maps), tlk=len(tlks), tlk_records=sum(len(t['records']) for t in tlks.values()),
            anm=len(programs), registered_maps=len(content['maps']), source_roots=len(formal_roots),
            valid_source_roots=len(valid_roots), independent_opening_root=1,
            source_objects=sum(len(t['objects']) for t in maps.values()),
            object_f6_by_cf={str(cf): sum(bool(obj['record']) and obj['cf'] == cf
                for table in maps.values() for obj in table['objects'])
                for cf in sorted({obj['cf'] for table in maps.values() for obj in table['objects'] if obj['record']})},
            source_npc_instances=sum(len(t['npc_slots']) for t in maps.values()),
            npc_record_callbacks=sum(len(t['npc_callbacks']) for t in maps.values()),
            source_npc_route_points=sum(t['route_points'] for t in maps.values()),
            npc_route_callbacks=sum(len(t['route_callbacks']) for t in maps.values()),
            source_chr=len(chr_dialogue),
            chr_embedded_tlk_records=sum(t['embedded_record_count'] for t in chr_dialogue),
            chr_post_battle_callbacks=sum(bool(t['post_battle_record']) for t in chr_dialogue),
            missing_valid_roots=len(missing), dangling_source_roots=len(dangling),
            physical_exits=len(physical), physical_exit_gaps=len(physical_gaps),
            reachable_tlk_records=sum(node[0] == 'tlk' for node in full),
            unrooted_tlk_records=len(unrooted_records),
            test_tlk_records=sum(row['status'] == 'excluded-test' for row in unrooted_records),
            completion_callbacks=sum(bool(obj['completion_record']) for t in maps.values() for obj in t['objects']),
            reachable_unregistered_programs=len(unregistered_programs), source_mismatches=len(mismatches),
            empty_trigger_guard_gaps=len(guard_gaps), empty_trigger_blocked_cells=sum(row['blocked_count'] for row in guard_gaps)),
        maps=by_map,
        chr_dialogue_sources=chr_dialogue, unclassified_additional_sources=additional_sources,
        unrooted_tlk_records=unrooted_records,
        potential_map_transfers=sorted(transfers, key=str),
        roots=roots, missing_roots=missing, dangling_source_roots=dangling,
        invalid_graph_targets=sorted(invalid), invalid_selected_graph_targets=sorted(selected_invalid),
        extra_reachable_records=sorted(node for node in full - selected if node[0] == 'tlk'),
        reachable_unregistered_programs=unregistered_programs,
        physical_exits=physical, physical_exit_gaps=physical_gaps,
        unregistered_maps=unregistered_maps, unregistered_anm=unregistered_anm,
        secondary_tlk_indexes=secondary, inactive_descriptors=inactive,
        empty_events=empty, empty_runtime=empty_runtime, runtime_guard_gaps=guard_gaps,
        disabled_objects_with_tlk=disabled,
        source_mismatches=mismatches, original_input_sha256=source.hashes,
        runtime_definition_sha256=sha(content_path.read_bytes()),
        runtime_input_sha256={name: sha((runtime / 'web/data' / name).read_bytes()) for name in
            ['runtime_content.json', 'runtime_content.mjs', 'chapter_story.json',
             'chapter_map_resources.json', 'opening_program.json', 'story/index.json']},
        audit_code_sha256=sha(Path(__file__).read_bytes()),
        audit_complete=True,
        source_coverage_passed=contract['verified'] and not any([missing, invalid, selected_invalid, unregistered_programs, physical_gaps, mismatches, additional_sources]),
        passed=contract['verified'] and not any([missing, invalid, selected_invalid, unregistered_programs, physical_gaps, mismatches, additional_sources, guard_gaps]),
        limits=['分支展开不根据当前旗标裁剪，不证明互斥条件可同时满足。',
                '无源入口不等于文件不能被调试选图或外来存档加载。',
                '未知玩法能力由独立能力检查报告，地图静态覆盖不替代功能和实玩。'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original-dir', type=Path, required=True)
    parser.add_argument('--runtime', type=Path, default=RUNTIME)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--check-runtime', action='store_true')
    args = parser.parse_args()
    report = audit(args.original_dir, args.runtime)
    if args.check_runtime:
        report['runtime_checks'] = []
        for name in ['check_content.mjs', 'export_story_packages.mjs']:
            command = ['node', str(args.runtime / 'tools' / name)] + (['--check'] if name.startswith('export_') else [])
            result = subprocess.run(command, capture_output=True, text=True)
            report['runtime_checks'].append(dict(command=command, returncode=result.returncode,
                passed=result.returncode == 0, output=(result.stdout + result.stderr).strip()))
        report['passed'] &= all(row['passed'] for row in report['runtime_checks'])
    if args.output:
        if args.output.exists():
            raise FileExistsError('不覆盖既有审计证据：' + str(args.output))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(dict(audit_complete=report['audit_complete'], source_coverage_passed=report['source_coverage_passed'],
        passed=report['passed'], summary=report['summary'], output=str(args.output)), ensure_ascii=False))
    raise SystemExit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()
