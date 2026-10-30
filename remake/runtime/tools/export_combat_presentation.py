"""Export bounded, native-backed combat sequences and real indexed effects.

Original files are read only. RGB565 effect contributions are exported with
transparent sparse holes; consumers must use additive blending. Native damage,
movement/camera timing and dying-animation selection are outside this export.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import struct
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from PIL import Image
from source.combat_resources import CHR, GAME_SHA256, PROJECT, ROOT
from source.dgp import DGP, DGPError, Reader, u16, u32

WEB = PROJECT / 'web'
EVIDENCE = PROJECT / 'evidence/source'
ASSETS = WEB / 'assets/combat_effects'
SKILLS = (22, 24, 25)
EFFECTS = ('_DutyN.dgp', 'BFr01_Dn.dgp', 'BFr01_Nm.dgp')
NATIVE_IDS = {
    'loader': 'ev_9abd5ba6645433c0752e35b69015a7f998c9c9b054862a5afdfadc7499e40962',
    'indexed_draw': 'ev_0c237df7043928c88bbdebd562f666aa4b7f4201a779c0a793b1483939fd71d2',
    'pixel_format': 'ev_a6647ea0bc3a48a670332ca03d6a4e02d7b145a407b5a5ad2dcfa4ed39b122d1',
    'effect_draw_callers': 'ev_c46d00ee8fe35c2ec5c423d430d7dfb06f260c684d7cb5f7b0bddd5e241923bb',
    'effect_path': 'ev_f15f6172bbe054a3547a4f6357625e875adff7ca3960d10ed37fb93d74d4784e',
    'effect_queue': 'ev_3748f7fcd1e99d08d1e2ebd3e69e802c0f5e6a392e8a3e40e638732feb7eca49',
    'effect_action': 'ev_8a5106859a74859307743cb5be1794a453316af2b92ccfc05d4705257ef5ea6c',
    'range': 'ev_e684765a5b552708f4e35b7fa0516950d8ef5d9e5acc0b9e4ddb0f7e3ff1a5cf',
    'range_pseudo': 'ev_66f82c795bc2c5392a4af502e71da424a6f4e6b2c796a8bcc66a61f2d38eec29',
    'events': 'ev_0da74f80c4ef0fd4c6d105745a0341196c94b5a7d7f5cdff899ed375790c4e01',
    'settlement_effect': 'ev_7199407875fd945ae708cfdfaabfd31e75f0148dd8b57f794f1095e39d526c30',
    'reaction': 'ev_819c494be2480aa13c8f4c1284771c975ac31dc656933e6ee75cb13483e577ae',
    'reaction_select': 'ev_2614dc7c8e9b5453712dd345a9354e114f6636d682dd307d60da313df8c004ac',
    'terminal_command': 'ev_28368650259f3980bb37bf5b679f3a547aa66aa025d16e78432827d87efb27ab',
    'terminal_cleanup': 'ev_edcb55141827495dc256b7857ff40d1ab90f34d1605e9a9bb3d1e93130eb5e95',
}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def save_json(path: Path, value) -> None:
    if not path.resolve().is_relative_to(PROJECT.resolve()):
        raise DGPError('Export must stay within remake/runtime')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), 'utf-8')


def indexed_rows(dgp: DGP, frame: int):
    """0x52A278: FFFF empty row; absolute x, length, length byte indices."""
    record = dgp.indexed_auxiliary[frame]
    if not record['active_raw']:
        return
    start = record['indexed_pixels_offset']
    r = Reader(dgp.data[start:start + record['indexed_pixels_bytes']])
    for y in range(dgp.height):
        count = u16(r.take(2), 0)
        if count == 0xFFFF:
            yield y, []
            continue
        if count > dgp.width:
            raise DGPError(f'Indexed frame {frame} row {y}: excessive span count')
        spans, previous_end = [], 0
        for _ in range(count):
            x, size = struct.unpack('<HH', r.take(4))
            if x < previous_end or x + size > dgp.width:
                raise DGPError(f'Indexed frame {frame} row {y}: overlapping/out-of-bounds span')
            previous_end = x + size
            spans.append((x, size, r.take(size)))
        yield y, spans
    if r.pos != len(r.data):
        raise DGPError(f'Indexed frame {frame}: {len(r.data) - r.pos} trailing bytes')


def indexed_contribution(dgp: DGP, frame: int) -> tuple[Image.Image, dict]:
    """RGB565 additive contribution represented in 8-bit RGB by left shifts.

    A covered index is never treated as a transparent key. Alpha encodes sparse
    coverage only. The original renderer adds each quantized component to the
    destination and clamps it to the surface's corresponding channel maximum.
    """
    record = dgp.indexed_auxiliary[frame]
    pixels = bytearray(dgp.width * dgp.height * 4)
    stats = dict(frame=frame, covered_pixels=0, index_zero_pixels=0,
                 index_255_pixels=0, nonblack_pixels=0, bounds=None)
    if record['active_raw']:
        p = record['palette_offset']
        palette = dgp.data[p:p + 768]
        bounds = [dgp.width, dgp.height, 0, 0]
        for y, spans in indexed_rows(dgp, frame):
            for x, count, indices in spans:
                if count:
                    bounds = [min(bounds[0], x), min(bounds[1], y),
                              max(bounds[2], x + count), max(bounds[3], y + 1)]
                for dx, index in enumerate(indices):
                    red, green, blue = palette[index * 3:index * 3 + 3]
                    color = bytes((red & 0xF8, green & 0xFC, blue & 0xF8, 255))
                    q = ((y * dgp.width) + x + dx) * 4
                    pixels[q:q + 4] = color
                    stats['covered_pixels'] += 1
                    stats['index_zero_pixels'] += index == 0
                    stats['index_255_pixels'] += index == 255
                    stats['nonblack_pixels'] += any(color[:3])
        if stats['covered_pixels']:
            stats['bounds'] = bounds
    stats['rgba_sha256'] = sha(pixels)
    return Image.frombytes('RGBA', (dgp.width, dgp.height), bytes(pixels)), stats


def native_frame_sequence(raw_action: bytes, start: int, end: int, reverse: int,
                          *, total_frames: int | None = None) -> list[int]:
    """Bounded 0x50E980 frame interval, not an invented whole-group sequence."""
    if start < 0 or end < start:
        raise DGPError('CHR end-exclusive frame bound precedes its start')
    if total_frames is not None and (type(total_frames) is not int or total_frames <= 0):
        raise DGPError('DGP global frame pool must have a positive size')
    first = u32(raw_action, 0x72)
    if raw_action[0x0D] & 0x0F:
        if total_frames is not None and first + end > total_frames:
            raise DGPError('Frame sequence leaves its DGP global frame pool')
        sequence = list(range(start, end))
    else:
        # 50E980 indexes +16 with the CHR range, independently of +12's
        # declared sequence count. Shipped024 ID4 reads five zero entries
        # although its action4 declares two; all five repeat source frame37.
        if end > 0x5C:
            raise DGPError('DGP explicit sequence exceeds retained +0x16 table')
        sequence = list(raw_action[0x16 + start:0x16 + end])
    # 50E980 writes action+72 plus the CHR/local frame directly (50F2D7-E6).
    # Some shipped responses cross the nominal group end. Such a reference is
    # admitted only when its real DGP pool is known; callers without that pool
    # retain the conservative per-group bound.
    if total_frames is not None and any(first + i >= total_frames for i in sequence):
        raise DGPError('Frame sequence leaves its DGP global frame pool')
    if total_frames is None and any(i >= raw_action[0x0E] for i in sequence):
        raise DGPError('Frame sequence leaves its DGP physical group')
    return list(reversed(sequence)) if reverse else sequence


def export_effect(filename: str) -> tuple[dict, dict]:
    source = ROOT / 'Fight_Role/Effect' / filename
    dgp = DGP(source)
    if len(dgp.indexed_auxiliary) != dgp.frame_count:
        raise DGPError(f'{filename}: missing indexed records')
    main_pixels = sum(size for frame in range(dgp.frame_count)
                      for _, spans in dgp.rows(frame) for _, size, _ in spans)
    if main_pixels != 0:
        raise DGPError('This bounded indexed-only effect export must not omit a main pixel layer')
    key = source.stem
    target = ASSETS / key
    target.mkdir(parents=True, exist_ok=True)
    frame_images, checks = [], []
    for frame in range(dgp.frame_count):
        image, check = indexed_contribution(dgp, frame)
        if not check['nonblack_pixels']:
            raise DGPError(f'{filename}: indexed frame {frame} has no real color contribution')
        frame_images.append(image)
        checks.append({**check, **dgp.indexed_auxiliary[frame]})
    actions = []
    total = 0
    for action, raw in zip(dgp.actions, dgp.raw_actions, strict=True):
        n, directions = action['frames_per_direction'], action['directions']
        if action['first_frame'] != total:
            raise DGPError('Effect actions must exactly partition physical frames')
        sheet = Image.new('RGBA', (dgp.width * n, dgp.height * directions))
        for direction in range(directions):
            for column in range(n):
                index = action['first_frame'] + direction * n + column
                sheet.paste(frame_images[index], (column * dgp.width, direction * dgp.height))
        output = target / f"action_{action['index']:02d}.png"
        sheet.save(output)
        with Image.open(output) as stored:
            if stored.convert('RGBA').tobytes() != sheet.tobytes():
                raise DGPError('Indexed effect PNG round trip differs')
        entry = {k: action[k] for k in ('index', 'directions', 'directions_raw',
                                        'frames_per_direction', 'first_frame', 'interval_raw', 'loop_raw')}
        entry.update(sheet=output.relative_to(WEB).as_posix(),
                     sheet_sha256=sha(output.read_bytes()),
                     sheet_rgba_sha256=sha(sheet.tobytes()),
                     sheet_width=sheet.width, sheet_height=sheet.height,
                     frame_sequence=native_frame_sequence(raw, 0, n, 0),
                     frame_layout='columns=frames_per_direction; rows=directions')
        actions.append(entry)
        total += n * directions
    if total != dgp.frame_count:
        raise DGPError('Effect actions do not cover every physical frame')
    asset = dict(id=key, source=source.relative_to(ROOT).as_posix(),
                 source_sha256=dgp.sha256, frame_width=dgp.width, frame_height=dgp.height,
                 anchor=dict(x=dgp.anchor_raw[0], y=dgp.anchor_raw[1]), anchor_raw=dgp.anchor_raw,
                 actions=actions, native_default_action_index=0,
                 blend='additive', pixel_encoding='rgb565-additive-contribution',
                 sparse_holes='alpha=0; covered indices alpha=255; no color key',
                 evidence=[NATIVE_IDS[k] for k in ('loader', 'indexed_draw', 'pixel_format', 'effect_action')])
    verification = dict(id=key, source=asset['source'], source_sha256=dgp.sha256,
                        primary_covered_pixels=main_pixels, indexed_frames=len(checks),
                        covered_pixels=sum(c['covered_pixels'] for c in checks),
                        nonblack_pixels=sum(c['nonblack_pixels'] for c in checks),
                        frames=checks, actions=actions, eof_verified=True, png_roundtrip_equal=True)
    return asset, verification


def field_text(raw: bytes, offset: int, size: int) -> str:
    return raw[offset:offset + size].split(b'\0', 1)[0].decode('ascii', 'strict')


def export_skill(role: CHR, dgp: DGP, skill_index: int) -> dict:
    skill = role.skills[skill_index]
    sequence, terminal = [], []
    for action in skill['actions']:
        raw = bytes.fromhex(action['raw_hex'])
        origin = dict(source=role.path.relative_to(ROOT).as_posix(), offset=action['offset'],
                      bytes=len(raw), raw_hex=raw.hex(), raw_sha256=sha(raw))
        group = u32(raw, 1)
        if raw[0] != 0:
            if (raw[0], group) != (1, 11):
                raise DGPError('Only the observed type1 command11 terminal path is exported')
            terminal.append(dict(chr_record_index=action['index'], type_raw=raw[0],
                                 command_raw=group, behavior='0x5130D0 case 0xB calls 0x511C30 cleanup then advances the action record',
                                 raw=origin, evidence=[NATIVE_IDS['terminal_command'], NATIVE_IDS['terminal_cleanup']]))
            continue
        if group >= len(dgp.actions):
            raise DGPError('CHR references a nonexistent DGP action')
        start, end = u32(raw, 0x26), u32(raw, 0x2A)
        frames = native_frame_sequence(dgp.raw_actions[group], start, end, raw[0x1D])
        effects = []
        for offset, event_offset, placement, condition in (
            (9, 5, 'player', 'CHR +0x09 filename nonempty and current logical frame equals DWORD +0x05; attached to acting role'),
            (0x4E, 0x49, 'target', '0x50FA00 settlement path produces nonzero damage, +0x4E filename nonempty; attached to affected defender; other native gates still apply'),
        ):
            token = field_text(raw, offset, 20)
            if not token:
                continue
            if token not in EFFECTS:
                raise DGPError(f'Unexpected effect token {token}')
            event = u32(raw, event_offset)
            effects.append(dict(asset_id=Path(token).stem, action_index=0,
                                trigger_frame=event, placement=placement, condition=condition,
                                filename_field=hex(offset), event_field=hex(event_offset),
                                source_file_offset=action['offset'] + offset,
                                evidence=[NATIVE_IDS['events'], NATIVE_IDS['effect_queue'],
                                          NATIVE_IDS['effect_path'], NATIVE_IDS['effect_action']] +
                                         ([NATIVE_IDS['settlement_effect']] if placement == 'target' else [])))
        event = u32(raw, 0x49)
        segment = dict(chr_record_index=action['index'], type_raw=raw[0], action_index=group,
                       native_action_index_verified=True, frame_sequence=frames,
                       frame_sequence_confirmed=True, preview_sequence=list(range(dgp.actions[group]['frames_per_direction'])),
                       native_frame_range=dict(start=start, end_exclusive=end, reverse_raw=raw[0x1D]),
                       effects=effects,
                       combat_event=dict(frame=event, field='0x49', evidence=[NATIVE_IDS['events'], NATIVE_IDS['settlement_effect']]) if event else None,
                       reaction_class_raw=raw[0x62], target_class_raw=raw[0x24],
                       raw_reject_mask=raw[0x78], movement_flag_raw=raw[0x25],
                       unresolved_event_0x6a_raw=u32(raw, 0x6A),
                       sound_token_raw=field_text(raw, 0x7A, 20), sound_event_0x8e_raw=u32(raw, 0x8E),
                       raw=origin, evidence=[NATIVE_IDS['range'], NATIVE_IDS['range_pseudo'], NATIVE_IDS['events']])
        sequence.append(segment)
    reaction = dict(role_id='012', skill_index=1, action_index=1,
        condition='normal surviving reaction branch requesting CHR reaction class 1; 0x51C640 has state-specific alternate/fallback branches; not unconditional on every combat event',
        evidence=[NATIVE_IDS['reaction'], NATIVE_IDS['reaction_select']])
    return dict(role_id='001', skill_index=skill_index, id_raw=skill['id_raw'], name=skill['name_cp936'],
                source=role.path.relative_to(ROOT).as_posix(), source_sha256=role.sha256,
                skill_source_offset=skill['offset'], fixed_raw_sha256=sha(bytes.fromhex(skill['fixed_raw_hex'])),
                sequence=sequence, terminal_commands=terminal,
                target_reaction=reaction, death_action=None,
                recipe=dict(target_reaction=reaction, death_action=None))


def require_evidence() -> None:
    bundle = json.loads((EVIDENCE / 'combat_presentation_native_20261011.json').read_text('utf-8'))
    ids = {r['evidence_id'] for r in bundle['records']}
    if missing := set(NATIVE_IDS.values()) - ids:
        raise DGPError(f'Missing retained native evidence: {sorted(missing)}')
    if sha((ROOT / 'GAME.exe').read_bytes()) != GAME_SHA256:
        raise DGPError('Native evidence GAME.exe hash mismatch')


def main() -> None:
    require_evidence()
    sources = [ROOT / 'GAME.exe', ROOT / 'Fight_Role/001.CHR', ROOT / 'Fight_Role/001.dgp',
               ROOT / 'Fight_Role/012.CHR', ROOT / 'Fight_Role/012.dgp']
    sources += [ROOT / 'Fight_Role/Effect' / name for name in EFFECTS]
    before = {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in sources}
    old_manifest = WEB / 'data/source/combat_manifest.json'
    original_manifest_hash = sha(old_manifest.read_bytes())
    role, dgp = CHR(ROOT / 'Fight_Role/001.CHR'), DGP(ROOT / 'Fight_Role/001.dgp')
    snow = CHR(ROOT / 'Fight_Role/012.CHR')
    category1 = [s['index'] for s in snow.skills if s['id_raw'] == 1]
    if category1 != [1] or snow.skills[1]['actions'][0]['u32_at_0x01_raw'] != 1:
        raise DGPError('Snow reaction is no longer the unique category1 skill/action1')
    assets, checks = zip(*(export_effect(name) for name in EFFECTS), strict=True)
    skills = [export_skill(role, dgp, index) for index in SKILLS]
    limits = [
        'Only role001 skills22/24/25 and their three literal DGP effects are reconstructed here.',
        'Skill/action identity and seven segment frame ranges are native backed; movement trajectories, camera and combined timing are not replayed.',
        'interval_raw remains original DWORD; browser demonstration speed is not an original-game timing claim.',
        'PNG RGB is an RGB565 additive contribution: source palette R/B are truncated to multiples of8, G to multiples of4; alpha preserves sparse coverage only.',
        'Native indexed draw saturates channel sums on the destination RGB565/RGB555 surface. Canvas lighter is a presentation approximation unless destination quantization is also emulated.',
        'BFr target effect is conditional on nonzero damage and native branch gates. A browser demonstration may explicitly preview it without reproducing damage.',
        'Snow reaction action1 is established for the ordinary surviving class1 branch; state alternatives and death action selection remain unresolved.',
        'CHR +0x6A is retained without claiming a hit event; the observed settlement trigger is DWORD +0x49.',
        'Type1 command11 terminates these sequences through cleanup; it is not an effect filename or DGP action index.',
        'No ANM/ECP effect indirection occurs in the confirmed +0x09/+0x4E token paths for this bounded sample.',
    ]
    manifest = dict(schema='seventh-seal-combat-presentation', version=1,
                    native_action_index_verified=True, skills=skills, assets=list(assets),
                    source_hashes=before, evidence=dict(bundle='remake/runtime/evidence/source/combat_presentation_native_20261011.json',
                        references=NATIVE_IDS), limits=limits)
    after = {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in sources}
    if before != after or sha(old_manifest.read_bytes()) != original_manifest_hash:
        raise DGPError('Original input or existing combat manifest changed during export')
    save_json(WEB / 'data/source/combat_presentation.json', manifest)
    verification = dict(schema='seventh-seal-combat-presentation-verification', version=1,
        original_inputs_unchanged=True, source_hashes_before=before, source_hashes_after=after,
        previous_combat_manifest_unchanged=True, previous_combat_manifest_sha256=original_manifest_hash,
        assets=list(checks), skills=[dict(role_id=s['role_id'], skill_index=s['skill_index'],
            dgp_sequence=[x['action_index'] for x in s['sequence']],
            source_frames=sum(len(x['frame_sequence']) for x in s['sequence'])) for s in skills],
        exported_effect_frames=sum(c['indexed_frames'] for c in checks),
        indexed_covered_pixels=sum(c['covered_pixels'] for c in checks))
    save_json(EVIDENCE / 'combat_presentation_verification_20261011.json', verification)
    print(json.dumps(dict(skills=len(skills), assets=len(assets), frames=verification['exported_effect_frames'],
                         indexed_covered_pixels=verification['indexed_covered_pixels'],
                         original_inputs_unchanged=True, previous_manifest_unchanged=True)))


if __name__ == '__main__':
    main()
