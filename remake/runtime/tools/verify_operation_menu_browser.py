"""Verify frozen menu UI evidence; never replay UI or replace its fingerprints."""
from pathlib import Path
import hashlib
import json
from datetime import datetime, timezone

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
    observation = read('operation_menu_browser_observation.json')
    assert observation['origin'] == 'http://127.0.0.1:8767/'
    for field in ['current_fingerprints', 'evidence_fingerprints']:
        assert observation[field]
        for name, expected in observation[field].items():
            path = (ROOT/name).resolve()
            assert path.is_relative_to(ROOT) and sha(path) == expected, name
    ui = read('operation_menu_ui_observations.json')
    assert ui['console'] == []
    cases = {row['case']:row for row in ui['cases']}
    assert cases['tab-open-status']['next'].endswith('1500')
    assert cases['tab-close']['closed']
    assert cases['kai-head-only-flame-crown']['candidates'] == '烈焰冠 ×1'
    assert cases['ingni-head-only-pearl-earrings']['candidates'] == '珍珠耳环 ×1'
    assert cases['tea-card']['image'].endswith('_item/frame_002.png') and cases['tea-card']['useEnabled']
    assert cases['field-tea']['items'] == '碧沙草茶 ×3'
    assert not cases['full-hp-field-skill-disabled']['enabled']
    assert cases['full-hp-field-skill-disabled']['reason'] == '目标HP已满'
    assert cases['warm-heart-self-heal']['before'].endswith('HP 375/968 · MP 42/72')
    assert cases['warm-heart-self-heal']['after'].endswith('HP 675/968 · MP 36/72')
    assert [row['value'] for row in cases['shortcut-reload']['values']] == ['23','22','19']
    assert cases['crystals-source-card-disabled']['image'].endswith('_cmpite/frame_028.png')
    assert not cases['crystals-source-card-disabled']['enabled']
    _, before = saved('chapter_systems_win_save.json')
    _, after = saved('operation_menu_after_save.json')
    assert after['skill_shortcuts'] == {'version':1,'roles':{'002':[23,22,19]}}
    assert after['party'][0]['hp']['current'] == before['party'][0]['hp']['current']+300
    assert after['party'][0]['mp']['current'] == before['party'][0]['mp']['current']-6
    assert after['party'][1] == before['party'][1]
    for key in before:
        if key not in ['revision','party']: assert before[key] == after[key], key
    retained, _ = saved('operation_menu_retained_save.json')
    previous, _ = saved('chapter_systems_previous_save.json')
    assert retained['sha256'] == previous['sha256']
    log = read('operation_menu_log.json')
    warm = [row for row in log['events'] if row['type']=='world-skill-used']
    assert len(warm) == 1 and warm[0]['skillId'] == 'yannuan' and warm[0]['mp_cost'] == 6
    assert warm[0]['configuration']['mode'] == 'original'
    assert warm[0]['target_hp'] == {'before':375,'after':675}
    assert warm[0]['caster_mp'] == {'before':42,'after':36}
    assert not [row for row in log['events'] if row['type']=='operation-failed']
    return dict(current_fingerprints=observation['current_fingerprints'],
        evidence_fingerprints=observation['evidence_fingerprints'],
        observation_path='remake/runtime/evidence/operation_menu_browser_observation.json',
        observation_sha256=sha(EVIDENCE/'operation_menu_browser_observation.json'),
        checked_cases=sorted(cases), retained_local_save_sha256=retained['sha256'],
        original_game_execution_observed=False, actual_browser_flow_checked_this_run=False,
        limits=observation['limits'])

def main():
    report = dict(schema='seventh-seal-operation-menu-browser-validation',version=1,
        checked_utc=datetime.now(timezone.utc).isoformat(),passed=False)
    try: report.update(verify(),passed=True)
    except Exception as error: report['error'] = f'{type(error).__name__}: {error}'
    (EVIDENCE/'operation_menu_browser_validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'passed':report['passed'],'cases':len(report.get('checked_cases',[])), 'error':report.get('error')},ensure_ascii=False))
    if not report['passed']: raise SystemExit(1)

if __name__ == '__main__': main()
