"""Check retained battle UI observations; --record freezes a new dated report.

This does not drive a browser or execute GAME.exe. Ordinary current verification
checks these frozen fingerprints rather than relabelling old UI observations.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parent.parent
EVIDENCE = RUNTIME / 'evidence'
SCENE = EVIDENCE / 'battle_alignment_20261015'
REPORT = EVIDENCE / 'battle_alignment_browser_validation_20261015.json'


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_observation():
    observation = read(SCENE / 'browser_observation.json')
    final = {row['name']: row for row in observation['final_checks']}
    first = {row['name']: row for row in read(SCENE / 'browser_checks_first.json')}
    behavior = {row['name']: row for row in read(SCENE / 'browser_checks_behavior.json')}
    completed = read(SCENE / 'browser_log_completed.json')
    replay = read(SCENE / 'browser_log_final.json')
    checks = {}

    def check(name, condition):
        checks[name] = bool(condition)
        assert condition, name

    check('controlled-entry-explicitly-labelled',
          read(SCENE / 'controlled_entry_fixture.json')['normal_rng_sequence_claimed'] is False)
    check('idle-clock-advances-without-player-command',
          int(final['idle_ready']['dom']['ticks']) > int(final['initial_charging']['dom']['ticks']))
    check('two-allies-ready', set(final['idle_ready']['dom']['readyIds'].split(',')) == {'001', '002'})
    check('ready-actor-switch', final['switch_ready']['dom']['actorId'] == '002')
    check('skill-list-original-five-entries', len(final['skill_list']['rows']) == 5)
    check('cancel-restores-visible-wheel-focus', final['skill_cancel']['focus'] == {'label': '使用招式', 'hidden': False})
    check('target-ui-hides-enemy-values', all('HP' not in t['label'] and 'MP' not in t['label']
          for t in final['target_selection']['targets']) and len(final['target_selection']['targets']) == 2)
    check('target-cancel-returns-to-wheel', final['target_cancel']['dom']['focusLayer'] == 'wheel')
    check('ally-numbers-only', len(final['idle_ready']['players']) == 2 and
          all('HP' in p['label'] and 'MP' in p['label'] for p in final['idle_ready']['players']))
    check('independent-additive-glow-layer', final['render_layers']['composite_mode'] == 'canvas-source-over-lighter'
          and final['render_layers']['canvas_sizes'] == [[640, 480], [640, 480]])
    check('no-final-browser-errors', not observation['final_browser_errors'])
    check('final-battle-not-interrupted', replay['current_battle']['phase'] != 'interrupted'
          and not any(e['type'] == 'battle-interrupted' for e in replay['events']))
    queues = [e for e in replay['events'] if e['type'] == 'battle-command-queued']
    check('final-held-confirm-queues-once', len(queues) == 1 and queues[0]['skill_id'] == 'kai_mieyan')
    check('selection-cancellation-does-not-queue',
          len([e for e in read(SCENE / 'browser_log_behavior.json')['events']
               if e['type'] == 'battle-command-queued']) == 2)
    check('earlier-animation-input-covered', first['target_select']['dom']['phase'] == 'action')
    check('earlier-skill-cancel-covered', behavior['cancel_returns_focus']['focus']['hidden'] is False)
    used = [e for e in completed['events'] if e['type'] == 'battle-item-used']
    check('earlier-item-commits-once', len(used) == 1 and used[0]['item_id'] == 12 and
          next(x['quantity'] for x in completed['current_battle']['inventory'] if x['id'] == 12) == 2)
    check('earlier-defend-and-escape-queued-once', all(
          len([e for e in completed['events'] if e['type'] == f'battle-{kind}']) == 1
          for kind in ['defend', 'escape']))
    check('earlier-defeat-commits-once', len(completed['battle_history']) == 1 and
          len([e for e in completed['events'] if e['type'] == 'battle-world-commit']) == 1 and
          completed['current_battle']['outcome'] == 'defeat')
    before = read(SCENE / 'browser_previous_save.json')
    after = read(SCENE / 'browser_restored_save.json')
    check('existing-browser-progress-restored', before['payload'] == after['payload'])
    check('audio-preferences-preserved', observation['restored_audio'] == observation['initial_audio'])
    fingerprints = read(SCENE / 'final_replay_fingerprints.json')
    for name, expected in fingerprints.items():
        assert sha(ROOT / name) == expected, f'Final browser replay code changed: {name}'
    for name, expected in read(EVIDENCE / 'battle_ui_resources.json')['source_hashes'].items():
        assert sha(ROOT / name) == expected, f'Original battle input changed: {name}'
    return observation, checks, fingerprints


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record', action='store_true')
    args = parser.parse_args()
    observation, checks, fingerprints = verify_observation()
    evidence_paths = [p for p in SCENE.iterdir() if p.suffix in {'.json', '.jpg', '.png'}]
    evidence_paths += [EVIDENCE / 'battle_ui_resources.json', EVIDENCE / 'battle_ui_slot_crosscheck.json']
    evidence_fingerprints = {p.relative_to(ROOT).as_posix(): sha(p) for p in evidence_paths}
    if args.record:
        report = dict(schema='seventh-seal-battle-alignment-browser-validation', version=1,
                      passed=True, checked_utc=datetime.now(timezone.utc).isoformat(),
                      cases=len(checks), checks=checks, current_fingerprints=fingerprints,
                      evidence_fingerprints=evidence_fingerprints,
                      observation_path=(SCENE / 'browser_observation.json').relative_to(ROOT).as_posix(),
                      observation_sha256=sha(SCENE / 'browser_observation.json'),
                      original_game_execution_observed=False,
                      scope=observation['scope'], limits=observation['limits'])
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    else:
        report = read(REPORT)
        assert report['passed'] and report['current_fingerprints'] == fingerprints
        assert report['evidence_fingerprints'] == evidence_fingerprints
    print(json.dumps(dict(passed=True, checks=len(checks), report=REPORT.relative_to(ROOT).as_posix())))


if __name__ == '__main__':
    main()
