"""按影响范围验收；默认 task，完整遍历、版本交付和来源审计显式选择。"""
from pathlib import Path
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
import argparse
import ast
import fnmatch
import hashlib
import importlib.util
import json
import os
import platform
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
CACHE = RUNTIME / '.cache/test_results'
CACHE_VERSION = 2


def load_manifest():
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    if manifest.get('version') != 2:
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
    if set(manifest.get('smoke', [])) - actual:
        raise ValueError('核心冒烟引用了不存在的测试')
    for profile, names in manifest['profiles'].items():
        if set(names) - manifest['suites'].keys():
            raise ValueError(f'验收档位引用了未知测试组：{profile}')
    for suite in manifest['suites'].values():
        if not suite.get('layer'):
            raise ValueError('测试组必须声明验证层级')
        if suite.get('cache') and (suite.get('requires') or any(
                manifest.get('requirements', {}).get(name) for name in suite['files'])):
            raise ValueError('依赖外部环境的测试组不能自动复用结果')
    return manifest


def select_tests(manifest, suites, patterns=()):
    selected = set()
    for suite in suites:
        names = manifest['suites'] if suite == 'all' else manifest.get('aliases', {}).get(suite, [suite])
        for name in names:
            if name not in manifest['suites']:
                raise ValueError(f'未知测试组：{name}')
            selected.update(manifest['suites'][name]['files'])
    if patterns:
        selected = {name for name in selected if any(fnmatch.fnmatchcase(name, p) for p in patterns)}
    if not selected:
        raise ValueError('没有匹配的测试；请先用 --list 查看范围')
    return sorted(selected)


def repo_path(name):
    path = (ROOT / name).resolve()
    if not path.is_relative_to(ROOT.resolve()):
        raise ValueError(f'改动路径超出项目：{name}')
    return path.relative_to(ROOT.resolve()).as_posix()


def changed_files(since='HEAD'):
    revision = subprocess.run(['git', 'rev-parse', '--verify', '--end-of-options', since+'^{commit}'],
                              cwd=ROOT, capture_output=True, encoding='utf-8')
    if revision.returncode:
        raise ValueError('Git 基线不是有效提交：'+since+'；可显式传 --changed')
    result = subprocess.run(['git', 'diff', '--name-only', '-z', revision.stdout.strip(), '--'], cwd=ROOT,
                            capture_output=True, encoding='utf-8')
    if result.returncode:
        raise ValueError('无法确定改动范围：'+result.stderr.strip()+'；可显式传 --changed')
    untracked = subprocess.run(['git', 'ls-files', '--others', '--exclude-standard', '-z'],
                              cwd=ROOT, capture_output=True, encoding='utf-8', check=True)
    return sorted({repo_path(name) for name in (result.stdout+untracked.stdout).split('\0') if name})


def dependencies(path, parsed):
    """只推导代码 import；动态数据依赖在计划中保守扩大，不冒称精确分析。"""
    path = path.resolve()
    if path in parsed:
        return parsed[path]
    found = set()
    if path.is_file() and path.suffix in {'.mjs', '.js', '.py'}:
        source = path.read_text(encoding='utf-8-sig')
        if path.suffix == '.py':
            try:
                tree = ast.parse(source)
            except SyntaxError:
                return found
            for node in ast.walk(tree):
                modules = ([node.module] if isinstance(node, ast.ImportFrom) and node.module
                           else [alias.name for alias in node.names] if isinstance(node, ast.Import) else [])
                for module in modules:
                    relative = Path(*module.split('.')).with_suffix('.py')
                    for base in (path.parent, RUNTIME/'tools', ROOT/'save_analysis_20261010'):
                        candidate = base/relative
                        if candidate.is_file():
                            found.add(candidate.resolve())
        else:
            for specifier in re.findall(r'''(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']''', source):
                if specifier.startswith('.'):
                    found.add((path.parent/specifier).resolve())
                elif specifier.startswith('/'):
                    found.add((RUNTIME/'web'/specifier.lstrip('/')).resolve())
    parsed[path] = found
    return found


