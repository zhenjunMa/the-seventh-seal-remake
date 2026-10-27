"""Freeze this menu pass's actual observations; later runs only audit its hashes."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import sys

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parent.parent
WEB = RUNTIME / 'web'
EVIDENCE = RUNTIME / 'evidence'
CASES = EVIDENCE / 'menu_finish_browser_20261014'
REPORT = EVIDENCE / 'menu_finish_browser_validation_20261014.json'

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
        print(json.dumps({'passed':True, 'frozen_report_matches':True}))
        return
    observation_path = CASES / 'browser_observation.json'
    observation = read(observation_path)
    cases = {row['case']:row for row in observation['cases']}
    assert len(cases) == len(observation['cases'])
    checks = {}
    def check(name, condition):
        assert condition, name
        checks[name] = True
    def selected(name):
        return [row for row in cases[name]['items'] if row['selected']]
    def pressed(name, label):
        return any(row['label'] == label and row['pressed'] == 'true' for row in cases[name]['buttons'])
    for name, label, offset in [
        ('final-armor-page-edge','安息香带 ×1',0),
        ('final-armor-page-tail','珍珠耳环 ×1',60),
        ('final-crystal-page-edge','蛋白石 ×2',0),
        ('final-crystal-page-tail','月眠石 ×2',120),
        ('final-crystal-page-up-edge','白水晶原石 ×2',120),
        ('final-crystal-arrow-up','红水晶原石 ×2',0)]:
        row = cases[name]
        check(name, row['active'] == label and row['list']['scrollTop'] == offset
              and len(selected(name)) == 1 and selected(name)[0]['inside'])
    for name, label in [
        ('final-armor-default-head','头饰／耳环'),('final-armor-neck-filter','项链'),
        ('final-armor-ring-filter','戒指'),('final-armor-badge-filter','徽章'),
        ('final-armor-special-filter','特殊饰品'),('final-armor-wrap-head','头饰／耳环'),
        ('final-armor-click-ring','戒指')]:
        check(name, pressed(name,label) and cases[name]['list']['scrollTop'] == 0)
    check('armor-confirm-inspects-only', [r['label'] for r in selected('final-armor-click-ring')] ==
          [r['label'] for r in selected('final-armor-confirm-inspects')])
    check('empty-armor-clears-detail', not cases['final-armor-empty-head']['items']
          and cases['final-armor-empty-head']['active'] == '头饰／耳环'
          and not cases['final-armor-empty-head']['detailVisible'])
    check('crystal-has-no-armor-filters', not any(b['label'] in ['项链','戒指','徽章','特殊饰品']
          for b in cases['final-crystal-right-noop']['buttons']))
    check('crystal-right-noop', [r['label'] for r in selected('final-crystal-right-noop')] ==
          [r['label'] for r in selected('final-crystal-catalog-default')])
    check('medicine-cancel-retains-item', cases['final-medicine-escape-retains-tea']['active'] == '碧沙草茶 ×4')
    check('last-stack-focuses-adjacent', cases['final-medicine-last-stack-adjacent-focus']['active'] == '碧沙草茶 ×4')
    fixture, used = world('menu-test-save.json'), world('after-medicine-export.json')
    removed = [row for row in fixture['inventory'] if row['instance_id'] not in
               {item['instance_id'] for item in used['inventory']}]
    check('medicine-consumes-only-final-stack', len(removed) == 1 and removed[0]['id'] == 12
          and removed[0]['quantity'] == 1 and used['inventory'] ==
          [row for row in fixture['inventory'] if row['instance_id'] != removed[0]['instance_id']])
    check('medicine-preserves-other-world-content', all(fixture.get(k) == used.get(k)
          for k in set(fixture)|set(used) if k not in {'inventory','revision'}))
    baseline = cases['final-status-roster']['system']
    check('system-volume-baseline-retained', baseline['volume'] ==
          [int(row['raw']) for row in cases['before-system-preferences']['system']])
    for name in ['final-system-cursor-space-noop','final-system-cursor-enter-noop',
                 'final-system-preferences-restored','final-system-after-reboot']:
        check(name, cases[name]['system'] == baseline)
    check('system-cursor-arrows', cases['final-system-cursor-initial']['system']['cursor'] == ['初始'])
    check('system-volume-source-step-four', cases['final-system-volume-plus-four']['system']['volume'] == [33,56,64])
    for name in ['final-kai-three-pointer-fixed','final-ingni-two-pointer-stays-compose']:
        rows = cases[name]['techRows']
        check(name+'-text-and-strip', len(rows) == 5 and all(r['textTop'] == '5px' and r['icon'] for r in rows)
              and sum(r['highlights'] for r in rows) == 1
              and all(r['color'] == ('rgb(255, 255, 255)' if r['selected'] == 'true' else 'rgb(255, 255, 0)') for r in rows))
    check('fist-four-sword-three-capacity', len(cases['final-kai-three-pointer-fixed']['locks']) == 3
          and len(cases['final-ingni-two-pointer-stays-compose']['locks']) == 4
          and cases['final-kai-four-pointer-fixed-naming']['activeKey'] == 'char-0'
          and cases['final-ingni-three-pointer-enters-naming']['activeKey'] == 'char-0')
    check('naming-Escape-retains-character', cases['final-naming-fixed-escape-actions']['activeKey'] == 'name-PROV'
          and cases['final-naming-fixed-escape-character']['activeKey'] == 'char-0'
          and len(cases['final-naming-fixed-escape-actions']['nameGlyphs']) == 1
          and cases['final-naming-fixed-escape-actions']['nameGlyphs'] == cases['final-naming-fixed-escape-character']['nameGlyphs'])
    for name,index,image in [('magic',1,3),('general',2,4),('special',3,5)]:
        row = cases['final-category-'+name+'-complete']
        selected_categories = [c for c in row['categories'] if c['images']]
        check(name+'-complete-bright-label', len(selected_categories) == 1
              and selected_categories[0] == {'key':f'category-{index}', 'images':[f'assets/menu/game002b/image_{image:03}.png']})
    for name,index in [('first',0),('second',1),('third',2)]:
        row = cases['final-slot-gold-ring-'+name]
        check('gold-ring-'+name, row['activeKey'] == f'slot-{index}' and len(row['ring']) == 1
              and '/board_bright/frame_' in row['ring'][0]['src'])
    check('slot-cancel-removes-ring', not cases['final-slot-cancel-no-ring']['ring'])
    check('all-previews-cancel-without-world-write', world('after-all-cancel-export.json') == fixture
          and world('after-technique-cancel-export.json') == fixture)
    for name,label in [('final-equipment-fixture-escape-head','头饰：珍珠耳环'),
                       ('final-equipment-fixture-kai-same-head','头饰：烈焰冠'),
                       ('final-equipment-fixture-ingni-same-head','头饰：珍珠耳环')]:
        check(name, cases[name]['active'] == label and pressed(name,label))
    check('equipment-grey-focus', cases['final-equipment-fixture-picker']['active'].endswith('此角色无法装备'))
    check('equipment-edge-and-tail', cases['final-equipment-fixture-page-edge']['active'].startswith('路那狄斯的假面')
          and cases['final-equipment-fixture-page-tail']['active'] == '卸下头饰／耳饰')
    check('formation-first-selection-cancel', cases['final-formation-cancel-to-header']['activeId'] == 'menuFormationPage')
    check('weapon-default-socket-after-actor-cycle', all(cases[n]['active'] == '法器第1孔：空孔'
          for n in ['final-weapon-kai-default-hole','final-weapon-ingni-default-hole']))
    for name in ['final-font-menu-default','final-reopening-default']:
        check(name, pressed(name,'人物状态') and not pressed(name,'技能'))
    before = read(CASES/'previous-save-before.json')['payload']
    check('stored-progress-preserved-through-reboot', all(read(CASES/name)['payload'] == before
          for name in ['previous-save-after.json','previous-save-after-reboot.json','previous-save-final.json']))
    check('browser-console-clean', observation['console_errors'] == [])
    check('old-geometry-evidence-frozen', sha(EVIDENCE/'weapon_socket_ui_geometry_20261014.json') ==
          '716c19b496bdeffeaca9a864ee6222bdc0e9558fba0ed33d8af831f0bc25695b')
    sys.path.insert(0,str(RUNTIME/'tools'))
    from export_menu_text_gdi import collect_text_charset
    charset, sources = collect_text_charset()
    fonts = read(WEB/'data/menu_fonts.json')
    missing = ''.join(c for c in charset if c not in fonts['text_charset']['characters'])
    check('final-font-charset-complete', not missing and fonts['text_charset']['character_count'] == 1000)
    for profile in fonts['fonts'].values():
        assert sha(WEB/profile['image']) == profile['sha256']
    font_check_path = EVIDENCE/'menu_text_final_source_check_20261014.json'
    font_check_path.write_text(json.dumps(dict(schema='seventh-seal-menu-final-font-source-check',
        version=1, missing_characters=missing, character_count=len(charset), current_sources=sources,
        manifest_sha256=sha(WEB/'data/menu_fonts.json'), atlas_hashes_match=True,
        scope='Final pointer-events change alters only hit testing; atlas and exported characters remain unchanged.',
        original_game_execution_observed=False),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    current = sorted(p for p in WEB.rglob('*') if p.is_file() and p.suffix in {'.mjs','.js','.css','.html','.json'})
    current += sorted((RUNTIME/'tests').glob('test_*.mjs'))
    current += [Path(__file__),RUNTIME/'tools/verify_current.py',RUNTIME/'tools/build_runtime.py',
                RUNTIME/'tools/create_menu_finish_fixture.mjs',RUNTIME/'tools/menu_font_recipe.json',
                RUNTIME/'tools/export_menu_text_gdi.py',*[RUNTIME.parent/name for name in
                ['README.md','assessment/validation_design.md','runtime/README.md','runtime/architecture.md',
                 'runtime/config_guide.md','runtime/tools/README.md']]]
    evidence = sorted(p for p in CASES.iterdir() if p.suffix in {'.json','.jpg','.png'})
    evidence += [EVIDENCE/name for name in ['menu_finish_native_20261014.json','menu_catalog_finish_native_20261014.json',
        'menu_navigation_audit_20261014.json','menu_catalog_finish_audit_20261014.json','menu_detail_finish_audit_20261014.json',
        'weapon_socket_ui_geometry_finish_20261014.json','menu_text_finish_audit_20261014.json',
        'menu_text_armor_provenance_20261014.json','menu_text_armor_delivery_export_20261014.json',
        'menu_text_finish_widget_requests_20261014.json',font_check_path.name]]
    report = dict(schema='seventh-seal-menu-finish-browser-validation',version=1,
        checked_utc=datetime.now(timezone.utc).isoformat(),passed=True,checks=checks,cases=len(cases),
        observation_path=observation_path.relative_to(ROOT).as_posix(),observation_sha256=sha(observation_path),
        current_fingerprints={p.relative_to(ROOT).as_posix():sha(p) for p in current},
        evidence_fingerprints={p.relative_to(ROOT).as_posix():sha(p) for p in evidence},
        screenshot=(CASES/'final-skill-list.jpg').relative_to(ROOT).as_posix(),
        original_game_execution_observed=False,actual_browser_flow_checked_this_run=False,
        limits=observation['limits']+['This verifier checks retained actual UI observations and exports; it does not replay the browser.',
        'Preliminary duplicate/pointer attempts are retained separately and are not acceptance cases.',
        'Original source cost-string formatting, 16-bit blending, missing requested fonts and unconnected menus remain bounded.'])
    REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'passed':True,'checks':len(checks),'cases':len(cases),'fingerprints':len(current)}))

if __name__ == '__main__':
    main()
