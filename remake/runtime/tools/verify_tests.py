"""按职责运行回归；默认 daily 不需要原版、媒体、历史证据或图像库。"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import fnmatch
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
TESTS = RUNTIME / 'tests'
MANIFEST = TESTS / 'suites.json'


def load_manifest():
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    if manifest.get('version') != 1:
        raise ValueError('不支持的测试清单版本')
    entries = [name for suite in manifest['suites'].values() for name in suite['files']]
    actual = {path.name for pattern in ('test_*.mjs', 'test_*.py') for path in TESTS.glob(pattern)}
    if len(entries) != len(set(entries)) or set(entries) != actual:
        raise ValueError(f'测试职责清单需更新：未分类={sorted(actual-set(entries))}，'
                         f'失效={sorted(set(entries)-actual)}；每个文件只能登记一次')
    for name in entries:
        if Path(name).name != name:
            raise ValueError(f'测试路径必须是 tests 下的文件名：{name}')
    if set(manifest.get('requirements', {})) - actual:
        raise ValueError('前置条件引用了不存在的测试')
    return manifest


def select_tests(manifest, suites, patterns=()):
    selected = set()
    for suite in suites:
        names = manifest['suites'] if suite == 'all' else manifest['aliases'].get(suite, [suite])
        for name in names:
            if name not in manifest['suites']:
                raise ValueError(f'未知测试组：{name}')
            selected.update(manifest['suites'][name]['files'])
    if patterns:
        selected = {name for name in selected if any(fnmatch.fnmatchcase(name, pattern) for pattern in patterns)}
    if not selected:
        raise ValueError('没有匹配的测试；请先用 --list 查看范围')
    return sorted(selected)


def missing_requirements(manifest, selected):
    missing = {}
    group_requirements = {name: suite.get('requires', []) for suite in manifest['suites'].values()
                          for name in suite['files']}
    for name in selected:
        for requirement in [*group_requirements[name], *manifest.get('requirements', {}).get(name, [])]:
            absent = (importlib.util.find_spec(requirement[7:]) is None if requirement.startswith('python:')
                      else not (ROOT / requirement).exists())
            if absent:
                missing.setdefault(requirement, []).append(name)
    if not shutil.which('node') and any(name.endswith('.mjs') for name in selected):
        missing['command:node'] = [name for name in selected if name.endswith('.mjs')]
    return missing


def fingerprints(manifest, selected):
    paths = {TESTS/name for name in selected} | {MANIFEST}
    paths.update(path for directory in (TESTS/'helpers', RUNTIME/'tools', RUNTIME/'web')
                 for path in directory.rglob('*') if path.is_file()
                 and '__pycache__' not in path.parts and 'vendor' not in path.parts
                 and path.suffix in {'.py', '.mjs', '.js', '.json', '.html', '.css'})
    paths.add(RUNTIME/'web/vendor/phaser/manifest.json')
    for name in selected:
        for requirement in manifest.get('requirements', {}).get(name, []):
            path = ROOT/requirement
            if not requirement.startswith('python:') and path.is_file():
                paths.add(path)
    for suite in manifest['suites'].values():
        if set(selected) & set(suite['files']):
            paths.update(ROOT/name for name in suite.get('requires', []) if (ROOT/name).is_file())
    return {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths)}


def run_suites(suites=('daily',), patterns=(), timeout=300):
    manifest = load_manifest()
    selected = select_tests(manifest, suites, patterns)
    report = dict(schema='seventh-seal-test-run', version=1, suites=list(suites), files=selected,
                  passed=False, missing=missing_requirements(manifest, selected), runs=[])
    if report['missing']:
        return report
    report['fingerprints'] = fingerprints(manifest, selected)
    environment = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
    # Specialized exporter overrides must not leak into a normal regression.
    for key in list(environment):
        if key.startswith('SEVENTH_SEAL_') or key in {'FIRST_RETURN_RUNTIME', 'WHITE_FOREST_CHEST_REPORT'}:
            del environment[key]
    javascript = [name for name in selected if name.endswith('.mjs')]
    python = [name for name in selected if name.endswith('.py')]
    commands = []
    if javascript:
        commands.append(('javascript', javascript, [shutil.which('node'), '--test', '--test-reporter=tap',
                                                   *[str(TESTS/name) for name in javascript]]))
    if python:
        # Embedded/isolated Python may omit cwd from sys.path. Pass the chosen
        # test directory explicitly so discovery does not depend on host setup.
        loader = 'import sys, unittest; sys.path.insert(0, sys.argv[1]); unittest.main(module=None, argv=[sys.argv[0], *sys.argv[2:]])'
        commands.append(('python', python, [sys.executable, '-B', '-c', loader, str(TESTS),
                                           *[name.removesuffix('.py') for name in python]]))
    for language, files, command in commands:
        started = time.monotonic()
        try:
            result = subprocess.run(command, cwd=TESTS if language == 'python' else ROOT,
                                    env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    encoding='utf-8', errors='replace', timeout=timeout)
            output, returncode = result.stdout, result.returncode
        except subprocess.TimeoutExpired as error:
            output = error.stdout or b''
            if isinstance(output, bytes):
                output = output.decode('utf-8', errors='replace')
            output += f'\n测试超过 {timeout} 秒，已终止。\n'
            returncode = 124
        if language == 'javascript':
            counts = {key: int(value) for key, value in re.findall(
                r'^# (tests|pass|fail|cancelled|skipped) (\d+)$', output, re.M)}
            passed = (returncode == 0 and counts.get('tests', 0) > 0
                      and counts.get('tests') == counts.get('pass')
                      and all(counts.get(key) == 0 for key in ('fail', 'cancelled', 'skipped')))
        else:
            ran = re.search(r'^Ran (\d+) tests?\b', output, re.M)
            skipped = re.search(r'skipped=(\d+)', output)
            counts = dict(tests=int(ran[1]) if ran else 0, skipped=int(skipped[1]) if skipped else 0)
            passed = returncode == 0 and counts['tests'] > 0 and counts['skipped'] == 0
        report['runs'].append(dict(language=language, files=files, command=command, counts=counts,
                                   passed=passed, returncode=returncode,
                                   seconds=round(time.monotonic()-started, 3), output=output))
    after = fingerprints(manifest, selected)
    report['changed_inputs'] = sorted(name for name in set(report['fingerprints']) | set(after)
                                      if report['fingerprints'].get(name) != after.get(name))
    report['passed'] = (bool(report['runs']) and all(run['passed'] for run in report['runs'])
                        and not report['changed_inputs'])
    return report


def save_report(report):
    # Fresh directories keep milestone reports immutable, including failed runs.
    directory = RUNTIME / 'evidence/test_runs'
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-')
    folder = Path(tempfile.mkdtemp(prefix=stamp, dir=directory))
    summary = {**report, 'runs': []}
    for run in report['runs']:
        filename = run['language'] + ('.tap' if run['language'] == 'javascript' else '.log')
        (folder/filename).write_text(run['output'], encoding='utf-8')
        summary['runs'].append({**{key: value for key, value in run.items() if key != 'output'}, 'log': filename})
    (folder/'run.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    return folder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', action='append', help='daily（默认）、runtime、content、source、assets、integration、history 或 all；可重复')
    parser.add_argument('--match', action='append', default=[], help='组内文件名通配符，可重复，例如 "*battle*"')
    parser.add_argument('--list', action='store_true', help='只列出选中的文件及前置条件')
    parser.add_argument('--check', action='store_true', help='只核对所有测试均已分类且无重复或失效条目')
    parser.add_argument('--report', action='store_true', help='将结果保存到新的 evidence/test_runs 子目录')
    parser.add_argument('--timeout', type=int, default=300, help='每种语言的执行上限，单位秒')
    args = parser.parse_args()
    try:
        if args.timeout <= 0:
            raise ValueError('--timeout 必须大于零')
        manifest = load_manifest()
        if args.check:
            print('测试职责清单完整：'+ '，'.join(f'{name}={len(row["files"])}' for name, row in manifest['suites'].items()))
            return
        suites = args.suite or ['daily']
        selected = select_tests(manifest, suites, args.match)
        if args.list:
            for name, row in manifest['suites'].items():
                names = sorted(set(selected) & set(row['files']))
                if names:
                    print(f'{name}：{row["description"]}（{len(names)} 文件）')
                    for file in names:
                        requirements = [*row.get('requires', []), *manifest.get('requirements', {}).get(file, [])]
                        print('  '+file+('；需要 '+ '、'.join(requirements) if requirements else ''))
            return
        report = run_suites(suites, args.match, args.timeout)
        for requirement, files in report['missing'].items():
            print(f'缺少前置：{requirement}（影响 {len(files)} 个测试文件）')
        for run in report['runs']:
            print(f'{run["language"]}：{len(run["files"])} 文件，{run["counts"]}，{run["seconds"]} 秒，'
                  + ('通过' if run['passed'] else '失败'))
            if not run['passed']:
                print(run['output'])
        if report.get('changed_inputs'):
            print('测试期间输入发生变化，本次结果无效：'+'、'.join(report['changed_inputs']))
        if args.report:
            print('本次报告：'+str(save_report(report)))
        if report['missing']:
            print('未执行测试。请补齐已选组的前置条件；日常回归使用 --suite daily。')
        raise SystemExit(0 if report['passed'] else 1)
    except (ValueError, OSError) as error:
        parser.exit(2, str(error)+'\n')


if __name__ == '__main__':
    main()
