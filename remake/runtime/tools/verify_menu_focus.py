"""Freeze actual menu focus observations; later checks do not replay the browser."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import sys

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parent.parent
WEB = RUNTIME/'web'
EVIDENCE = RUNTIME/'evidence'
CASES = EVIDENCE/'menu_focus_browser_20261014'
REPORT = EVIDENCE/'menu_focus_browser_validation_20261014.json'


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
    cases = {row['case']: row for row in observation['cases']}
    assert len(cases) == len(observation['cases']) == 15
    checks = {}

    def check(name, condition):
        assert condition, name
        checks[name] = True

    header_cases = [
        ('status-header-selected', 'menuStatusPage'),
        ('equipment-header-only-before-confirm', 'menuEquipmentPage'),
        ('formation-header-only', 'menuFormationPage'),
        ('weapon-header-only', 'menuWeaponPage'),
        ('status-wrap-only', 'menuStatusPage'),
        ('equipment-header-only-after-click', 'menuEquipmentPage'),
        ('item-header-items-only', 'menuItemsPage'),
        ('item-header-equipment-only', 'menuInventoryEquipmentPage'),
        ('item-header-crystals-only', 'menuCrystalsPage')]
    for name, selected_id in header_cases:
        case = cases[name]
        group = case['itemHeaders'] if name.startswith('item-') else case['headers']
        check(name, [r['id'] for r in group if r['images']] == [selected_id]
              and all(len(r['images']) <= 1 for r in group))
        if name != 'equipment-header-only-after-click':
            check(name+'-focused', case['activeId'] == selected_id and case['layer'] == 'sub')
    pending = cases['equipment-header-only-before-confirm']
    check('pending-focus-clears-old-visual-without-committing-page',
          next(r for r in pending['headers'] if r['id'] == 'menuStatusPage')['pressed'] == 'true'
          and next(r for r in pending['headers'] if r['id'] == 'menuEquipmentPage')['pressed'] == 'false')
    confirmed = cases['equipment-header-only-after-click']
    check('confirmation-commits-only-equipment', confirmed['layer'] == 'content'
          and next(r for r in confirmed['headers'] if r['id'] == 'menuStatusPage')['pressed'] == 'false'
          and next(r for r in confirmed['headers'] if r['id'] == 'menuEquipmentPage')['pressed'] == 'true')
    bright_frame = 'assets/menu/game002_2a/image_002.png'
    glyphs = cases['naming-PROV-bright']['nameGlyphs']
    check('actual-draft-character-retained', glyphs == ['assets/menu/techniques/name_text/frame_000.png'])
    for action in ['PROV', 'NEXT', 'DEL', 'CANCEL', 'OK']:
        name = 'naming-PROV-bright' if action == 'PROV' else f'naming-{action}-bright-only'
        case = cases[name]
        key = f'name-{action}'
        check(name, case['activeKey'] == key and len(case['nameActions']) == 5
              and [(r['key'], r['images']) for r in case['nameActions'] if r['images']] == [(key, [bright_frame])]
              and case['nameGlyphs'] == glyphs)
    returned = cases['naming-return-to-character-clears-action']
    check('Escape-clears-all-action-frames', returned['activeKey'] == 'char-0'
          and len(returned['nameActions']) == 5 and not any(r['images'] for r in returned['nameActions'])
          and returned['nameGlyphs'] == glyphs)
    fixture_path = ROOT/observation['fixture']
    check('cancel-keeps-world-exactly-unchanged', world(fixture_path) == world(CASES/'after-cancel-export.json'))
    check('previous-stored-progress-preserved',
          world(CASES/'previous-save-before.json') == world(CASES/'previous-save-after.json')
          and read(CASES/'previous-save-before.json')['payload'] == read(CASES/'previous-save-after.json')['payload'])
    check('browser-console-clean', observation['console_errors'] == [])
    source_path = WEB/'data/operation_menu.json'
    source = next(m for m in read(source_path)['menus'] if m['id'] == 'game002_2a')
    check('original-naming-resource-unchanged', sha(ROOT/source['source']) == source['source_sha256'])
    actions = [w for w in source['widgets'] if w['name'] in {'PROV', 'NEXT', 'DEL', 'CANCEL', 'OK'}]
    frames = [f'assets/menu/game002_2a/image_{n:03}.png' for n in range(2, 7)]
    check('five-actions-share-original-five-frame-cursor', len(actions) == 5
          and all(w['normal_images'] == [] and w['active_images'] == w['selected_images'] == frames for w in actions))
    source_images = [r for r in source['images'] if r['image'] in frames]
    check('original-cursor-PNGs-match-source-manifest', len(source_images) == 5
          and all(sha(WEB/r['image']) == r['png_sha256'] for r in source_images))
    sys.path.insert(0, str(RUNTIME/'tools'))
    from export_menu_text_gdi import collect_text_charset
    charset, font_sources = collect_text_charset()
    fonts = read(WEB/'data/menu_fonts.json')
    check('existing-font-atlas-covers-final-labels', not set(charset)-set(fonts['text_charset']['characters']))
    check('existing-font-assets-match-manifest', all(sha(WEB/p['image']) == p['sha256'] for p in fonts['fonts'].values()))
    audit_path = EVIDENCE/'menu_focus_audit_20261014.json'
    audit_path.write_text(json.dumps(dict(schema='seventh-seal-menu-focus-audit', version=1,
        source_type='original-menu-resource-and-browser-observation', original_game_execution_observed=False,
        source=dict(path=source['source'], sha256=source['source_sha256'], cursor_frames=frames,
                    displayed_focus_frame=bright_frame, multi_frame_timing_reproduced=False),
        changes=['Naming actions use the original first bright frame as a stable focus cue.',
                 'Each header group displays focused header or committed header, exclusively.',
                 'Escape back to character grid clears action focus and preserves unsaved text.'],
        existing_fonts_unchanged=True, font_character_count=len(charset), font_source_fingerprints=font_sources,
        limitations=observation['limits']), ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    current = sorted(p for p in WEB.rglob('*') if p.is_file() and p.suffix in {'.mjs', '.js', '.css', '.html', '.json'})
    current += sorted((RUNTIME/'tests').glob('test_*.mjs'))
    current += [Path(__file__), RUNTIME/'tools/verify_current.py', RUNTIME/'tools/build_runtime.py',
                *[RUNTIME.parent/name for name in ['README.md', 'assessment/validation_design.md', 'runtime/README.md',
                 'runtime/architecture.md', 'runtime/config_guide.md', 'runtime/tools/README.md']]]
    evidence = sorted(p for p in CASES.iterdir() if p.suffix in {'.json', '.jpg', '.png'})
    evidence += [audit_path, fixture_path, source_path, *[WEB/frame for frame in frames]]
    report = dict(schema='seventh-seal-menu-focus-browser-validation', version=1,
        checked_utc=datetime.now(timezone.utc).isoformat(), passed=True, checks=checks, cases=len(cases),
        observation_path=(CASES/'browser_observation.json').relative_to(ROOT).as_posix(),
        observation_sha256=sha(CASES/'browser_observation.json'),
        current_fingerprints={p.relative_to(ROOT).as_posix(): sha(p) for p in current},
        evidence_fingerprints={p.relative_to(ROOT).as_posix(): sha(p) for p in evidence},
        screenshot=(CASES/'naming-bright-gold-frame.jpg').relative_to(ROOT).as_posix(),
        actual_browser_flow_checked_this_run=False, original_game_execution_observed=False,
        limits=observation['limits']+['This verifier checks retained actual UI observations and exports; it does not replay them.'])
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'passed': True, 'checks': len(checks), 'cases': len(cases)}))


if __name__ == '__main__':
    main()
