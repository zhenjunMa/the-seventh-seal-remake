"""Export registered SCN v2/mode4 stages using the recovered zero-camera rules.

New stage IDs select Fight_Bk/<id>.scn. Existing explicit manifests retain their
specialized exporters unless export="source" is selected. Original files are read-only.
"""
from pathlib import Path
import hashlib
import json
import re
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
sys.path.insert(0, str(RUNTIME / 'tools'))
sys.path.insert(0, str(RUNTIME.parent / 'prototype/tools'))
from content_registration import stage_exports

RECORD_START, RECORD_BYTES = 0x62c4, 0x47


def sha(value):
    return hashlib.sha256(value).hexdigest()


def u32(value, offset):
    return struct.unpack_from('<I', value, offset)[0]


def stage_records(raw, ident):
    if len(raw) < RECORD_START or u32(raw, 0) != 2 or u32(raw, 0x38) != 4:
        raise ValueError(f'Stage {ident}: unsupported SCN version/rendering mode')
    count = u32(raw, 0x34) + 2
    if not 2 <= count <= 256 or len(raw) != RECORD_START + count * RECORD_BYTES:
        raise ValueError(f'Stage {ident}: unsupported SCN record layout')
    rows = []
    for index in range(count):
        at = RECORD_START + index * RECORD_BYTES
        record = raw[at:at + RECORD_BYTES]
        name = record[1:21].split(b'\0')[0].decode('ascii')
        if record[0] != min(index, 2) or not re.fullmatch(r'[A-Za-z0-9_-]+\.[dD][gG][pP]', name):
            raise ValueError(f'Stage {ident} record {index}: unsupported layer or filename')
        rows.append((name, record, at))
    if len({Path(name).stem.lower() for name, _, _ in rows}) != count:
        raise ValueError(f'Stage {ident}: duplicate layer identities')
    return rows


def source_files():
    names = {'GAME.exe'}
    for ident, row in stage_exports().items():
        if row['export'] != 'source':
            continue
        name = f'Fight_Bk/{ident}.scn'
        names.add(name)
        source = ROOT / name
        if source.is_file():
            names.update(f'Fight_Bk/{name}' for name, _, _ in stage_records(source.read_bytes(), ident))
    return tuple(sorted(names))


def prepare_stage(ident, entry):
    from dgp import DGP
    from export_skill_layers import SourceAudit
    name = f'Fight_Bk/{ident}.scn'
    raw = (ROOT / name).read_bytes()
    rows = []
    for index, (filename, record, at) in enumerate(stage_records(raw, ident)):
        graphics = DGP(ROOT / f'Fight_Bk/{filename}')
        audit = SourceAudit(graphics.data)
        if graphics.indexed_auxiliary or (audit.width, audit.height, audit.count, audit.anchor) != (graphics.width, graphics.height, graphics.frame_count, graphics.anchor_raw):
            raise ValueError(f'Stage {ident}: unsupported image channels or inconsistent decoder')
        if u32(record, 0x1d) >= graphics.frame_count:
            raise ValueError(f'Stage {ident}: invalid initial frame')
        animation = None
        if graphics.actions:
            if index != 0 or len(graphics.actions) != 1:
                raise ValueError(f'Stage {ident}: non-sky/multiple animation actions need a handler')
            action = graphics.actions[0]
            if action['directions'] != 1 or action['loop_raw'] != 1 or action['interval_raw'] <= 0 or action['frames_per_direction'] != graphics.frame_count:
                raise ValueError(f'Stage {ident}: unsupported sky animation')
            animation = dict(action_index=0, interval_raw=action['interval_raw'], loop_raw=1,
                frames=list(range(graphics.frame_count)), first_frame_raw=action['first_frame'],
                action_raw_hex=graphics.raw_actions[0].hex(), runtime_clock_observed=False)
        rows.append(dict(id=Path(filename).stem, graphics=graphics, audit=audit, raw=record, offset=at, animation=animation))
    sky, ground = (row['graphics'] for row in rows[:2])
    horizon = 480 - (ground.height - 95)
    if ground.width < 640 or not 0 < horizon < 480 or sky.width < 640 or sky.height < horizon:
        raise ValueError(f'Stage {ident}: zero-camera geometry needs a handler')
    return dict(id=ident, entry=entry, source_path=name, raw=raw, rows=rows, horizon=horizon)


def stage_composition(layers):
    """Same recovered 640x480 projection as the retained formal/test stages."""
    ground = layers[1]['source']
    gx, gy, gh = (ground['width'] >> 1) - 320, 95, ground['height']
    horizon = 480 - (gh - gy)
    composition = dict(viewport=dict(width=640, height=480), camera=dict(x=0, y=0, z=0),
        sky=dict(layer_id=layers[0]['id'], initial_frame=layers[0]['scn']['current_frame_raw_1d'],
            source_rect=[0, 0, 640, horizon], destination_rect=[0, 0, 640, horizon]),
        ground=dict(layer_id=layers[1]['id'], frame=layers[1]['scn']['current_frame_raw_1d'],
            source_rect=[gx, gy, 640, gh - gy], destination_rect=[0, horizon, 640, gh - gy]),
        scene_objects=[], camera_limit_x=(ground['width'] - 640) // 2 + 30,
        animated_camera_projection_implemented=False,
        draw_order='sky, ground, scenery textures, combat actors sorted by ground Y, then effects and HUD')
    for layer in layers[2:]:
        pos, source = layer['scn']['position_raw'], layer['source']
        x, y = pos['x'] - source['anchor_raw'][0], pos['y'] + pos['z'] + 480 - gh - source['anchor_raw'][1] - 32
        composition['scene_objects'].append(dict(layer_id=layer['id'], frame=layer['scn']['current_frame_raw_1d'],
            source_rect=[0, 0, source['width'], source['height']], destination_rect=[x, y, source['width'], source['height']],
            sort_category=layer['scn']['sort_category_raw_36'], sort_y=pos['y']))
    return composition


