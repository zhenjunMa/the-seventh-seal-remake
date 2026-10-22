"""Check frozen actual keyboard observations and their associated file versions.

This does not replay the browser or renew an observation's fingerprints.
"""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = ROOT/'remake/runtime/evidence'


def read(name):
    return json.loads((EVIDENCE/name).read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def saved(name):
    envelope = read(name)
    assert hashlib.sha256(envelope['payload'].encode()).hexdigest() == envelope['sha256']
    return envelope, json.loads(envelope['payload'])


def verify():
    observation = read('operation_menu_fidelity_browser_observation.json')
    assert observation['origin'] == 'http://127.0.0.1:8767/'
    for field in ['current_fingerprints', 'evidence_fingerprints']:
        assert observation[field]
        for name, expected in observation[field].items():
            path = (ROOT/name).resolve()
            assert path.is_relative_to(ROOT) and sha(path) == expected, name
    ui = read('operation_menu_fidelity_ui_observations.json')
    assert ui['console'] == [] and not ui['original_game_execution_observed']
    cases = {row['case']: row for row in ui['cases']}
    assert len(cases) == len(ui['cases']) >= 27
    for name in ['tab-default-roster', 'reopen-default-roster']:
        row = cases[name]
        assert row['page'] == 'roster' and row['layer'] == 'main'
        assert row['active'] == 'operationFrame'
        assert row['rosterImages'] == ['assets/menu/actor_panels/frame_000.png',
                                      'assets/menu/actor_panels/frame_001.png']
    assert cases['space-main-to-header']['layer'] == 'sub'
    assert cases['space-main-to-header']['active'] == 'menuStatusPage'
    assert cases['roster-focus-kai']['rosterImages'] == [
        'assets/menu/actor_panels/frame_006.png', 'assets/menu/actor_panels/frame_001.png']
    assert cases['kai-detail']['page'] == 'status'
    assert cases['esc-detail-to-roster']['page'] == 'roster'
    assert cases['esc-roster-to-header']['layer'] == 'sub'
    assert cases['esc-header-to-main']['layer'] == 'main'
    assert cases['kai-head-unequipped']['options'] == '烈焰冠 ×1'
    assert cases['ingni-head-unequipped']['options'] == '珍珠耳环 ×1'
    assert cases['kai-head-reequipped']['message'] == '装备已更换。'
    assert cases['weapon-proven-empty']['sockets'] == 4
    assert cases['weapon-proven-empty']['card'].endswith('/_arms/frame_000.png')
    assert cases['items-card-back']['image'] == 'assets/menu/item_card_back.png'
    assert cases['tea-selected-card']['image'].endswith('/_item/frame_002.png')
    assert cases['tea-target-picker']['active'].startswith('使用目标 英格妮')
    assert cases['field-tea-result']['rows'] == '碧沙草茶x2'
    assert cases['esc-items-to-header']['layer'] == 'sub'
    assert cases['esc-items-header-to-main']['layer'] == 'main'
    assert cases['esc-main-closes']['closed']
    _, before = saved('chapter_systems_win_save.json')
    _, after = saved('operation_menu_fidelity_after_save.json')
    assert after['party'][0]['mp']['current'] == before['party'][0]['mp']['current'] + 30
    assert after['party'][0]['hp'] == before['party'][0]['hp']
    assert after['party'][1] == before['party'][1]
    assert [row['quantity'] for row in after['inventory']] == [2, 1, 1]
    for role_id, rows in before['equipment']['roles'].items():
        assert sorted(rows, key=lambda row: row['slot_id']) == sorted(
            after['equipment']['roles'][role_id], key=lambda row: row['slot_id'])
    for key in before:
        if key not in ['revision', 'party', 'inventory', 'equipment']:
            assert after[key] == before[key], key
    retained, _ = saved('operation_menu_fidelity_retained_save.json')
    previous, _ = saved('chapter_systems_previous_save.json')
    assert retained['sha256'] == previous['sha256']
    log = read('operation_menu_fidelity_log.json')
    uses = [row for row in log['events'] if row['type'] == 'world-item-used']
    assert len(uses) == 1 and uses[0]['target_id'] == '001'
    assert uses[0]['changes']['mp'] == {'before': 42, 'after': 72}
    assert len([row for row in log['events'] if row['type'] == 'equipment-changed']) == 2
    assert not [row for row in log['events'] if row['type'] == 'operation-failed']
    return dict(current_fingerprints=observation['current_fingerprints'],
                evidence_fingerprints=observation['evidence_fingerprints'],
                observation_path='remake/runtime/evidence/operation_menu_fidelity_browser_observation.json',
                observation_sha256=sha(EVIDENCE/'operation_menu_fidelity_browser_observation.json'),
                checked_cases=sorted(cases), retained_local_save_sha256=retained['sha256'],
                observed_utc=ui['observed_utc'], original_game_execution_observed=False,
                actual_browser_flow_checked_this_run=False, limits=observation['limits'])


def main():
    report = dict(schema='seventh-seal-operation-menu-fidelity-browser-validation', version=1,
                  checked_utc=datetime.now(timezone.utc).isoformat(), passed=False)
    try:
        report.update(verify(), passed=True)
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
    (EVIDENCE/'operation_menu_fidelity_browser_validation.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'cases': len(report.get('checked_cases', [])),
                      'error': report.get('error')}, ensure_ascii=False))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
