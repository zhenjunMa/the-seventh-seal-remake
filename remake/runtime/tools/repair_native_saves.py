"""Repair native saves written with the remake's missing-role-identity bug.

Preview backs up the originals and stages checked outputs. Only --apply replaces
player files; filenames, timestamps and all unrelated progress stay unchanged.
"""
from pathlib import Path
from base64 import b64encode
import argparse
import hashlib
import json
import os
import re
import struct
import sys

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME))
from native_save import decode_native_save, encode_native_save, resources, initialize_map_npc, map_actions, native_camera_position
from tools.source.save_format import complete_layout


def repair_save(raw):
    """Return a candidate only after checking every byte outside named fixes."""
    _, skills, items, maps, _ = resources()
    layout = complete_layout(raw, {int(k): v['name'] for k, v in items.items()})
    named = [role for role in layout['characters'] if role['name']]
    missing = [role for role in named if struct.unpack_from('<I', raw, role['header_offset'] + 0x2FF)[0] == 0]
    report = dict(source_sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw),
                  bug_signature=dict(missing_role_identity_slots=[role['role_index'] for role in missing]),
                  changed=False, allowed_byte_ranges=[], domains=[])
    if not missing:
        report.update(sha256=report['source_sha256'], status='healthy-source-preserved')
        return raw, report

    envelope = decode_native_save(raw)
    world = json.loads(envelope['payload'])
    map_id = world['location']['map_id']
    map_header = bytes.fromhex(maps[map_id]['header_raw_hex'])
    map_key = struct.unpack_from('<I', map_header, 0x92)[0]
    roles = {role['id']: role for role in world['party']}
    roles.update({entry['role']['id']: entry['role'] for entry in world['reserve_party']})
    allowed = [(0x34, 4, 'native loading progress total: 2048 + NPC count')]
    for role in named:
        at = role['header_offset']
        role_id = f'{role["role_index"] + 1:03}'
        allowed.append((at + 0x2FF, 4, f'{role_id}: native role identity'))
        if role_id in world['formation_slots']:
            allowed.append((at + 0x303, 4, f'{role_id}: formation slot'))
            # The earlier writer put this slot in an unrelated, unmapped field.
            # Restore it only for the observed missing-identity signature and
            # only when its value is exactly that earlier writer's value.
            old_slot = world['formation_slots'].index(role_id)
            if role in missing and struct.unpack_from('<I', raw, at + 0x2B3)[0] == old_slot:
                initial = bytes.fromhex(skills[role_id]['header_raw_hex'])
                head = bytearray.fromhex(roles[role_id]['combat_progress']['header_raw_hex'])
                head[0x2B3:0x2B7] = initial[0x2B3:0x2B7]
                roles[role_id]['combat_progress']['header_raw_hex'] = head.hex()
                allowed.append((at + 0x2B3, 4, f'{role_id}: undo known misplaced formation write'))
    actor_section = next(row for row in layout['sections'] if row['section'] == 'map_objects')
    dynamic = actor_section['offset'] + 8 + 10 * 0x4C5
    repaired_base = bytearray(raw)
    camera = native_camera_position(map_header, maps[map_id]['native_camera_extent_cells'],
                                    round(world['location']['x'] / 2), round(world['location']['y'] / 2))
    struct.pack_into('<2I', repaired_base, 0x61, *camera)
    allowed.append((0x61, 8, 'native viewport position'))
    for role in world['party']:
        at = dynamic + (int(role['id']) - 1) * 0x4C5 + 0x93
        struct.pack_into('<I', repaired_base, at, map_key)
        allowed.append((at, 4, f'{role["id"]}: active map layer'))
    npc_sources = {npc['slot_zero_based']: npc for npc in maps[map_id]['npc_records']}
    for actor in world['map_npc_state']['actors']:
        actor['layer'] = map_key
        at = dynamic + actor['slot'] * 0x4C5
        source = bytes.fromhex(npc_sources[actor['slot']]['raw_hex'])
        initial = initialize_map_npc(source, map_header)
        # Home, channels and DAT ranges were never converted to live state by
        # the old writer. Keep pose, route progress and AI clocks untouched.
        fields = [(0x2F, 1), (0x30, 8), (0x46, 20), (0x5B, 8), (0x93, 4),
                  (0xC5, 1), (0xD6, 4), (0xE0, 1), (0x2C7, 4), (0x2CB, 4),
                  (0x2D3, 4), (0x2D7, 4), (0x2DF, 4), (0x2EF, 4), (0x2FF, 4),
                  (0x30B, 4), (0x30F, 4), (0x495, 4)]
        for route in range(struct.unpack_from('<I', source, 0x14B)[0]):
            fields.extend(((0x14F + route * 0x15, 4), (0x153 + route * 0x15, 4)))
        for offset, length in fields:
            repaired_base[at + offset:at + offset + length] = initial[offset:offset + length]
            allowed.append((at + offset, length, f'NPC {actor["slot"]}: native initialization +0x{offset:X}'))
        definition = map_actions().get(f'{struct.unpack_from("<I", source, 0x28)[0]:03}', {}).get(actor['action'])
        if definition:
            physical = definition['first_frame'] + actor['frame'] + (
                actor['direction'] * definition['frame_count'] if definition['directions'] == 8 else 0)
            struct.pack_into('<I', repaired_base, at + 0x7F, actor['direction'])
            struct.pack_into('<I', repaired_base, at + 0x8B, physical)
            allowed.extend(((at + 0x7F, 4, f'NPC {actor["slot"]}: current pose direction cache'),
                            (at + 0x8B, 4, f'NPC {actor["slot"]}: current pose physical frame')))
    if raw[0x3A9:0x3B1] == bytes(8):
        world['game_settings'] = dict(audio={name: dict(volume=1, muted=False)
                                             for name in ('master', 'music', 'effects')},
                                      battle_cursor='memory')
        allowed.append((0x3A9, 8, 'restore missing native settings defaults'))
    world['native_save']['raw'] = b64encode(repaired_base).decode('ascii')
    payload = json.dumps(world, ensure_ascii=False, separators=(',', ':'))
    envelope.update(payload=payload, sha256=hashlib.sha256(payload.encode('utf-8')).hexdigest())
    if envelope.get('preview'):
        envelope['preview']['payload_sha256'] = envelope['sha256']
    candidate = encode_native_save(envelope)

    if len(candidate) != len(raw):
        raise ValueError('修复改变了存档长度，未安装候选文件')
    permitted = {offset for at, size, _ in allowed for offset in range(at, at + size)}
    unexpected = next((index for index, (before, after) in enumerate(zip(raw, candidate))
                       if before != after and index not in permitted), None)
    if unexpected is not None:
        raise ValueError(f'修复越过允许字段：0x{unexpected:X}，未安装候选文件')
    if struct.unpack_from('<I', candidate, 0x34)[0] != 2048 + actor_section['map_npc_count']:
        raise ValueError('原版加载进度总量未正确修复')
    if struct.unpack_from('<2I', candidate, 0x61) != camera:
        raise ValueError('原版视口位置未正确修复')
    for role in named:
        at = role['header_offset']
        role_id = f'{role["role_index"] + 1:03}'
        if struct.unpack_from('<I', candidate, at + 0x2FF)[0] != role['role_index'] + 1:
            raise ValueError(f'{role_id}原版身份未正确修复')
        if role_id in world['formation_slots'] and struct.unpack_from('<I', candidate, at + 0x303)[0] != world['formation_slots'].index(role_id):
            raise ValueError(f'{role_id}原版队列位置未正确修复')
    for actor in world['map_npc_state']['actors']:
        if struct.unpack_from('<I', candidate, dynamic + actor['slot'] * 0x4C5 + 0x93)[0] != map_key:
            raise ValueError('原版地图人物层码未正确修复')
    if raw[0x3A9:0x3B1] == bytes(8) and candidate[0x3A9:0x3B1] != bytes((64, 64, 64, 1, 1, 1, 1, 0)):
        raise ValueError('原版默认设置未正确修复')

    # Each section includes every original byte. Mask only the explicitly listed
    # repairs; role-header checks therefore include HP/MP, attributes and growth.
    for row in layout['sections']:
        at, size = row['offset'], row['length']
        before, after = bytearray(raw[at:at + size]), bytearray(candidate[at:at + size])
        original_sha = hashlib.sha256(before).hexdigest()
        repaired_sha = hashlib.sha256(after).hexdigest()
        for start, length, _ in allowed:
            low, high = max(at, start), min(at + size, start + length)
            if low < high:
                before[low - at:high - at] = bytes(high - low)
                after[low - at:high - at] = bytes(high - low)
        if before != after:
            raise ValueError(f'{row["section"]}进度发生非预期变化，未安装候选文件')
        domain = row['section'] if row['section'] != 'role' else f'role:{row["index"] + 1:03}'
        report['domains'].append(dict(domain=domain, offset=at, bytes=size,
            before_sha256=original_sha, after_sha256=repaired_sha,
            preserved_sha256=hashlib.sha256(before).hexdigest(), unrelated_progress_equal=True))
    for role in named:
        at, end = role['header_offset'] + 0x30B, role['end_offset']
        report['domains'].append(dict(domain=f'role:{role["role_index"] + 1:03}:skills-and-actions',
            offset=at, bytes=end - at, before_sha256=hashlib.sha256(raw[at:end]).hexdigest(),
            after_sha256=hashlib.sha256(candidate[at:end]).hexdigest(),
            unrelated_progress_equal=raw[at:end] == candidate[at:end]))
    for at, size, reason in sorted(allowed):
        report['allowed_byte_ranges'].append(dict(offset=at, offset_hex=f'0x{at:X}', bytes=size,
            reason=reason, before_hex=raw[at:at + size].hex(), after_hex=candidate[at:at + size].hex()))
    report.update(status='known-remake-signature-repaired', changed=raw != candidate,
                  sha256=hashlib.sha256(candidate).hexdigest(),
                  changed_bytes=sum(a != b for a, b in zip(raw, candidate)),
                  preserved_domains=['HP/MP、属性与成长', '装备与晶石', '背包', '旗标与事件',
                                     '技能定义、学习、熟练度与动作', '地图、世界表与配方', '累计时间'])
    return candidate, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--save-dir', type=Path, default=RUNTIME.parent / 'saves')
    parser.add_argument('--backup-dir', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    saves, backup = args.save_dir.resolve(), args.backup_dir.resolve()
    if backup.is_relative_to(saves):
        parser.error('备份目录必须位于 saves 之外')
    paths = sorted(path for path in saves.iterdir() if path.is_file()
                   and re.fullmatch(r'(SaveGame\d+\.Dat|Game\.SAV)', path.name, re.IGNORECASE))
    if not paths:
        raise SystemExit('没有可检查的原版格式存档')
    outputs = []
    for path in paths:
        metadata = path.stat()
        raw = path.read_bytes()
        candidate, entry = repair_save(raw)
        entry.update(name=path.name, mtime_ns=metadata.st_mtime_ns)
        outputs.append((path, metadata, raw, candidate, entry))
    (backup / 'inputs').mkdir(parents=True, exist_ok=False)
    (backup / 'repaired').mkdir()
    # Back up every input before replacing any player file.
    for path, metadata, raw, _, _ in outputs:
        original = backup / 'inputs' / path.name
        original.write_bytes(raw)
        os.utime(original, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
    for path, metadata, _, candidate, _ in outputs:
        staged = backup / 'repaired' / path.name
        staged.write_bytes(candidate)
        os.utime(staged, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
    if args.apply:
        for path, metadata, _, candidate, entry in outputs:
            if entry['changed']:
                temporary = path.with_name(path.name + '.repair.tmp')
                temporary.write_bytes(candidate)
                os.replace(temporary, path)
                os.utime(path, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
    report = dict(applied=args.apply, save_dir=str(saves), backup_dir=str(backup),
                  files=[entry for _, _, _, _, entry in outputs])
    (backup / 'repair.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
