"""One-time conversion of existing remake JSON progress to original v2 saves.

Normal gameplay never reads JSON saves. All inputs and overwritten test saves
are backed up outside saves; --apply installs the verified native outputs.
"""
from pathlib import Path
from copy import deepcopy
import argparse
import hashlib
import json
import os
import shutil
import sys

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME))
from native_save import decode_native_save, encode_native_save, resources


def converted_envelope(envelope, source_root=ROOT):
    if hashlib.sha256(envelope['payload'].encode('utf-8')).hexdigest() != envelope['sha256']:
        raise ValueError('旧存档校验失败，原存档已保留')
    world = json.loads(envelope['payload'])
    source = world.get('source', {})
    original_path = (source_root / source.get('path', '')).resolve()
    if not world.get('native_save') and original_path.suffix.lower() in ('.dat', '.sav'):
        if not original_path.is_relative_to(source_root.resolve()):
            raise ValueError('旧存档来源不在游戏目录中')
        original = json.loads(decode_native_save(original_path.read_bytes())['payload'])
        roles = {role['id']: role for role in original['party']}
        roles.update({row['role']['id']: row['role'] for row in original['reserve_party']})
        world = {**original, **world}
        world['party'] = [{**roles[role['id']], **role} for role in world['party']]
        world['source'] = {**deepcopy(resources()[0]['source']), **source}
    payload = json.dumps(world, ensure_ascii=False, separators=(',', ':'))
    result = {**envelope, 'payload': payload, 'sha256': hashlib.sha256(payload.encode('utf-8')).hexdigest()}
    if result.get('preview'):
        result['preview'] = {**result['preview'], 'payload_sha256': result['sha256']}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--save-dir', type=Path, default=RUNTIME.parent / 'saves')
    parser.add_argument('--backup-dir', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    saves = args.save_dir.resolve()
    backup = args.backup_dir.resolve()
    if backup.is_relative_to(saves):
        parser.error('备份目录必须位于 saves 之外')
    names = {f'SaveGame{index:02}.json': f'SaveGame{index}.Dat' for index in range(20)}
    names['QuickSave.json'] = 'Game.SAV'
    outputs = []
    for source_name, target_name in names.items():
        path = saves / source_name
        if not path.exists():
            continue
        envelope = json.loads(path.read_bytes())
        raw = encode_native_save(converted_envelope(envelope))
        restored = json.loads(decode_native_save(raw)['payload'])
        outputs.append((path, target_name, raw, restored))
    if not outputs:
        raise SystemExit('没有待转换的重制版JSON存档')
    (backup / 'inputs').mkdir(parents=True, exist_ok=False)
    (backup / 'converted').mkdir()
    for path in saves.iterdir():
        if path.is_file():
            shutil.copy2(path, backup / 'inputs' / path.name)
    report = {'applied': args.apply, 'save_dir': str(saves), 'backup_dir': str(backup), 'files': []}
    for source, target, raw, world in outputs:
        staged = backup / 'converted' / target
        staged.write_bytes(raw)
        report['files'].append(dict(source=source.name, target=target, bytes=len(raw),
            source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
            sha256=hashlib.sha256(raw).hexdigest(), location=world['location'],
            party=[dict(id=r['id'], level=r['level']) for r in world['party']],
            inventory_records=len(world['inventory'])))
    if args.apply:
        for source, target, raw, _ in outputs:
            temporary = saves / (target + '.tmp')
            temporary.write_bytes(raw)
            os.replace(temporary, saves / target)
            metadata = source.stat()
            os.utime(saves / target, (metadata.st_atime, metadata.st_mtime))
            source.unlink()
    (backup / 'migration.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
