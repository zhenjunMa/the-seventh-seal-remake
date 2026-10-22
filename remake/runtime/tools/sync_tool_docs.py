"""从构建声明同步文档清单；--check 只检查，不执行导出或写入证据。"""
from pathlib import Path
from datetime import datetime, timedelta, timezone
import argparse
import json

from build_runtime import STEPS, plan


TOOLS = Path(__file__).resolve().parent
INDEX = TOOLS / 'tool_index.json'
README = TOOLS / 'README.txt'
BEGIN = '[自动生成：构建目标开始]'
END = '[自动生成：构建目标结束]'


def generated_files():
    index = json.loads(INDEX.read_text(encoding='utf-8'))
    rows = {row['path']: row for row in index['tools']}
    actual = {path.name for path in TOOLS.iterdir()
              if path.is_file() and path.suffix in {'.py', '.mjs', '.js'}}
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

    readme = README.read_text(encoding='utf-8')
    if readme.count(BEGIN) != 1 or readme.count(END) != 1:
        raise ValueError('README.txt 必须有唯一的构建清单起止标记')
    before, rest = readme.split(BEGIN)
    _, after = rest.split(END)
    lines = [f'{name}: {step.tool}; 依赖={",".join(step.depends) or "无声明依赖"}'
             for name, step in STEPS.items()]
    return {
        INDEX: json.dumps(index, ensure_ascii=False, indent=2) + '\n',
        README: before + BEGIN + '\n' + '\n'.join(lines) + '\n' + END + after,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='只读核对生成内容是否与构建代码一致')
    args = parser.parse_args()
    # 先准备全部内容，避免索引或文档有误时只写入一部分。
    files = generated_files()
    changed = [path for path, value in files.items() if path.read_text(encoding='utf-8') != value]
    if args.check:
        if changed:
            parser.exit(1, '构建文档待同步：' + '、'.join(path.name for path in changed) + '\n')
        print('构建文档一致：目标数量、content 计划、工具目标和依赖清单均通过。')
        return
    for path in changed:
        newline = '\r\n' if b'\r\n' in path.read_bytes() else '\n'
        path.write_bytes(files[path].replace('\n', newline).encode('utf-8'))
    print('已同步：' + ('、'.join(path.name for path in changed) or '无需更新'))


if __name__ == '__main__':
    main()
