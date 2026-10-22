"""Check frozen 0.8 UI evidence. This does not operate or replay a browser."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / 'remake/runtime/evidence'
REPORT = EVIDENCE / 'chapter_systems_browser_validation.json'


def read(name):
    return json.loads((EVIDENCE / name).read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def events(log, kind):
    return [row for row in log['events'] if row['type'] == kind]


def saved(name):
    envelope = read(name)
    assert hashlib.sha256(envelope['payload'].encode()).hexdigest() == envelope['sha256'], name
    return envelope, json.loads(envelope['payload'])


def verify():
    observation = read('chapter_systems_browser_observation.json')
    assert observation['origin'] == 'http://127.0.0.1:8767/'
    assert observation['console_errors_and_warnings_after_memory_fix'] == []
    for field in ['current_fingerprints', 'evidence_fingerprints']:
        assert observation[field]
        for name, expected in observation[field].items():
            path = (ROOT / name).resolve()
            assert path.is_relative_to(ROOT) and sha(path) == expected, name
    ui = {row['case']: row for row in read('chapter_systems_ui_observations.json')}
    opening = read('chapter_systems_opening_log.json')
    home_log = read('chapter_systems_home_log.json')
    _, home = saved('chapter_systems_home_save.json')
    win_envelope, win = saved('chapter_systems_win_save.json')
    reload_envelope, reloaded = saved('chapter_systems_reload_save.json')
    previous_envelope, previous = saved('chapter_systems_previous_save.json')
    restored_envelope, restored = saved('chapter_systems_restored_save.json')
    assert events(opening, 'opening-complete')
    assert home['source']['kind'] == win['source']['kind'] == 'native-new-game'
    assert [row['id'] for row in home['party']] == ['001', '002']
    assert events(home_log, 'chapter-join')
    assert [r['id'] for r in home['equipment']['roles']['001']] == [1, 61, 4]
    assert [r['id'] for r in home['equipment']['roles']['002']] == [10, 51, 4]
    assert len([r for r in home['inventory'] if r['id'] == 12]) == 1
    assert next(r['quantity'] for r in home['inventory'] if r['id'] == 12) == 4
    field_tea = events(home_log, 'world-item-used')
    assert len(field_tea) == 1 and field_tea[0]['target_id'] == '002'
    assert field_tea[0]['changes']['mp'] == {'before': 0, 'after': 40}
    assert '烈焰冠' not in ui['ingni-head-options']['options']
    assert '珍珠耳' not in ui['kai-head-options']['options']
    assert '烈焰冠' in ui['kai-head-options']['options']
    assert '珍珠耳環' in ui['ingni-head-options']['options'] or '珍珠耳环' in ui['ingni-head-options']['options']
    assert '968/968' in ui['item-config-open-snapshot']['vitals']
    assert '1012/1012' in ui['item-config-debug-refreshed']['vitals']
    assert '968/968' in ui['item-config-original-restored']['vitals']
    assert ui['rest-decline']['phase'] == ui['rest-accept']['phase'] == '探索中'
    rest = events(home_log, 'chapter-restored')
    assert len(rest) == 1 and rest[0]['recordId'] == 12
    assert all(row['before'] == row['after'] for row in rest[0]['resources'])
    assert home_log['audio']['music']['started'] and home_log['audio']['music']['ready_state'] == 4
    assert home_log['audio']['stats']['effects_started'] > 0
    assert home_log['audio']['stats']['playback_failures'] == 0

    win_log = read('chapter_systems_win_log.json')
    defeat_log = read('chapter_systems_defeat_log.json')
    for run in [win_log, defeat_log]:
        assert len(events(run, 'field-encounter')) == len(events(run, 'battle-start')) == 1
        assert not any('development' in row['type'] or 'sample' in row['type'] for row in run['events'])
        assert len(run['battle_history']) == 1
        for name, expected in events(run, 'battle-start')[0]['source']['source_hashes'].items():
            assert sha(ROOT / name) == expected, name
    original = events(win_log, 'battle-start')[0]['source']['runtime_configuration']
    assert original['mode'] == 'original' and original['differences'] == []
    victory = win_log['battle_history'][0]['result']
    assert victory['outcome'] == 'victory' and victory['rewards_applied']
    assert len(events(win_log, 'battle-world-commit')) == len(win['reward_records']) == 1
    medicine = events(win_log, 'battle-item-used')
    assert len(medicine) == 1 and medicine[0]['item_id'] == 12
    assert medicine[0]['actor_id'] == medicine[0]['target_id'] == '001'
    assert medicine[0]['result']['changes']['mp']['after'] > medicine[0]['result']['changes']['mp']['before']
    presentation = events(win_log, 'battle-item-presentation')
    assert len(presentation) == 1
    assert len(presentation[0]['observations']['contacts']) == 1
    assert presentation[0]['observations']['contacts'][0]['logical_frame'] == 17
    assert '_iReMP' in presentation[0]['observations']['effect_ids']
    assert medicine[0]['charge']['command_kind'] == 'item' and medicine[0]['charge']['effective_delay'] == 0
    assert next(r['quantity'] for r in win['inventory'] if r['id'] == 12) == 3
    assert home['equipment'] == win['equipment'] == reloaded['equipment']
    assert win_envelope['payload'] == reload_envelope['payload']
    assert win_log['audio']['stats']['effects_started'] > 0 and win_log['audio']['stats']['playback_failures'] == 0

    controlled = events(defeat_log, 'battle-start')[0]['source']['runtime_configuration']
    assert controlled['mode'] == 'debug' and controlled['differences']
    defeat = defeat_log['battle_history'][0]['result']
    assert defeat['outcome'] == 'defeat' and not defeat['rewards_applied']
    assert len(events(defeat_log, 'battle-world-commit')) == 1
    assert defeat_log['world']['reward_records'] == win['reward_records']
    assert defeat_log['world']['inventory'] == win['inventory']
    assert all(a['hp']['current'] == 0 for a in defeat_log['battle_history'][0]['battle']['actors'] if a['side'] == 'player')
    game_over = events(defeat_log, 'game-over')
    assert len(game_over) == 1 and game_over[0]['movie'] == '/assets/video/go02.mp4'
    assert game_over[0]['playback_error'] is None
    assert ui['game-over-title']['phase'] == '等待开始' and ui['game-over-title']['save_disabled']
    assert previous_envelope['payload'] == restored_envelope['payload'] and previous == restored
    config_dir = ROOT / 'remake/runtime/web/data/config'
    for file in ['index.json', 'items.json']:
        backup = EVIDENCE / 'item_config_browser' / (file.split('.')[0] + '_original.json')
        assert (config_dir / file).read_bytes() == backup.read_bytes(), file
    assert (config_dir / 'battle.json').read_bytes() == (EVIDENCE / 'chapter_systems_battle_original.json').read_bytes()
    assert json.loads((config_dir / 'index.json').read_text(encoding='utf-8'))['mode'] == 'original'
    return dict(runtime_version='0.8', origin=observation['origin'], method=observation['method'],
                current_fingerprints=observation['current_fingerprints'], evidence_fingerprints=observation['evidence_fingerprints'],
                observation_path='remake/runtime/evidence/chapter_systems_browser_observation.json',
                observation_sha256=sha(EVIDENCE / 'chapter_systems_browser_observation.json'),
                ui_observations=len(read('chapter_systems_ui_observations.json')),
                victory_commands=len(events(win_log, 'battle-command-queued')),
                equipment_roles=len(home['equipment']['roles']), item_catalog_entries=416,
                restored_payload_sha256=restored_envelope['sha256'], original_game_execution_observed=False,
                limits=[
                    'Defeat is a separately labelled debug enemy-attack case entered by normal walking; victory uses original parameters.',
                    'Opening/home observations precede the rendering-only memory correction; the forest loop was replayed after it.',
                    'Rest was exercised at full resources; depleted-resource restoration is covered by source-backed unit checks.',
                    'Early departure denial and later flag12/16 stories were not replayed in this UI run.',
                    'The initial encounter RNG seed, camera, trajectories, blending, font and timing still require original-game execution comparison.'])


def main():
    report = dict(schema='seventh-seal-chapter-systems-browser-validation', version=1,
                  checked_utc=datetime.now(timezone.utc).isoformat(), passed=False)
    try:
        report.update(verify(), passed=True)
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if not report['passed']:
        raise SystemExit(report['error'])
    print(json.dumps({'passed': True, 'observations': report['ui_observations'], 'victory_commands': report['victory_commands']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