def export():
    selected = {ident: row for ident, row in stage_exports().items() if row['export'] == 'source'}
    if not selected:
        print(json.dumps(dict(passed=True, stages=[], message='No new source stages registered')))
        return
    from PIL import Image
    from combat_resources import GAME_SHA256
    from export_skill_layers import save_layer
    from export_forest_stage import image_asset
    before = {name: sha((ROOT / name).read_bytes()) for name in source_files()}
    if before['GAME.exe'] != GAME_SHA256:
        raise ValueError('Stage executable differs from recovered rules')
    reference_path = WEB / 'data/forest_stage.json'
    reference_bytes = reference_path.read_bytes()
    reference = json.loads(reference_bytes)
    if reference['source_hashes']['GAME.exe'] != GAME_SHA256:
        raise ValueError('Stage rule reference executable differs')
    prepared = [prepare_stage(ident, entry) for ident, entry in selected.items()]
    generated, checks = [], []
    for stage in prepared:
        ident, entry, rows, horizon = stage['id'], stage['entry'], stage['rows'], stage['horizon']
        layers, initial = [], {}
        for index, row in enumerate(rows):
            graphics, raw = row['graphics'], row['raw']
            frames = []
            for frame in range(graphics.frame_count):
                image = graphics.decode(frame)
                rgba, check = row['audit'].sparse(frame, False)
                output = WEB / entry['asset_prefix'] / row['id'] / f'frame_{frame:03}.png'
                output.parent.mkdir(parents=True, exist_ok=True)
                asset = save_layer(image, output, rgba, check)
                generated.append(output)
                frames.append(dict(index=frame, **asset))
                checks.append(dict(stage=ident, layer=row['id'], frame=frame, **check))
                if frame == u32(raw, 0x1d):
                    initial[row['id']] = image
            layers.append(dict(id=row['id'], role='sky' if index == 0 else 'ground' if index == 1 else 'scene_object',
                source=dict(path=graphics.path.relative_to(ROOT).as_posix(), sha256=graphics.sha256,
                    width=graphics.width, height=graphics.height, frame_count=graphics.frame_count,
                    anchor_raw=graphics.anchor_raw, header_raw_hex=graphics.header.hex()),
                scn=dict(record_index=index, offset=row['offset'], bytes=RECORD_BYTES, raw_hex=raw.hex(),
                    type_raw_00=raw[0], current_frame_raw_1d=u32(raw, 0x1d),
                    position_raw=dict(zip(('x', 'y', 'z'), struct.unpack_from('<iii', raw, 0x21))),
                    sort_category_raw_36=raw[0x36]), frames=frames, animation=row['animation']))
        composition = stage_composition(layers)
        gx, gy, _, ground_rows = composition['ground']['source_rect']
        gh = gy + ground_rows
        preview = Image.new('RGBA', (640, 480), 'black')
        preview.alpha_composite(initial[layers[0]['id']].crop((0, 0, 640, horizon)), (0, 0))
        preview.alpha_composite(initial[layers[1]['id']].crop((gx, gy, gx + 640, gh)), (0, horizon))
        for row in sorted(composition['scene_objects'], key=lambda row: (row['sort_category'], row['sort_y'])):
            preview.alpha_composite(initial[row['layer_id']], tuple(row['destination_rect'][:2]))
        preview_path = WEB / entry['asset_prefix'] / 'default_composite.png'
        preview_asset = image_asset(preview, preview_path)
        generated.append(preview_path)
        value = dict(schema=entry['schema'], version=1, stage_id=ident,
            source_scn=dict(path=stage['source_path'], sha256=before[stage['source_path']], version_raw=2,
                record_start=RECORD_START, record_bytes=RECORD_BYTES, record_count=len(rows),
                header_raw_hex=stage['raw'][:0x4c].hex(), opaque_block=dict(offset=0x4c,
                    bytes=RECORD_START - 0x4c, sha256=sha(stage['raw'][0x4c:RECORD_START]))),
            layers=layers, default_composition=composition, default_composite=preview_asset,
            source_hashes={name: before[name] for name in ['GAME.exe', stage['source_path'], *[layer['source']['path'] for layer in layers]]},
            native_evidence=reference['native_evidence'],
            derivation_source=dict(path='data/forest_stage.json', sha256=sha(reference_bytes)),
            original_game_execution_observed=False,
            limitations=['Recovered SCN v2/mode4 zero-camera layout only; dynamic camera, non-sky animation and exact native blending require additional handlers.'])
        output = WEB / entry['path']
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'utf-8')
        generated.append(output)
    if before != {name: sha((ROOT / name).read_bytes()) for name in before}:
        raise ValueError('Original stage sources changed during export')
    report = dict(schema='seventh-seal-battle-stages-export', version=1, passed=True, source_hashes=before,
        source_unchanged=True, stages=list(selected), frame_checks=checks,
        output_hashes={p.relative_to(RUNTIME).as_posix(): sha(p.read_bytes()) for p in generated},
        original_game_execution_observed=False)
    evidence = RUNTIME / 'evidence'
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / 'battle_stages_export.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    print(json.dumps(dict(passed=True, stages=list(selected), pixel_checks=len(checks))))


if __name__ == '__main__':
    export()