def test_dependencies(name, parsed):
    pending, result = [TESTS/name], set()
    while pending:
        path = pending.pop().resolve()
        if path in result or not path.is_relative_to(ROOT.resolve()):
            continue
        result.add(path)
        pending.extend(dependencies(path, parsed)-result)
    return result


def domain_files(manifest, names, selected, closures):
    matched = set()
    for domain in names:
        if domain not in manifest['domains']:
            raise ValueError(f'未知系统：{domain}')
        row = manifest['domains'][domain]
        for name in selected:
            if any(fnmatch.fnmatchcase(name, p) for p in row.get('tests', [])) or any(
                    fnmatch.fnmatchcase(path.relative_to(RUNTIME).as_posix(), pattern)
                    for path in closures[name] if path.is_relative_to(RUNTIME)
                    for pattern in row.get('modules', [])):
                matched.add(name)
    return matched


def make_plan(manifest, profile='task', changed=None, domains=(), regions=(), since='HEAD', patterns=()):
    if profile not in manifest['profiles']:
        raise ValueError(f'未知验收档位：{profile}')
    for region in regions:
        if region not in manifest.get('regions', {}):
            raise ValueError(f'未知区域：{region}')
    changed = changed_files(since) if changed is None else sorted({repo_path(name) for name in changed})
    pool = set(select_tests(manifest, manifest['profiles'][profile]))
    parsed = {}
    closures = {name: test_dependencies(name, parsed) for name in pool}
    reasons = {}

    def add(names, reason):
        for name in names:
            reasons.setdefault(name, []).append(reason)

    if profile != 'task':
        add(pool, f'{profile} 档位')
        # 无区域参数保留全部阶段遍历；指定区域不影响共享规则。
        if profile == 'phase' and regions:
            for suite in manifest['suites'].values():
                if suite.get('regions') and not set(regions).intersection(suite['regions']):
                    for name in suite['files']:
                        reasons.pop(name, None)
    prefix = RUNTIME.relative_to(ROOT).as_posix()+'/'
    relevant = [name for name in changed if not name.endswith('.md')]
    if profile == 'task':
        for name in relevant:
            path = ROOT/name
            direct = {file for file in pool if path.resolve() in closures[file]}
            if name.startswith(prefix+'tests/'):
                add(direct or pool, f'测试或辅助代码变化：{name}')
            elif name.startswith(prefix+'tools/source/') or (
                    not name.startswith(prefix) and path.suffix.upper() in
                    {'.DAT', '.TLK', '.ANM', '.DGP', '.CHR', '.ITM', '.MAG', '.EXE', '.MNU'}):
                # 原版解析器变化必须进入来源验证，不能仅靠便携组。
                sources = set(select_tests(manifest, ['source']))
                add(sources, f'原版输入或解析器变化：{name}')
            elif name.startswith(prefix+'tools/') or name.endswith(('serve.py', '.cmd', '.bat', '.ps1', '.sh')):
                add(pool, f'构建或验收基础变化：{name}')
            elif name.startswith(prefix+'web/data/') or name.startswith(prefix+'web/content/'):
                add(pool, f'内容数据变化，动态依赖保守检查便携组：{name}')
            elif name.startswith(prefix+'web/'):
                add(direct or pool, f'代码依赖：{name}' if direct else f'未确定依赖，扩大便携检查：{name}')
                if name.endswith(('/story_flow.mjs', '/story_flow_compiler.mjs', '/chapter.mjs')):
                    add(select_tests(manifest, ['content-full']), f'共享剧情执行机制变化：{name}')
            else:
                add(pool, f'未分类运行改动，保守扩大：{name}')
        if relevant:
            add(set(manifest['smoke']) & pool, '固定核心冒烟')
    if domains:
        chosen = domain_files(manifest, domains, pool, closures)
        # 显式系统范围可用于干净工作区；实际改动仍取并集，防止漏掉跨系统修改。
        add(chosen, '显式系统：'+','.join(domains))
    if regions and profile == 'task':
        add({name for name in pool for region in regions
             if any(fnmatch.fnmatchcase(name, p) for p in manifest['regions'][region]['tests'])},
            '显式区域：'+','.join(regions))
    if patterns:
        reasons = {name: why for name, why in reasons.items()
                   if any(fnmatch.fnmatchcase(name, p) for p in patterns)}
        if not reasons:
            raise ValueError('没有匹配的测试；不能把空筛选当成通过')
    content_check = (profile in {'phase', 'release'} or bool(regions) or any(
        name.startswith((prefix+'web/data/', prefix+'web/content/')) or
        name.endswith(('/content_readiness.mjs', '/story_flow_compiler.mjs', '/chapter.mjs'))
        for name in relevant))
    return dict(profile=profile, changed=changed, files=sorted(reasons), reasons=reasons,
                content_check=content_check, filtered=bool(patterns),
                browser_required=(profile in {'phase', 'release'} or 'engine' in domains or profile == 'task' and any(
                    name.startswith(prefix+'web/') and not name.startswith(prefix+'web/data/')
                    for name in relevant)),
                note='代码 import 递归选择；动态内容变化保守覆盖便携组，来源和浏览器范围单独记录。')


