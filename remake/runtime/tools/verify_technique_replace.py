"""Freeze source-backed technique replacement observations without replaying UI."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import sys

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parent.parent
WEB = RUNTIME/'web'
EVIDENCE = RUNTIME/'evidence'
CASES = EVIDENCE/'technique_replace_browser_20261014'
REPORT = EVIDENCE/'technique_replace_browser_validation_20261014.json'

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
        report=read(REPORT)
        assert report['passed']
        for field in ['current_fingerprints','evidence_fingerprints']:
            for name,expected in report[field].items():
                assert sha(ROOT/name)==expected, f'Frozen observation differs: {name}'
        print(json.dumps({'passed':True,'frozen_report_matches':True}))
        return
    observation=read(CASES/'browser_observation.json')
    cases={r['case']:r for r in observation['cases']}
    assert len(cases)==len(observation['cases'])
    checks={}
    def check(name,condition):
        assert condition,name
        checks[name]=True
    check('setting-categories-show-source-wheel',len(cases['final-setting-categories-show-wheel']['wheel'])==1)
    for name in ['final-return-actions-wheel-hidden','final-switch-header-cleans-overlays','final-reopen-edit-actions-clean']:
        check(name, not cases[name]['wheel'] and not cases[name]['rings'] and not cases[name]['effects'])
    check('return-retains-set-action',cases['final-return-actions-wheel-hidden']['activeKey']=='action-set')
    for prefix,index in [('seventh',6),('first',0)]:
        preview=cases[f'final-{prefix}-slot-preview']
        slot=next(r for r in preview['slots'] if r['key']==f'slot-{index}')
        check(prefix+'-slot-selected',preview['activeKey']==f'slot-{index}' and len(preview['rings'])==1 and not preview['effects'])
        effect_case=cases['final-seventh-slot-effect-start' if index==6 else 'final-first-slot-animation-allows-navigation']
        check(prefix+'-replacement-clears-cursor',len(effect_case['effects'])==1 and not effect_case['rings'])
        effect=effect_case['effects'][0]
        scale=effect['rect']['w']/70
        check(prefix+'-source-effect-origin',abs(effect['rect']['h']-70*scale)<.001
              and abs(effect['rect']['x']-slot['rect']['x']+18*scale)<.001
              and abs(effect['rect']['y']-slot['rect']['y']+18*scale)<.001)
    start=cases['final-seventh-slot-effect-start']['effects'][0]
    third=cases['final-seventh-slot-effect-frame-three']
    check('replacement-resets-frame-zero',start['frame']=='0' and start['src'].endswith('/board_brightB/frame_000.png'))
    check('replacement-advances-source-frames',third['effects'][0]['frame']=='3'
          and third['effects'][0]['src'].endswith('/board_brightB/frame_003.png'))
    check('native-additive-adaptation',third['blend']=='plus-lighter'
          and third['effects'][0]['opacity']=='')
    check('one-shot-clears-after-play',not cases['final-seventh-slot-effect-completed']['effects']
          and len(cases['final-seventh-slot-effect-completed']['wheel'])==1)
    check('playback-does-not-lock-navigation',cases['final-first-slot-animation-allows-navigation']['activeKey']=='entry-0-41')
    check('Escape-clears-active-replacement',not cases['final-animation-escape-clears-effect']['effects']
          and len(cases['final-animation-escape-clears-effect']['wheel'])==1)
    fixture_path=ROOT/observation['fixture']
    before,after=world(fixture_path),world(CASES/'after-two-replacements.json')
    slots=after['technique_bindings']['roles']['001']
    check('actual-saved-first-and-seventh-slot',slots[0]==dict(type=0,index_one_based=38,icon=0,color=1)
          and slots[6]==dict(type=0,index_one_based=42,icon=0,color=0))
    check('other-five-source-slots-retained',slots[1:6]==[
          dict(type=0,index_one_based=23,icon=0,color=1),dict(type=0,index_one_based=24,icon=0,color=1),
          *[dict(type=2,index_one_based=n,icon=n-1,color=0) for n in [1,2,3]]])
    check('two-confirmations-only-two-transactions',after['revision']==before['revision']+2)
    check('legacy-three-slot-table-synchronized',after['skill_shortcuts']==dict(version=1,roles={'001':[37,22,23]}))
    check('other-world-content-preserved',all(before.get(k)==after.get(k) for k in set(before)|set(after)
          if k not in {'revision','technique_bindings','skill_shortcuts'}))
    check('actual-import-export-roundtrip',world(CASES/'after-reimport-export.json')==after)
    check('previous-stored-progress-preserved',read(CASES/'previous-save-before.json')['payload']==read(CASES/'previous-save-after.json')['payload'])
    check('browser-console-clean',observation['console_errors']==[])
    native_path=EVIDENCE/'technique_slot_effect_native_20261014.json'
    native=read(native_path)
    links={
        'commit-and-reset-frame':'ev_8b181d128785e54f306f6a8bb229faa04690ecbc621cfd8e463296e47518be1d',
        'one-cycle-timer':'ev_9578946b444a319cc41f980804882a09c3fc47e8679bcd14f3c531de99ec8860',
        'Space-and-Escape':'ev_a37de39d989bf9190b892f3b17f89fb02d69644c9941fc3b9baf6678251a2a32',
        'RGB-add-saturate-and-frame':'ev_99b0ca28d6e1ec8f4df0fdc85aba571d0955992a3c649ce0e8f75cb5424d2859',
        'wheel-return-hide':'ev_a2c40afcb76c1a4519c795a34e00fe46cc7ab2cb7407fe84b7f5ca01e00d2b9e',
        'wheel-initialize-before-categories':'ev_0f7e85f1d04c8b5b77ea40379a653a739e4abb525fb900235d1a13cd31555cd0',
        'effect-slot-rect-position':'ev_a7e9c53a47c8f39295bf30aef7a37b5d4a9ef58109db768be32300a11837b85c'}
    ids={r['evidence_id'] for r in native['records']}
    cached_native_path=EVIDENCE/'menu_technique_native_20261013.json'
    cached_ids={r['evidence_id'] for r in read(cached_native_path)['records']}
    check('static-evidence-links-complete',set(links.values())<=ids|cached_ids)
    source=read(WEB/'data/operation_techniques.json')['icons']['board_brightB']
    check('original-effect-source-unchanged',sha(ROOT/source['source'])==source['sha256'])
    check('source-nine-frames120ms',len(source['frames'])==9 and source['width']==source['height']==70
          and source['actions'][0]['interval_raw']==120 and source['actions'][0]['loop_raw']==1)
    sys.path.insert(0,str(RUNTIME/'tools'))
    from export_menu_text_gdi import collect_text_charset
    charset,font_sources=collect_text_charset()
    fonts=read(WEB/'data/menu_fonts.json')
    check('existing-font-atlas-covers-final-labels',not set(charset)-set(fonts['text_charset']['characters']))
    check('existing-font-assets-match-manifest',all(sha(WEB/profile['image'])==profile['sha256'] for profile in fonts['fonts'].values()))
    audit_path=EVIDENCE/'technique_slot_effect_audit_20261014.json'
    audit_path.write_text(json.dumps(dict(schema='seventh-seal-technique-slot-effect-audit',version=1,
        source_type='native-static-and-original-sprites',original_game_execution_observed=False,
        native_bundle=native_path.relative_to(ROOT).as_posix(),native_records=len(ids),
        cached_native_bundle=cached_native_path.relative_to(ROOT).as_posix(),evidence_links=links,
        source=dict(path=source['source'],sha256=source['sha256'],frames=9,interval_ms=120,
                    native_effect_loops=False,position_from_widget_rect=[-23,-23],blend='add-and-saturate RGB565/555'),
        changes=['Wheel belongs to active SET categories/candidates/confirmation, never the exited action layer.',
                 'Slot commits once, resets effect frame zero, clears pending scratch, then plays source light.',
                 'Candidate navigation remains available; Escape/header/page/close clear animation and stale confirmations.'],
        existing_fonts_unchanged=True,font_character_count=len(charset),font_source_fingerprints=font_sources,
        limitations=['Source global timer first-frame phase is not synchronized to the browser local timer.',
                     'CSS plus-lighter uses8bit channels; source adds/saturates quantized RGB565/555.',
                     'The DGP loop flag is overridden by the native frame-count stop.']),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    current=sorted(p for p in WEB.rglob('*') if p.is_file() and p.suffix in {'.mjs','.js','.css','.html','.json'})
    current+=sorted((RUNTIME/'tests').glob('test_*.mjs'))
    current += [Path(__file__),RUNTIME/'tools/verify_current.py',RUNTIME/'tools/build_runtime.py',
                ROOT/'README.md', *[RUNTIME.parent/name for name in ['assessment/validation_design.md','runtime/architecture.md','runtime/config_guide.md','runtime/tools/README.md']]]
    evidence=sorted(p for p in CASES.iterdir() if p.suffix in {'.json','.jpg','.png'})
    evidence += [native_path,cached_native_path,audit_path,fixture_path,EVIDENCE/'menu_technique_export_20261013.json',
                 *[WEB/frame for frame in source['frames']]]
    report=dict(schema='seventh-seal-technique-replace-browser-validation',version=1,
        checked_utc=datetime.now(timezone.utc).isoformat(),passed=True,checks=checks,cases=len(cases),
        observation_path=(CASES/'browser_observation.json').relative_to(ROOT).as_posix(),
        observation_sha256=sha(CASES/'browser_observation.json'),
        current_fingerprints={p.relative_to(ROOT).as_posix():sha(p) for p in current},
        evidence_fingerprints={p.relative_to(ROOT).as_posix():sha(p) for p in evidence},
        screenshot=(CASES/'replacement-light-frame.jpg').relative_to(ROOT).as_posix(),
        actual_browser_flow_checked_this_run=False,original_game_execution_observed=False,
        limits=observation['limits']+['This verifier checks retained actual UI observations and exports; it does not replay them.'])
    REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'passed':True,'checks':len(checks),'cases':len(cases)}))

if __name__=='__main__':
    main()
