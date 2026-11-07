"""从构建声明同步工具索引；--check 只检查，不执行导出。"""
from pathlib import Path
from datetime import datetime, timedelta, timezone
import argparse
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_runtime import STEPS, plan


TOOLS = Path(__file__).resolve().parent
INDEX = TOOLS / 'tool_index.json'


def generated_files():
    index = json.loads(INDEX.read_text(encoding='utf-8'))
    rows = {row['path']: row for row in index['tools']}
    actual = {path.relative_to(TOOLS).as_posix() for path in TOOLS.rglob('*')
              if path.is_file() and '__pycache__' not in path.parts
              and path.suffix in {'.py', '.mjs', '.js'}}
    if len(rows) != len(index['tools']) or set(rows) != actual:
        raise ValueError(f'工具索引需先人工核对分类：缺少={sorted(actual-set(rows))}，'
                         f'失效={sorted(set(rows)-actual)}；path 不得重复')
    for step in STEPS.values():
        if step.tool not in rows:
            raise ValueError(f'构建工具未登记：{step.tool}')

    index['registered_steps'] = len(STEPS)
    index['content_plan'] = plan(['content'])
    for path, row in rows.items():
        row['build_targets'] = [name for name, step in STEPS.items() if step.tool == path]
    # 分类、导入关系、历史路径和恢复映射由维护者核对，生成器只更新派生字段。
    if index != json.loads(INDEX.read_text(encoding='utf-8')):
        index['updated'] = datetime.now(timezone(timedelta(hours=8))).date().isoformat()

    return {
        INDEX: json.dumps(index, ensure_ascii=False, indent=2) + '\n',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='只读核对生成内容是否与构建代码一致')
    args = parser.parse_args()
    # 先核对工具分类和构建声明，再写入派生字段。
    files = generated_files()
    changed = [path for path, value in files.items() if path.read_text(encoding='utf-8') != value]
    if args.check:
        if changed:
            parser.exit(1, '工具索引待同步：' + '、'.join(path.name for path in changed) + '\n')
        print('工具索引一致：工具分类、目标数量、content 计划和工具目标均通过。')
        return
    for path in changed:
        newline = '\r\n' if b'\r\n' in path.read_bytes() else '\n'
        path.write_bytes(files[path].replace('\n', newline).encode('utf-8'))
    print('已同步：' + ('、'.join(path.name for path in changed) or '无需更新'))


if __name__ == '__main__':
    main()