def requirements(manifest, name):
    return [requirement for suite in manifest['suites'].values() if name in suite['files']
            for requirement in suite.get('requires', [])] + manifest.get('requirements', {}).get(name, [])


def missing_requirements(manifest, selected):
    missing = {}
    for name in selected:
        for requirement in requirements(manifest, name):
            absent = (importlib.util.find_spec(requirement[7:]) is None if requirement.startswith('python:')
                      else not (ROOT/requirement).exists())
            if absent:
                missing.setdefault(requirement, []).append(name)
    if not shutil.which('node') and any(name.endswith('.mjs') for name in selected):
        missing['command:node'] = [name for name in selected if name.endswith('.mjs')]
    return missing


def fingerprints(manifest, selected):
    # 第一版按全部便携生产输入保守失效，避免不完整的数据依赖图导致错误复用。
    paths = {TESTS/name for name in selected} | {MANIFEST}
    for directory in (TESTS, RUNTIME/'tools', RUNTIME/'web'):
        paths.update(path for path in directory.rglob('*') if path.is_file()
                     and '__pycache__' not in path.parts and '.cache' not in path.parts
                     and path.suffix in {'.py', '.mjs', '.js', '.json', '.html', '.css'}
                     and 'assets' not in path.relative_to(RUNTIME).parts)
    # HTTP/原安装/真实媒体检查不复用；仍记录已声明外部文件的身份。
    for name in selected:
        for requirement in requirements(manifest, name):
            if not requirement.startswith('python:') and (ROOT/requirement).is_file():
                paths.add(ROOT/requirement)
    return {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths)}


def clean_environment():
    environment = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
    for key in list(environment):
        if key.startswith('SEVENTH_SEAL_') or key in {'FIRST_RETURN_RUNTIME', 'WHITE_FOREST_CHEST_REPORT'}:
            del environment[key]
    return environment


def result_counts(language, output, returncode):
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
    return counts, passed


def execute(name, timeout, environment):
    language = 'javascript' if name.endswith('.mjs') else 'python'
    if language == 'javascript':
        command = [shutil.which('node'), '--test', '--test-reporter=tap', str(TESTS/name)]
    else:
        loader = 'import sys, unittest; sys.path.insert(0, sys.argv[1]); unittest.main(module=None, argv=[sys.argv[0], *sys.argv[2:]])'
        command = [sys.executable, '-B', '-c', loader, str(TESTS), name.removesuffix('.py')]
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
    counts, passed = result_counts(language, output, returncode)
    return dict(file=name, language=language, command=command, counts=counts, passed=passed,
                returncode=returncode, seconds=round(time.monotonic()-started, 3), output=output, reused=False)


