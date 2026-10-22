"""Check retained unified-skill UI evidence, without replaying the browser."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json

ROOT = Path(__file__).resolve().parents[3]
RUNTIME = ROOT / 'remake/runtime'
EVIDENCE = RUNTIME / 'evidence'
OBSERVATION = EVIDENCE / 'skill_config_browser_observation.json'
REPORT = EVIDENCE / 'skill_config_browser_validation.json'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def saved(name):
    envelope = read(EVIDENCE / name)
    assert hashlib.sha256(envelope['payload'].encode('utf-8')).hexdigest() == envelope['sha256']
    return envelope, json.loads(envelope['payload'])


def verify():
    observation = read(OBSERVATION)
    for field in ['current_fingerprints', 'evidence_fingerprints']:
        assert observation[field]
        for name, expected in observation[field].items():
            path = (ROOT / name).resolve()
            assert path.is_relative_to(ROOT) and sha(path) == expected, name
    dom = read(EVIDENCE / 'skill_config_browser_dom.json')
    assert dom['hero_fire_label'] == '炎灵．焠炼 · MP 7'
    assert dom['kai_label'] == '灭颜打 · MP 3' and dom['kai_enabled'] is False
    assert dom['hero_mp_after'] == 'MP 65 / 72'
    assert dom['next_hero_fire_label'] == '炎灵．焠炼 · MP 5'
    assert dom['next_kai_label'] == '灭颜打 · MP 0' and dom['next_kai_enabled'] is True
    assert dom['console_errors_and_warnings'] == []
    original_index = read(EVIDENCE / 'skill_config_original_index.json')
    original_skills = read(EVIDENCE / 'skill_config_original_skills.json')
    assert original_index['mode'] == 'original' and original_skills['version'] == 2
    for name in ['index.json', 'skills.json']:
        assert (RUNTIME / 'web/data/config' / name).read_bytes() == (EVIDENCE / ('skill_config_original_' + name)).read_bytes()
    entries = original_skills['entries']
    assert len(entries) == 14
    owners = [(row['owner']['role_id'], row['owner']['skill_index']) for row in entries.values()]
    assert len(owners) == len(set(owners))
    debug = read(EVIDENCE / 'skill_config_browser_final_debug_log.json')
    final = read(EVIDENCE / 'skill_config_browser_final_original_log.json')
    assert len(debug['battle_history']) == 1 and len(final['battle_history']) == 2
    first, second = [row['result'] for row in final['battle_history']]
    assert first == debug['battle_history'][0]['result']
    cfg = first['source']['runtime_configuration']
    assert cfg['mode'] == 'debug' and len(cfg['parameters']['skills']) == 14
    assert cfg['parameters']['skills']['yancui']['mp_cost'] == 7
    assert cfg['parameters']['skills']['kai_mieyan']['mp_cost'] == 3
    assert cfg['parameters']['skills']['kai_suizu']['preparation_delay_raw'] == 400
    assert second['source']['runtime_configuration']['mode'] == 'original'
    assert second['source']['runtime_configuration']['differences'] == []
    assert second['source']['runtime_configuration']['parameters']['skills'] == {
        key: row['parameters'] for key, row in entries.items()}
    for result in [first, second]:
        assert result['source']['party_new_game']
        assert result['outcome'] == 'aborted' and not result['rewards_applied']
        for name, expected in result['source']['source_hashes'].items():
            assert sha(ROOT / name) == expected, name
    commands = [row for row in debug['events'] if row['type'] == 'battle-action' and row['actor_id'] in ['001', '002']]
    assert [(row['actor_id'], row['skill_id']) for row in commands] == [('002', 'kai_suizu'), ('001', 'yancui')]
    assert second['actions'] == 0
    kai_dispatch = next(row for row in debug['events'] if row['type'] == 'battle-scheduled' and row['skill_id'] == 'kai_suizu')
    assert kai_dispatch['charge']['effective_delay'] == 400
    fire = [row for row in debug['events'] if row['type'] == 'battle-impact' and row['skill_id'] == 'yancui']
    assert len(fire) == 1 and fire[0]['effect_token'] == 1 and fire[0]['damage'] > 0
    assert fire[0]['presentation']['carrier_source_frame'] == 6
    for log in [debug, final]:
        assert not any('development' in row['type'] or 'sample' in row['type'] for row in log['events'])
    assert len([row for row in final['events'] if row['type'] == 'field-encounter']) == 2
    _, initial = saved('chapter_browser_save.json')
    _, debug_world = saved('skill_config_browser_final_debug_save.json')
    assert initial['source']['kind'] == 'native-new-game'
    assert initial['party'][0]['mp']['current'] - debug_world['party'][0]['mp']['current'] == 7
    assert first['resources_by_actor']['001']['mp'] == 59
    for key in ['inventory', 'reward_records', 'source', 'flags', 'event_records', 'money']:
        assert initial[key] == debug_world[key], key
    previous, _ = saved('skill_config_browser_previous_save.json')
    restored, _ = saved('skill_config_browser_restored_save.json')
    assert previous['payload'] == restored['payload']
    return dict(runtime_version='0.7', origin=observation['origin'], method=observation['method'],
                source_continuation='remake/runtime/evidence/chapter_browser_save.json',
                opening_story_replayed_this_run=False, development_relocation_used=False,
                original_game_execution_observed=False, unified_skills=len(entries),
                player_skill_count=8, enemy_skill_count=6, skills_schema_version=2,
                ui_observations=dom, real_player_commands=['kai_suizu', 'yancui'],
                kai_effective_preparation_delay=400, hero_effective_mp_before=72, hero_effective_mp_after=65,
                hero_saved_raw_mp_after=59, config_snapshots_isolated=True,
                original_profile_loaded_next_battle_without_page_reload=True,
                original_configuration_restored=True, original_browser_save_restored=True,
                original_browser_payload_sha256=restored['sha256'],
                observation_path=OBSERVATION.relative_to(ROOT).as_posix(), observation_sha256=sha(OBSERVATION),
                observation_checked_utc=observation['captured_utc'],
                current_fingerprints=observation['current_fingerprints'], evidence_fingerprints=observation['evidence_fingerprints'],
                limits=['This command checks retained observations, not a fresh browser replay.',
                        'This UI run verifies configuration and abort/resource behavior; it does not replay an entire victory or opening.',
                        'Future role registration is covered by a test fixture; additional teammates and their unimplemented skill behavior are not shipped.'])


def main():
    report = dict(schema='seventh-seal-skill-config-browser-validation', version=1,
                  checked_utc=datetime.now(timezone.utc).isoformat(), passed=False)
    try:
        report.update(verify(), passed=True)
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if not report['passed']:
        print(report['error'])
        raise SystemExit(1)
    print(json.dumps(dict(passed=True, unified_skills=report['unified_skills'], actual_mp_cost=7,
                         next_battle_reads_original=True, config_and_browser_save_restored=True), ensure_ascii=False))


if __name__ == '__main__':
    main()
