"""Check retained actor-focus observations; freeze without replaying the browser."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parent.parent
WEB = RUNTIME/'web'
CASES = RUNTIME/'evidence/roster_focus_browser_20261014'
REPORT = RUNTIME/'evidence/roster_focus_browser_validation_20261014.json'


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def world(path):
    envelope = read(path)
    assert hashlib.sha256(envelope['payload'].encode()).hexdigest() == envelope['sha256']
    return json.loads(envelope['payload'])


def main():
    if REPORT.exists():
        report = read(REPORT)
        assert report['passed']
        for field in ['current_fingerprints', 'evidence_fingerprints']:
            for name, expected in report[field].items():
                assert sha(ROOT/name) == expected, f'Frozen observation differs: {name}'
        print(json.dumps({'passed': True, 'frozen_report_matches': True}))
        return
    observation = read(CASES/'browser_observation.json')
    cases = {row['case']: row for row in observation['cases']}
    assert len(cases) == len(observation['cases']) == 16
    checks = {}

    def check(name, condition):
        assert condition, name
        checks[name] = True

    panels = read(WEB/'data/operation_menu.json')['actor_panels']
    before = read(CASES/'bug-before.json')
    check('original-bug-reproduced', before['layer'] == 'sub'
          and before['activeId'] == 'menuEquipmentPage'
          and [r['id'] for r in before['roster'] if r['selected']] == ['001'])
    focused = {'equipment-actor-selected': '001', 'equipment-reentry-selected': '001',
               'equipment-second-actor-selected': '002', 'equipment-detail-return-selected': '002',
               'status-actor-selected': '001', 'weapon-actor-selected': '001'}
    for name, case in cases.items():
        selected_id = focused.get(name)
        check(name+'-focus', [r['id'] for r in case['roster'] if r['selected']]
              == ([selected_id] if selected_id else []))
        check(name+'-original-panel', all(r['image'] == panels[r['id']]
              ['unfocused' if r['id'] == selected_id else 'normal'] for r in case['roster']))
        if selected_id:
            check(name+'-active-actor', case['activeRole'] == selected_id
                  and case['layer'] == 'content' and case['page'] == 'roster')
    for name, header in [('equipment-Escape-clear','menuEquipmentPage'),
                         ('equipment-second-Escape-clear','menuEquipmentPage'),
                         ('status-Escape-clear','menuStatusPage'), ('weapon-Escape-clear','menuWeaponPage')]:
        check(name+'-header', cases[name]['activeId'] == header and cases[name]['layer'] == 'sub')
    check('detail-return-preserves-actor', cases['equipment-detail-clear']['page'] == 'equipment'
          and cases['equipment-detail-return-selected']['activeRole'] == '002')
    fixture = ROOT/observation['fixture']
    check('cancel-keeps-test-world-identical', world(fixture) == world(CASES/'after-test-save.json'))
    check('original-progress-and-stored-save-preserved', world(CASES/'before-save.json')
          == world(CASES/'restored-save.json') == world(CASES/'stored-save-after.json'))
    check('audio-preferences-preserved', read(CASES/'before-log.json')['audio']['channels']
          == read(CASES/'restored-log.json')['audio']['channels'])
    check('browser-console-clean', observation['console_errors'] == [])
    current = sorted(p for p in WEB.rglob('*') if p.is_file() and p.suffix in {'.mjs','.js','.css','.html','.json'})
    current += sorted((RUNTIME/'tests').glob('test_*.mjs'))
    current += [Path(__file__), RUNTIME/'tools/verify_current.py',
                ROOT/'remake/assessment/validation_design.txt', RUNTIME/'tools/README.txt']
    evidence = sorted(p for p in CASES.iterdir() if p.is_file()) + [fixture]
    report = dict(schema='seventh-seal-roster-focus-browser-validation', version=1,
                  checked_utc=datetime.now(timezone.utc).isoformat(), passed=True, cases=len(cases), checks=checks,
                  observation_path=(CASES/'browser_observation.json').relative_to(ROOT).as_posix(),
                  observation_sha256=sha(CASES/'browser_observation.json'),
                  current_fingerprints={p.relative_to(ROOT).as_posix():sha(p) for p in current},
                  evidence_fingerprints={p.relative_to(ROOT).as_posix():sha(p) for p in evidence},
                  screenshot=(CASES/'equipment-Escape-clear.jpg').relative_to(ROOT).as_posix(),
                  actual_browser_flow_checked_this_run=False, original_game_execution_observed=False,
                  limits=observation['limits'])
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'passed': True, 'checks': len(checks), 'cases': len(cases)}))


if __name__ == '__main__':
    main()
