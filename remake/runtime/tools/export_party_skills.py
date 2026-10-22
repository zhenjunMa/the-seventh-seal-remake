"""Export the new-game party's learned direct attacks and Kai battle pixels.

Only writes new party outputs. Historical forest manifests, source resources and
the level-12 saved fixture remain immutable. Native menu/default binding rules
are retained separately from the remake's direct-skill command presentation.
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
sys.path.insert(0, str(ROOT / 'remake/prototype/tools'))
sys.path.insert(0, str(RUNTIME / 'tools'))
from PIL import Image
from combat_resources import CHR, GAME_SHA256
from dgp import DGP
from export_battle_view import sequence
from export_combat_presentation import indexed_contribution, native_frame_sequence, NATIVE_IDS
from export_skill_layers import SourceAudit, save_layer
from content_registration import registration,role_ids,skill_bindings

COMMANDS = {}
FIELD_COMMANDS = {}
RESPONSE_IDS = (1, 2, 3, 9, 12, 18, 19)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def hash_bytes(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text('utf-8'))


def save(path, data):
    assert path.resolve().is_relative_to(RUNTIME)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', 'utf-8')


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


def enrich_sequence(c, d, index, runtime_id=None):
    binding=next((row for row in registration()['roles'].get(c.path.stem,{}).get('battle_skills',[]) if row['index']==index),{})
    if binding.get('handler') == 'effect-carrier':
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
                segments.append(dict(chr_record_index=entry['index'], action_index=group,
                    source=origin, frames=native_frame_sequence(d.raw_actions[group], start, end, raw[0x1d]),
                    start=start, end_exclusive=end, reverse_raw=raw[0x1d], interval_raw=d.actions[group]['interval_raw'],
                    movement_step_raw=0, movement_source_field='0x1e', movement_flag_raw=0,
                    event=None, effects=[], evidence=[NATIVE_IDS['range']]))
            else:
                assert raw[0] == 1 and group in (0, 4, 6, 11)
                descriptor = dict(chr_record_index=entry['index'], type_raw=1, command_raw=group,
                    source=origin, raw_hex=raw.hex(), immediate=group != 4 or not raw[0x1d])
                if group == 4:
                    token=raw[9:29].split(b'\0')[0].decode('ascii')
                    effect=DGP(ROOT / f'Fight_Role/Effect/{token}')
                    start, end=struct.unpack_from('<II', raw, 0x26)
                    if end == 0: end=effect.frame_count
                    descriptor.update(effect_asset_id=Path(token).stem, wait_raw=raw[0x1d],
                        slot='target' if raw[0x22] else 'actor', start=start, end_exclusive=end,
                        frames=native_frame_sequence(effect.raw_actions[0], start, end, 0),
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
    segments = [s for v in views for s in v['segments']] + [role['idle'], role['reaction']]
    used = sorted({s['action_index'] for s in segments})
    role['actions'] = []
    for index in used:
        action = d.actions[index]
        assert action['directions'] == 1
        out = WEB / f'assets/{group}_roles/{role["id"]}/action_{index:02}.png'
        out.parent.mkdir(parents=True, exist_ok=True)
        sheet = Image.new('RGBA', (d.width * action['frames_per_direction'], d.height))
        for frame in range(action['frames_per_direction']):
            sheet.paste(d.decode(action['first_frame'] + frame), (frame * d.width, 0))
        sheet.save(out)
        with Image.open(out) as stored:
            assert stored.convert('RGBA').tobytes() == sheet.tobytes()
        role['actions'].append(dict(index=index, sheet='/' + out.relative_to(WEB).as_posix(),
            sha256=sha(out), frame_count=action['frames_per_direction'], directions=1,
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
        prefix.parent.mkdir(parents=True, exist_ok=True)
        main_rgba, main_check = audit.sparse(source_frame, False)
        intrinsic_rgba, intrinsic_check = audit.sparse(source_frame, True)
        main = save_layer(d.decode(source_frame), Path(str(prefix) + '_main.png'), main_rgba, main_check)
        intrinsic_image = indexed_contribution(d, source_frame)[0] if d.indexed_auxiliary else Image.new('RGBA', (d.width, d.height))
        intrinsic = save_layer(intrinsic_image,
            Path(str(prefix) + '_intrinsic.png'), intrinsic_rgba, intrinsic_check)
        intrinsic['active'] = bool(d.indexed_auxiliary and d.indexed_auxiliary[source_frame]['active_raw'])
        frames.append(dict(source_frame=source_frame, main=main, intrinsic=intrinsic))
        checks.append(dict(role_id=role['id'], source_frame=source_frame,
            main=main_check, intrinsic=intrinsic_check))
    path = WEB / f'data/{group}_role_layers_{role["id"]}.json'
    save(path, dict(schema='seventh-seal-native-layer-bank', version=1,
        role_id=role['id'], frame_width=d.width, frame_height=d.height,
        anchor=role['anchor'], frames=frames, source_hashes={p: v for p, v in sources.items()
            if p == 'GAME.exe' or p.startswith(f'Fight_Role/{role["id"]}.')},
        evidence=[NATIVE_IDS['range'], NATIVE_IDS['indexed_draw'], NATIVE_IDS['pixel_format']],
        limits=['Source main and intrinsic layers share one physical frame and origin.',
                'Canvas additive blending and wall-clock timing are preview policies.']))
    return dict(path='/' + path.relative_to(WEB).as_posix(), sha256=sha(path))


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
            assert skill['type_raw'] in (1, 2)
            skill['battle_handler'] = next(row['handler'] for row in registration()['roles'][ident]['battle_skills'] if row['index']==index)
            if next(row for row in registration()['roles'][ident]['battle_skills'] if row['index']==index)['handler']=='effect-carrier':
                assert all(a['type_raw'] == 0 or a['u32_at_0x01_raw'] in (0,4,6,11) for a in skill['actions'])
                magic = read(RUNTIME / 'evidence/party_magic_native.json')
                proof = {r['parameters'].get('procedure','').lower(): r['evidence_id'] for r in magic['records'] if r['operation']=='procedure_assembly'}
                skill['effect_context'] = dict(effect_token=1, effect_source_skill_index=index,
                    effect_target_skill=dict(fixed_raw_hex='00'*0x41d, allocation='LocalAlloc(0x40,200*0x421); source CHR loader visits only skill_count',
                        initialized_slots=200, source_skill_count_by_role={id:row['skill_count'] for id,row in read(WEB/'data/forest_ai.json')['roles'].items()},
                        evidence=[proof['0x519a80'],proof['0x501930']],
                        localalloc_documentation='https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-localalloc'),
                    policy='Bounded fresh actor allocation; the declared source index must be outside the target loaded skill count. Remake token1 names the damage carrier, while native queue indices are ephemeral. Source attack target+25=0 does not apply recovery +143.')
                skill['magic_native_bundle'] = dict(path='evidence/party_magic_native.json',sha256=sha(RUNTIME / 'evidence/party_magic_native.json'))
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
            assert skill['learned_raw'] and skill['type_flags_u32_0x32'] & (1 << 13)
            skill['id'] = runtime_id
            skill['field_handler'] = 'flat-resource-recovery'
            skill['field_evidence'] = ['0x450a20', '0x45c100', '0x426fe0', '0x426ac0']
            field_commands[runtime_id] = skill
    native_ref = dict(path=native.relative_to(RUNTIME).as_posix(), sha256=sha(native))
    save(WEB / 'data/party_skills.json', dict(schema='seventh-seal-party-skills', version=1,
        skills=commands, field_skills=field_commands, roles=roles, idle_skills=idles, source_hashes=sources,
        evidence=evidence, native_bundle=native_ref,
        policy=dict(eligibility='Native learned byte +0x23 and nonzero type +0x32 low nibble.',
            commands='Remake directly exposes selected learned attacks; native default UI binds the first three eligible skills.',
            source='Fresh CHR definitions; admission does not alter learned bytes, required levels or saved progress.',
            original_game_execution_observed=False),
        limits=['001 exposes two learned attacks and source skill37 fire spell; other learned spells/attacks remain outside this milestone.',
                '002 exposes all five learned direct attacks at its source level 10; no skill unlock is invented.',
                'Original active command menu and default three-slot configuration are not reproduced.']))
    reactions = read(WEB / 'data/enemy_reactions.json')
    reactions['roles'].update(roles)
    reactions['source_hashes'].update({p: sources[p] for p in original_paths if p.endswith('.CHR')})
    reactions['policy']['player_attack_skills'] = 'Party source CHR direct skills; historical fixture source remains separate.'
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
    known_effects = {e['id'] for e in meta['effects']}
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
                    if ident in known_effects:
                        continue
                    p = ROOT / f'Fight_Role/Effect/{ident}.dgp'
                    d = DGP(p)
                    sources[p.relative_to(ROOT).as_posix()] = sha(p)
                    audit = SourceAudit(d.data)
                    assert len(d.actions) == 1 and d.actions[0]['directions'] == 1
                    assert sum(n for f in range(d.frame_count) for _, spans in d.rows(f) for _, n, _ in spans) == 0
                    sheet = Image.new('RGBA', (d.width * d.frame_count, d.height))
                    for f in range(d.frame_count):
                        indexed = bool(d.indexed_auxiliary)
                        image = indexed_contribution(d, f)[0] if indexed else d.decode(f)
                        rgba, check = audit.sparse(f, indexed)
                        assert image.tobytes() == rgba
                        sheet.paste(image, (f * d.width, 0))
                        checks.append(dict(effect_id=ident, source_frame=f, intrinsic=check))
                    out = WEB / f'assets/party_effects/{ident}/action_00.png'
                    out.parent.mkdir(parents=True, exist_ok=True)
                    sheet.save(out)
                    meta['effects'].append(dict(id=ident, source=p.relative_to(ROOT).as_posix(), source_sha256=sha(p),
                        frame_width=d.width, frame_height=d.height, frame_count=d.frame_count,
                        anchor=dict(x=d.anchor_raw[0], y=d.anchor_raw[1]),
                        sheet='/' + out.relative_to(WEB).as_posix(), sha256=sha(out),
                        frames=native_frame_sequence(d.raw_actions[0], 0, d.frame_count, 0), native_raw_hex=d.raw_actions[0].hex(),
                        blend='lighter', evidence=[NATIVE_IDS['indexed_draw'], NATIVE_IDS['effect_action']]))
                    known_effects.add(ident)
    meta['roles'].sort(key=lambda r: r['id'])
    meta['extra_layer_banks'] = banks
    meta.pop('extra_layers', None)
    meta['source_hashes'].update(sources)
    meta['limits'] = ['Source sprites, logical contacts, reaction/death actions and main/intrinsic layers for 001/002 plus forest enemies.',
        '001 two learned attacks and skill37 commands0/4/6/11; 002 all five learned direct attacks; other commands remain outside this manifest.',
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
