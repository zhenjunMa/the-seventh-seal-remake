"""Incrementally export native per-frame ROLE shadow masks, leaving main/light PNGs intact.

Also imported by the registered map-effects exporter. Inputs in the game root
are read-only; generated assets and the verification ledger stay in remake.
"""
from __future__ import annotations

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
from source.dgp import DGP, DGPError
from PIL import Image

GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'
EVIDENCE = ['ev_eb99cdc708334aa3c802009d14bd69c55ec0ea8966cbcebed14d22c589ea7a9b',
            'ev_8742bac48db84c1a41d0f484e0a65f166747220758a7659523a8940d01f4c32c',
            'ev_7515c2967c274d7710d9bc0107185694d39d193b99f5f69e4996a99cf61fd752']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def audit_mask(blob, width, height):
    """Independent direct-offset mask replay, not DGP.shadow_rows/decode_shadow."""
    mask = bytearray(width * height)
    offset = 0
    for y in range(height):
        if offset + 2 > len(blob):
            raise DGPError('Independent shadow audit: truncated row')
        count = int.from_bytes(blob[offset:offset + 2], 'little')
        offset += 2
        if count == 0xffff:
            continue
        end = offset + count * 4
        if end > len(blob):
            raise DGPError('Independent shadow audit: truncated spans')
        previous_end = 0
        for x, length in struct.iter_unpack('<HH', blob[offset:end]):
            if x < previous_end or x + length > width:
                raise DGPError('Independent shadow audit: invalid span')
            mask[y * width + x:y * width + x + length] = bytes([128]) * length
            previous_end = x + length
        offset = end
    if offset != len(blob):
        raise DGPError('Independent shadow audit: trailing bytes')
    return bytes(mask)


