"""Read-only original victory report export, isolated from historical HUD assets.

Original resources and retained evidence are inputs only.  Native findings are
static observations; this exporter does not execute GAME.exe or claim a replay.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_battle_ui as ui
from export_skill_layers import SourceAudit

ROOT, RUNTIME, WEB = ui.ROOT, ui.RUNTIME, ui.WEB
OUT = WEB / 'assets/battle_result'
EVIDENCE = RUNTIME / 'evidence/battle_result_20261020'
GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, data):
    assert path.resolve().is_relative_to(RUNTIME.resolve())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=True, indent=2) + '\n', 'utf-8')


def main():
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    bundle_path = EVIDENCE / 'native_evidence.json'
    bundle = json.loads(bundle_path.read_text('utf-8'))
    records = bundle['records']
    assert all(r['subject']['digest']['sha256'] == GAME_SHA for r in records)

    def evidence(procedure, operation='procedure_pseudo_code'):
        found = [r for r in records if r.get('operation') == operation and
                 r.get('parameters', {}).get('procedure', '').lower() == procedure]
        assert found, (procedure, operation)
        return found[0]['evidence_id']

    refs = {name: evidence(address, operation) for name, address, operation in [
        ('settlement_entry', '0x50d1c0', 'procedure_pseudo_code'),
        ('load_report', '0x50b9a0', 'procedure_pseudo_code'),
        ('counter_enqueue', '0x50bed0', 'procedure_pseudo_code'),
        ('notification_enqueue', '0x50bb50', 'procedure_pseudo_code'),
        ('notification_advance', '0x50bd20', 'procedure_pseudo_code'),
        ('notification_pending', '0x50be40', 'procedure_assembly'),
        ('draw', '0x50d450', 'procedure_assembly'),
        ('advance', '0x50db70', 'procedure_assembly'),
        ('counter_finish', '0x50e070', 'procedure_pseudo_code'),
        ('press', '0x50e280', 'procedure_assembly'),
        ('release', '0x50e240', 'procedure_pseudo_code'),
        ('input_messages', '0x50b340', 'procedure_assembly'),
        ('masked_dispatch', '0x52ae7f', 'procedure_assembly'),
        ('masked_draw', '0x529924', 'procedure_assembly'),
        ('skill_settle', '0x50c560', 'procedure_assembly'),
        ('skill_level', '0x50c000', 'procedure_assembly'),
        ('skill_requirements', '0x50c4c0', 'procedure_assembly'),
        ('skill_practice', '0x501b70', 'procedure_assembly'),
        ('single_practice_caller', '0x501cc0', 'procedure_assembly'),
        ('combo_practice_caller', '0x501e90', 'procedure_pseudo_code'),
        ('party_copy', '0x4fe7e0', 'procedure_assembly'),
        ('money_text', '0x50d3a0', 'procedure_pseudo_code'),
    ]}
    sources = ['GAME.exe', 'SYSTEM/Fight_Report.mnu', 'SYSTEM/Fight_Report.CAP',
               'Fight_Role/combo/Fight_Report_01.dgp',
               'Fight_Role/combo/Fight_Report_02.dgp', 'Fight_Role/Effect/victor.dgp',
               'sound/victorb1.wav']
    before = {p: sha((ROOT / p).read_bytes()) for p in sources}
    assert before['GAME.exe'] == GAME_SHA
    ui.OUT = OUT
    menu = ui.menu(ROOT / sources[1])
    assets, audits = {}, {}
    for source in sources[3:6]:
        item = ui.dgp(ROOT / source)
        decoder = ui.DGP(ROOT / source)
        audit = SourceAudit(decoder.data)
        assert (audit.width, audit.height, audit.count) == (decoder.width, decoder.height, decoder.frame_count)
        frame_checks = []
        for frame in item['frames']:
            index = frame['index']
            original, checked = audit.sparse(index, False)
            with Image.open(WEB / frame['image']) as png:
                assert png.convert('RGBA').tobytes() == original
            check = dict(index=index, main=checked)
            if 'indexed_image' in frame:
                original_indexed, checked_indexed = audit.sparse(index, True)
                with Image.open(WEB / frame['indexed_image']) as png:
                    assert png.convert('RGBA').tobytes() == original_indexed
                check['indexed'] = checked_indexed
            frame['render_image'] = frame.get('inverse_mask_image', frame['image'])
            frame['width'], frame['height'] = item['width'], item['height']
            frame_checks.append(check)
        item['rendering'] = dict(primary_blend='source-over', indexed_blend='plus-lighter',
            mask_rule='Canvas alpha=(255-source_mask)/255; source native RGB565 lookup rounding remains an explicit adapter.',
            evidence=[refs['draw'], refs['masked_dispatch'], refs['masked_draw']])
        assets[item['id']] = item
        audits[item['id']] = dict(passed=True, source=source, source_sha256=item['source_sha256'],
                                 frames=frame_checks)

    raw_sound = (ROOT / 'sound/victorb1.wav').read_bytes()
    assert raw_sound[:2] == b'\xff\xfb'
    sound_path = OUT / 'audio/victorb1.mp3'
    sound_path.parent.mkdir(parents=True, exist_ok=True)
    sound_path.write_bytes(raw_sound)
    action = bytes.fromhex(assets['victor']['actions'][0]['raw_hex'])
    token = action[0x56:0x6a].split(b'\0')[0].decode('ascii')
    assert token == 'victorb1.wav'
    sound = dict(embedded_victor_action=dict(path='/' + sound_path.relative_to(WEB).as_posix(),
        mime='audio/mpeg', sha256=sha(raw_sound), source='sound/victorb1.wav',
        source_sha256=before['sound/victorb1.wav'], source_action_offset=0x43,
        source_sound_field_offset=0x56, source_logical_frame_offset=0x6a,
        logical_frame=struct.unpack_from('<I', action, 0x6a)[0], token=token,
        authority='source DGP action field only',
        limitation='Result update/draw routines do not explicitly dispatch this sound. Original victory sound playback was not observed; autoplay is a renderer adapter, not a native playback claim.'))
    font_record = ui.pe_data(0x670930, 12)
    font_record['encoding'] = 'cp950 (Big5)'
    source_font_name = bytes.fromhex(font_record['raw_hex']).split(b'\0', 1)[0].decode('cp950')
    assert source_font_name == '\u5168\u771f\u7279\u9ed1\u9ad4'
    layout = dict(
        report=dict(asset='fight_report_01', frame=0, origin=dict(x=0, y=0),
                    source_origin_globals=['0x055ee348', '0x055ee34c'],
                    render_image_field='render_image', evidence=refs['draw']),
        victor=dict(asset='victor', origin=dict(x=0, y=0), indexed_blend='plus-lighter', evidence=refs['draw']),
        text=dict(font=source_font_name, size=18, report_color_rgb565='0xffff',
                  notification_color_rgb='0xffffff', source_font=font_record,
                  limitation='Browser/GDI fallback glyphs are adaptations if the original font is unavailable.'),
        counters=dict(role_name=dict(x=55, y=110, row_step=35, format='%s'),
            role_gain_exp=dict(x=120, y=110, row_step=35, format='%5d'),
            role_next_exp=dict(x=220, y=110, row_step=35, format='%d'),
            money_total=dict(x=112, y=75, format='decimal left-padded with zero to 9 digits'),
            combo_count=dict(x=112, y=251, format='%d'),
            technique_points=dict(x=112, y=320, format='%d'),
            drops=dict(x=90, y=353, row_step=33, items_per_line=4, item_format='%sx%d  '),
            positions_relative_to_report_origin=True, evidence=refs['draw']),
        notifications=dict(asset='fight_report_02', width=175, height=26,
            source_actor_row_formula='actor_index*35+103',
            text_rect_relative=dict(left=20, top=3, right=126, bottom=23), text_alignment='center',
            frames=[dict(index=0, pixel_label='\u4e60\u5f97', pixel_label_raw='\u7fd2\u5f97'),
                    dict(index=1, pixel_label='\u52a0\u4e58', pixel_label_raw='\u52a0\u4e58'),
                    dict(index=2, pixel_label='\u5347\u7ea7', pixel_label_raw='\u5347\u7d1a'),
                    dict(index=3, pixel_label='\u53d6\u5f97', pixel_label_raw='\u53d6\u5f97')],
            actor_type_frame_formula='actor_type<4: frame=(kind!=0); actor_type>=4: frame=actor_type-4',
            text_formula='actor_type<4: skill_index==-1 ? actor_name : skill_name; type6: x%d(value); other>=4: item_name',
            source_item_index_note='50D450 item-name branch uses type payload directly as zero-based index. Preserve raw source record; do not silently reinterpret item IDs.',
            visibility='Active records draw whenever Victor has finished; phase 2 is not required.',
            ordering='Draw insertion order; active earlier records remain. Same actor notifications occupy the same y and later records cover earlier ones.',
            evidence=[refs['notification_enqueue'], refs['draw']]))
    motion = dict(
        victor=dict(clock_ms=60, comparison='elapsed>59', source_frame_sequence='ascending native report frame field',
            dgp_interval_ms=80, native_override=True, evidence=refs['advance']),
        report=dict(initial_x=-630, target_x=0, y=0, initial_dx=120, clock_ms=30,
            update='If x<target, when (step_count&3)!=0 and dx>10: dx-=dx>>2; step_count++; x+=dx. Otherwise clamp x=target and mark slide complete.',
            evidence=[refs['counter_enqueue'], refs['advance']]),
        counters=dict(clock_ms=10, increment=1, all_counters_parallel=True,
            update='For each unfinished record on its clock: displayed_value++; remaining--; player EXP++/NEXT--. At role threshold call 518B60 and enqueue role-level notice. Phase remains1 while any counter unfinished.',
            skip='50E070 consumes all remaining values, loops all earned role levels, and adds each role-level notification.',
            evidence=[refs['advance'], refs['counter_finish']]),
        notifications=dict(initial_x=500, target_x=280, dx=-80, clock_ms=30,
            ordinal='count of all previously enqueued records with same actor/type byte',
            initial_active='ordinal==0',
            advance='Snap active unfinished records to target/done; activate each unfinished record whose ordinal==page+1; increment page once if any were activated.',
            done='Motion completion means x has reached280; it does not erase active records.',
            evidence=[refs['notification_enqueue'], refs['notification_advance'], refs['advance']]))
    input_rules = dict(
        native_messages=dict(press=['WM_KEYDOWN(any key)', 'WM_LBUTTONDOWN', 'WM_RBUTTONDOWN'],
                             release=['WM_KEYUP', 'WM_LBUTTONUP', 'WM_RBUTTONUP'], evidence=refs['input_messages']),
        latch=dict(address='0x055ee73d', reset='release handler50E240',
            limit='50E280 early intro-skip returns before setting this latch. Browser uses Space physical edges uniformly to satisfy the requested no-repeat behavior.', evidence=[refs['press'], refs['release']]),
        phases=[dict(value=1, behavior='Victor not complete: skip Victor only; else force report to target, finish every counter and move to phase2.'),
                dict(value=2, behavior='If any notification is unfinished, advance notification group; otherwise free assets and leave battle result.')],
        final_confirmation='One later press after all notifications are done exits; same press which advances pending records cannot exit.',
        evidence=[refs['press'], refs['notification_pending']],
        browser_adapter='Space keydown physical edge only; ignore repeat, release before next advance.')
    findings = dict(schema='seventh-seal-battle-result-static-findings', version=1,
        authority='read-only shipped-artifact static analysis', original_game_execution_observed=False,
        source_game_sha256=GAME_SHA, evidence=refs, layout=layout, motion=motion, input=input_rules,
        settlement_order=['50B9A0 initialize report', '50CC20 drops and special item notices',
            'each player actor:50C560 skill settlement then enqueue role EXP counter',
            'money/combo/TP counters and type6 bonus notice',
            '50DB70 automatic or50E070 skipped role EXP settlement appends one notice per earned role level'],
        learning=dict(rule='Normal victory newly learned skills are scanned in50C560 only when at least one skill leveled. This precedes role EXP levels. 518B60 and50E070/50DB70 do not add a second role-level learning scan.',
            evidence=[refs['skill_settle'], refs['counter_finish']]),
        practice=dict(rule='Single start calls501B70(actor,1,skillIndex); combo start calls once per resolved component with total component count. No hit test is involved. Practice equals levelWeight[10,8,6,5,4,2,1]*min(componentCount,7), level0 becomes1. 4FE7E0 zeros destination2FF on both battle loading and party writeback, so escaped/test practice does not carry to next fight.',
            evidence=[refs['skill_practice'], refs['single_practice_caller'], refs['combo_practice_caller'], refs['party_copy']]),
        sound=sound,
        limitations=['No original executable gameplay was run or observed.',
            'Static reported coordinates and message gates are source facts; browser frame scheduling and font fallback remain adapters.',
            'RGB565 masked blending and indexed additive layers are represented in Canvas 8-bit color; native per-channel LUT rounding is not reproduced.',
            'Fight_Report.mnu is preserved as a source menu but the confirmed battle renderer uses the DGP plate; MNU presence alone does not establish a battle draw caller.',
            'Embedded victory sound token is preserved without claiming original playback.'])
    manifest = dict(schema='seventh-seal-battle-result', version=1,
        native_canvas=dict(width=640, height=480), menus=[menu], assets=assets,
        layout=layout, motion=motion, input=input_rules, sound=sound,
        source_hashes=before, evidence=refs, native_bundle=bundle_path.relative_to(RUNTIME).as_posix(),
        native_bundle_sha256=sha(bundle_path.read_bytes()),
        findings='evidence/battle_result_20261020/findings.json',
        original_game_execution_observed=False, limitations=findings['limitations'])
    assert before == {p: sha((ROOT / p).read_bytes()) for p in sources}
    manifest['original_inputs_unchanged'] = True
    save(EVIDENCE / 'findings.json', findings)
    save(WEB / 'data/battle_result.json', manifest)
    save(EVIDENCE / 'source_frame_audit.json', dict(passed=True, assets=audits,
        mask_audit='All raw mask planes are byte-preserved with source offsets and hashes; inverse-mask candidates roundtrip exactly.',
        original_game_execution_observed=False))
    outputs = {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in sorted(OUT.rglob('*.png'))}
    for p in [sound_path, WEB/'data/battle_result.json', EVIDENCE/'findings.json', EVIDENCE/'source_frame_audit.json']:
        outputs[p.relative_to(ROOT).as_posix()] = sha(p.read_bytes())
    report = dict(passed=True, source_hashes=before, output_hashes=outputs,
        native_bundle_sha256=sha(bundle_path.read_bytes()), mnu_images=len(menu['images']),
        dgp_frames=sum(a['frame_count'] for a in assets.values()),
        independent_source_frames_verified=True, secondary_streams_verified=True,
        png_roundtrip_verified=True, original_inputs_unchanged=True,
        original_game_execution_observed=False)
    save(EVIDENCE/'export.json', report)
    print(json.dumps({k:report[k] for k in ['passed','mnu_images','dgp_frames','original_inputs_unchanged']}))


if __name__ == '__main__':
    main()
