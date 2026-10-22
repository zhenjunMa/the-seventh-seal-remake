"""Verify retained 0.7 UI exports against the fingerprints captured with that run.

This checks browser evidence; it never drives a browser or creates a new replay.
"""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RUNTIME = ROOT / 'remake/runtime'
EVIDENCE = RUNTIME / 'evidence'
REPORT = EVIDENCE / 'party_browser_validation.json'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(name):
    envelope = read(EVIDENCE / name)
    assert hashlib.sha256(envelope['payload'].encode('utf-8')).hexdigest() == envelope['sha256'], name
    return envelope, json.loads(envelope['payload'])


def events(log, kind):
    return [row for row in log['events'] if row['type'] == kind]


def experience(role):
    return int.from_bytes(bytes.fromhex(role['combat_progress']['header_raw_hex'])[0x28:0x2c], 'little')


def verify():
    observation = read(EVIDENCE / 'party_browser_observation.json')
    for field in ['current_fingerprints', 'evidence_fingerprints']:
        assert observation[field], field
        for name, expected in observation[field].items():
            path = (ROOT / name).resolve()
            assert path.is_relative_to(ROOT)
            assert sha(path) == expected, f'Captured browser input/evidence changed: {name}'
    assert observation['origin'] == 'http://localhost:8767/'
    assert observation['console_errors_and_warnings'] == []
    initial_envelope, initial = save('chapter_browser_save.json')
    win_envelope, win = save('party_browser_win_save.json')
    reload_envelope, reloaded = save('party_browser_reload_save.json')
    _, reentry = save('party_browser_reentry_save.json')
    previous_envelope, previous = save('party_browser_previous_save.json')
    recovered_envelope, recovered = save('party_browser_recovered_save.json')
    restored_envelope, restored = save('party_browser_restored_save.json')
    assert win_envelope['payload'] == reload_envelope['payload']
    assert previous_envelope['payload'] == recovered_envelope['payload'] == restored_envelope['payload']
    assert previous == recovered == restored
    assert previous_envelope['sha256'] == '091744f99295dcfb3f7d7d82bc96a5f402e0d0bcc2ba47a348cf1a4a9c631c42'
    assert initial['source']['kind'] == 'native-new-game'
    assert initial['location']['map_id'] == 'M70010'
    assert [row['id'] for row in initial['party']] == ['001', '002']
    assert not initial['reward_records']
    log = read(EVIDENCE / 'party_browser_win_log.json')
    again = read(EVIDENCE / 'party_browser_reentry_log.json')
    assert len(log['battle_history']) == len(again['battle_history']) == 1
    for run in [log, again]:
        assert len(events(run, 'field-encounter')) == len(events(run, 'battle-start')) == 1
        assert not any('development' in row['type'] or 'sample' in row['type'] for row in run['events'])
        source = events(run, 'battle-start')[0]['source']
        assert source['party_new_game']
        assert source['runtime_configuration']['mode'] == 'original'
        assert source['runtime_configuration']['differences'] == []
        for name, expected in source['source_hashes'].items():
            assert sha(ROOT / name) == expected, name
    first = log['battle_history'][0]
    battle, result = first['battle'], first['result']
    players = {row['id']: row for row in battle['actors'] if row['side'] == 'player'}
    assert list(players) == ['001', '002']
    assert [players[key]['role_link_raw'] for key in players] == [1, 2]
    assert result['outcome'] == 'victory' and result['rewards_applied']
    expected_resources = {'001': {'hp': 6, 'mp': 46}, '002': {'hp': 619, 'mp': 0}}
    assert result['resources_by_actor'] == expected_resources
    assert len(events(log, 'battle-world-commit')) == 1
    group = events(log, 'field-encounter')[0]['group']
    assert [row['id'] for row in group['members']] == ['012', '013', '013']
    skill_ids = set(read(RUNTIME / 'web/data/party_skills.json')['skills'])
    queued = events(log, 'battle-command-queued')
    commands = [row for row in events(log, 'battle-action') if row['actor_id'] in players]
    assert len(queued) == len(commands) == 12
    assert set(row['skill_id'] for row in commands) == skill_ids and len(skill_ids) == 8
    assert [(row['actor_id'], row['skill_id']) for row in queued] == [
        (row['actor_id'], row['skill_id']) for row in commands]
    contacts = events(log, 'battle-impact')
    contact_keys = [(row['action_id'], row['contact_key']) for row in contacts]
    assert len(contact_keys) == len(set(contact_keys))
    fire = [row for row in contacts if row['skill_id'] == 'yancui']
    assert len(fire) == 4
    assert all(row['effect_token'] == 1 and row['source_skill_index'] == 37 and row['damage'] > 0
               and row['presentation']['carrier_source_frame'] == 6 for row in fire)
    assert {row['target_id'] for row in contacts if row['actor_id'].startswith('enemy-')} >= {'001', '002'}
    assert battle['reward_ledger']['experience'] == 184
    assert len(battle['reward_ledger']['defeated_ids']) == 3
    assert [row['experience'] for row in result['rewards']['experience']] == [184, 184]
    assert [row['role_id'] for row in result['rewards']['experience']] == ['001', '002']
    assert len(win['reward_records']) == 1
    assert win['reward_records'][0]['battle_id'] == result['battle_id']
    for before, after in zip(initial['party'], win['party']):
        assert before['id'] == after['id']
        assert experience(after) - experience(before) == 184
        assert {key: after[key]['current'] for key in ['hp', 'mp']} == expected_resources[after['id']]
    assert initial['party'][0]['mp']['current'] - win['party'][0]['mp']['current'] == 4 * 5
    assert players['001']['hp'] == {'current': 94, 'maximum': 968}
    assert players['001']['mp'] == {'current': 52, 'maximum': 72}
    assert players['002']['hp'] == {'current': 619, 'maximum': 900}
    assert players['002']['mp'] == {'current': 0, 'maximum': 40}
    assert win['inventory'][:len(initial['inventory'])] == initial['inventory']
    assert len(win['inventory']) == len(initial['inventory']) + 1
    assert win['inventory'][-1]['id'] == 242 and win['inventory'][-1]['quantity'] == 1
    for key in ['source', 'flags', 'event_records', 'object_states', 'opening', 'world_map', 'money']:
        assert initial[key] == win[key], key
    for key in ['party', 'inventory', 'reward_records', 'money', 'source', 'flags', 'event_records']:
        assert win[key] == reloaded[key] == reentry[key], key
    second = again['battle_history'][0]
    assert second['result']['outcome'] == 'aborted'
    assert second['result']['actions'] == 0 and not second['result']['rewards_applied']
    assert second['result']['resources_by_actor'] == expected_resources
    second_players = [row for row in second['battle']['actors'] if row['side'] == 'player']
    assert [(row['id'], row['hp'], row['mp']) for row in second_players] == [
        (row['id'], row['hp'], row['mp']) for row in players.values()]
    return dict(
        runtime_version='0.7', origin=observation['origin'],
        method=observation['method'],
        opening_story_replayed_this_run=False,
        source_continuation=dict(path='remake/runtime/evidence/chapter_browser_save.json',
                                 payload_sha256=initial_envelope['sha256']),
        development_relocation_used=False, debug_configuration_used=False,
        original_game_execution_observed=False,
        natural_encounters=[dict(members=[row['id'] for row in group['members']], outcome='victory'),
                            dict(members=[row['id'] for row in events(again, 'field-encounter')[0]['group']['members']],
                                 outcome='aborted', actions=0)],
        player_commands=dict(unique_ids=sorted(skill_ids), count=len(commands), fire_casts=len(fire)),
        settled_contacts=len(contacts), contacts_settled_once=True,
        rewards=dict(experience_pool=184, experience_each={'001': 184, '002': 184},
                     drops=[dict(id=242, quantity=1)], records_after_reentry=1),
        final_effective_resources={key: dict(hp=row['hp'], mp=row['mp']) for key, row in players.items()},
        saved_resources=expected_resources, reload_payload_identical=True,
        reentry_resources_identical=True, original_browser_save_restored=True,
        original_browser_payload_sha256=restored_envelope['sha256'],
        console_errors_and_warnings=observation['console_errors_and_warnings'],
        interruption=observation['interruption'],
        observation_checked_utc=observation['captured_utc'],
        observation_sha256=sha(EVIDENCE / 'party_browser_observation.json'),
        current_fingerprints=observation['current_fingerprints'],
        evidence_fingerprints=observation['evidence_fingerprints'],
        limits=['Retained exports verify the observed UI run; this command does not replay the browser.',
                'The 0.6 opening flow was continued from its source-backed browser save, not replayed here.',
                'Rendering remains a preview. Item use/equipment menus, full defeat recovery and audio remain pending.'])


def main():
    report = dict(schema='seventh-seal-party-browser-validation', version=1,
                  checked_utc=datetime.now(timezone.utc).isoformat(), passed=False)
    try:
        report.update(verify(), passed=True)
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if not report['passed']:
        print(report['error'])
        raise SystemExit(1)
    print(json.dumps(dict(passed=True, commands=report['player_commands'],
                         contacts=report['settled_contacts'], experience_each=report['rewards']['experience_each'],
                         reload=True, reentry=True, original_browser_save_restored=True), ensure_ascii=False))


if __name__ == '__main__':
    main()