def export():
    if sha(ROOT / 'GAME.exe') != GAME_SHA:
        raise DGPError('Revalidate shadow evidence for this GAME.exe version')
    native = read(RUNTIME / 'evidence/movement_audit_20261023/native_evidence.json')
    retained = [row for row in native['records'] if row['evidence_id'] in EVIDENCE]
    if {row['evidence_id'] for row in retained} != set(EVIDENCE) or any(
            row['subject']['digest']['sha256'] != GAME_SHA for row in retained):
        raise DGPError('Shadow native evidence is missing or bound to another executable')

    # Export precisely the actions selected by the established manifests.
    selected, rasters = {}, set()
    for name in ['opening_map_resources.json', 'chapter_map_resources.json']:
        for ident, role in read(WEB / 'data' / name)['roles'].items():
            selected[ident] = dict(source=role['source']['path'],
                                   actions={a['index'] for a in role['actions']}, event_only=False)
            rasters.update(WEB / a['sheet'].lstrip('/') for a in role['actions'])
    event_path = WEB / 'data/events.json'
    events = read(event_path) if event_path.exists() else []
    if isinstance(events, dict):
        events = events['events']
    for event in events:
        resource = event.get('npc', {}).get('resource')
        if not resource:
            continue
        ident = Path(resource['source']).stem
        chosen = selected.setdefault(ident, dict(source=resource['source'], actions=set(), event_only=True))
        chosen['actions'].add(0)
        rasters.add(WEB / resource['sheet'].lstrip('/'))
    # These are the leader's original preview PNGs; they must also stay intact.
    for role in read(WEB / 'data/catalog.json')['roles']:
        for action in role['actions']:
            path = action['sheet']
            rasters.add(WEB / path.lstrip('/'))
    effects = read(WEB / 'data/map_effects.json')
    rasters.update(WEB / a['intrinsic_sheet'].lstrip('/') for role in effects['roles'].values()
                   for a in role['actions'] if a.get('intrinsic_sheet'))
    raster_before = {p.relative_to(ROOT).as_posix(): sha(p) for p in sorted(rasters)}

    sources = {'GAME.exe': GAME_SHA}
    roles, outputs, checks = {}, {}, []
    full_rgba_bytes, compact_rgba_bytes, empty_actions = 0, 0, []
    for ident, choice in sorted(selected.items()):
        if len(ident) != 3 or not ident.isdecimal() or Path(choice['source']).stem != ident:
            raise DGPError('Shadow role must use its original three-digit ROLE resource ID')
        dgp = DGP(ROOT / choice['source'])
        sources[choice['source']] = dgp.sha256
        if not dgp.shadow_blobs:
            continue
        actions = []
        for index in sorted(choice['actions']):
            action = dgp.actions[index]
            target = WEB / f'assets/map_shadows/{ident}/action_{index:02}_shadow.png'
            n, dirs = action['frames_per_direction'], action['directions']
            if n <= 0 or dirs <= 0:
                raise DGPError('Shadow action has an empty physical frame group')
            sheet = Image.new('RGBA', (n * dgp.width, dirs * dgp.height))
            bounds = []
            for direction in range(dirs):
                for frame in range(n):
                    physical = action['first_frame'] + direction * n + frame
                    image = dgp.decode_shadow(physical)
                    expected = audit_mask(dgp.shadow_blobs[physical], dgp.width, dgp.height)
                    if image.getchannel('A').tobytes() != expected or image.convert('RGB').getbbox():
                        raise DGPError('Shadow decoder differs from the independent source mask replay')
                    if image.getbbox():
                        bounds.append(image.getbbox())
                    sheet.paste(image, (frame * dgp.width, direction * dgp.height))
                    checks.append(dict(role=ident, action=index, direction=direction, physical_frame=physical,
                                       covered_pixels=expected.count(128), blob_bytes=len(dgp.shadow_blobs[physical]),
                                       blob_sha256=hashlib.sha256(dgp.shadow_blobs[physical]).hexdigest()))
            full_rgba_bytes += n * dirs * dgp.width * dgp.height * 4
            if not bounds:
                empty_actions.append(dict(role=ident, action=index))
                target.unlink(missing_ok=True)
                continue
            left, top = min(b[0] for b in bounds), min(b[1] for b in bounds)
            right, bottom = max(b[2] for b in bounds), max(b[3] for b in bounds)
            width, height = right - left, bottom - top
            compact = Image.new('RGBA', (n * width, dirs * height))
            for direction in range(dirs):
                for frame in range(n):
                    physical = action['first_frame'] + direction * n + frame
                    x, y = frame * dgp.width, direction * dgp.height
                    cropped = sheet.crop((x + left, y + top, x + right, y + bottom))
                    compact.paste(cropped, (frame * width, direction * height))
                    restored = Image.new('RGBA', (dgp.width, dgp.height))
                    restored.paste(cropped, (left, top))
                    if restored.getchannel('A').tobytes() != audit_mask(dgp.shadow_blobs[physical], dgp.width, dgp.height):
                        raise DGPError('Compact shadow atlas cannot reconstruct the independent original mask')
            compact_rgba_bytes += compact.width * compact.height * 4
            sheet = compact
            target.parent.mkdir(parents=True, exist_ok=True)
            sheet.save(target)
            with Image.open(target) as stored:
                if stored.convert('RGBA').tobytes() != sheet.tobytes():
                    raise DGPError('Shadow atlas PNG round-trip differs')
            url = '/' + target.relative_to(WEB).as_posix()
            outputs[url] = sha(target)
            actions.append(dict(index=index, first_frame=action['first_frame'], frame_count=n, directions=dirs,
                                shadow_sheet=url, shadow_geometry=dict(x=left, y=top, width=width, height=height),
                                sha256=outputs[url]))
        roles[ident] = dict(source=dict(path=choice['source'], sha256=dgp.sha256),
                            frame_width=dgp.width, frame_height=dgp.height,
                            event_only=choice['event_only'], actions=actions)
    manifest = WEB / 'data/map_shadows.json'
    write(manifest, dict(schema='seventh-seal-map-shadows', version=1, roles=roles,
                         alpha=128, blend='source-over', evidence=EVIDENCE,
                         source_rule='DGP geometry[41] per-physical-frame sparse masks; action-wide union crop plus shadow_geometry restores original frame coordinates and anchor',
                         limits=['Native halves RGB565/555 destination components; black alpha 128 approximates this in 8-bit Canvas/Phaser.',
                                 'Actor shadow is drawn immediately before its main/light layers at the same actor depth.',
                                 'No original executable execution or bit-exact pixel/timing comparison is claimed.']))
    outputs['/data/map_shadows.json'] = sha(manifest)
    after = {p: sha(ROOT / p) for p in sources}
    raster_after = {name: sha(ROOT / name) for name in raster_before}
    if sources != after or raster_before != raster_after:
        raise DGPError('Read-only sources or pre-existing main/light PNGs changed')
    report = dict(schema='seventh-seal-map-shadow-export', version=1, passed=True,
                  source_bytes_unchanged=True, source_hashes=sources, source_hashes_after=after,
                  main_and_light_pngs_unchanged=True, main_and_light_png_hashes=raster_after,
                  output_hashes=outputs, roles=list(roles), frame_checks=checks,
                  independent_source_mask_replay=True, evidence=EVIDENCE,
                  compact_atlas_reconstruction_verified=True, empty_actions_omitted=empty_actions,
                  full_frame_rgba_bytes=full_rgba_bytes, compact_atlas_rgba_bytes=compact_rgba_bytes,
                  original_game_execution_observed=False)
    write(RUNTIME / 'evidence/movement_optimization_20261023/shadow_export.json', report)
    return report


if __name__ == '__main__':
    report = export()
    print(json.dumps(dict(passed=True, roles=report['roles'], frames=len(report['frame_checks']),
                          outputs=len(report['output_hashes']), source_bytes_unchanged=True)))
