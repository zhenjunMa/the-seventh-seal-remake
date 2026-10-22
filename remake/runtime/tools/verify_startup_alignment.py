"""Freeze retained startup UI observations; this does not operate a browser."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
EVIDENCE = RUNTIME / 'evidence'
FOLDER = EVIDENCE / 'startup_alignment_20261020'

def read(path):
    return json.loads(path.read_text('utf-8-sig'))

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def verify():
    observation = read(FOLDER / 'browser_observation.json')
    before, after = read(FOLDER / 'storage_before.json'), read(FOLDER / 'storage_after.json')
    assert before == after and before['read_only']
    states = {row['label']: row for row in observation['states']}
    assert states['escape_skip_gametitle']['stage'] == 'preopenpress'
    assert states['main_menu_default_read']['selection'] == 'read'
    assert states['read_panel_open']['submenu'] == 'read'
    assert states['rotate_left_start']['frame'] == '10'
    assert states['music_group_boundary_18']['submenu'] == 'extras'
    assert states['exit_category']['frame'] == '28'
    assert states['new_game_opening_entry']['phase'] == '序章演出'
    assert states['new_game_opening_complete']['phase'] == '探索中'
    assert states['resume_exploration']['phase'] == '探索中'
    assert states['restore_existing_save']['phase'] == '探索中'
    assert observation['natural_final']['stage'] == 'openpress' and observation['natural_final']['loop']
    assert observation['natural_final']['media_entries'] == ['gametitle', 'preopenpress', 'openpress']
    assert observation['preopenpress_input_ignored']['stage'] == 'preopenpress'
    assert not observation['console_errors']
    narrow = observation['narrow_layout']
    assert abs(narrow['viewport_width'] / narrow['viewport_height'] - 4 / 3) < .001
    assert narrow['viewport_left'] >= narrow['screen_left'] - 1
    assert narrow['viewport_right'] <= narrow['screen_right'] + 1
    logs = [read(FOLDER / name) for name in observation['log_files']]
    events = [event for log in logs for event in log['events']]
    assert any(e['type'] == 'opening-complete' for e in events)
    assert any(e['type'] == 'restore' for e in events)
    assert any(e['type'] == 'operation-exit-to-title' for e in events)
    assert {e['index'] for e in events if e['type'] == 'startup-gallery-play'} >= {0, 18}
    assert observation['gallery_audio']['desired_clip'] == 'sound/Special/Mitsuda/YM001.wav'
    assert observation['gallery_audio']['music']['started']
    export = read(EVIDENCE / 'startup_menu_export_20261020.json')
    assert export['passed'] and export['original_inputs_unchanged']
    for field in ['source_hashes', 'output_hashes']:
        for name, digest in export[field].items():
            assert sha(ROOT / name) == digest, name
    code_names = [
        'web/startup_view.mjs', 'web/core/startup.mjs', 'web/core/audio.mjs',
        'web/controllers/boot.mjs', 'web/controllers/session.mjs', 'web/controllers/input.mjs',
        'web/controllers/map.mjs', 'web/controllers/state.mjs', 'web/index.html', 'web/startup.css',
        'web/data/startup_menu.json', 'web/data/startup_media.json', 'web/tests/startup_storage.html',
        'tests/test_startup.mjs', 'tools/export_startup_menu.py', 'tools/verify_startup_alignment.py',
    ]
    current = {(RUNTIME / name).relative_to(ROOT).as_posix(): sha(RUNTIME / name) for name in code_names}
    for name, digest in observation['browser_code_fingerprints'].items():
        assert current[name] == digest, 'UI code changed after browser observation: ' + name
    evidence_paths = [*FOLDER.glob('*'), EVIDENCE / 'startup_menu_export_20261020.json',
                      EVIDENCE / 'startup_menu_findings_20261020.json', EVIDENCE / 'startup_menu_native_20261020.json',
                      EVIDENCE / 'original_main_menu_gdi_20261011.png']
    report = dict(schema='seventh-seal-startup-alignment-browser-validation', version=1, passed=True,
        checked_utc=datetime.now(timezone.utc).isoformat(),
        scope='Current startup movie sequence, original picture menu, keyboard/mouse navigation, music gallery, new-game prologue completion, existing save restore, return/resume and narrow viewport. Original game was not executed this round. Game storage was read for fingerprints and load, never overwritten.',
        checks=dict(storage_and_preferences_unchanged=True, source_assets_unchanged=True,
                    natural_and_escape_startup=True, original_menu_geometry=True,
                    gallery_group_boundary_and_playback=True, opening_and_restore_entry=True,
                    exit_resume=True, responsive_original_plane=True, console_errors=[]),
        observation_path=(FOLDER / 'browser_observation.json').relative_to(ROOT).as_posix(),
        observation_sha256=sha(FOLDER / 'browser_observation.json'), current_fingerprints=current,
        evidence_fingerprints={p.relative_to(ROOT).as_posix(): sha(p) for p in evidence_paths if p.is_file()},
        limitations=['Existing audio preference is muted; successful media playback is not speaker recording.',
                     'H264 conversion and RGB565-to-RGBA quantization remain lossy; positive button timing uses a browser clock.',
                     'Browser load has one remake slot and fallback metadata font; native thumbnails/20 Dat slots are not reproduced.',
                     'Locked special pictures/movies and registry MenuCode unlock conditions are not enabled.',
                     'This startup pass does not replay the entire chapter or battles.'])
    target = EVIDENCE / 'startup_alignment_browser_validation_20261020.json'
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    print(json.dumps(dict(passed=True, observed_states=len(states), screenshots=len(list(FOLDER.glob('*.jpg'))),
                          source_hashes=len(export['source_hashes']), report=str(target)), ensure_ascii=False))

if __name__ == '__main__':
    verify()
