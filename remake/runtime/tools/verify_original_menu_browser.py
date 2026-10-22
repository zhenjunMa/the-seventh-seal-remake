"""Check retained browser observations for fixes confirmed against the original.

Does not replay UI or replace the fingerprints frozen after actual observation.
"""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / 'remake/runtime/evidence'


def read(name):
    return json.loads((EVIDENCE / name).read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def saved(name):
    envelope = read(name)
    assert hashlib.sha256(envelope['payload'].encode()).hexdigest() == envelope['sha256']
    return envelope, json.loads(envelope['payload'])


def verify():
    observation = read('operation_menu_original_browser_observation.json')
    for field in ['current_fingerprints', 'evidence_fingerprints']:
        assert observation[field]
        for name, expected in observation[field].items():
            path = (ROOT / name).resolve()
            assert path.is_relative_to(ROOT) and sha(path) == expected, name
    ui = read('operation_menu_original_ui_observations.json')
    assert ui['console'] == []
    cases = {row['case']: row for row in ui['cases']}
    assert len(cases) == len(ui['cases'])
    base = ['assets/menu/actor_panels/frame_000.png', 'assets/menu/actor_panels/frame_001.png']
    for name in ['tab-default', 'layout-reopen-default']:
        row = cases[name]
        assert row['page'] == 'roster' and row['layer'] == 'main' and not row['closed']
        assert row['active'] == 'operationFrame' and row['rosterImages'] == base
        assert row['mainImage'] == 'assets/menu/game001/image_007.png'
    assert cases['space-header']['layer'] == 'sub'
    assert cases['focus-ingni']['rosterImages'] == [
        'assets/menu/actor_panels/frame_006.png', base[1]]
    for name in ['focus-kai', 'layout-fresh-kai']:
        assert cases[name]['rosterImages'] == [base[0], 'assets/menu/actor_panels/frame_007.png']
    assert cases['kai-status']['page'] == 'status'
    assert cases['kai-status']['detailImage'] == base[1]
    assert cases['esc-detail']['rosterImages'] == cases['focus-ingni']['rosterImages']
    assert cases['esc-roster']['layer'] == 'sub' and cases['esc-header']['layer'] == 'main'
    assert cases['tea-target-before']['active'].endswith('MP 42/72')
    result = cases['tea-used-target-stays']
    assert not result['targetsHidden'] and result['active'].endswith('MP 72/72')
    assert result['items'] == '碧沙草茶x2'
    assert cases['tea-target-esc']['targetsHidden']
    assert cases['tea-target-esc']['layer'] == 'content'
    assert cases['tea-list-esc']['layer'] == 'sub'
    assert cases['tea-header-esc']['layer'] == 'main' and cases['menu-closed']['closed']
    assert ui['layout']['fits'] and abs(ui['layout']['ratio'] - 4 / 3) < 1e-6
    _, before = saved('chapter_systems_win_save.json')
    _, after = saved('operation_menu_original_after_save.json')
    assert after['party'][0]['mp'] == {'current': 66, 'maximum': 66}
    for index, role in enumerate(before['party']):
        for key in role:
            if index == 0 and key == 'mp':
                continue
            assert role[key] == after['party'][index][key], (index, key)
    assert [row['quantity'] for row in after['inventory']] == [2, 1, 1]
    for index, item in enumerate(before['inventory']):
        for key in item:
            if index == 0 and key in ['quantity', 'source_raw_hex']:
                continue
            assert item[key] == after['inventory'][index][key], (index, key)
    raw_before = bytes.fromhex(before['inventory'][0]['source_raw_hex'])
    raw_after = bytes.fromhex(after['inventory'][0]['source_raw_hex'])
    assert raw_after[4:8] == (2).to_bytes(4, 'little')
    assert raw_before[:4] + raw_before[8:] == raw_after[:4] + raw_after[8:]
    for key in before:
        if key not in ['revision', 'party', 'inventory']:
            assert before[key] == after[key], key
    previous, _ = saved('operation_menu_original_previous_save.json')
    retained, _ = saved('operation_menu_original_retained_save.json')
    assert previous['sha256'] == retained['sha256']
    return dict(current_fingerprints=observation['current_fingerprints'],
                evidence_fingerprints=observation['evidence_fingerprints'],
                observation_path='remake/runtime/evidence/operation_menu_original_browser_observation.json',
                observation_sha256=sha(EVIDENCE / 'operation_menu_original_browser_observation.json'),
                checked_cases=sorted(cases), observed_utc=ui['observed_utc'],
                retained_local_save_sha256=retained['sha256'],
                actual_browser_flow_checked_this_run=False,
                limits=observation['limits'])


def main():
    report = dict(schema='seventh-seal-original-menu-browser-validation', version=1,
                  checked_utc=datetime.now(timezone.utc).isoformat(), passed=False)
    try:
        report.update(verify(), passed=True)
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
    (EVIDENCE / 'operation_menu_original_browser_validation.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(dict(passed=report['passed'], cases=len(report.get('checked_cases', [])),
                         error=report.get('error')), ensure_ascii=True))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
