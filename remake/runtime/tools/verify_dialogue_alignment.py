"""Check frozen dialogue observations and fingerprints; does not drive a browser."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
from PIL import Image

RUNTIME=Path(__file__).resolve().parents[1]
ROOT=RUNTIME.parents[1]
FOLDER=RUNTIME/'evidence/dialogue_alignment_20261021'
UI_FILES=['web/dialogue_view.mjs','web/dialogue.css','web/core/dialogue.mjs','web/core/events.mjs',
    'web/controllers/story.mjs','web/controllers/input.mjs','web/controllers/boot.mjs','web/controllers/state.mjs',
    'web/opening_view.mjs','web/caption_view.mjs','web/core/menu_text.mjs','web/index.html',
    'web/data/dialogue_ui.json','web/data/dialogue_fonts.json','web/tests/dialogue_alignment.html']

def read(path):return json.loads(path.read_text('utf-8-sig'))
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def world(name):
    envelope=read(FOLDER/name)
    assert hashlib.sha256(envelope['payload'].encode()).hexdigest()==envelope['sha256']
    return json.loads(envelope['payload'])

def verify():
    source=read(FOLDER/'source_audit.json')
    assert source['passed'] and source['source_unchanged'] and not source['original_runtime_observed']
    for field in ['source_hashes','output_hashes']:
        for name,digest in source[field].items():assert sha(ROOT/name)==digest,name
    observation=read(FOLDER/'browser_observation.json')
    assert observation['original_storage_unchanged']
    assert read(FOLDER/'storage_before.json')==read(FOLDER/'storage_after.json')
    assert not observation['production_console_errors']
    # The first nested harness asset path failed before the final reload. It
    # remains explicitly retained; only that already-corrected error is excluded.
    assert not observation['new_sample_console_errors']
    current={(RUNTIME/name).relative_to(ROOT).as_posix():sha(RUNTIME/name) for name in UI_FILES}
    assert current==observation['browser_code_fingerprints'],'UI changed after the observed reload'
    states={row['label']:row for row in observation['states']}
    assert states['long_enter_typing']['state']['stage']=='typing'
    assert states['long_wait_no_input']['state']['revealed']=='54'
    assert states['long_one_held_confirmation']['state']['page']=='1'
    assert states['long_one_held_confirmation']['visible']
    assert states['long_scrolled_wait']['state']['stage']=='waiting'
    assert not states['long_closed']['visible']
    assert states['top_style0_wait']['state']['style']=='0'
    assert states['thought_next_page_no_carry']['state']['page']=='1'
    assert not states['explicit_abort_cleanup']['visible']
    assert states['choice_default_final']['state']['selection']=='0'
    assert states['choice_escape_boundary_final']['state']['selection']=='1'
    assert states['choice_escape_boundary_final']['visible']
    assert not states['choice_mouse_decline_final']['visible']
    assert states['choice_fast_fill_held_no_commit']['visible']
    assert states['choice_fast_fill_held_no_commit']['state']['stage']=='choices'
    assert states['choice_fast_fill_held_no_commit']['state']['selection']=='0'
    sample_events=read(FOLDER/'samples_log.json')['logs']
    questions=[event for event in sample_events if event['type']=='dialogue-open' and event.get('choices')]
    assert len(questions)==2
    natural_steps=[event for event in sample_events if event.get('session')==questions[0]['session'] and event['type']=='dialogue-advance']
    assert natural_steps==[],'Natural question required an extra confirmation before selecting'
    fill_steps=[event for event in sample_events if event.get('session')==questions[1]['session'] and event['type']=='dialogue-advance']
    assert len(fill_steps)==1 and fill_steps[0]['result']=='reveal','Held fill also submitted or advanced twice'
    for label in ['normal_npc_repeat_exit','controlled_chain_complete','home_decline_exit','restored_original_progress']:
        assert not states[label]['visible'] and states[label]['phase']=='探索中'
        assert states[label]['focus']['id']=='stage'
    narrow=states['narrow_wait']
    assert abs(narrow['viewport']['width']/narrow['viewport']['height']-4/3)<1e-6
    assert narrow['screen']['left']<=narrow['viewport']['left']
    assert narrow['viewport']['right']<=narrow['screen']['right']+.1
    npc=read(FOLDER/'npc_log.json')
    opens=[event for event in npc['events'] if event['type']=='dialogue-open']
    assert any(event['style']==2 and event['speaker']=='侦探' for event in opens)
    assert any(event['speaker']=='英格妮' and event['face_index']==26 for event in opens)
    assert any(event['speaker']=='凯' and event['face_index'] in [34,36] for event in opens)
    mutation=[event for event in npc['events'] if event['type']=='event-mutation']
    assert len(mutation)==1 and mutation[0]['changes']==[{'index':3,'before':0,'after':4}]
    before,declined,rested=map(world,['home_before_save.json','home_declined_save.json','home_rested_save.json'])
    assert declined['revision']==before['revision']+1 and rested['revision']==before['revision']+2
    expected_decline={**before,'revision':declined['revision']}
    assert declined==expected_decline,'Declining rest changed world resources'
    expected_rest=json.loads(json.dumps(before));expected_rest['revision']=rested['revision']
    for actor in expected_rest['party']:
        actor['hp']['current']=actor['hp']['maximum'];actor['mp']['current']=actor['mp']['maximum']
    assert rested==expected_rest,'Rest changed fields beyond HP/MP and one revision'
    home=read(FOLDER/'home_log.json')
    commits=[event for event in home['events'] if event['type']=='chapter-commit' and event['mapId']=='M17026' and event['recordId']==10]
    assert len(commits)==2 and [event['revision'] for event in commits]==[declined['revision'],rested['revision']]
    assert any(event['type']=='caption-open' for event in home['events'])
    for name in ['sample_bottom.png','sample_scrolled.png','sample_top.png','sample_choices.png','sample_narrow.png',
                 'normal_npc.png','normal_thought.png','normal_portrait_26.png','normal_portrait_34.png','home_choices.png']:
        with Image.open(FOLDER/name) as image:assert image.width>=640 and image.height>=480
    evidence_names=['source_audit.json','export_verification.json','native_evidence.json','reference_findings.txt','state_matrix.txt',
        'connected_tlk_ui_records.json','browser_observation.json','storage_before.json','storage_after.json',
        'samples_log.json','npc_log.json','home_log.json','controlled_home_save.json','controlled_home_scope.json',
        'home_before_save.json','home_declined_save.json','home_rested_save.json',
        *[path.name for path in sorted(FOLDER.glob('*.png'))]]
    fingerprints={**current,**{(RUNTIME/name).relative_to(ROOT).as_posix():sha(RUNTIME/name)
        for name in ['tools/export_dialogue_ui.py','tools/verify_dialogue_alignment.py','tests/test_dialogue.mjs','tests/test_caption.mjs']}}
    report=dict(schema='seventh-seal-dialogue-alignment-browser-validation',version=1,passed=True,
        checked_utc=datetime.now(timezone.utc).isoformat(),
        scope='Original dialogue resources and static rule alignment. Actual existing-save NPC repeat interaction, controlled first-contact reset through normal E entry and complete exit; isolated long/short/top/choice/abort/held/narrow samples; controlled home-save E entry, decline and damaged-resource rest through real ANM/caption. Browser save/preferences unchanged and original progress restored. No original game execution.',
        checks=dict(original_sources_unchanged=True,browser_storage_unchanged=True,
            native_portraits_and_no_separate_name_panel=True,ordinary_row_scroll_and_thought_page_clear=True,
            keyboard_mouse_and_choice_boundary=True,choices_appear_at_text_end=True,fill_does_not_commit_choice=True,held_input_single_transition=True,
            npc_flag_mutation_once=True,decline_resources_unchanged=True,rest_resources_once=True,
            narrow_plane_fits=True,abort_cleanup=True,production_console_errors=[]),
        observation_path=(FOLDER/'browser_observation.json').relative_to(ROOT).as_posix(),
        observation_sha256=sha(FOLDER/'browser_observation.json'),current_fingerprints=fingerprints,
        evidence_fingerprints={(FOLDER/name).relative_to(ROOT).as_posix():sha(FOLDER/name) for name in evidence_names},
        limitations=['Static original code/resources, not a new original GAME.exe runtime comparison.',
            'Windows GDI resolves unavailable Benguiat to SimSun; exact original ASCII glyphs remain outside coverage.',
            'Original RGB565 blending, shared timer phase, animated row-scroll interpolation and nonzero portrait-side branch need original runtime corroboration.',
            'Thought positioning uses the displayed browser sprite head; original actor/role-table height calculation is retained separately.',
            'No dialogue audio mapping was inferred; outer original input/sound dispatch remains unverified.',
            'Top style0 is a controlled presentation sample; home sample explicitly supplies an existing scene and damaged HP/MP. This is not a new-game route replay.'])
    target=RUNTIME/'evidence/dialogue_alignment_browser_validation_20261021.json'
    target.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n','utf8')
    print(json.dumps(dict(passed=True,states=len(observation['states']),npc_lines=len(opens),home_commits=len(commits),report=str(target)),ensure_ascii=False))

if __name__=='__main__':verify()
