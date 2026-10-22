"""Audit retained 20261014 UI evidence without replaying or rebinding a frozen report."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parent.parent
WEB = RUNTIME / 'web'
EVIDENCE = RUNTIME / 'evidence'
CASES = EVIDENCE / 'menu_socket_browser_20261014'
REPORT = EVIDENCE / 'menu_socket_browser_validation_20261014.json'

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def world(name):
    envelope = read(CASES / name)
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
    observation_path = CASES / 'browser_observation.json'
    observation = read(observation_path)
    cases = {row['case']:row for row in observation['cases']}
    assert len(cases) == len(observation['cases'])
    checks = {}
    def check(name, condition):
        assert condition, name
        checks[name] = True
    for name in ['technique-use-aligned-final', 'technique-compose-first-row-aligned-final',
                 'technique-compose-second-row-aligned-final']:
        rows = cases[name]['rows']
        selected = [r for r in rows if r['selected'] == 'true']
        check(name, len(selected) == 1 and all(r['textTop'] == '7px' and r['icon'] for r in rows)
              and len([r for r in rows if r['highlight']]) == 1)
        index = rows.index(selected[0])
        scale = selected[0]['row']['w'] / 375
        check(name+'-source-strip-origin', abs((selected[0]['highlight']['y']-selected[0]['row']['y'])/scale-(5-index)) < .001)
    for label, index, frame in [('magic',1,3),('general',2,4),('special',3,5)]:
        row = cases[label+'-category-full-highlight-final']
        selected = [r for r in row['categories'] if r['images']]
        check(label+'-complete-selected-image', len(selected) == 1 and selected[0]['key'] == f'category-{index}'
              and selected[0]['images'] == [f'assets/menu/game002b/image_{frame:03}.png'])
    check('category-retained-after-x', cases['category-retained-after-x-and-escape']['activeKey'] == 'category-3')
    check('sword-capacity-three', len(cases['technique-use-aligned-final']['locks']) == 4
          and cases['composition-two-skills-not-naming']['rows']
          and cases['composition-three-skills-enters-naming']['activeKey'] == 'char-0')
    check('fist-capacity-four', len(cases['kai-composition-four-open-three-locked']['locks']) == 3
          and cases['kai-three-skills-stays-composition']['rows']
          and cases['kai-four-skills-enters-naming']['activeKey'] == 'char-0')
    codes = cases['naming-character-selected']['nameCodes']
    check('naming-escape-actions-retains-text', len(codes) == 1
          and cases['naming-escape-to-actions']['activeKey'] == 'name-PROV'
          and cases['naming-escape-to-actions']['nameCodes'] == codes)
    check('naming-second-escape-restores-character', cases['naming-second-escape-to-character']['activeKey'] == 'char-0'
          and cases['naming-second-escape-to-character']['nameCodes'] == codes)
    check('naming-explicit-cancel', not cases['naming-explicit-cancel']['nameCodes'] and cases['naming-explicit-cancel']['rows'])
    for index in range(7):
        row = cases['slot-gold-ring-first' if index == 0 else f'slot-gold-ring-{index+1}']
        button = next(b for b in row['buttons'] if b['key'] == f'slot-{index}')
        check(f'gold-ring-slot-{index+1}', row['activeKey'] == f'slot-{index}' and len(row['ring']) == 1
              and not button['disabled'] and len(row['buttons']) == 7
              and row['ring'][0]['rect']['x'] < button['rect']['x']
              and row['ring'][0]['rect']['y'] < button['rect']['y']
              and row['ring'][0]['rect']['w'] > button['rect']['w'])
    animation = cases['slot-ring-animation']
    check('gold-ring-animates', animation['first'] != animation['second']
          and all('/board_bright/frame_' in animation[k] for k in ['first','second']))
    check('slot-cancel-clears-ring', not cases['slot-setting-cancel']['ring'] and cases['slot-setting-cancel']['rows'])
    check('technique-cancels-do-not-write-world', read(CASES/'after-technique-cancel.json')['payload']
          == read(CASES/'ruby-restored-export.json')['payload'])
    check('crystal-source-socket-count', len(cases['crystal-empty-sockets-final']['sockets']) == 4
          and len(cases['kai-three-visible-holes-final']['sockets']) == 3)
    check('crystal-eight-row-picker', len(cases['crystal-empty-picker-final']['candidates']) == 8)
    first = cases['ruby-first-hole-inserted-final']
    two = cases['ruby-two-holes-inserted-final']
    check('crystal-insert-consumes-one', first['pickerOpen'] and first['sockets'][0]['item'] == '156'
          and first['active'] == '红宝石 ×2' and first['preview'] == ['315','  0',' 40','  0','  0','  0'])
    check('two-sockets-consume-two', [r['item'] for r in two['sockets'][:2]] == ['156','156'] and two['active'] == '红宝石 ×1')
    check('crystal-replacement-preview', cases['crystal-replacement-preview-final']['preview'] == ['345>315','  0>30',' 30>40','  0','  0','  0'])
    replacement = cases['crystal-replaced-returned-ruby-final']
    check('replacement-returns-ruby', replacement['sockets'][1]['item'] == '157' and replacement['active'] == '蛋白石 ×1'
          and any(r['label'] == '红宝石 ×2' for r in replacement['candidates']))
    tail = cases['crystal-empty-tail-selected-final']
    unloaded = cases['crystal-unloaded-returned-final']
    check('blank-tail-unloads-and-returns', tail['candidates'][-1]['empty'] == 'true'
          and not unloaded['sockets'][1]['item'] and unloaded['pickerOpen']
          and any(r['label'] == '蛋白石 ×2' for r in unloaded['candidates']))
    check('crystal-escape-restores-same-hole', cases['crystal-escape-same-socket-final']['active'] == '法器第2孔：空孔'
          and not cases['crystal-escape-same-socket-final']['pickerOpen'])
    restored = cases['ingni-ruby-selected-after-cycle-final']
    check('actor-cycle-preserves-gem-and-focus', restored['sockets'][0]['item'] == '156'
          and restored['sockets'][0]['selected'] == 'true' and restored['actor'] == '英格妮')
    fixture = world('crystal-test-save.json')
    final = world('crystal-final-export.json')
    gem = final['crystal_sockets']['roles']['001'][0]
    check('saved-crystal-raw-record-preserved', gem['quantity'] == 3 and gem['source_raw_hex']
          == next(r for r in fixture['inventory'] if r['id'] == 156)['source_raw_hex'])
    check('saved-inventory-only-one-ruby-consumed', all(
        next(r for r in final['inventory'] if r['instance_id'] == row['instance_id'])['quantity']
        == row['quantity']-(1 if row['id'] == 156 else 0) for row in fixture['inventory']))
    check('saved-other-five-sockets-empty', final['crystal_sockets']['roles']['001'][1:] == [None]*5
          and final['crystal_sockets']['roles']['002'] == [None]*6)
    check('crystal-transactions-preserve-world-content', all(fixture.get(k) == final.get(k) for k in
          ['source','party','equipment','leader_id','money','flags','event_records','encounters','position',
           'formation_slots','technique_bindings','technique_combinations']))
    check('crystal-save-roundtrip', read(CASES/'ruby-installed-save.json')['payload']
          == read(CASES/'ruby-restored-export.json')['payload'])
    before, after = read(CASES/'previous-save-before.json'), read(CASES/'previous-save-after.json')
    check('previous-browser-progress-preserved', before['payload'] == after['payload'])
    check('final-browser-console-clean', observation['console_errors'] == [])
    current = sorted(p for p in WEB.rglob('*') if p.is_file() and p.suffix in {'.mjs','.js','.css','.html','.json'})
    current += sorted((RUNTIME/'tests').glob('test_*.mjs'))
    current += [Path(__file__), RUNTIME/'tools/verify_current.py', RUNTIME/'tools/create_menu_socket_fixture.mjs',
                *[RUNTIME.parent/name for name in ['README.txt','assessment/validation_design.txt',
                  'runtime/README.txt','runtime/architecture.txt','runtime/config_guide.txt','runtime/tools/README.txt']]]
    evidence = sorted(p for p in CASES.iterdir() if p.suffix in {'.json','.jpg','.png'})
    evidence += [EVIDENCE/name for name in ['crystal_socket_audit_20261014.json','crystal_socket_native_20261014.json',
                  'weapon_socket_ui_geometry_20261014.json','technique_interaction_audit_20261014.json',
                  'menu_technique_native_20261013.json','operation_menu_native.json']]
    report = dict(schema='seventh-seal-menu-socket-browser-validation',version=1,
                  checked_utc=datetime.now(timezone.utc).isoformat(),passed=True,checks=checks,
                  observation_path=observation_path.relative_to(ROOT).as_posix(),observation_sha256=sha(observation_path),
                  current_fingerprints={p.relative_to(ROOT).as_posix():sha(p) for p in current},
                  evidence_fingerprints={p.relative_to(ROOT).as_posix():sha(p) for p in evidence},
                  previous_browser_save_payload_sha256=hashlib.sha256(before['payload'].encode()).hexdigest(),
                  screenshot=(CASES/'skill-slot-gold-ring-center-final.jpg').relative_to(ROOT).as_posix(),
                  original_game_execution_observed=False,actual_browser_flow_checked_this_run=False,
                  limits=observation['limits']+[
                    'This verifier checks retained browser observations and actual UI exports; it does not replay them.',
                    'Only21 source-proven numeric crystals are enabled;45 special-passive crystals, crafting and formal acquisition are not implemented.',
                    'Original source template has7 composition positions; capped positions are covered with original frame7.',
                    'Preliminary technique-edit-aligned.jpg predates the row-icon repaint repair; only -final checks are acceptance.',
                    'No new-game story or combat replay was performed in this UI-focused pass; prior dated evidence remains separate.'])
    REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'passed':True,'checks':len(checks),'cases':len(cases),'fingerprints':len(current)}))

if __name__ == '__main__':
    main()
