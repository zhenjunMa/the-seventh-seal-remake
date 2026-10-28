"""Read-only entry, death and revival source export, isolated from old banks.

Never rewrites party_battle_view/reactions or their historical evidence. The
controller selects native skill indices; this manifest preserves source order,
including entry command7 and Kai's reverse-then-forward frame records.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME/'web'
OUT = WEB/'assets/battle_lifecycle'
EVIDENCE = RUNTIME/'evidence/battle_lifecycle_20261015'
sys.path.insert(0,str(ROOT/'remake/runtime/tools'))
from incremental import resource, recipe_hash, write_json, save_png
from PIL import Image
from source.combat_resources import CHR, GAME_SHA256
from source.dgp import DGP
from export_combat_presentation import indexed_contribution, native_frame_sequence, NATIVE_IDS
from export_skill_layers import SourceAudit
from export_party_skills import source_skill
from content_registration import registration,role_ids

ROLE_IDS = role_ids()
EFFECT_IDS = ('_iRelife',)
NATIVE = {
 'entry':('remake/runtime/evidence/equipment_speed_native.json','ev_058f6553bdbe4702f6c550168a98b6dc64a09c8af9b303cee8aa51e1f55f7695'),
 'death':('remake/runtime/evidence/forest_death_reactions_native_20261011.json','ev_427d6fcc14c2ce2f41ff99c7b65d9a0ded4cedf3252c2fc0512bb1c36e8b134d'),
 'grounded_death':('remake/runtime/evidence/forest_death_reactions_native_20261011.json','ev_dfd502e36e42d3d86b939d5ecc57e456ccf15f5d452b93d72d9e43a30794c2d9'),
 'lookup':('remake/runtime/evidence/source/combat_presentation_native_20261011.json','ev_d636f80d05fddd079b3b8371cbdedeef740f86ef6bc272e85186578555918c41'),
 'command7':('remake/runtime/evidence/party_magic_native.json','ev_6a97d55ce2cda38f5a9cacf245900414d96566b052c7e04fb96bac9a431a6764'),
 'effect_carrier':('remake/runtime/evidence/party_magic_native.json','ev_c9bbdef1c8377c5cb768f67c055aa4189564ec176aa68cd9b38b398e47bb0b9b'),
 'renderer_clear':('remake/runtime/evidence/forest_stage_native.json','ev_5b7111bef94d84d0b13d5977a201ad2d9595de8a70f9458dc568aeb20865f72f'),
 'source_clock':('remake/runtime/evidence/forest_scheduler_native_20261011.json','ev_8e3ec5a4b14b1aa3628f2b1ea4e90e43ca550b15e065c57deac7a65f003216b5'),
 'sprite_effect_gate':('remake/runtime/evidence/source/combat_animation_native_20261011.json','ev_15074ba1e716dbee5de449c6c18c8af0dfb570150803f5138f7f9fe4991fe96f'),
 'after_source':('remake/runtime/evidence/forest_scheduler_native_20261011.json','ev_17c4b3199dc1b5cb6278ffab2686449d8098e5784dd2ff814a562d148b7ddea0'),
 'return_motion':('remake/runtime/evidence/fire_valley_20261025/vertical_519fa0_assembly.json','ev_f85520dace8aea1bc83b2b93d1098640e01cbd89689b5eaeb66d0326f390cb9b'),
 'idle_tail':('remake/runtime/evidence/fire_valley_20261025/vertical_519dd0_assembly.json','ev_21a9d5bdd4837f53c97499ff0f4005b8539e84c51c0509e1cb7d63cf629db951'),
 'appearance6':('remake/runtime/evidence/jade_lake_battle_20261028/appearance_native.json','ev_8d1e6359dcc6439fb3d4d925aa51d3c868ecbd9c53d837cd6140d28d90f316b8'),
 'appearance6_init':('remake/runtime/evidence/jade_lake_battle_20261028/appearance_native.json','ev_8402cb5bbc62277bfb9e80aca1ce2177f2f1c89dd20a52b7d39dcb550d6489a2'),
 'appearance7':('remake/runtime/evidence/jade_lake_battle_20261028/appearance_native.json','ev_c4e9cb6e69308d406fe7e93580d29694082c835e56d2030a38f2959ea1d9eff6'),
}
RENDERER_BUNDLE=RUNTIME/'evidence/battle_lifecycle_renderer_native_20261015.json'
RENDERER_FINDINGS=EVIDENCE/'renderer_static_findings.json'
FAILURE_FINDINGS=EVIDENCE/'missing_effect_static_findings.json'
FAILURE_RECORDS=EVIDENCE/'missing_effect_native_retained.json'


def source_findings(path):
    value=json.loads(path.read_text('utf-8'))
    if value['game_sha256']!=GAME_SHA256:
        raise ValueError('Lifecycle findings belong to another executable')
    return value


def evidence_file(path):
    return dict(path=path.relative_to(RUNTIME).as_posix(),sha256=sha(path.read_bytes()))


def renderer_rules():
    findings=source_findings(RENDERER_FINDINGS)
    return dict(native_bundle=evidence_file(RENDERER_BUNDLE),findings=evidence_file(RENDERER_FINDINGS),
        appearance=dict(clock_interval_ms=60,clock_address='0x0521a7b1',mode_address='0x0521f666',
            elapsed_address='0x0521f66e',clock_evidence=NATIVE['source_clock'][1],
            sprite_progression_gate='51A4F0 pauses subsequent sprite advancement while appearance or death effect mode is nonzero.',
            sprite_gate_evidence=NATIVE['sprite_effect_gate'][1],
            mode1=findings['appearance_mode1'],mode5=findings['appearance_mode5'],
            mode6=dict(callee='0x552039',initializer='0x551f03',step_per_render=8,
                initial_coefficient='minOpaquePixelX - scaledPixelX',target_coefficient=255,
                completion='max(1, ceil((255 + maxOpaquePixelX - minOpaquePixelX) / 8)) actual render calls after last elapsed0 initialization; empty frame completes in1 call',
                evidence=[NATIVE['appearance6'][1],NATIVE['appearance6_init'][1]],
                limit='Source main pixels without an opacity plane; RGB16 interpolation uses the existing alpha presentation adapter.'),
            mode7=dict(callee='0x552437',completion_expression='signed(240 - elapsed * 6) < 11',
                first_nonnegative_elapsed_returning_zero=39,evidence=NATIVE['appearance7'][1]),
            mode0=dict(selector=[1,5,7],rng_rule='one native rand modulo3 at command7 execution',evidence=NATIVE['command7'][1]),
            one_to_one_source_pixel_geometry=findings['source_pixel_geometry'],
            renderer_clear_rule='Source stage renderer clears appearance mode, immune gate and source action clock only when552642 returns0.',
            renderer_clear_evidence=NATIVE['renderer_clear'][1]),
        death=dict(clock_interval_ms=220,clock_address='0x0521a7b1',
            mode_formula='native RNG modulo7 plus1',mode_address='0x0521f66a',elapsed_address='0x0521f66e',
            dispatcher=findings['death_dispatch'],
            renderer_clear_rule='When555D65 returns0, source stage renderer clears death effect mode, marks immune1 and state7.',
            renderer_clear_evidence=NATIVE['renderer_clear'][1]),
        limits=['Completion arithmetic is source-bound; exact scene projection, RGB565 interpolation and native render cadence are not reproduced here.',
            'Appearance60 and death220 are source clock intervals, not total effect durations.',
            'Death mode1..7 have a hard elapsed ceiling30 and may return0 earlier when their per-pixel active flag is zero.'])


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save_json(path,value):
    if not path.resolve().is_relative_to(RUNTIME):
        raise ValueError('Lifecycle outputs must remain inside runtime')
    write_json(path,value)


def save_image(path,image):
    path.parent.mkdir(parents=True,exist_ok=True)
    save_png(image,path)
    with Image.open(path) as stored:
        if stored.convert('RGBA').tobytes()!=image.convert('RGBA').tobytes():
            raise ValueError('Lifecycle PNG roundtrip differs')
    return dict(path=path.relative_to(WEB).as_posix(),sha256=sha(path.read_bytes()),width=image.width,height=image.height)


def retained_native():
    records=[]
    for topic,(name,ident) in NATIVE.items():
        path=ROOT/name
        bundle=json.loads(path.read_text('utf-8'))
        record=next(r for r in (bundle['records'] if 'records' in bundle else [bundle]) if r.get('evidence_id')==ident)
        if record['subject']['digest']['sha256']!=GAME_SHA256:
            raise ValueError('Retained lifecycle evidence belongs to another executable')
        records.append(dict(topic=topic,retained_from=name,retained_file_sha256=sha(path.read_bytes()),record=record))
    target=EVIDENCE/'native_retained.json'
    save_json(target,dict(schema='seventh-seal-lifecycle-retained-native',version=1,
        evidence_type='historical-native-static-retained',game_sha256=GAME_SHA256,
        rea_analysis_rerun_this_export=False,original_game_execution_observed=False,records=records,
        limits=['Records are copied verbatim from existing source-bound REA evidence.',
            'This exporter neither executes the original game nor invokes a new analyzer.',
            'Appearance modes5/6 use source pixel completion with an alpha adapter; renderer wall-clock correspondence remains separate rendering work.']))
    return dict(path=target.relative_to(RUNTIME).as_posix(),sha256=sha(target.read_bytes()))


def export_sequence(c,d,skill):
    segments=[]
    commands=[]
    timeline=[]
    ordered=[]
    records=[]
    for entry in skill['actions']:
        raw=bytes.fromhex(entry['raw_hex'])
        group=struct.unpack_from('<I',raw,1)[0]
        source=dict(path=c.path.relative_to(ROOT).as_posix(),sha256=c.sha256,
            offset=entry['offset'],bytes=len(raw),record_sha256=sha(raw),raw_hex=raw.hex())
        if raw[0]==0:
            start,end=struct.unpack_from('<II',raw,0x26)
            frames=native_frame_sequence(d.raw_actions[group],start,end,raw[0x1d],total_frames=d.frame_count)
            segment=dict(chr_record_index=entry['index'],action_index=group,source=source,
                start=start,end_exclusive=end,reverse_raw=raw[0x1d],frames=frames,
                interval_raw=d.actions[group]['interval_raw'],
                movement_step_raw=struct.unpack_from('<i',raw,0x1e)[0],movement_flag_raw=raw[0x25],
                source_skill_index=skill['index'],evidence=[NATIVE_IDS['range'],NATIVE_IDS['range_pseudo']])
            segment.update(raw_hex=raw.hex(),effects=[],event=None)
            if not frames:
                raise ValueError('Lifecycle source contains an empty sprite segment')
            segments.append(segment)
            ordered.append(dict(kind='sprite',segment_index=len(segments)-1,chr_record_index=entry['index']))
            records.append(dict(type_raw=0,chr_record_index=entry['index'],action_index=group,
                frames=[d.actions[group]['first_frame']+f for f in frames],action_frames=frames,
                interval_ms=segment['interval_raw'],reverse_raw=raw[0x1d],source=source))
            for frame in frames:
                timeline.append(dict(kind='sprite',chr_record_index=entry['index'],action_index=group,
                    action_frame=frame,source_frame=d.actions[group]['first_frame']+frame,
                    interval_raw=segment['interval_raw'],raw_hex=raw.hex(),source=source))
        elif raw[0]==1:
            if group not in (0,3,4,6,7,11):
                raise ValueError(f'Uncovered lifecycle command {group}; preserve before implementing')
            command=dict(chr_record_index=entry['index'],type_raw=1,command_raw=group,
                mode_raw_0x47=raw[0x47],u32_at_0x05=struct.unpack_from('<I',raw,5)[0],source=source,
                raw_hex=raw.hex(),immediate=group!=4 or not raw[0x1d])
            if group==3:
                command.update(
                    vertical_speed_raw=struct.unpack_from('<I',raw,5)[0],
                    vertical_height_multiplier_raw=struct.unpack_from('<I',raw,0x1e)[0],
                    vertical_mode_raw=raw[0x47],
                    vertical_wait_raw=raw[0x1d],vertical_acceleration_raw=raw[0x23],
                    semantics='5130D0 case3 initializes the independent native vertical clock; preserve source wait and both original command records.',
                    evidence=NATIVE['command7'][1])
            elif group==7:
                command.update(
                semantics='5130D0 case7: F666=byte+0x47; when zero select [1,5,7] using native RNG; F66E=0; A7B1=60.',
                appearance_fields=dict(mode_address='0x0521f666',elapsed_address='0x0521f66e',clock_address='0x0521a7b1',clock_raw=60),
                evidence=NATIVE['command7'][1],
                renderer_rules_reference='renderer_rules.appearance',
                limit='Preserve its exact source position. Active appearance pauses subsequent sprite advancement; completion follows the renderer, not a fixed60-tick duration.')
            elif group==4:
                token=raw[9:29].split(b'\0')[0].decode('ascii')
                path=ROOT/'Fight_Role/Effect'/token
                start,end=struct.unpack_from('<II',raw,0x26)
                command.update(effect_asset_id=Path(token).stem,source_filename=token,
                    wait_raw=raw[0x1d],slot='target' if raw[0x22] else 'actor',
                    start=start,end_exclusive=end,event=dict(frame=struct.unpack_from('<I',raw,0x49)[0],field='0x49') if raw[0x49] else None,
                    missing_source_file=not path.is_file(),evidence=NATIVE['effect_carrier'][1])
                if path.is_file():
                    effect=DGP(path)
                    end=end or effect.frame_count
                    command.update(frames=native_frame_sequence(effect.raw_actions[0],start,end,0),
                        interval_raw=effect.actions[0]['interval_raw'],end_exclusive=end)
                else:
                    failure=source_findings(FAILURE_FINDINGS)
                    command.update(frames=[],source_failure_rule=failure['native_failure_rule'],
                        source_failure_evidence=evidence_file(FAILURE_FINDINGS),
                        limit='Original literal file is absent. The source loader-failure branch creates no carrier or new wait and returns to normal CHR record advancement; never substitute a different effect.')
            commands.append(command)
            ordered.append(dict(kind='command',command_index=len(commands)-1,chr_record_index=entry['index']))
            timeline.append(dict(kind='command',command_index=len(commands)-1,chr_record_index=entry['index'],command_raw=group,mode_raw_0x47=raw[0x47],raw_hex=raw.hex(),source=source))
            records.append(dict(command))
        else:
            raise ValueError('Lifecycle source has an unsupported record type')
    sprites=[s for s in timeline if s['kind']=='sprite']
    # Some source entries contain command7 only. 5130D0 keeps the current
    # source pose while its renderer runs; it does not invent an idle record.
    final=sprites[-1] if sprites else None
    source = source_skill(c,skill)
    if bytes.fromhex(skill['fixed_raw_hex'])[0x23c] == 3:
        source['battle_handler'] = 'native-revival'
    return dict(role_id=c.path.stem,chr_skill_index=skill['index'],source_skill_index=skill['index'],
        skill_id_raw=skill['id_raw'],original_id_raw=skill['id_raw'],name=skill['name_cp936'],
        source_skill=source,
        fixed_record_offset=skill['offset'],fixed_raw_hex=skill['fixed_raw_hex'],
        fixed_record_sha256=sha(bytes.fromhex(skill['fixed_raw_hex'])),
        segments=segments,command_effects=commands,terminal_commands=[],ordered_records=ordered,timeline=timeline,records=records,
        source_interval_sum_ms=sum(x['interval_raw'] for x in sprites),
        duration_limit='Sum of source sprite intervals only. Command7 effect progression and native global clock/lifecycle scheduling are not flattened into this duration.',
        last_source_pose=dict(action_index=final['action_index'],action_frame=final['action_frame'],source_frame=final['source_frame']) if final else None,
        last_pose_limit='This is the final source sprite frame. Holding it for a corpse is a presentation policy until final native state/renderer handling is corroborated.')


def lifecycle_skills(character):
    # 51CC00 follows hit/launch through landing, getting up and returning to
    # the original position. Missing source IDs remain absent and use the
    # native lookup/fallback rule; never invent an ID5 for the stage12 boss.
    wanted=(1,2,3,4,5,6,8,10,11,12,14)
    return wanted, [skill for skill in character.skills
        if skill['id_raw'] in wanted or bytes.fromhex(skill['fixed_raw_hex'])[0x23c]==3]


def export_role(ident,checks):
    tools=Path(__file__).parent
    rules=recipe_hash([Path(__file__),tools/'source/dgp.py',tools/'source/combat_resources.py',tools/'export_skill_layers.py',
                       tools/'export_combat_presentation.py',tools/'export_party_skills.py'])
    inputs={suffix:sha((ROOT/f'Fight_Role/{ident}.{suffix}').read_bytes()) for suffix in ('CHR','dgp')}
    inputs['side']=registration()['roles'][ident]['side']
    def produce():
        local_checks=[]
        role=_export_role(ident,local_checks)
        bank=WEB/role['layer_bank']['path'].lstrip('/')
        frames=json.loads(bank.read_text('utf-8'))['frames']
        outputs=[bank,*[WEB/action['sheet'].lstrip('/') for action in role['actions']],
                 *[WEB/pair[layer]['path'] for pair in frames for layer in ('main','intrinsic')]]
        return {'role':role,'checks':local_checks},outputs
    cached=resource(RUNTIME,'lifecycle/role/'+ident,inputs,rules,produce)
    checks.extend(cached['checks'])
    return cached['role']


def _export_role(ident,checks):
    c=CHR(ROOT/f'Fight_Role/{ident}.CHR')
    d=DGP(ROOT/f'Fight_Role/{ident}.dgp')
    if c.parsed_end!=len(c.data):
        raise ValueError('Lifecycle CHR EOF mismatch')
    wanted, selected=lifecycle_skills(c)
    skills=[export_sequence(c,d,skill) for skill in selected]
    by_id={str(n):[s['chr_skill_index'] for s in skills if s['skill_id_raw']==n] for n in wanted}
    used=sorted({s['action_index'] for v in skills for s in v['segments']})
    physical=sorted({d.actions[s['action_index']]['first_frame']+f for v in skills for s in v['segments'] for f in s['frames']})
    audit=SourceAudit(d.data)
    if (audit.width,audit.height,audit.count,audit.anchor)!=(d.width,d.height,d.frame_count,d.anchor_raw):
        raise ValueError('Independent lifecycle source geometry differs')
    frames=[]
    source_images={}
    for frame in physical:
        main=d.decode(frame)
        main_rgba,main_check=audit.sparse(frame,False)
        if d.indexed_auxiliary:
            intrinsic,stats=indexed_contribution(d,frame)
            indexed_rgba,indexed_check=audit.sparse(frame,True)
            indexed_active=bool(d.indexed_auxiliary[frame]['active_raw'])
        else:
            if audit.indexed:
                raise ValueError('Independent lifecycle optional layer presence differs')
            intrinsic=Image.new('RGBA',(d.width,d.height))
            indexed_rgba=bytes(d.width*d.height*4)
            indexed_check=dict(active=False,covered_pixels=0,transparent_pixels=d.width*d.height,
                bounds=None,source_optional_indexed_layer_absent=True)
            indexed_active=False
        if main.tobytes()!=main_rgba or intrinsic.tobytes()!=indexed_rgba:
            raise ValueError('Independent lifecycle pixel audit differs')
        prefix=OUT/ident/f'frame_{frame:04}'
        main_record=save_image(Path(str(prefix)+'_main.png'),main)
        indexed_record=save_image(Path(str(prefix)+'_intrinsic.png'),intrinsic)
        indexed_record['active']=indexed_active
        indexed_record['blend']='lighter'
        frames.append(dict(source_frame=frame,main=main_record,intrinsic=indexed_record))
        source_images[frame]=main
        checks.append(dict(role_id=ident,source_frame=frame,main=main_check,indexed=indexed_check))
    actions=[]
    for index in used:
        action=d.actions[index]
        if action['directions']!=1:
            raise ValueError('Lifecycle source has unhandled directions')
        # Atlas only needs source physical group order; ordered CHR reversal
        # and ranges stay in each sequence instead of modifying source pixels.
        referenced=[frame for skill in skills for segment in skill['segments']
                    if segment['action_index']==index for frame in segment['frames']]
        sheet_frames=max(action['frames_per_direction'],max(referenced,default=-1)+1)
        if action['first_frame']+sheet_frames>d.frame_count:
            raise ValueError('Lifecycle atlas leaves the DGP global frame pool')
        sheet=Image.new('RGBA',(d.width*sheet_frames,d.height))
        for frame in range(sheet_frames):
            image=source_images.get(action['first_frame']+frame)
            if image is None:
                image=d.decode(action['first_frame']+frame)
            sheet.paste(image,(frame*d.width,0))
        out=OUT/ident/f'action_{index:02}.png'
        record=save_image(out,sheet)
        actions.append(dict(index=index,sheet='/'+record['path'],sha256=record['sha256'],
            frame_count=sheet_frames,source_frame_count=action['frames_per_direction'],first_frame=action['first_frame'],directions=1,
            interval_raw=action['interval_raw'],native_raw_hex=d.raw_actions[index].hex()))
    layer_file=WEB/f'data/battle_lifecycle_layers_{ident}.json'
    save_json(layer_file,dict(schema='seventh-seal-native-layer-bank',version=1,role_id=ident,
        frame_width=d.width,frame_height=d.height,anchor=dict(x=d.anchor_raw[0],y=d.anchor_raw[1]),
        source_frame_pool_count=d.frame_count,frames=frames,
        source_hashes={f'Fight_Role/{ident}.CHR':c.sha256,f'Fight_Role/{ident}.dgp':d.sha256,'GAME.exe':GAME_SHA256},
        limits=['Layer coverage and pixels are audited independently from original bytes; native game execution is not observed.',
            'Indexed contributions use additive coverage and must composite against the underlying scene.']))
    return dict(id=ident,name=c.name,side=registration()['roles'][ident]['side'],
        frame_width=d.width,frame_height=d.height,anchor=dict(x=d.anchor_raw[0],y=d.anchor_raw[1]),mirror=False,direction=0,
        source_chr=f'Fight_Role/{ident}.CHR',source_chr_sha256=c.sha256,
        source_dgp=f'Fight_Role/{ident}.dgp',source_dgp_sha256=d.sha256,source_frame_pool_count=d.frame_count,
        skills=skills,skill_indices_by_id=by_id,entry_skill_indices=by_id['11'],death_skill_indices=by_id['12'],
        fallback_death_skill_indices=by_id['2'],revive_skill_indices=by_id['14'],actions=actions,
        layer_bank=dict(path='/'+layer_file.relative_to(WEB).as_posix(),sha256=sha(layer_file.read_bytes())),
        death_policy=dict(preferred_id=12,fallback_id=2,has_death_id12=bool(by_id['12']),
            source_rule='4FFE90 prefers id12; without it selects id2 only if current skill id is not 4/2/12. Enemy fade fields are initialized only in the no-selected-skill path, not simultaneously with a selected id2 animation.',
            enemy_fade_fields=dict(clock_raw=220,clock_interval_ms=220,
                fade_mode_raw=None,mode_formula='native RNG modulo7 plus1',mode_address='0x0521f66a',
                elapsed_address='0x0521f66e',mode_selection='Core selects the concrete fade_mode_raw from1..7 through the native RNG.',
                semantics='F66A selects a555D65 disappearance effect; it is not an opacity decrement or speed.',
                renderer_rules_reference='renderer_rules.death'),
            player_corpse_request='Keep the selected death sequence final source pose visible for player corpses; revival changes to the selected id14 sequence. This exporter does not make player corpses fade.',
            evidence=NATIVE['death'][1]),
        eof_verified=True)


def export_effect(ident,checks):
    tools=Path(__file__).parent
    rules=recipe_hash([Path(__file__),tools/'source/dgp.py',tools/'export_skill_layers.py',
                       tools/'export_combat_presentation.py'])
    def produce():
        local_checks=[]
        effect=_export_effect(ident,local_checks)
        return {'effect':effect,'checks':local_checks},[WEB/effect['sheet'].lstrip('/')]
    cached=resource(RUNTIME,'lifecycle/effect/'+ident,
        {'source':sha((ROOT/f'Fight_Role/Effect/{ident}.dgp').read_bytes())},rules,produce)
    checks.extend(cached['checks'])
    return cached['effect']


def _export_effect(ident,checks):
    path=ROOT/f'Fight_Role/Effect/{ident}.dgp'
    d=DGP(path)
    audit=SourceAudit(d.data)
    if len(d.actions)!=1 or d.actions[0]['directions']!=1:
        raise ValueError('Uncovered lifecycle effect geometry')
    main_pixels=sum(n for f in range(d.frame_count) for _,spans in d.rows(f) for _,n,_ in spans)
    if main_pixels:
        raise ValueError('Lifecycle effect has nonempty main pixels; export both layers before using')
    sheet=Image.new('RGBA',(d.width*d.frame_count,d.height))
    for frame in range(d.frame_count):
        image,stats=indexed_contribution(d,frame)
        rgba,check=audit.sparse(frame,True)
        if image.tobytes()!=rgba:
            raise ValueError('Independent lifecycle effect pixel audit differs')
        sheet.paste(image,(frame*d.width,0))
        checks.append(dict(effect_id=ident,source_frame=frame,indexed=check))
    out=OUT/'effects'/ident/'action_00.png'
    image=save_image(out,sheet)
    return dict(id=ident,source=path.relative_to(ROOT).as_posix(),source_sha256=d.sha256,
        frame_width=d.width,frame_height=d.height,frame_count=d.frame_count,
        anchor=dict(x=d.anchor_raw[0],y=d.anchor_raw[1]),sheet='/'+image['path'],sha256=image['sha256'],
        frames=native_frame_sequence(d.raw_actions[0],0,d.frame_count,0),native_raw_hex=d.raw_actions[0].hex(),
        interval_raw=d.actions[0]['interval_raw'],blend='lighter',
        evidence=[NATIVE_IDS['indexed_draw'],NATIVE_IDS['effect_action']],
        primary_covered_pixels=main_pixels,eof_verified=True)


def main():
    originals=['GAME.exe',*[f'Fight_Role/{i}.{suffix}' for i in ROLE_IDS for suffix in ('CHR','dgp')],
        *[f'Fight_Role/Effect/{i}.dgp' for i in EFFECT_IDS]]
    before={p:sha((ROOT/p).read_bytes()) for p in originals}
    if before['GAME.exe']!=GAME_SHA256:
        raise ValueError('Lifecycle executable source differs')
    protected=[WEB/'data/party_battle_view.json',WEB/'data/party_reactions.json',WEB/'data/forest_full_battle_view.json',
        RUNTIME/'evidence/party_skills_export.json',RUNTIME/'evidence/forest_reactions_export_20261011.json',
        *[ROOT/name for name,_ in NATIVE.values()],RENDERER_BUNDLE,RENDERER_FINDINGS,FAILURE_FINDINGS,FAILURE_RECORDS]
    protected_before={p.relative_to(ROOT).as_posix():sha(p.read_bytes()) for p in protected}
    retained=retained_native()
    checks=[]
    roles=[export_role(i,checks) for i in ROLE_IDS]
    effects=[export_effect(i,checks) for i in EFFECT_IDS]
    manifest=dict(schema='seventh-seal-battle-lifecycle',version=2,roles=roles,effects=effects,
        renderer_rules=renderer_rules(),
        missing_effects=[dict(id='m77Rwz01',source='Fight_Role/Effect/m77Rwz01.dgp',
            role_id='001',chr_skill_index=43,chr_record_index=7,
            source_exists=False,substitution_performed=False,
            observations=[dict(path=p.relative_to(ROOT).as_posix(),exists=p.is_file(),
                sha256=sha(p.read_bytes()) if p.is_file() else None) for p in (
                    ROOT/'Fight_Role/Effect/m77Rwz01.dgp',
                    ROOT/'remake/observation/original_window_20261011/game/Fight_Role/Effect/m77Rwz01.dgp',
                    ROOT/'sound/m77rwz01.wav')],
            source_failure_rule=source_findings(FAILURE_FINDINGS)['native_failure_rule'],
            source_failure_evidence=evidence_file(FAILURE_FINDINGS),
            limit='Literal source file does not exist; its similarly named sound file is separate. Static source loader failure creates no carrier/new wait and normal record advancement continues.')],
        source_hashes=before,retained_native=retained,
        policy=dict(selection='Core performs sourceLookup in native roster order and consumes native RNG; view receives the selected chr_skill_index.',
            appearance='Preserve each id11 command7 source mode and cursor. Mode0 draws once from [1,5,7] in the controller; fixed modes consume no RNG. Modes5/6 use source pixel progression, modes1/7 source elapsed thresholds. Command-only entries keep the current pose.',
            timing='Use each DGP action interval_raw for sprite progression; global source clock/effect progression remains distinct.',
            corpse='Source id12 final pose is available. Player corpse hold until revive is the requested presentation behavior, separate from enemy fade.',
            revival='id14 source animation is included for 001/002. HP/state/revival qualification and block150 application belong to the core dispatcher.',
            original_game_execution_observed=False),
        limits=['No original executable, resource, save, old party manifest or historical evidence is edited.',
            'This manifest exports entry/death/revival plus source001 skill43 sequences; no gameplay qualification or input transaction is implemented here.',
            '001 skill43 learned_raw remains zero. Its missing literal m77Rwz01.dgp is retained as a missing-source command and is never substituted.',
            'Command7 source modes0/1/5/6/7 are retained with native fields and executed at their source cursor.',
            'Appearance modes1/5/6/7 completion and death modes1..7 hard ceiling/early-return rules are retained as static renderer evidence.',
            'Native global render cadence, exact appearance/disappearance pixel transforms and RGB565/RGB555 rendering remain outside this pixel export.'])
    dest=WEB/'data/battle_lifecycle.json'
    save_json(dest,manifest)
    if {p:sha((ROOT/p).read_bytes()) for p in originals}!=before:
        raise ValueError('Original lifecycle inputs changed')
    if {p.relative_to(ROOT).as_posix():sha(p.read_bytes()) for p in protected}!=protected_before:
        raise ValueError('Historical lifecycle inputs changed')
    outputs=[dest,*[WEB/f'data/battle_lifecycle_layers_{i}.json' for i in ROLE_IDS],
        *OUT.rglob('*.png'),RUNTIME/retained['path']]
    save_json(EVIDENCE/'export.json',dict(schema='seventh-seal-lifecycle-export-audit',version=1,passed=True,
        source_hashes=before,original_inputs_unchanged=True,protected_inputs_unchanged=True,protected_input_hashes=protected_before,
        output_hashes={p.relative_to(ROOT).as_posix():sha(p.read_bytes()) for p in outputs},
        native_records_retained=True,rea_analysis_rerun=False,original_game_execution_observed=False,
        independent_pixel_audit=True,png_roundtrip_verified=True,checks=checks,
        roles=len(roles),source_sequences=sum(len(r['skills']) for r in roles),physical_frames=len(checks),effects=len(effects)))
    print(json.dumps(dict(passed=True,roles=len(roles),sequences=sum(len(r['skills']) for r in roles),physical_frames=len(checks))))


if __name__=='__main__':
    main()
