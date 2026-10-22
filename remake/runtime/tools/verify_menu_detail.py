"""Check retained menu browser observations; this does not replay the UI."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parent.parent
WEB = RUNTIME / 'web'
EVIDENCE = RUNTIME / 'evidence'

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def world(name):
    return json.loads(read(EVIDENCE / name)['payload'])

def main():
    observation_path = EVIDENCE / 'menu_detail_browser_observation_20261014.json'
    observation = read(observation_path)
    cases = {row['case']: row for row in observation['cases']}
    checks = {}
    def check(name, condition):
        assert condition, name
        checks[name] = True
    check('empty_tail_is_unequip', cases['final-empty-equipment-picker']['candidates'][0]['empty'] == 'true')
    check('escape_cancels_picker', not cases['final-equipment-cancel']['pickerOpen'])
    check('unequip_retains_picker', cases['final-equipment-unequip-keeps-picker']['pickerOpen'] and cases['final-equipment-unequip-keeps-picker']['slots'][1]['label'].endswith('空槽'))
    check('element_comparison_glyphs', cases['final-equipment-preview-elements']['details'] == ['285','  0','  0>50','  0','  0','  0'])
    check('physical_comparison', cases['final-equipment-preview-physical']['details'] == ['  6',' 81',' 42','  2'])
    check('defense_comparison', cases['final-equipment-preview-defense']['details'] == [' 47>55','  0','  0','  0'])
    check('reequip_retains_picker', cases['final-equipment-reequip-keeps-picker']['pickerOpen'] and cases['final-equipment-reequip-keeps-picker']['slots'][1]['label'].endswith('珍珠耳环'))
    grey = cases['final-equipment-grey-crown']
    confirmed = cases['final-equipment-grey-confirm-nochange']
    check('ineligible_candidate_visible_no_commit', grey['candidates'][0]['available'] == 'false' and all(grey[k] == confirmed[k] for k in ['slots','candidates','details']))
    check('four_slot_exchange', [row['label'] for row in cases['formation-swap-empty']['slots']] == ['攻击型：空位','防御型：凯','一般型：空位','一般型：英格妮'])
    check('formation_roundtrip_integer_anchor', [row['left'] for row in cases['formation-roundtrip-integer-anchor']['actors']] == ['50px','135px'])
    check('roster_focus_panel', cases['technique-roster-kai-focus']['actorPanels'][1]['src'].endswith('frame_007.png'))
    check('seven_slot_choices', len([row for row in cases['technique-seven-slot-preview']['buttons'] if row['key'].startswith('slot-')]) == 7)
    check('slot_cancel_restores_candidates', any(row['key'] == 'entry-0-37' and not row['disabled'] for row in cases['technique-slot-cancel']['buttons']))
    check('partial_compose_end_continue', [row['key'] for row in cases['technique-partial-end-continue']['buttons']] == ['compose-end','compose-continue'])
    check('combination_roundtrip_seventh_slot', any(row['key'] == 'slot-6' and row['label'] == '槽7：火炎' for row in cases['technique-roundtrip-combination-seven']['buttons']))
    check('mouse_commit_returns_to_list', cases['technique-mouse-slot-six-commit']['active'] == '火炎' and all(not row['key'].startswith('slot-') for row in cases['technique-mouse-slot-six-commit']['buttons']))
    check('combination_renamed', cases['technique-combination-renamed']['active'] == '风炎')
    check('combination_delete_retains_keyboard', cases['technique-delete-keyboard-focus-recovered']['active'] == '编成技巧')
    check('field_heal_resources', cases['technique-heal-target-before']['text'][3:7] == ['375','968','42','72'] and cases['technique-heal-target-after']['text'][3:7] == ['675','968','36','72'])
    check('item_quantity_target_stays', cases['item-target-after']['targetsVisible'] and cases['item-target-after']['quantityButtonVisible'] and 'MP 72/72' in cases['item-target-after']['targetLabels'][0])
    check('system_channel_ticks_and_crop', [row['raw'] for row in cases['system-three-channels-and-initial-cursor']['volumes']] == ['0','60','60'] and [row['width'] for row in cases['system-three-channels-and-initial-cursor']['volumes']] == ['0px','202px','202px'])
    check('system_ui_preferences_restored', all(cases['system-baseline'][key] == cases['system-restored-baseline'][key] for key in ['volumes','mutes','cursor']))
    check('system_exit_resumes_map', cases['system-exit-and-resume']['returnedToMap'])
    status = cases['final-status-preview-after-all-checks']['data']
    check('status_padded_number_fields', status['values'] == ['11','  968/','968','   72/','72','5950','1500'])
    check('menu_frame_preserves_ratio', abs(status['frame']['width'] / status['frame']['height'] - 4/3) < 1e-8)
    before = read(EVIDENCE / 'menu_detail_previous_save_20261013.json')
    after = read(EVIDENCE / 'menu_detail_previous_save_after_20261014.json')
    check('existing_browser_save_payload_preserved', before['payload'] == after['payload'])
    home = world('chapter_systems_home_save.json')
    edited = world('menu_detail_edited_save_20261014.json')
    deleted = world('menu_detail_deleted_save_20261014.json')
    check('persistent_seventh_combination', edited['formation_slots'] == [None,'002',None,'001'] and edited['technique_bindings']['roles']['001'][6]['type'] == 1 and edited['technique_combinations']['roles']['001'][0]['indices'] == [37])
    check('deletion_repairs_all_duplicate_references', deleted['technique_combinations']['roles']['001'] == [] and all(slot['type'] != 1 for slot in deleted['technique_bindings']['roles']['001']))
    check('editing_preserves_other_world_content', all(home.get(key) == saved.get(key) for saved in [edited,deleted] for key in ['source','party','inventory','equipment','leader_id','money','flags','encounters']))
    check('final_browser_console_clean', not observation['console_errors'])
    current = sorted(path for path in WEB.rglob('*') if path.is_file() and path.suffix in {'.mjs','.js','.css','.html','.json'})
    current += [RUNTIME/'tools'/name for name in ['verify_menu_detail.py','verify_current.py','build_runtime.py','menu_font_recipe.json','export_menu_techniques.py','export_menu_text_gdi.py']]
    evidence = [observation_path, *[EVIDENCE/name for name in [
        'menu_detail_previous_save_20261013.json','menu_detail_previous_save_after_20261014.json','menu_detail_edited_save_20261014.json','menu_detail_deleted_save_20261014.json',
        'menu_equipment_audit_20261013.json','menu_equipment_native_20261013.json','menu_formation_audit_20261013.json','menu_formation_native_20261013.json',
        'menu_technique_audit_20261013.json','menu_technique_native_20261013.json','menu_system_font_audit_20261013.json','menu_system_font_native_20261013.json',
        'menu_text_font_audit_20261013.json','menu_text_font_native_20261013.json','menu_text_font_export_20261014.json','menu_technique_export_20261013.json']]]
    evidence += sorted(path for path in (EVIDENCE/'menu_detail_browser_20261014').glob('*.jpg') if 'before_arrow' not in path.name)
    evidence += sorted(EVIDENCE.glob('original_tab_*_gdi_20261011.png'))
    report = dict(schema='seventh-seal-menu-detail-browser-validation',version=1,checked_utc=datetime.now(timezone.utc).isoformat(),passed=True,
                  observation_path=observation_path.relative_to(ROOT).as_posix(),observation_sha256=sha(observation_path),checks=checks,
                  current_fingerprints={p.relative_to(ROOT).as_posix():sha(p) for p in current},evidence_fingerprints={p.relative_to(ROOT).as_posix():sha(p) for p in evidence},
                  previous_browser_save_payload_sha256=hashlib.sha256(before['payload'].encode()).hexdigest(),
                  screenshot='remake/runtime/evidence/menu_detail_browser_20261014/status-final.jpg',
                  limits=observation['limits']+[
                      'Combination combat execution, test battle resource writeback, crystal editing, positional battle bonuses and proficiency tint remain unimplemented.',
                      'GDI glyph atlases use this machine font resolution; missing native typeface, RGB565 blending, ASCII metrics and exact cursor timing remain bounded.',
                      'Pre-fix mouse slot and delete-focus observations are retained; final corresponding checks and three focused view regressions cover their repairs.',
                      'This report checks the retained observations and fingerprints; it does not replay browser interactions.'])
    (EVIDENCE/'menu_detail_browser_validation_20261014.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'passed':True,'checks':len(checks),'cases':len(observation['cases']),'fingerprints':len(current)},ensure_ascii=True))

if __name__ == '__main__':
    main()
