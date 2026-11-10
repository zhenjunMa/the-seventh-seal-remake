"""版本自动验收汇总。"""
from pathlib import Path
import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
EVIDENCE = RUNTIME/'evidence'
REPORT = EVIDENCE/'current_validation.json'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=('task', 'phase', 'release', 'audit'), default='release')
    parser.add_argument('--region', action='append', default=[])
    parser.add_argument('--since', default='HEAD')
    parser.add_argument('--fresh', action='store_true')
    parser.add_argument('--jobs', type=int, default=4)
    parser.add_argument('--timeout', type=int, default=1800)
    args = parser.parse_args()
    from verify_tests import load_manifest, make_plan, run_selected, save_report
    try:
        manifest = load_manifest()
        plan = make_plan(manifest, args.profile, None if args.profile == 'task' else [],
                         regions=args.region, since=args.since)
        result = run_selected(manifest, plan['files'], timeout=args.timeout, reuse=not args.fresh,
                              jobs=args.jobs, content_check=plan['content_check'])
        result['plan'] = plan
        # 汇总使用同一缓存；只有阶段/版本验收再检查真实媒体。
        if result['passed'] and args.profile in {'phase', 'release'}:
            started = time.monotonic()
            command = ['node', str(RUNTIME/'tools/verify_phaser.mjs'), '--assets']
            media = subprocess.run(command, cwd=ROOT, capture_output=True, text=True,
                                   encoding='utf-8', errors='replace', timeout=args.timeout)
            result['checks'].append(dict(name='正式运行资源完整性', command=command,
                                         passed=media.returncode == 0, output=media.stdout+media.stderr,
                                         seconds=round(time.monotonic()-started, 3)))
            result['passed'] = media.returncode == 0
        folder = save_report(result)
        summary = dict(schema='seventh-seal-current-validation', version=2,
                       checked_utc=datetime.now(timezone.utc).isoformat(), passed=result['passed'],
                       scope='automated-'+args.profile, report=folder.relative_to(ROOT).as_posix(),
                       current_fingerprints=result.get('fingerprints', {}),
                       missing=result['missing'], actual_browser_flow_checked_this_run=False,
                       browser_required=plan.get('browser_required', False),
                       historical_workspace_audit_checked_this_run=False)
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        REPORT.write_text(json.dumps(summary, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        for requirement in result['missing']:
            print('缺少前置：'+requirement)
        for run in result['runs']:
            print(f'{run["language"]}：执行 {run["executed"]}，复用 {run["reused"]}，通过={run["passed"]}')
        for check in result['checks']:
            print(check['name']+'：'+('通过' if check['passed'] else '失败'))
            if not check['passed']:
                print(check['output'])
        print('本次报告：'+str(folder))
        if plan.get('browser_required'):
            print('自动检查范围之外，仍须另做本版正式浏览器验收。')
        raise SystemExit(0 if result['passed'] else 1)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(2, str(error)+'\n')


if __name__ == '__main__': main()
