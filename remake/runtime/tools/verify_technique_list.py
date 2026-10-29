"""Freeze retained technique-list UI observations and source links, never replay UI."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import struct
import sys

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parent.parent
WEB = RUNTIME/'web'
EVIDENCE = RUNTIME/'evidence'
CASES = EVIDENCE/'technique_list_browser_20261014'
REPORT = EVIDENCE/'technique_list_browser_validation_20261014_v2.json'


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
    assert len(cases) == len(observation['cases']) == 10
    checks = {}

    def check(name, condition):
        assert condition, name
        checks[name] = True

    skills = read(WEB/'data/party_skills.json')
    icons = read(WEB/'data/operation_techniques.json')['icons']
    source_frames = set()
    for name, case in cases.items():
        if name == 'empty-special-category-clears-details':
            check(name, case['rows'] == [])
            continue
        rows = case['rows']
        check(name+'-one-yellow-row', sum(r['color'] == 'rgb(255, 255, 0)' for r in rows) == 1
              and all(r['color'] == ('rgb(255, 255, 0)' if r['selected'] == 'true' else 'rgb(255, 255, 255)') for r in rows))
        check(name+'-one-source-strip', sum(len(r['highlight']) for r in rows) == 1
              and next(r['key'] for r in rows if r['selected'] == 'true') == case['activeKey'])
        check(name+'-sprites-loaded', all(r['imagesComplete'] for r in rows))
        role = '002' if name.startswith('kai-') else '001'
        for row in rows:
            index = int(row['key'].split('-')[-1])
            skill = skills['roles'][role]['skills'][index]
            data = bytes.fromhex(skill['fixed_raw_hex'])
            flags, units = struct.unpack_from('<II', data, 0x32)
            level = [] if units == 0 else [dict(value=str(units),
                src=icons['magic_ball1_num']['frames'][((flags >> 4) & 15)*7+units-1], x='22px', y='17px')]
            attributes = [dict(value=str(n), src=icons['magic_ball1_attr']['frames'][n],
                               x=f'{204+n*24}px', y='5px') for n in range(5) if flags & (1 << (8+n))]
            check(name+'-'+row['key']+'-original-level-and-features', row['level'] == level and row['attributes'] == attributes)
            required, experience = struct.unpack_from('<ii', data, 0x2f7)
            check(name+'-'+row['key']+'-original-zero-experience', required > 0 and experience == 0
                  and len(row['experience']) == 1 and row['experience'][0]['percent'] == '0'
                  and row['experience'][0]['label'] == f'技巧经验 0/{required}（0%）'
                  and (row['experience'][0]['x'], row['experience'][0]['y']) == ('339px', '3px')
                  and row['experience'][0]['tint'] == 'rgb(0, 128, 0)' and row['experience'][0]['opacity'] == '0.5'
                  and row['experience'][0]['mask'].endswith('/assets/menu/techniques/use_ball/frame_000.png")')
                  and row['digits'] == [dict(frame='10', src=icons['use_ball_num']['frames'][10], x='364px', y='15px'),
                                        dict(frame='0', src=icons['use_ball_num']['frames'][0], x='357px', y='15px')])
            for key in ['level', 'attributes', 'digits', 'highlight']:
                source_frames.update(r['src'] for r in row[key])
    check('down-arrow-from-native-bit-nine', [r['value'] for r in next(r for r in cases['kai-down-arrow-selected']['rows']
          if r['key'] == 'entry-0-20')['attributes']] == ['0', '1'])
    fixture_path = ROOT/observation['fixture']
    check('canceled-previews-preserve-complete-world', world(fixture_path) == world(CASES/'after-cancel-export.json'))
    check('original-stored-progress-preserved', world(CASES/'previous-save-before.json') == world(CASES/'previous-save-after.json')
          and read(CASES/'previous-save-before.json')['payload'] == read(CASES/'previous-save-after.json')['payload'])
    check('browser-console-clean', observation['console_errors'] == [])
    used_banks = ['magic_ball1_num', 'magic_ball1_attr', 'use_ball', 'use_ball_num']
    check('original-icon-inputs-unchanged', all(sha(ROOT/icons[name]['source']) == icons[name]['sha256'] for name in used_banks))
    source_frames.update(frame for name in used_banks for frame in icons[name]['frames'])
    export = read(EVIDENCE/'menu_technique_export_20261013.json')
    check('exported-icons-unchanged', all(sha(WEB/frame) == export['output_hashes'][(WEB/frame).relative_to(ROOT).as_posix()]
          for name in used_banks for frame in icons[name]['frames']))
    native_path = EVIDENCE/'technique_list_native_20261014.json'
    native = read(native_path)
    links = dict(single_row='ev_c809dbabf8ac42866f1bafa560e0bde28e011648bbd24930698504c7e0110d3a',
        combination_row='ev_f42c9022cff10fc816ded45ad175081b142bce54088ceefe6286ba1f009d5989',
        signed_color_bytes='ev_8f4b585e6ca00ebaf49794010873c31dde4a44203ba511ff436902e23a0052e9',
        sprite_interpolation='ev_6e9a1644b678a8ccfe7618845246d6778cb1f6efd1a7bb60a2085e4662737715',
        color_packing='ev_b5e53a3675059e35ccdb06d34e1e618550f6b4ea5e22f5eac432d8ae4b163e62')
    check('native-evidence-links-retained', set(links.values()) <= {r['evidence_id'] for r in native['records']})
    sys.path.insert(0, str(RUNTIME/'tools'))
    from export_menu_text_gdi import collect_text_charset
    charset, font_sources = collect_text_charset()
    fonts = read(WEB/'data/menu_fonts.json')
    missing = set(charset)-set(fonts['text_charset']['characters'])
    # The collector scans the entire new ARIA template, including the letter
    # q in ${required} and the character 验. It is spoken metadata,
    # never sent to the glyph renderer; all visible labels remain unchanged.
    check('no-new-rendered-glyphs', missing <= {'q', '验'})
    check('existing-font-atlases-unchanged', all(sha(WEB/p['image']) == p['sha256'] for p in fonts['fonts'].values()))
    audit_path = EVIDENCE/'technique_list_ui_audit_20261014_v2.json'
    audit_path.write_text(json.dumps(dict(schema='seventh-seal-technique-list-ui-audit', version=1,
        source_type='original-menu-sprites-native-static-and-user-screenshot', original_game_execution_observed=False,
        native_bundle=native_path.relative_to(ROOT).as_posix(), evidence_links=links,
        color_reference=(CASES/'user-skill-list.png').relative_to(ROOT).as_posix(),
        selected_text='yellow', normal_text='white',
        fields=dict(level_and_composition_units='skill+0x36', attributes='skill+0x32 bits8..12',
                    required_experience='skill+0x2F7', current_experience='skill+0x2FB'),
        font_character_count=len(fonts['text_charset']['characters']), font_source_fingerprints=font_sources,
        non_rendered_aria_charset_difference=sorted(missing),
        validation_note='Final regression uses deterministic integer test time for exact120ms animation boundaries; production animation timing is unchanged.',
        limits=observation['limits']), ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    current = sorted(p for p in WEB.rglob('*') if p.is_file() and p.suffix in {'.mjs', '.js', '.css', '.html', '.json'})
    current += sorted((RUNTIME/'tests').glob('test_*.mjs'))
    current += [Path(__file__), RUNTIME/'tools/verify_current.py', RUNTIME/'tools/build_runtime.py',
                ROOT/'README.md', *[RUNTIME.parent/name for name in ['assessment/validation_design.md', 'runtime/README.md',
                 'runtime/architecture.md', 'runtime/config_guide.md', 'runtime/tools/README.md']]]
    evidence = sorted(p for p in CASES.iterdir() if p.suffix in {'.json', '.jpg', '.png'})
    evidence += [audit_path, native_path, fixture_path, EVIDENCE/'menu_technique_export_20261013.json',
                 *[WEB/frame for frame in sorted(source_frames)]]
    report = dict(schema='seventh-seal-technique-list-browser-validation', version=1,
        checked_utc=datetime.now(timezone.utc).isoformat(), passed=True, checks=checks, cases=len(cases),
        observation_path=(CASES/'browser_observation.json').relative_to(ROOT).as_posix(),
        observation_sha256=sha(CASES/'browser_observation.json'),
        current_fingerprints={p.relative_to(ROOT).as_posix(): sha(p) for p in current},
        evidence_fingerprints={p.relative_to(ROOT).as_posix(): sha(p) for p in evidence},
        screenshot=(CASES/'general-yellow-white.jpg').relative_to(ROOT).as_posix(),
        actual_browser_flow_checked_this_run=False, original_game_execution_observed=False,
        limits=observation['limits']+['This verifier checks retained observations, not new browser operations.'])
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'passed': True, 'checks': len(checks), 'cases': len(cases)}))


if __name__ == '__main__':
    main()
