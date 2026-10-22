"""Check retained battle rendering observations; --record freezes the report."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parent.parent
EVIDENCE = RUNTIME / 'evidence'
SCENE = EVIDENCE / 'battle_render_20261015'
REPORT = EVIDENCE / 'battle_render_browser_validation_20261015.json'


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record', action='store_true')
    args = parser.parse_args()
    observation = read(SCENE / 'browser_observation.json')
    rows = {r['name']: r for r in observation['checks']}
    log = read(SCENE / 'battle_log.json')
    fingerprints = read(SCENE / 'replay_fingerprints.json')
    checks = {}

    def check(name, condition):
        checks[name] = bool(condition)
        assert condition, name

    check('final-code-fingerprints-match', all(sha(ROOT / n) == h for n, h in fingerprints.items()))
    check('no-browser-errors', not observation['errors'])
    check('no-interrupted-battle', log['current_battle']['phase'] != 'interrupted' and
          not any(e['type'] == 'battle-interrupted' for e in log['events']))
    incoming = rows['incoming_contact']['impact']
    check('incoming-contact-captured', incoming['impactActor'].startswith('enemy-') and incoming['impactFrame'])
    outgoing = rows['player_flying_target_contact']['impact']
    check('source-player-contact-captured', outgoing['impactActor'] == '001' and outgoing['impactFrame'] == '326')
    for actor in ['001', '002']:
        check(f'{actor}-single-queued-attack', len([e for e in log['events'] if
              e['type'] == 'battle-command-queued' and e['actor_id'] == actor and e['target_id'] == 'enemy-0']) == 1)
        check(f'{actor}-committed-contact', any(e['type'] == 'battle-impact' and e['actor_id'] == actor and
              e['target_id'] == 'enemy-0' and e['damage'] > 0 and not e.get('skipped') for e in log['events']))
    check('incoming-53-confirmed-in-runtime-log', any(e['type'] == 'battle-impact' and e['damage'] == 53 and
          e['target_id'] == '001' and e['hp_after'] == 915 for e in log['events']))
    for name in ['incoming_damage.jpg', 'player_attack_in_front_of_ridge.jpg']:
        check(f'{name}-retained', (SCENE / name).stat().st_size > 10000)
    check('existing-progress-restored', read(SCENE / 'previous_save.json')['payload'] ==
          read(SCENE / 'restored_save.json')['payload'])
    audio = lambda name: {k: read(SCENE / name)['audio'][k] for k in ['muted', 'volume', 'channels']}
    check('audio-preferences-preserved', audio('previous_log.json') == audio('restored_log.json'))
    check('controlled-entry-explicitly-labelled', read(EVIDENCE / 'battle_alignment_20261015' /
          'controlled_entry_fixture.json')['normal_rng_sequence_claimed'] is False)
    evidence = {p.relative_to(ROOT).as_posix(): sha(p) for p in SCENE.iterdir() if p.suffix in {'.json', '.jpg'}}
    if args.record:
        report = dict(schema='seventh-seal-battle-render-browser-validation', version=1,
                      checked_utc=datetime.now(timezone.utc).isoformat(), passed=True, cases=len(checks), checks=checks,
                      current_fingerprints=fingerprints, evidence_fingerprints=evidence,
                      observation_path=(SCENE / 'browser_observation.json').relative_to(ROOT).as_posix(),
                      observation_sha256=sha(SCENE / 'browser_observation.json'),
                      original_game_execution_observed=False, scope=observation['scope'],
                      visual_review=observation['visual_review'],
                      limits=['Depth/number rendering use the declared browser placement and 900ms presentation policies.',
                              'Both source player paths and counter paths are checked across frames by separate Canvas regressions.',
                              'Second-player contact is confirmed by the log; its screenshot was not captured.',
                              'Slow RAF, skipped contacts, MISS/zero, counter channels and cancellation are covered by regression fixtures, not claimed as browser captures.'])
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    else:
        report = read(REPORT)
        assert report['passed'] and report['current_fingerprints'] == fingerprints
        assert report['evidence_fingerprints'] == evidence
    print(json.dumps(dict(passed=True, checks=len(checks), report=REPORT.relative_to(ROOT).as_posix())))


if __name__ == '__main__':
    main()
