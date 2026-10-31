"""Export registered player skills, reactions and battle presentation.

Only writes new party outputs. Historical forest manifests, source resources and
the level-12 saved fixture remain immutable. Registration does not unlock skills;
native learning, level and resource gates remain separate from menu bindings.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
sys.path.insert(0, str(ROOT / "remake/runtime/tools"))
from incremental import resource, recipe_hash, write_json, save_png
from PIL import Image
from source.combat_resources import CHR, GAME_SHA256
from source.dgp import DGP
from export_battle_view import sequence
from export_combat_presentation import indexed_contribution, native_frame_sequence, NATIVE_IDS
from export_skill_layers import SourceAudit, save_layer
from content_registration import registration,role_ids,skill_bindings

COMMANDS = {}
FIELD_COMMANDS = {}
RESPONSE_IDS = (1, 2, 3, 9, 12, 18, 19)
EFFECT_LAYER_EVIDENCE = [
    'ev_933340f95b60e313671e7e94cd437e581060c7d1b55e337a07505a4785ea22d9',  # 515FB0 carrier passes
    'ev_8742bac48db84c1a41d0f484e0a65f166747220758a7659523a8940d01f4c32c',  # 54F68B main
    'ev_c650a80b15b29e80c4625d568bdf0ffd867f3c795604430a1bb4ad1cf3fe2f74',  # 54F456 copies main
    'ev_26ca5e077ad2fcdfb6fc3f460728a9f39cd90cda58ba0c38249d09f8b1f9a731',  # 5458CD indexed add
    'ev_7515c2967c274d7710d9bc0107185694d39d193b99f5f69e4996a99cf61fd752',  # 53ECAA shadow
]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def hash_bytes(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text('utf-8'))


def save(path, data):
    assert path.resolve().is_relative_to(RUNTIME)
    write_json(path, data)


def pixel_rules():
    tools = Path(__file__).parent
    return recipe_hash([Path(__file__), tools/'source/dgp.py', tools/'export_skill_layers.py',
                        tools/'export_combat_presentation.py'])


def source_skill(c, s):
    b = bytes.fromhex(s['fixed_raw_hex'])
    actions = []
    for action in s['actions']:
        raw = bytes.fromhex(action['raw_hex'])
        actions.append(dict(index=action['index'], offset=action['offset'], bytes=0xb0,
            type_raw=raw[0], u32_at_0x01_raw=struct.unpack_from('<I', raw, 1)[0],
            duration_ticks_u32_0x01=struct.unpack_from('<I', raw, 1)[0],
            movement_i32_raw_0x1e=struct.unpack_from('<i', raw, 0x1e)[0],
            class_raw=raw[0x24], action_mask_raw=raw[0x78],
            reaction_mode_raw_0x77=raw[0x77],
            reaction_class_raw_0x62=raw[0x62],
            contact_u32_raw_0x49=struct.unpack_from('<I', raw, 0x49)[0],
            raw_hex=raw.hex(), raw_sha256=hash_bytes(raw)))
    mp_delta = struct.unpack_from('<i', b, 0x14f)[0]
    source = dict(path=c.path.relative_to(ROOT).as_posix(), sha256=c.sha256,
                  fixed_record_offset=s['offset'], fixed_bytes=0x41d)
    return dict(id=f'{c.path.stem}_reaction_source_{s["index"]}', actor_id=c.path.stem,
        index=s['index'], original_skill_index=s['index'], original_id_raw=b[0],
        name=s['name_cp936'], fixed_raw_hex=b.hex(), fixed_bytes=0x41d,
        record_sha256=hash_bytes(b), memory_stride_bytes=0x421,
        source_record_offset=s['offset'], source=source,
        learned_raw=b[0x23], combination_code_raw=b[0x19], target_side_raw=b[0x25],
        type_raw=struct.unpack_from('<I', b, 0x32)[0] & 15,
        mp_delta_raw=mp_delta, mp_cost=max(0, -mp_delta),
        charge_i32_0x2e=struct.unpack_from('<i', b, 0x2e)[0],
        type_flags_u32_0x32=struct.unpack_from('<I', b, 0x32)[0],
        class_raw=actions[0]['class_raw'], action_mask_raw=actions[0]['action_mask_raw'],
        actions=actions)


def source_role(c):
    skills = [source_skill(c, s) for s in c.skills]
    return dict(id=c.path.stem, name=c.name, skill_count=c.skill_count,
        definition_level=struct.unpack_from('<I', c.header, 0x24)[0],
        header_raw_hex=c.header.hex(), header_sha256=hash_bytes(c.header),
        source=dict(path=c.path.relative_to(ROOT).as_posix(), sha256=c.sha256,
                    header_offset=8, header_bytes=0x30b),
        learned_indices=[s['index'] for s in skills if s['learned_raw']],
        default_hotkey_indices=[s['index'] for s in skills if s['learned_raw'] and s['type_raw']][:3],
        exposed_indices=list(COMMANDS.get(c.path.stem, {})), skills=skills,
        reaction_id_indices={str(i): [s['index'] for s in skills if s['original_id_raw'] == i]
                             for i in (0, 1, 2, 3, 9, 12, 18, 19)})


def enrich_sequence(c, d, index, runtime_id=None, handler=None):
    binding=next((row for row in registration()['roles'].get(c.path.stem,{}).get('battle_skills',[]) if row['index']==index),{}) if runtime_id is not None and handler is None else {}
    if (handler or binding.get('handler')) in ('effect-carrier', 'native-support', 'native-revival') or any(
        a['type_raw'] == 1 and a['u32_at_0x01_raw'] != 11 for a in c.skills[index]['actions']):
        # 5130D0 command4 creates an independent effect carrier; it is not a
        # character DGP action4 and +1D means wait, not image reversal.
        s = c.skills[index]
        segments, controls = [], []
        for entry in s['actions']:
            raw = bytes.fromhex(entry['raw_hex'])
            group = struct.unpack_from('<I', raw, 1)[0]
            origin = dict(source=c.path.relative_to(ROOT).as_posix(), offset=entry['offset'],
                          bytes=len(raw), raw_sha256=hash_bytes(raw))
            if raw[0] == 0:
                start, end = struct.unpack_from('<II', raw, 0x26)
                effects = []
                for field, event_field, slot in ((9, 5, 'actor'), (0x4e, 0x49, 'target')):
                    token = raw[field:field + 20].split(b'\0')[0].decode('ascii')
                    if token:
                        effects.append(dict(asset_id=Path(token).stem, frame=struct.unpack_from('<I', raw, event_field)[0], slot=slot))
                event = struct.unpack_from('<I', raw, 0x49)[0]
                segments.append(dict(chr_record_index=entry['index'], action_index=group,
                    source=origin, frames=native_frame_sequence(d.raw_actions[group], start, end, raw[0x1d], total_frames=d.frame_count),
                    start=start, end_exclusive=end, reverse_raw=raw[0x1d], interval_raw=d.actions[group]['interval_raw'],
                    movement_step_raw=struct.unpack_from('<i', raw, 0x1e)[0], movement_source_field='0x1e', movement_flag_raw=raw[0x25],
                    event=dict(frame=event, field='0x49') if event else None, effects=effects, evidence=[NATIVE_IDS['range']]))
            else:
                assert raw[0] == 1 and group in (0, 1, 4, 6, 7, 8, 10, 11)
                if group == 10 and raw[0x47] not in (0, 1):
                    raise ValueError('Native target vertical mode is not recovered')
                if group == 1 and (raw[0x47] not in (0, 1) or raw[0x1d]):
                    raise ValueError('Native camera shake axis is not recovered')
                if group == 7 and raw[0x47] not in (1, 7) or group == 8 and raw[0x47] not in (1, 2, 3, 4, 5, 6, 7, 9):
                    raise ValueError('Native appearance/disappearance renderer mode is not recovered')
                descriptor = dict(chr_record_index=entry['index'], type_raw=1, command_raw=group,
                    source=origin, raw_hex=raw.hex(), immediate=group != 4 or not raw[0x1d])
                if group == 4:
                    token=raw[9:29].split(b'\0')[0].decode('ascii')
                    path=ROOT / f'Fight_Role/Effect/{token}'
                    if not path.is_file():
                        descriptor.update(effect_asset_id=Path(token).stem, missing_source_file=True)
                        controls.append(descriptor)
                        continue
                    effect=DGP(path)
                    start, end=struct.unpack_from('<II', raw, 0x26)
                    if end == 0: end=effect.frame_count
                    # 5074C0 keeps the CHR end even past the DGP pool. The
                    # renderers reject the missing physical frame without
                    # shortening the carrier clock or wrapping its image.
                    if effect.raw_actions[0][0x0d] & 15:
                        frames=[frame if frame < effect.frame_count else None for frame in range(start, end)]
                    else:
                        frames=native_frame_sequence(effect.raw_actions[0], start, end, 0)
                    descriptor.update(effect_asset_id=Path(token).stem, wait_raw=raw[0x1d],
                        slot='target' if raw[0x22] else 'actor', start=start, end_exclusive=end,
                        frames=frames,
                        event=dict(frame=struct.unpack_from('<I', raw, 0x49)[0], field='0x49') if raw[0x49] else None)
                controls.append(descriptor)
        v=dict(role_id=c.path.stem, chr_skill_index=index, skill_id_raw=s['id_raw'],
               name=s['name_cp936'], segments=segments, command_effects=controls, terminal_commands=[])
    else:
        v = sequence(c, d, index)
    if runtime_id:
        v['runtime_skill_id'] = runtime_id
    for segment in v['segments']:
        segment['raw_hex'] = c.skills[index]['actions'][segment['chr_record_index']]['raw_hex']
        segment['source_skill_index'] = index
    return v


def export_role_assets(role, c, d, sources, checks, group='party'):
    views = [role['skill']] + role['alternate_skills'] + role['response_skills']
    segments = [s for v in views for s in v['segments']] + role.get('idle_sequence', {}).get('segments', [role['idle']]) + [role['reaction']]
    used = sorted({s['action_index'] for s in segments})
    role['actions'] = []
    rules = pixel_rules()
    for index in used:
        action = d.actions[index]
        assert action['directions'] == 1
        referenced = [frame for segment in segments if segment['action_index'] == index for frame in segment['frames']]
        sheet_frames = max(action['frames_per_direction'], max(referenced, default=-1) + 1)
        if action['first_frame'] + sheet_frames > d.frame_count:
            raise ValueError(f"Role {role['id']} action {index} leaves its DGP global frame pool")
        out = WEB / f'assets/{group}_roles/{role["id"]}/action_{index:02}.png'
        def produce_action():
            sheet = Image.new('RGBA', (d.width * sheet_frames, d.height))
            for frame in range(sheet_frames):
                sheet.paste(d.decode(action['first_frame'] + frame), (frame * d.width, 0))
            save_png(sheet, out)
            with Image.open(out) as stored:
                assert stored.convert('RGBA').tobytes() == sheet.tobytes()
            return sha(out), [out]
        output_hash = resource(RUNTIME, f'{group}/role/{role["id"]}/action/{index}',
            {'source': d.sha256, 'frames': sheet_frames}, rules, produce_action)
        role['actions'].append(dict(index=index, sheet='/' + out.relative_to(WEB).as_posix(),
            sha256=output_hash, frame_count=sheet_frames, source_frame_count=action['frames_per_direction'], directions=1,
            first_frame=action['first_frame'], native_raw_hex=d.raw_actions[index].hex()))
    # Include every used physical frame, including native death id12, in a
    # role-specific bank. Frame numbers overlap between characters.
    physical = sorted({d.actions[s['action_index']]['first_frame'] + f
                       for s in segments for f in s['frames']})
    audit = SourceAudit(d.data)
    assert (audit.width, audit.height, audit.count, audit.anchor) == (
        d.width, d.height, d.frame_count, d.anchor_raw)
    frames = []
    for source_frame in physical:
        prefix = WEB / f'assets/{group}_layers/{role["id"]}/frame_{source_frame:04}'
        def produce_frame():
            main_rgba, main_check = audit.sparse(source_frame, False)
            intrinsic_rgba, intrinsic_check = audit.sparse(source_frame, True)
            main_path, intrinsic_path = Path(str(prefix)+'_main.png'), Path(str(prefix)+'_intrinsic.png')
            main = save_layer(d.decode(source_frame), main_path, main_rgba, main_check, web=WEB)
            intrinsic_image = indexed_contribution(d, source_frame)[0] if d.indexed_auxiliary else Image.new('RGBA', (d.width, d.height))
            intrinsic = save_layer(intrinsic_image, intrinsic_path, intrinsic_rgba, intrinsic_check, web=WEB)
            intrinsic['active'] = bool(d.indexed_auxiliary and d.indexed_auxiliary[source_frame]['active_raw'])
            return {'frame': dict(source_frame=source_frame, main=main, intrinsic=intrinsic),
                    'check': dict(role_id=role['id'], source_frame=source_frame,
                                  main=main_check, intrinsic=intrinsic_check)}, [main_path, intrinsic_path]
        cached = resource(RUNTIME, f'{group}/role/{role["id"]}/frame/{source_frame}',
                          {'source': d.sha256}, rules, produce_frame)
        frames.append(cached['frame'])
        checks.append(cached['check'])
    path = WEB / f'data/{group}_role_layers_{role["id"]}.json'
    save(path, dict(schema='seventh-seal-native-layer-bank', version=1,
        role_id=role['id'], frame_width=d.width, frame_height=d.height,
        anchor=role['anchor'], frames=frames, source_hashes={p: v for p, v in sources.items()
            if p == 'GAME.exe' or p.startswith(f'Fight_Role/{role["id"]}.')},
        evidence=[NATIVE_IDS['range'], NATIVE_IDS['indexed_draw'], NATIVE_IDS['pixel_format']],
        limits=['Source main and intrinsic layers share one physical frame and origin.',
                'Canvas additive blending and wall-clock timing are preview policies.']))
    return dict(path='/' + path.relative_to(WEB).as_posix(), sha256=sha(path))


def source_status_block(c, index):
    skill = c.skills[index]
    fixed = bytes.fromhex(skill['fixed_raw_hex'])
    block = fixed[0x16b:0x231]
    if block[1] and (block[0xb] not in (0, 2) or block[0x10] not in (0, 1)):
        raise ValueError(f'{c.path.stem}:{index}: unsupported native status mode')
    return dict(actor_id=c.path.stem, original_skill_index=index, name=skill['name_cp936'],
        fixed_raw_hex=fixed.hex(), effect_raw_hex=block.hex(), effect_id_raw=block[1], mode_raw=block[0xb],
        source=dict(path=c.path.relative_to(ROOT).as_posix(), sha256=c.sha256, fixed_offset=skill['offset'],
            block_offset=skill['offset'] + 0x16b, fixed_bytes=0x41d, effect_bytes=0xc6))


def extend_status_descriptors(status, blocks, sources, *, retain_skills=True):
    status['effects'] = dict(status.get('effects', {}))
    for effect_id in sorted({row['effect_id_raw'] for row in blocks.values() if row['effect_id_raw']}):
        path = ROOT / f'Fight_Role/Status/{effect_id:03d}.dgp'
        if not path.is_file():
            #507AA0 zeros each status frame count before51FCC4. Missing files
            #leave it zero;509E10 uses80ms and skips visual-frame advancement.
            status['effects'][str(effect_id)] = dict(id_raw=effect_id, interval_ms=80, frame_count=0,
                source=dict(path=path.relative_to(ROOT).as_posix(), source_exists=False),
                evidence=['ev_1c8d0a0767a10475883a351f8834c495e46431f1056ef9b80babf2cb4eb73df3',
                    'ev_9abd5ba6645433c0752e35b69015a7f998c9c9b054862a5afdfadc7499e40962'],
                policy='Original missing status DGP: preserve zero frames and native80ms status clock; no replacement art.')
            continue
        graphics = DGP(path)
        if len(graphics.actions) != 1 or graphics.actions[0]['directions'] != 1:
            raise ValueError(f'Status {effect_id}: unsupported action table')
        sources[path.relative_to(ROOT).as_posix()] = graphics.sha256
        status['effects'][str(effect_id)] = dict(id_raw=effect_id,
            interval_ms=graphics.actions[0]['interval_raw'], frame_count=graphics.actions[0]['frames_per_direction'],
            source=dict(path=path.relative_to(ROOT).as_posix(), sha256=graphics.sha256, action_raw_hex=graphics.raw_actions[0].hex()))
    if retain_skills:
        status['skills'].update(blocks)


def export_one_effect(ident, p, asset_group):
    sources, effect_checks = {}, []
    def produce():
        d = DGP(p)
        sources[p.relative_to(ROOT).as_posix()] = sha(p)
        audit = SourceAudit(d.data)
        assert len(d.actions) == 1 and d.actions[0]['directions'] == 1
        assert (audit.width, audit.height, audit.count, audit.anchor) == (
            d.width, d.height, d.frame_count, d.anchor_raw)
        assert d.actions[0]['first_frame'] == 0 and d.actions[0]['frames_per_direction'] == d.frame_count
        # DGP +B1 primary pixels and +C5 indexed contributions are
        # independent passes, even for a command4 effect carrier.
        # Retain the old action_00/sheet as the intrinsic pass;
        # main is separately source-over, never additive.
        main_sheet = Image.new('RGBA', (d.width * d.frame_count, d.height))
        intrinsic_sheet = Image.new('RGBA', (d.width * d.frame_count, d.height))
        shadow_sheet = Image.new('RGBA', (d.width * d.frame_count, d.height))
        for f in range(d.frame_count):
            main = d.decode(f)
            intrinsic = indexed_contribution(d, f)[0] if d.indexed_auxiliary else Image.new('RGBA', (d.width, d.height))
            shadow = d.decode_shadow(f) if d.shadow_blobs else Image.new('RGBA', (d.width, d.height))
            main_rgba, main_check = audit.sparse(f, False)
            intrinsic_rgba, intrinsic_check = audit.sparse(f, True)
            shadow_rgba, shadow_check = audit.shadow(f)
            intrinsic_check.setdefault('rgba_sha256', hash_bytes(intrinsic_rgba))
            assert main.tobytes() == main_rgba
            assert intrinsic.tobytes() == intrinsic_rgba
            assert shadow.tobytes() == shadow_rgba
            main_sheet.paste(main, (f * d.width, 0))
            intrinsic_sheet.paste(intrinsic, (f * d.width, 0))
            shadow_sheet.paste(shadow, (f * d.width, 0))
            effect_checks.append(dict(effect_id=ident, source_frame=f,
                main=main_check, intrinsic=intrinsic_check, shadow=shadow_check))
        out = WEB / f'assets/{asset_group}_effects/{ident}/action_00.png'
        out.parent.mkdir(parents=True, exist_ok=True)
        main_out = out.with_name('action_00_main.png')
        shadow_out = out.with_name('action_00_shadow.png')
        for image, path in ((shadow_sheet, shadow_out), (main_sheet, main_out), (intrinsic_sheet, out)):
            save_png(image, path)
            with Image.open(path) as stored:
                assert stored.convert('RGBA').tobytes() == image.tobytes()
        descriptor = dict(id=ident, source=p.relative_to(ROOT).as_posix(), source_sha256=sha(p),
            frame_width=d.width, frame_height=d.height, frame_count=d.frame_count,
            anchor=dict(x=d.anchor_raw[0], y=d.anchor_raw[1]),
            sheet='/' + out.relative_to(WEB).as_posix(), sha256=sha(out),
            main_sheet='/' + main_out.relative_to(WEB).as_posix(), main_sha256=sha(main_out),
            main_rgba_sha256=hash_bytes(main_sheet.tobytes()), main_blend='source-over',
            intrinsic_sheet='/' + out.relative_to(WEB).as_posix(), intrinsic_sha256=sha(out),
            intrinsic_rgba_sha256=hash_bytes(intrinsic_sheet.tobytes()), intrinsic_blend='lighter',
            shadow_sheet='/' + shadow_out.relative_to(WEB).as_posix(), shadow_sha256=sha(shadow_out),
            shadow_rgba_sha256=hash_bytes(shadow_sheet.tobytes()), shadow_blend='source-over',
            shadow_alpha=128, shadow_native='RGB565/555 destination channel floor-half; 8-bit alpha128 presentation',
            layer_order=['shadow', 'main', 'intrinsic'], interval_ms=d.actions[0]['interval_raw'],
            frames=native_frame_sequence(d.raw_actions[0], 0, d.frame_count, 0), native_raw_hex=d.raw_actions[0].hex(),
            blend='lighter', evidence=[NATIVE_IDS['indexed_draw'], NATIVE_IDS['effect_action'], *EFFECT_LAYER_EVIDENCE])
        return {'descriptor': descriptor, 'checks': effect_checks}, [out, main_out, shadow_out]
    cache_root = RUNTIME if WEB.resolve().is_relative_to(RUNTIME.resolve()) else WEB
    return resource(cache_root, f'effect/{ident}',
                    {'source': sha(p)}, pixel_rules(), produce)


def export_effect_assets(meta, sources, checks, asset_group='party'):
    known_effects = {e['id'] for e in meta['effects']}
    checked_effects = set()
    missing = {row['id']: row for row in meta.get('missing_effects', [])}
    for role in meta['roles']:
        for view in [role['skill']] + role.get('alternate_skills', []) + role.get('response_skills', []):
            carrier_segments=[]
            for s in view.get('command_effects',[]):
                if s['command_raw'] != 4: continue
                events=[dict(asset_id=s['effect_asset_id'])]
                target=bytes.fromhex(s['raw_hex'])[0x4e:0x62].split(b'\0')[0].decode('ascii')
                if target: events.append(dict(asset_id=Path(target).stem))
                carrier_segments.append(dict(effects=events))
            for segment in view['segments']+carrier_segments:
                for event in segment['effects']:
                    ident = event['asset_id']
                    if ident in checked_effects:
                        continue
                    checked_effects.add(ident)
                    p = ROOT / f'Fight_Role/Effect/{ident}.dgp'
                    if ident in known_effects:
                        retained = next(row for row in meta['effects'] if row['id'] == ident)
                        fields = [('sheet','sha256'),('main_sheet','main_sha256'),
                                  ('intrinsic_sheet','intrinsic_sha256'),('shadow_sheet','shadow_sha256')]
                        valid = p.is_file() and retained.get('source_sha256') == sha(p)
                        for field, hash_field in fields:
                            if field in retained:
                                output = WEB/retained[field].lstrip('/')
                                valid = valid and output.is_file() and sha(output) == retained[hash_field]
                        if valid:
                            continue
                        meta['effects'] = [row for row in meta['effects'] if row['id'] != ident]
                        known_effects.remove(ident)
                    if not p.is_file():
                        missing[ident] = dict(id=ident, source=p.relative_to(ROOT).as_posix(), source_exists=False,
                            policy='Original literal file absent; native effect allocation returns without a carrier or pixels.')
                        continue
                    sources[p.relative_to(ROOT).as_posix()] = sha(p)
                    missing.pop(ident, None)
                    cached = export_one_effect(ident, p, asset_group)
                    meta['effects'].append(cached['descriptor'])
                    checks.extend(cached['checks'])
                    known_effects.add(ident)
    meta['missing_effects'] = list(missing.values())


def main():
    global COMMANDS, FIELD_COMMANDS
    COMMANDS, FIELD_COMMANDS = skill_bindings(), skill_bindings(field=True)
    original_paths = ['GAME.exe', *[f'Fight_Role/{ident}.{suffix}' for ident in role_ids('player') for suffix in ('CHR','dgp')]]
    sources = {p: sha(ROOT / p) for p in original_paths}
    assert sources['GAME.exe'] == GAME_SHA256
    historical_paths = [WEB / f'data/{name}.json' for name in (
        'forest_full_battle_view', 'forest_reactions', 'battle_scheduler', 'forest_combat',
        'skills', 'yantu_layers', 'xuanying_layers')]
    historical = {p.relative_to(RUNTIME).as_posix(): sha(p) for p in historical_paths}
    native = RUNTIME / 'evidence/party_native.json'
    records = read(native)['records']
    required = {'menu_defaults': ('procedure_assembly', '0x444590'),
                'silence_gate': ('procedure_assembly', '0x427470'),
                'command_select': ('procedure_pseudo_code', '0x42fa90'),
                'command_dispatch': ('procedure_pseudo_code', '0x42fe40')}
    evidence = {}
    for key, (operation, address) in required.items():
        r = next(r for r in records if r['operation'] == operation and
                 r['parameters'].get('procedure', '').lower() == address)
        assert r['subject']['digest']['sha256'] == GAME_SHA256
        evidence[key] = r['evidence_id']
    definitions = {i: CHR(ROOT / f'Fight_Role/{i}.CHR') for i in COMMANDS}
    roles = {i: source_role(c) for i, c in definitions.items()}
    commands = {}
    field_commands = {}
    idles = {}
    for ident, role in roles.items():
        for index, runtime_id in COMMANDS[ident].items():
            skill = dict(role['skills'][index])
            # Admission and learning progress are independent. Unlearned source
            # attacks can be exported now and become usable after native unlock.
            assert skill['type_raw'] in (1, 2, 3) or (
                ident == '005' and index in (29, 30) and skill['type_raw'] == 0
                and skill['original_id_raw'] == index + 42)
            skill['battle_handler'] = next(row['handler'] for row in registration()['roles'][ident]['battle_skills'] if row['index']==index)
            if skill['battle_handler'] in ('effect-carrier', 'native-support', 'native-revival'):
                assert all(a['type_raw'] == 0 or a['u32_at_0x01_raw'] in (0,4,6,7,8,11) for a in skill['actions'])
                magic = read(RUNTIME / 'evidence/party_magic_native.json')
                proof = {r['parameters'].get('procedure','').lower(): r['evidence_id'] for r in magic['records'] if r['operation']=='procedure_assembly'}
                skill['effect_context'] = dict(effect_token=1, effect_source_skill_index=index,
                    effect_target_skill=dict(fixed_raw_hex='00'*0x41d, allocation='LocalAlloc(0x40,200*0x421); source CHR loader visits only skill_count',
                        initialized_slots=200, source_skill_count_by_role={id:row['skill_count'] for id,row in read(WEB/'data/forest_ai.json')['roles'].items()},
                        evidence=[proof['0x519a80'],proof['0x501930']],
                        localalloc_documentation='https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-localalloc'),
                    policy='Bounded fresh actor allocation; the declared source index must be outside the target loaded skill count. Remake token1 names the damage carrier, while native queue indices are ephemeral. Source attack target+25=0 does not apply recovery +143.')
                if skill['type_flags_u32_0x32'] != 0x1102 or any(row['skill_count'] > index for row in read(WEB/'data/forest_ai.json')['roles'].values()):
                    skill['effect_context'] = dict(effect_token=1, effect_source_skill_index=index, effect_lookup='same-index-source-table',
                        evidence=[proof['0x501930'], proof['0x512430']])
                skill['magic_native_bundle'] = dict(path='evidence/party_magic_native.json',sha256=sha(RUNTIME / 'evidence/party_magic_native.json'))
                if skill['battle_handler'] in ('native-support', 'native-revival'):
                    fixed = bytes.fromhex(skill['fixed_raw_hex'])
                    assert fixed[0x24] in (0, 1) and fixed[0x25] == 1 and fixed[0x16c] == 0 and fixed[0x23c] in (0, 1, 3, 5)
                    skill.pop('effect_context', None)
            else:
                assert skill['mp_cost'] >= 0 and skill['charge_i32_0x2e'] >= 0
                assert all(a['type_raw'] == 0 or a['u32_at_0x01_raw'] == 11 for a in skill['actions'])
            skill['id'] = runtime_id
            skill['evidence'] = list(evidence.values()) + [NATIVE_IDS['range'], NATIVE_IDS['events']]
            commands[runtime_id] = skill
        idle = role['skills'][0]
        idles[ident] = {k: idle[k] for k in ('actor_id', 'name', 'fixed_raw_hex',
                                            'class_raw', 'action_mask_raw', 'source')}
        idles[ident]['id'] = ident + '_idle'
        for index, runtime_id in FIELD_COMMANDS.get(ident, {}).items():
            skill = dict(role['skills'][index])
            assert skill['type_flags_u32_0x32'] & (1 << 13)
            skill['id'] = runtime_id
            skill['field_handler'] = 'flat-resource-recovery'
            if runtime_id in commands:
                skill['battle_handler'] = commands[runtime_id]['battle_handler']
                skill['magic_native_bundle'] = commands[runtime_id]['magic_native_bundle']
            skill['field_evidence'] = ['0x450a20', '0x45c100', '0x426fe0', '0x426ac0']
            field_commands[runtime_id] = skill
    status = read(WEB / 'data/forest_status.json')
    blocks = {f'{ident}:{index}': source_status_block(definitions[ident], index) for ident, indices in COMMANDS.items() for index in indices}
    for key, block in blocks.items():
        retained = status['skills'].get(key)
        if not retained or retained['fixed_raw_hex'] != block['fixed_raw_hex'] or retained['effect_raw_hex'] != block['effect_raw_hex']:
            raise ValueError(f'{key}: source status table must be rebuilt by enemies before party-skills')
    native_ref = dict(path=native.relative_to(RUNTIME).as_posix(), sha256=sha(native))
    save(WEB / 'data/party_skills.json', dict(schema='seventh-seal-party-skills', version=1,
        skills=commands, field_skills=field_commands, roles=roles, idle_skills=idles, source_hashes=sources,
        evidence=evidence, native_bundle=native_ref,
        policy=dict(eligibility='登记与学习状态独立；运行按原学习状态、技能类型、等级及资源条件判断可用性。',
            commands='战斗与场外技能按runtime_content.json登记；原前三个合资格技能用于默认快捷键来源，操作菜单与战斗使用已保存的七槽绑定。',
            source='基于原CHR定义；登记不改写原学习字节、等级条件或存档进度。',
            original_game_execution_observed=False),
        limits=['技能接入范围以runtime_content.json为准；保留完整CHR技能用于来源核对，不表示全部技能已实现。',
                '登记未学习技能不会自动解锁；开发样本的显式技能授予只作用于该样本。',
                '七槽绑定、组合编辑与执行复用已接入技能；原type0及空白记录保留来源资格。当前验收范围见remake/assessment/validation_design.md。']))
    reactions = read(WEB / 'data/enemy_reactions.json')
    reactions['roles'].update(roles)
    reactions['source_hashes'].update({p: sources[p] for p in original_paths if p.endswith('.CHR')})
    reactions['policy']['player_attack_skills'] = '按内容登记读取玩家原CHR技能；历史样本来源独立保留。'
    reactions['policy']['roster'] = 'party-source-group'
    reactions['party_native_bundle'] = native_ref
    save(WEB / 'data/party_reactions.json', reactions)
    meta = read(WEB / 'data/enemy_battle_view.json')
    meta['policy']['roster'] = 'party-source-group'
    meta['policy']['complete_contacts'] = True
    meta['source_hashes'].update(sources)
    checks = []
    banks = list(meta.get('extra_layer_banks', []))
    for ident, c in definitions.items():
        d = DGP(ROOT / f'Fight_Role/{ident}.dgp')
        primary=registration()['roles'][ident]['primary_skill']
        ordered = [primary, *[index for index in COMMANDS[ident] if index!=primary]]
        views = [enrich_sequence(c, d, i, COMMANDS[ident][i]) for i in ordered]
        responses = [enrich_sequence(c, d, i) for i, s in enumerate(c.skills) if s['id_raw'] in RESPONSE_IDS]
        role = dict(id=ident, name=c.name, frame_width=d.width, frame_height=d.height,
            cursor_height_raw=d.cursor_height_raw,
            anchor=dict(x=d.anchor_raw[0], y=d.anchor_raw[1], source='DGP extra_header+0x10/+0x14', native_use_verified=False),
            mirror=False, direction=0, idle=enrich_sequence(c, d, 0)['segments'][0],
            reaction=enrich_sequence(c, d, 1)['segments'][0], skill=views[0],
            alternate_skills=views[1:], response_skills=responses,
            reaction_basis='Native fixed-id lookup selects each source response; id12 death source is included.')
        if ident == '001':
            # The established primary/alternate skill layers remain referenced,
            # while the new role bank also includes idle and death frames.
            old = next(r for r in meta['roles'] if r['id'] == ident)
            role['alternate_skills'][0]['layers'] = old['alternate_skills'][0]['layers']
        banks.append(export_role_assets(role, c, d, sources, checks))
        meta['roles'] = [r for r in meta['roles'] if r['id'] != ident] + [role]
    export_effect_assets(meta, sources, checks)
    meta['roles'].sort(key=lambda r: r['id'])
    meta['extra_layer_banks'] = banks
    meta.pop('extra_layers', None)
    meta['source_hashes'].update(sources)
    meta['limits'] = ['Source sprites, logical contacts, reaction/death actions and main/intrinsic layers for every registered player and enemy.',
        'All six players retain their own source command records, learning gates and effect ranges; absent literal files and out-of-pool frames follow native no-draw behavior.',
        'Coordinate projection, interpolation, sprite-scale and additive Canvas remain remake presentation policies; original renderer and clocks were not executed.']
    save(WEB / 'data/party_battle_view.json', meta)
    assert all(sha(ROOT / p) == v for p, v in meta['source_hashes'].items())
    assert all(sha(RUNTIME / p) == v for p, v in historical.items())
    outputs = [WEB / f'data/{name}.json' for name in ('party_skills', 'party_reactions', 'party_battle_view',
                                                       *[f'party_role_layers_{ident}' for ident in role_ids('player')])]
    outputs += list((WEB / 'assets/party_roles').rglob('*.png'))
    outputs += list((WEB / 'assets/party_layers').rglob('*.png'))
    outputs += list((WEB / 'assets/party_effects').rglob('*.png'))
    save(RUNTIME / 'evidence/party_skills_export.json', dict(schema='seventh-seal-party-skills-export', version=1,
        passed=True, source_hashes=meta['source_hashes'], source_unchanged=True,
        historical_hashes=historical, historical_unchanged=True,
        output_hashes={p.relative_to(RUNTIME).as_posix(): sha(p) for p in outputs},
        direct_commands=list(commands), learned_indices={i: r['learned_indices'] for i, r in roles.items()},
        default_hotkey_indices={i: r['default_hotkey_indices'] for i, r in roles.items()},
        contacts={k: sum(a['contact_u32_raw_0x49'] != 0 for a in s['actions']) for k, s in commands.items()},
        frame_checks=checks, native_bundle=native_ref, original_game_execution_observed=False))
    print(json.dumps(dict(passed=True, commands=len(commands), roles=len(meta['roles']),
                         source_frame_checks=len(checks), new_outputs=len(outputs), historical_unchanged=True)))


if __name__ == '__main__':
    main()
