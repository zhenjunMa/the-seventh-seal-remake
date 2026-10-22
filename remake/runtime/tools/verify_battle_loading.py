"""Validate recorded browser observations; --record freezes a new report once."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
FOLDER = RUNTIME/'evidence/battle_loading_20261021'
REPORT = RUNTIME/'evidence/battle_loading_browser_validation_20261021.json'
FILES = [
    'web/core/battle_resources.mjs', 'web/battle_view.mjs', 'web/forest_stage.mjs',
    'web/battle_menu_view.mjs', 'web/battle_result_view.mjs', 'web/loading_view.mjs',
    'web/battle_transition_view.mjs', 'web/controllers/battle.mjs', 'web/controllers/boot.mjs',
    'web/controllers/state.mjs', 'web/tests/battle_loading.html', 'web/tests/battle_loading.mjs',
    'web/tests/fixtures/battle_loading_save.json', 'web/data/battle_packs.json',
    'tools/battle_pack_inventory.mjs', 'tools/export_battle_packs.py',
    'tools/prepare_battle_loading_fixture.mjs', 'tools/verify_battle_loading.py',
    'tools/build_runtime.py', 'tools/verify_current.py',
    'tests/test_battle_resources.mjs', 'tests/test_battle_transition.mjs',
    'tests/test_battle_controller.mjs', 'tests/test_party_skills.mjs', 'architecture.txt', 'tools/README.txt',
]


def read(path):
    return json.loads(path.read_text('utf-8-sig'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(record=False):
    export = read(FOLDER/'pack_export.json')
    assert export['source_unchanged'] and export['pixel_reconstruction_passed']
    for field in ['source_hashes', 'output_hashes']:
        for name, digest in export[field].items():
            assert sha(ROOT/name) == digest, name
    observation_path = FOLDER/'browser_observation.json'
    observed = read(observation_path)
    assert observed['storage_unchanged']
    checks, runs = observed['checks'], observed['runs']
    assert not [r for r in checks if 'error' in r or 'render_error' in r]
    assert all(r['entry_observations'] > 0 and r['clock_frozen_during_entry'] for r in runs)
    assert all(r['phase'] == 'battle-charging' and r['resource_ms'] >= 0 for r in runs)
    normal = [r for r in runs if r['kind'] == 'normal']
    training = [r for r in runs if r['kind'] == 'training']
    assert len(normal) >= 2 and len(training) >= 2
    for pair in [normal[:2], training[:2]]:
        for key in ['page_requests', 'page_decodes']:
            assert pair[0]['cache'][key] == pair[1]['cache'][key], f'Warm load repeated {key}'
        assert pair[1]['cache']['page_hits'] > pair[0]['cache']['page_hits']
    assert all(r['world_revision_after'] == r['world_revision_before']+1 for r in normal)
    assert all(r['world_revision_after'] == r['world_revision_before'] for r in training)
    assert any(r.get('training_returned') and r['phase'] == 'party-menu' for r in checks)
    pixels = [r for r in checks if 'pixel_path' in r]
    assert len(pixels) >= 18 and len({r['pixel_path'] for r in pixels}) >= 6
    assert all(r['passed'] and r['differences'] == 0 for r in pixels)
    transitions = [r for r in checks if 'transition' in r]
    assert {r['transition'] for r in transitions} == set(range(7))
    assert all(r['completed'] and r['overlay_hidden'] for r in transitions)
    formal = read(FOLDER/'main_final_observation.json')
    assert not formal['console_errors']
    assert formal['state']['battle_visible'] and formal['state']['overlay_hidden']
    assert formal['state']['commands']['phase'] == 'action'
    current = {(RUNTIME/name).relative_to(ROOT).as_posix(): sha(RUNTIME/name) for name in FILES}
    current.update(export['output_hashes'])
    evidence = {p.relative_to(ROOT).as_posix(): sha(p) for p in [
        observation_path, FOLDER/'pack_export.json', FOLDER/'findings.json',
        FOLDER/'native_evidence.json', FOLDER/'entry_native_findings.json',
        FOLDER/'entry_native_evidence.json', FOLDER/'battle_ready.jpg',
        FOLDER/'main_final_observation.json', FOLDER/'main_entry.jpg',
    ]}
    if record:
        assert not REPORT.exists(), 'Frozen report exists; do not silently rebind an old observation'
        result = dict(
            schema='seventh-seal-battle-loading-browser-validation', version=1, passed=True,
            checked_utc=datetime.now(timezone.utc).isoformat(),
            scope=observed['scope'],
            checks=dict(cold_and_warm_normal=True, cold_and_warm_training=True,
                        warm_no_extra_image_requests_or_decodes=True, entry_clock_frozen=True,
                        training_returned=True, pixel_comparisons=len(pixels), transitions=7,
                        browser_storage_unchanged=True, formal_entry_and_skill_target_input=True,
                        lossless_source_images=export['images']),
            measurements=runs, current_fingerprints=current, evidence_fingerprints=evidence,
            observation_path=observation_path.relative_to(ROOT).as_posix(),
            observation_sha256=sha(observation_path),
            limitations=[
                'Independent controlled encounter and technique-test fixture; simulation paused after entry for observation.',
                'Formal page movement, entry, skill and target selection exercised after the final source reload on isolated port 18768.',
                'Seven transitions use original static code rules with Canvas RGBA, RAF timing and block lifetime adaptations; no fresh original runtime comparison.',
                'Measurements are local samples, not an old/new timed benchmark or a full chapter playthrough.',
                'The 192 MiB target evicts inactive LRU pages; pinned active resources may exceed it.',
            ])
        REPORT.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', 'utf-8')
    else:
        result = read(REPORT)
        assert result['passed'] and result['current_fingerprints'] == current, 'Current code differs from browser observation'
        assert result['evidence_fingerprints'] == evidence, 'Frozen evidence changed'
    print(json.dumps(dict(passed=True, runs=len(runs), pixel_comparisons=len(pixels),
                          transitions=len(transitions), images=export['images']), ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record', action='store_true')
    verify(parser.parse_args().record)