def aggregate_output(language, cases, counts):
    if language == 'python':
        return '\n'.join(f'# {case["file"]}'+('（复用）' if case['reused'] else '')+'\n'+case['output'] for case in cases)
    lines, number = ['TAP version 13'], 0
    for case in cases:
        lines.append('# '+case['file']+('（复用）' if case['reused'] else ''))
        for line in case['output'].splitlines():
            if line == 'TAP version 13' or re.match(r'^(1\.\.|# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) )', line):
                continue
            if re.match(r'^(not )?ok \d+', line):
                number += 1
                line = re.sub(r'^((?:not )?ok )\d+', lambda m: m[1]+str(number), line)
            lines.append(line)
    lines.append(f'1..{number}')
    lines.extend(f'# {key} {value}' for key, value in counts.items())
    return '\n'.join(lines)+'\n'


def run_selected(manifest, selected, *, timeout=300, reuse=True, jobs=4, content_check=False):
    if timeout <= 0 or jobs <= 0:
        raise ValueError('timeout 与 jobs 必须大于零')
    started = time.monotonic()
    report = dict(schema='seventh-seal-test-run', version=2, files=selected, passed=False,
                  missing=missing_requirements(manifest, selected), runs=[], checks=[])
    if content_check and not shutil.which('node'):
        report['missing']['command:node'] = ['内容能力检查']
    if report['missing']:
        return report
    report['fingerprints'] = fingerprints(manifest, selected)
    environment = clean_environment()
    node = subprocess.run([shutil.which('node'), '--version'], capture_output=True, text=True).stdout.strip() if shutil.which('node') else None
    portable_prefixes = tuple((directory.relative_to(ROOT).as_posix()+'/')
                              for directory in (TESTS, RUNTIME/'tools', RUNTIME/'web'))
    portable_inputs = {name: value for name, value in report['fingerprints'].items()
                       if name.startswith(portable_prefixes) and 'assets' not in Path(name).parts}
    # task 与 release 即使选中不同原文件，也可复用相同的便携检查。
    # 工具调用编号每条命令都会改变，不是游戏或测试的环境输入。
    cache_environment = {key: value for key, value in environment.items() if key != 'CODEX_TOOL_CALL_ID'}
    identity = dict(version=CACHE_VERSION, inputs=portable_inputs, python=sys.version,
                    executable=sys.executable, node=node, node_path=shutil.which('node'),
                    platform=platform.platform(), environment=cache_environment)
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    report['cache_identity'] = digest
    report['environment'] = dict(python=sys.version.split()[0], node=node, platform=platform.platform())
    cacheable = {name for suite in manifest['suites'].values() if suite.get('cache') for name in suite['files']}
    results, pending = {}, []
    for name in selected:
        key = hashlib.sha256((digest+name).encode()).hexdigest()
        cached = None
        if reuse and name in cacheable:
            try:
                entry = json.loads((CACHE/(name+'.json')).read_text(encoding='utf-8'))
                candidate = entry['result']
                counts, valid = result_counts(candidate['language'], candidate['output'], candidate['returncode'])
                expected_language = 'javascript' if name.endswith('.mjs') else 'python'
                if (entry['key'] == key and candidate['file'] == name and candidate['passed'] and valid
                        and candidate['language'] == expected_language and isinstance(candidate['seconds'], (int, float))
                        and isinstance(candidate['command'], list)):
                    cached = dict(candidate, counts=counts, reused=True)
            except (OSError, ValueError, KeyError, TypeError):
                pass
        if cached:
            results[name] = cached
        else:
            pending.append(name)
    if content_check:
        check_started = time.monotonic()
        command = [shutil.which('node'), str(RUNTIME/'tools/check_content.mjs')]
        try:
            result = subprocess.run(command, cwd=ROOT, env=environment, capture_output=True,
                                    text=True, encoding='utf-8', errors='replace', timeout=timeout)
        except subprocess.TimeoutExpired:
            result = subprocess.CompletedProcess(command, 124, stdout=f'内容准入检查超过 {timeout} 秒。', stderr='')
        report['checks'].append(dict(name='全部已登记入口的能力准入', command=command,
                                     passed=result.returncode == 0, output=result.stdout+result.stderr,
                                     seconds=round(time.monotonic()-check_started, 3)))
        if result.returncode:
            report['seconds'] = round(time.monotonic()-started, 3)
            return report
    with ThreadPoolExecutor(max_workers=jobs) as executor:
        # map 保留文件顺序；测试子进程之间不共享可变状态。
        for result in executor.map(lambda name: execute(name, timeout, environment), pending):
            results[result['file']] = result
    after = fingerprints(manifest, selected)
    report['changed_inputs'] = sorted(name for name in set(report['fingerprints']) | set(after)
                                      if report['fingerprints'].get(name) != after.get(name))
    for language in ('javascript', 'python'):
        cases = [results[name] for name in selected if results[name]['language'] == language]
        if not cases:
            continue
        counts = {key: sum(case['counts'].get(key, 0) for case in cases)
                  for key in sorted({key for case in cases for key in case['counts']})}
        report['runs'].append(dict(language=language, files=[case['file'] for case in cases], counts=counts,
                                   passed=all(case['passed'] for case in cases),
                                   returncode=0 if all(case['passed'] for case in cases) else 1,
                                   seconds=round(sum(case['seconds'] for case in cases if not case['reused']), 3),
                                   executed=sum(not case['reused'] for case in cases),
                                   reused=sum(case['reused'] for case in cases),
                                   cases=[{k: v for k, v in case.items() if k != 'output'} for case in cases],
                                   output=aggregate_output(language, cases, counts)))
    if not report['changed_inputs']:
        for name in pending:
            result = results[name]
            if name in cacheable and result['passed']:
                CACHE.mkdir(parents=True, exist_ok=True)
                entry = dict(key=hashlib.sha256((digest+name).encode()).hexdigest(), result=result)
                with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=CACHE, delete=False) as handle:
                    json.dump(entry, handle, ensure_ascii=False)
                    temporary = Path(handle.name)
                os.replace(temporary, CACHE/(name+'.json'))
    report['passed'] = all(run['passed'] for run in report['runs']) and not report['changed_inputs']
    report['not_needed'] = not selected and not content_check
    report['seconds'] = round(time.monotonic()-started, 3)
    return report


