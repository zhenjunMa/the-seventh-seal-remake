"""迁移旧原型目录的本地素材和证据；默认只盘点，--run 才复制。"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json
import shutil


RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
LAYOUT = Path(__file__).with_name('layout_migration.json')


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def relocated_path(name, *, root=None):
    """读取旧台账时解析迁移路径；台账原文及其中的旧 SHA 保持不变。"""
    root = ROOT if root is None else root
    layout = json.loads(LAYOUT.read_text(encoding='utf-8'))
    for row in layout['files']:
        if name == row['previous_path']:
            return root / row['path']
    for row in layout['local_directories']:
        prefix = row['previous_path'] + '/'
        if name.startswith(prefix):
            return root / row['path'] / name[len(prefix):]
    return root / name


def migration_plan(source_root):
    layout = json.loads(LAYOUT.read_text(encoding='utf-8'))
    rows = []
    # 核对整个计划后才允许写入，冲突时保留两端原文件。
    for entry in layout['local_directories']:
        directory = source_root / entry['previous_path']
        if not directory.is_dir():
            continue
        for source in sorted(directory.rglob('*')):
            if not source.is_file() or '__pycache__' in source.parts:
                continue
            if not source.resolve().is_relative_to(directory.resolve()):
                raise ValueError(f'来源文件超出旧目录：{source}')
            destination = ROOT / entry['path'] / source.relative_to(directory)
            if not destination.resolve().is_relative_to((ROOT / entry['path']).resolve()):
                raise ValueError(f'目标文件超出迁移目录：{destination}')
            digest = sha(source)
            if destination.exists() and (not destination.is_file() or sha(destination) != digest):
                raise ValueError(f'目标已有不同内容，未覆盖：{destination}')
            rows.append(dict(source=source, destination=destination, sha256=digest,
                             status='unchanged' if destination.exists() else 'copy'))
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=ROOT, help='旧项目根目录，默认当前项目')
    parser.add_argument('--run', action='store_true', help='复制已核对文件，保留旧目录和原字节')
    args = parser.parse_args()
    rows = migration_plan(args.source_root.resolve())
    pending = [row for row in rows if row['status'] == 'copy']
    if args.run:
        for row in pending:
            if sha(row['source']) != row['sha256']:
                raise ValueError(f'盘点后来源发生变化：{row["source"]}')
            target = row['destination']
            target.parent.mkdir(parents=True, exist_ok=True)
            # 独占创建避免盘点之后出现的新文件被覆盖。
            with row['source'].open('rb') as source, target.open('xb') as destination:
                shutil.copyfileobj(source, destination)
            if sha(target) != row['sha256']:
                raise ValueError(f'复制后指纹不符：{target}')
        if rows:
            directory = RUNTIME / 'evidence/layout_migration'
            directory.mkdir(parents=True, exist_ok=True)
            report = directory / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.json')
            report.write_text(json.dumps(dict(schema='seventh-seal-local-material-migration', version=1,
                source_root=str(args.source_root.resolve()), files=[{
                    **row, 'source': str(row['source']),
                    'destination': str(row['destination'].relative_to(ROOT))} for row in rows]),
                ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(dict(mode='copied' if args.run else 'preview', files=len(rows),
                          copied=len(pending) if args.run else 0, pending=0 if args.run else len(pending),
                          unchanged=len(rows)-len(pending)), ensure_ascii=False))


if __name__ == '__main__':
    main()
