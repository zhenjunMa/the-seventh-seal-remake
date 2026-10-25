"""Bind the first full-turn view to read-only CHR/DGP source bytes.

Frame ranges and +0x49 event positions reuse retained native field evidence.
Choreography, Canvas composition and the development battle backdrop are
explicit presentation policies. No original combat execution is asserted.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
sys.path.insert(0, str(RUNTIME / 'tools'))
from PIL import Image
from source.combat_resources import CHR
from source.dgp import DGP, u32
from export_combat_presentation import indexed_contribution, native_frame_sequence, NATIVE_IDS
from export_skill_layers import SourceAudit


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def save(path: Path, value: dict) -> None:
    if not path.resolve().is_relative_to(RUNTIME):
        raise ValueError('Battle view outputs must remain inside runtime')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'utf-8')


def sequence(role: CHR, dgp: DGP, index: int) -> dict:
    skill = role.skills[index]
    segments, terminal = [], []
    for entry in skill['actions']:
        raw = bytes.fromhex(entry['raw_hex'])
        group = u32(raw, 1)
        origin = dict(source=role.path.relative_to(ROOT).as_posix(), offset=entry['offset'],
                      bytes=len(raw), raw_sha256=sha(raw))
        if raw[0] != 0:
            if (raw[0], group) != (1, 11):
                raise ValueError('This slice only covers type 1 command 11 cleanup')
            terminal.append(dict(type_raw=1, command_raw=11, source=origin,
                                 evidence=[NATIVE_IDS['terminal_command'], NATIVE_IDS['terminal_cleanup']]))
            continue
        start, end = u32(raw, 0x26), u32(raw, 0x2a)
        frames = native_frame_sequence(dgp.raw_actions[group], start, end, raw[0x1d], total_frames=dgp.frame_count)
        event = u32(raw, 0x49)
        effects = []
        for field, event_field, slot in ((9, 5, 'actor'), (0x4e, 0x49, 'target')):
            token = raw[field:field + 20].split(b'\0')[0].decode('ascii')
            if token:
                effects.append(dict(asset_id=Path(token).stem, frame=u32(raw, event_field), slot=slot,
                    condition='source nonempty actor effect' if slot == 'actor' else 'accepted nonzero damage in bounded normal branch',
                    source_field=hex(field), source_event_field=hex(event_field)))
        segments.append(dict(chr_record_index=entry['index'], action_index=group,
            source=origin, frames=frames, start=start, end_exclusive=end, reverse_raw=raw[0x1d],
            interval_raw=dgp.actions[group]['interval_raw'], movement_flag_raw=raw[0x25],
            movement_step_raw=struct.unpack_from('<i',raw,0x1e)[0], movement_source_field='0x1e',
            event=dict(frame=event, field='0x49', evidence=[NATIVE_IDS['events'], NATIVE_IDS['settlement_effect']]) if event else None,
            reaction_class_raw=raw[0x62], effects=effects,
            evidence=[NATIVE_IDS['range'], NATIVE_IDS['range_pseudo'], NATIVE_IDS['events']]))
    return dict(role_id=role.path.stem, chr_skill_index=index, skill_id_raw=skill['id_raw'],
                name=skill['name_cp936'], segments=segments, terminal_commands=terminal)


def export_snow_effect(filename: str) -> dict:
    path = ROOT / 'Fight_Role/Effect' / filename
    dgp = DGP(path)
    if sum(n for frame in range(dgp.frame_count) for _, spans in dgp.rows(frame) for _, n, _ in spans):
        raise ValueError('Bounded effect has unexpected primary pixels')
    if len(dgp.actions) != 1 or dgp.actions[0]['directions'] != 1:
        raise ValueError('Bounded effect must be a single direction/action')
    action = dgp.actions[0]
    frames = native_frame_sequence(dgp.raw_actions[0], 0, action['frames_per_direction'], 0)
    sheet = Image.new('RGBA', (dgp.width * action['frames_per_direction'], dgp.height))
    audit = SourceAudit(path.read_bytes())
    checks = []
    for frame in range(dgp.frame_count):
        image, _ = indexed_contribution(dgp, frame)
        audited, check = audit.sparse(frame, indexed=True)
        if image.tobytes() != audited:
            raise ValueError('Independent snow effect sparse pixel audit differs')
        checks.append(dict(frame=frame, **check))
        sheet.paste(image, (frame * dgp.width, 0))
    output = RUNTIME / 'web/assets/combat_effects' / path.stem / 'action_00.png'
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output)
    with Image.open(output) as stored:
        if stored.convert('RGBA').tobytes() != sheet.tobytes():
            raise ValueError('Effect PNG roundtrip differs')
        for frame, check in enumerate(checks):
            cropped = stored.crop((frame * dgp.width, 0, (frame + 1) * dgp.width, dgp.height)).convert('RGBA').tobytes()
            if sha(cropped) != check['rgba_sha256']:
                raise ValueError('Stored snow effect frame differs from independent source audit')
    save(RUNTIME / 'evidence/snow_effect_pixels_20261011.json', dict(
        schema='seventh-seal-snow-effect-pixel-verification', version=1, source=path.relative_to(ROOT).as_posix(),
        source_sha256=dgp.sha256, png_sha256=sha(output.read_bytes()),
        independent_decoder='SourceAudit explicit LE sparse row/span and palette reads; no production DGP decoder calls',
        eof_verified=True, png_roundtrip_equal=True, frames=checks,
        original_game_execution_observed=False))
    return dict(id=path.stem, source=path.relative_to(ROOT).as_posix(), source_sha256=dgp.sha256,
                frame_width=dgp.width, frame_height=dgp.height,
                anchor=dict(x=dgp.anchor_raw[0], y=dgp.anchor_raw[1]),
                sheet='/' + output.relative_to(RUNTIME / 'web').as_posix(),
                sha256=sha(output.read_bytes()), frames=frames,
                frame_count=action['frames_per_direction'], blend='lighter',
                evidence=[NATIVE_IDS['indexed_draw'], NATIVE_IDS['effect_action']])


def main() -> None:
    manifest_path = WEB / 'data/source/combat_manifest.json'
    presentation_path = WEB / 'data/source/combat_presentation.json'
    layers_path = RUNTIME / 'web/data/yantu_layers.json'
    manifest = json.loads(manifest_path.read_text('utf-8'))
    presentation = json.loads(presentation_path.read_text('utf-8'))
    layers = json.loads(layers_path.read_text('utf-8'))
    sources = {**manifest['source_hashes'], **presentation['source_hashes']}
    sources['Fight_Role/Effect/BNo01_Nm.dgp'] = sha((ROOT / 'Fight_Role/Effect/BNo01_Nm.dgp').read_bytes())
    before = {p: sha((ROOT / p).read_bytes()) for p in sources}
    if any(before[p] != value for p, value in sources.items()):
        raise ValueError('Retained original source fingerprint mismatch')
    view_code = WEB / 'battle_view.mjs'
    old_hash = sha(view_code.read_bytes())
    native_bundle = json.loads((RUNTIME / 'evidence/source/combat_presentation_native_20261011.json').read_text('utf-8'))
    known = {entry['evidence_id'] for entry in native_bundle['records']}
    if set(NATIVE_IDS.values()) - known:
        raise ValueError('Missing retained native field evidence')
    roles = []
    for ident in ('001', '012'):
        src = next(role for role in manifest['roles'] if role['id'] == ident)
        chr_data = CHR(ROOT / src['chr_source'])
        dgp = DGP(ROOT / src['source'])
        # Category 0 and 1 are bounded default/normal reaction selections. The
        # complete native state-dependent reaction selector is not reproduced.
        idle = sequence(chr_data, dgp, 0)['segments'][0]
        reaction = sequence(chr_data, dgp, 1)['segments'][0]
        indices = {0, 1}
        skill = sequence(chr_data, dgp, 22 if ident == '001' else 14)
        indices.update(segment['action_index'] for segment in skill['segments'])
        actions = []
        for item in src['actions']:
            if item['index'] not in indices:
                continue
            asset = WEB / item['sheet']
            if sha(asset.read_bytes()) != item['sheet_sha256']:
                raise ValueError('Source atlas fingerprint mismatch')
            with Image.open(asset) as image:
                if image.size != (src['frame_width'] * item['frames_per_direction'], src['frame_height'] * item['directions']):
                    raise ValueError('Atlas size differs from source geometry')
            actions.append(dict(index=item['index'], sheet='/' + item['sheet'], sha256=item['sheet_sha256'],
                frame_count=item['frames_per_direction'], directions=item['directions'], first_frame=item['first_frame']))
        roles.append(dict(id=ident, name=src['name'], frame_width=src['frame_width'], frame_height=src['frame_height'],
            anchor=src['anchor'], cursor_height_raw=dgp.cursor_height_raw, mirror=False, direction=0,
            idle=idle, reaction=reaction, actions=actions, skill=skill,
            reaction_basis='original category 1 image sequence projected for the bounded normal surviving reaction branch'))
    player = roles[0]['skill']
    flattened = [(segment['action_index'], frame) for segment in player['segments'] for frame in segment['frames']]
    if flattened != [(frame['action_index'], frame['action_frame']) for frame in layers['frames']]:
        raise ValueError('Yantu main/intrinsic export differs from CHR source ranges')
    effects = []
    for src in presentation['assets']:
        if src['id'] not in ('_DutyN', 'BFr01_Dn'):
            continue
        action = src['actions'][0]
        asset = WEB / action['sheet']
        if sha(asset.read_bytes()) != action['sheet_sha256']:
            raise ValueError('Source effect fingerprint mismatch')
        effects.append(dict(id=src['id'], source=src['source'], source_sha256=src['source_sha256'],
            frame_width=src['frame_width'], frame_height=src['frame_height'], anchor=src['anchor'],
            sheet='/' + action['sheet'], sha256=action['sheet_sha256'], frames=action['frame_sequence'],
            frame_count=action['frames_per_direction'], blend='lighter', evidence=src['evidence']))
    effects.append(export_snow_effect('BNo01_Nm.dgp'))
    output = dict(schema='seventh-seal-battle-view', version=1, roles=roles, effects=effects,
        layers=dict(path='/data/yantu_layers.json', sha256=sha(layers_path.read_bytes())),
        source_hashes=sources,
        reference_hashes={str(p.relative_to(ROOT)).replace('\\', '/'): sha(p.read_bytes()) for p in (manifest_path, presentation_path, layers_path)},
        policy=dict(frame_ms=65, tail_ms=260, coordinate_space=[960, 540], sprite_scale=1.15,
            player_slot=[720, 350], enemy_slot=[240, 350], approach_distance=255,
            choreography='preview approach/hold/return, original precise displacement and timing unknown',
            backdrop='runtime development gradient; original battle background unknown',
            intrinsic_blend='same-source-frame source-over main followed by lighter intrinsic; RGB565 destination saturation approximated',
            death='fade after committed zero HP; original death action selection unknown',
            original_game_execution_observed=False),
        limits=['Only player001 Yantu and enemy012 skill14 are covered.',
                'World HP, MP, hit, damage and death are external controller results; this view never computes damage.',
                'Reaction uses bounded category1 sprite metadata; alternate native states and death action selection remain unresolved.',
                'Audio, camera and complete native skill scheduler remain unimplemented.'])
    after = {p: sha((ROOT / p).read_bytes()) for p in sources}
    if before != after or sha(view_code.read_bytes()) != old_hash:
        raise ValueError('Read-only source/runtime view code changed during export')
    save(RUNTIME / 'web/data/battle_view.json', output)
    save(RUNTIME / 'evidence/battle_view_export_20261011.json', dict(
        schema='seventh-seal-battle-view-export-verification', version=1,
        original_sources_unchanged=True, source_hashes=before, runtime_view_code_unchanged=True,
        runtime_view_sha256=old_hash,
        checks=dict(yantu_same_source_pairs=len(flattened), snow_skill_index=14,
                    source_event_positions=[(role['id'], segment['chr_record_index'], segment['event']['frame'])
                        for role in roles for segment in role['skill']['segments'] if segment['event']],
                    atlases_checked=sum(len(role['actions']) for role in roles), effect_assets=len(effects)),
        metadata_sha256=sha((RUNTIME / 'web/data/battle_view.json').read_bytes()),
        original_game_execution_observed=False, limits=output['limits']))
    print('Battle view: 32 same-source Yantu pairs, snow skill14 source event and read-only fingerprints verified.')


if __name__ == '__main__':
    main()