def run_suites(suites=('daily',), patterns=(), timeout=300, *, reuse=True, jobs=4):
    """旧入口兼容；完整汇总与 CLI 共用同一个结果缓存。"""
    manifest = load_manifest()
    report = run_selected(manifest, select_tests(manifest, suites, patterns), timeout=timeout, reuse=reuse, jobs=jobs)
    report['suites'] = list(suites)
    return report


def save_report(report):
    directory = RUNTIME/'evidence/test_runs'
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-')
    folder = Path(tempfile.mkdtemp(prefix=stamp, dir=directory))
    summary = {**report, 'runs': [], 'checks': []}
    for run in report['runs']:
        filename = run['language']+('.tap' if run['language'] == 'javascript' else '.log')
        (folder/filename).write_text(run['output'], encoding='utf-8')
        summary['runs'].append({**{key: value for key, value in run.items() if key != 'output'}, 'log': filename})
    for index, check in enumerate(report.get('checks', [])):
        filename = f'check-{index}.log'
        (folder/filename).write_text(check['output'], encoding='utf-8')
        summary['checks'].append({**{key: value for key, value in check.items() if key != 'output'}, 'log': filename})
    (folder/'run.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    return folder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument('--suite', action='append', help='显式职责组；daily/runtime/content/content-full/source/assets/integration/history/tooling/all')
    scope.add_argument('--profile', choices=('task', 'phase', 'release', 'audit'), help='默认 task')
    parser.add_argument('--changed', action='append', help='显式改动路径，可重复；否则包含相对 --since 的工作区、暂存和未跟踪文件')
    parser.add_argument('--since', default='HEAD', help='自动改动范围的 Git 基线，默认 HEAD')
    parser.add_argument('--domain', action='append', default=[], help='额外系统范围；battle/story/movement/save/menu/engine/build')
    parser.add_argument('--region', action='append', default=[], help='区域范围；fire-valley/white-forest/jade-lake/ember-city')
    parser.add_argument('--match', action='append', default=[], help='显式文件名通配符；报告标明为定向筛选')
    parser.add_argument('--list', action='store_true', help='只预览计划，不执行测试')
    parser.add_argument('--explain', action='store_true', help='输出每个文件的选择原因')
    parser.add_argument('--check', action='store_true', help='只核对职责和范围登记')
    parser.add_argument('--report', action='store_true', help='保存新的验收报告目录')
    parser.add_argument('--fresh', action='store_true', help='重新执行，忽略成功缓存')
    parser.add_argument('--jobs', type=int, default=4, help='独立文件的最大并发数，默认 4')
    parser.add_argument('--timeout', type=int, default=300, help='单个测试文件或准入检查的上限秒数')
    args = parser.parse_args()
    try:
        if args.jobs <= 0 or args.timeout <= 0:
            raise ValueError('--jobs 与 --timeout 必须大于零')
        manifest = load_manifest()
        if args.check:
            print('测试职责清单完整：'+'，'.join(f'{name}={len(row["files"])}' for name, row in manifest['suites'].items()))
            return
        if args.suite:
            if args.changed or args.domain or args.region:
                raise ValueError('--suite 为显式文件组，不与 --changed/--domain/--region 混用')
            selected = select_tests(manifest, args.suite, args.match)
            plan = dict(suites=args.suite, files=selected, reasons={}, content_check=False, filtered=bool(args.match))
        else:
            plan = make_plan(manifest, args.profile or 'task', args.changed, args.domain, args.region, args.since, args.match)
            selected = plan['files']
        print(f'验收范围：{plan.get("profile", ",".join(plan.get("suites", [])))}；{len(selected)} 文件'
              + ('；定向筛选' if plan.get('filtered') else ''))
        if plan['content_check']:
            print('另执行：全部已登记入口的能力准入（不按当前旗标删分支）')
        if plan.get('browser_required'):
            print('需另做受影响的正式浏览器验收；引擎专项：'+manifest['browser']['path'])
        if args.list or args.explain:
            for name in selected:
                why = '；'.join(plan.get('reasons', {}).get(name, ['显式职责组']))
                print('  '+name+(' ← '+why if args.explain else ''))
        if args.list:
            missing = missing_requirements(manifest, selected)
            for requirement in missing:
                print('缺少前置：'+requirement)
            return
        if not selected and not plan['content_check']:
            print('当前范围没有运行改动，无需执行自动回归。')
        report = run_selected(manifest, selected, timeout=args.timeout, reuse=not args.fresh,
                              jobs=args.jobs, content_check=plan['content_check'])
        report['plan'] = plan
        for requirement, files in report['missing'].items():
            print(f'缺少前置：{requirement}（影响 {len(files)} 个测试文件）')
        for check in report.get('checks', []):
            print(f'{check["name"]}：'+('通过' if check['passed'] else '失败'))
            if not check['passed']:
                print(check['output'])
        for run in report['runs']:
            print(f'{run["language"]}：执行 {run["executed"]}，复用 {run["reused"]}，{run["counts"]}，'
                  + ('通过' if run['passed'] else '失败'))
            if not run['passed']:
                print(run['output'])
        if report.get('changed_inputs'):
            print('相关运行输入发生变化，本次结果无效：'+'、'.join(report['changed_inputs']))
        if 'seconds' in report:
            print(f'本次总耗时：{report["seconds"]} 秒')
        if args.report:
            print('本次报告：'+str(save_report(report)))
        raise SystemExit(0 if report['passed'] else 1)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(2, str(error)+'\n')


if __name__ == '__main__':
    main()
