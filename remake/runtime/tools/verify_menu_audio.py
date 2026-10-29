"""Freeze retained browser cue trajectories, real exports and original sound links."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parent.parent
WEB = RUNTIME/'web'
EVIDENCE = RUNTIME/'evidence'
CASES = EVIDENCE/'menu_audio_browser_20261014'
REPORT = EVIDENCE/'menu_audio_browser_validation_20261014.json'


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
    cases = {r['case']: r for r in observation['cases']}
    assert len(cases) == len(observation['cases']) == 25
    checks = {}

    def check(name, condition):
        assert condition, name
        checks[name] = True

    cues = read(WEB/'data/audio.json')['cues']
    expected = {
        'final-baseline': [], 'final-tab-open': [('menuOpen', True)],
        'final-main-items': [('menuSelect', True)],
        'final-items-ready': [('menuConfirm', True)]*2,
        'final-clamped-item': [], 'final-item-move': [('menuSelect', True)],
        'final-tab-ignored': [], 'final-filter-move': [('menuSelect', True)],
        'final-techniques-ready': [('menuConfirm', True)]*5,
        'final-skill-move': [('menuSelect', True)],
        'final-slot-preview': [('menuConfirm', True)], 'final-slot-commit': [('menuConfirm', True)],
        'final-target-ready': [('menuConfirm', True)]*3,
        'final-illegal-operation': [('menuError', True)],
        'final-cancel-target': [('menuCancel', True)],
        'final-system-ready': [('menuConfirm', True)]*2,
        'final-effects-volume-down': [('menuSelect', True)],
        'final-effects-volume-restored': [('menuSelect', True)],
        'final-effects-muted': [('menuConfirm', False)],
        'final-muted-move': [('menuSelect', False)],
        'final-effects-unmuted': [('menuSelect', False), ('menuConfirm', True)],
        'final-close-menu': [('menuCancel', True)]*3,
        'final-master-muted-open': [('menuOpen', False)],
        'final-master-muted-close': [('menuCancel', False)], 'final-restored': []}
    sequence = started = attempts = 0
    gesture_keys = []
    for case in observation['cases']:
        name = case['case']
        log = read(CASES/case['path'])
        state = log['audio']
        actual = [r for r in state['cue_events'] if r['sequence'] > sequence]
        check(name+'-retained-export-matches-observation', actual == case['cues'])
        check(name+'-original-cues', [(r['name'], r['played']) for r in actual] == expected[name]
              and all(r['clip'] == cues[r['name']]['clip'] for r in actual))
        played = sum(r['played'] for r in actual)
        check(name+'-actual-play-success-count', state['stats']['effects_started']-started == played == case['effects_started_delta']
              and state['stats']['effect_play_attempts']-attempts == played == case['effect_attempts_delta'])
        check(name+'-no-playback-or-decode-failure', state['stats']['playback_failures'] == 0
              and state['stats']['last_error'] is None and state['stats']['missing_clips'] == 0)
        sequence = state['cue_events'][-1]['sequence'] if state['cue_events'] else 0
        started, attempts = state['stats']['effects_started'], state['stats']['effect_play_attempts']
        gesture_keys.extend(r['event_key'] for r in actual if r['event_key'] is not None)
    check('27-source-effects-started', started == attempts == 27)
    check('every-menu-gesture-key-unique', len(set(gesture_keys)) == len(gesture_keys))
    check('failed-field-cast-has-no-world-write', read(CASES/'final-target-ready.json')['world'] == read(CASES/'final-illegal-operation.json')['world'])
    check('failed-operation-visible', cases['final-illegal-operation']['ui']['messageError'])
    fixture_path = ROOT/observation['fixture']
    before, after = world(fixture_path), world(CASES/'after-test-save.json')
    check('one-successful-slot-transaction', after['revision'] == before['revision']+1
          and after['technique_bindings']['roles']['001'] == [
              dict(type=0, index_one_based=23, icon=0, color=1),
              dict(type=0, index_one_based=23, icon=0, color=1),
              dict(type=0, index_one_based=24, icon=0, color=1),
              *[dict(type=2, index_one_based=n+1, icon=n, color=0) for n in range(4)]])
    check('legacy-three-slots-synchronized', after['skill_shortcuts'] == dict(version=1, roles={'001': [22, 22, 23]}))
    check('all-other-world-state-preserved', all(before.get(k) == after.get(k) for k in set(before)|set(after)
          if k not in {'revision', 'technique_bindings', 'skill_shortcuts'}))
    check('original-stored-progress-preserved', world(CASES/'previous-save-before.json') == world(CASES/'previous-save-after.json')
          and read(CASES/'previous-save-before.json')['payload'] == read(CASES/'previous-save-after.json')['payload'])
    original_channels = read(CASES/'before-audio.json')['audio']['channels']
    check('original-audio-preferences-preserved', read(CASES/'final-restored.json')['audio']['channels'] == original_channels)
    check('effects-volume-down-and-restored', read(CASES/'final-effects-volume-down.json')['audio']['channels']['effects']['volume'] == .9375
          and read(CASES/'final-effects-volume-restored.json')['audio']['channels']['effects']['volume'] == 1)
    check('effects-mute-and-unmute', read(CASES/'final-effects-muted.json')['audio']['channels']['effects']['muted']
          and not read(CASES/'final-effects-unmuted.json')['audio']['channels']['effects']['muted'])
    check('console-clean', observation['console_errors'] == [])
    manifest = read(WEB/'data/audio.json')
    rules_path = WEB/'data/menu_audio_rules.json'
    rules = read(rules_path)
    native_path = ROOT/rules['native_bundle']
    native = read(native_path)
    check('native-menu-table-evidence-retained', sha(native_path) == rules['native_bundle_sha256']
          and set(rules['evidence'].values()) <= {r['evidence_id'] for r in native['records']})
    check('native-cancel-also-used-for-illegal-operation', cues['menuError']['clip'] == cues['menuCancel']['clip'] == 'sound/menu/cancel.wav')
    for name, token in [('menuOpen', 'open'), ('menuSelect', 'select'), ('menuConfirm', 'decide'), ('menuCancel', 'cancel')]:
        clip = manifest['clips'][cues[name]['clip']]
        check(name+'-source-bytes-and-decoded-PCM', clip['source']['path'] == f'sound/menu/{token}.wav'
              and sha(ROOT/clip['source']['path']) == clip['source']['sha256']
              and sha(WEB/clip['path'].lstrip('/')) == clip['sha256']
              and clip['export']['decoded_audio_unchanged'])
    check('absent-close-not-substituted', not (ROOT/'sound/menu/close.wav').exists() and cues['menuClose']['clip'] is None)
    audit_path = EVIDENCE/'menu_audio_audit_20261014.json'
    audit_path.write_text(json.dumps(dict(schema='seventh-seal-menu-audio-audit', version=1,
        native_bundle=rules['native_bundle'], evidence=rules['evidence'], pointer_table=rules['table_address'],
        source_cues=rules['cue_indices'], actual_effects_started=started,
        physical_speaker_output_recorded=False, original_game_execution_observed=False,
        original_audio_channels_restored=original_channels, limits=observation['limits']), ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    current = sorted(p for p in WEB.rglob('*') if p.is_file() and p.suffix in {'.mjs', '.js', '.css', '.html', '.json'})
    current += sorted((RUNTIME/'tests').glob('test_*.mjs'))
    current += [Path(__file__), RUNTIME/'tools/verify_current.py', RUNTIME/'tools/build_runtime.py', RUNTIME/'tools/export_audio.py',
                ROOT/'README.md', *[RUNTIME.parent/name for name in ['assessment/validation_design.md', 'runtime/architecture.md', 'runtime/config_guide.md', 'runtime/tools/README.md']]]
    evidence = sorted(p for p in CASES.iterdir() if p.suffix in {'.json', '.jpg', '.png'})
    evidence += [audit_path, native_path, fixture_path, EVIDENCE/'audio_export.json',
                 *[WEB/clip['path'].lstrip('/') for clip in manifest['clips'].values()]]
    report = dict(schema='seventh-seal-menu-audio-browser-validation', version=1,
        checked_utc=datetime.now(timezone.utc).isoformat(), passed=True, checks=checks, cases=len(cases),
        observation_path=(CASES/'browser_observation.json').relative_to(ROOT).as_posix(),
        observation_sha256=sha(CASES/'browser_observation.json'),
        current_fingerprints={p.relative_to(ROOT).as_posix(): sha(p) for p in current},
        evidence_fingerprints={p.relative_to(ROOT).as_posix(): sha(p) for p in evidence},
        screenshot=(CASES/'final-audio-menu.jpg').relative_to(ROOT).as_posix(),
        actual_browser_flow_checked_this_run=False, original_game_execution_observed=False,
        limits=observation['limits']+['This verifier checks retained UI exports, without new playback or browser operations.'])
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'passed': True, 'checks': len(checks), 'cases': len(cases), 'actual_effects_started': started}))


if __name__ == '__main__':
    main()
