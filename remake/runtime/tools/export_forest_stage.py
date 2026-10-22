"""Read-only stage13 SCN/DGP export and native default-camera composition.

The existing DGP decoder and an independent byte audit are reused. Original
resources are immutable; the browser manifest does not own camera transitions.
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
from combat_resources import GAME_SHA256
from dgp import DGP
from export_skill_layers import SourceAudit, save_layer

def sha(value): return hashlib.sha256(value).hexdigest()
def u32(raw, at): return struct.unpack_from('<I', raw, at)[0]
def i32(raw, at): return struct.unpack_from('<i', raw, at)[0]
def save(path, data):
    assert path.resolve().is_relative_to(RUNTIME.resolve())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', 'utf-8')
def image_asset(image, path):
    assert path.resolve().is_relative_to(RUNTIME.resolve())
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)
    with Image.open(path) as saved:
        assert saved.convert('RGBA').tobytes() == image.tobytes()
    return dict(path='/' + path.relative_to(WEB).as_posix(), sha256=sha(path.read_bytes()),
                width=image.width, height=image.height)

def main():
    paths = ['GAME.exe', 'Fight_Bk/stage13.scn', 'Fight_Bk/FS13A.DGP',
             'Fight_Bk/FG13A.DGP', 'Fight_Bk/FB13A.DGP']
    before = {p: sha((ROOT / p).read_bytes()) for p in paths}
    assert before['GAME.exe'] == GAME_SHA256
    bundle = RUNTIME / 'evidence/forest_stage_native.json'
    records = json.loads(bundle.read_text('utf-8'))['records']
    def proof(selector, operation='procedure_pseudo_code'):
        record = next(r for r in records if r['operation'] == operation and
                      (r['parameters'].get('procedure') or r['parameters'].get('address')) == selector)
        return dict(selector=selector, evidence_id=record['evidence_id'],
                    bundle=bundle.relative_to(ROOT).as_posix())
    evidence = dict(loader=proof('0x51c48f'), register=proof('0x51c070'),
        viewport=proof('0x67c3a0', 'read_bytes'), background_draw=proof('0x515d03'),
        sky_draw=proof('0x5154d8'), ground_scanlines=proof('0x5145d0', 'procedure_assembly'),
        object_projection=proof('0x513fc0', 'procedure_assembly'),
        object_queue=proof('0x514990'), depth_sort=proof('0x515320'),
        animation=proof('0x51d28f'))
    scn = (ROOT / paths[1]).read_bytes()
    assert u32(scn, 0) == 2 and u32(scn, 0x34) == 1 and u32(scn, 0x38) == 4
    offset, size, count = 0x62c4, 0x47, u32(scn, 0x34) + 2
    assert offset + count * size == len(scn)
    layers, checks, generated, images = [], [], [], {}
    names = ['FS13A.DGP', 'FG13A.DGP', 'FB13A.DGP']
    for index, name in enumerate(names):
        at = offset + index * size
        raw = scn[at:at + size]
        assert raw[0] == index and raw[1:21].split(b'\0')[0].decode('ascii').upper() == name
        d = DGP(ROOT / f'Fight_Bk/{name}')
        audit = SourceAudit(d.data)
        assert (audit.width, audit.height, audit.count, audit.anchor) == (d.width, d.height, d.frame_count, d.anchor_raw)
        assert not d.indexed_auxiliary
        expected = [(740, 250, 30), (1400, 400, 1), (899, 399, 1)][index]
        assert (d.width, d.height, d.frame_count) == expected
        frames = []
        decoded = []
        for frame in range(d.frame_count):
            image = d.decode(frame)
            rgba, check = audit.sparse(frame, False)
            path = WEB / f'assets/forest_stage/{Path(name).stem}/frame_{frame:03}.png'
            path.parent.mkdir(parents=True, exist_ok=True)
            asset = save_layer(image, path, rgba, check)
            frames.append(dict(index=frame, **asset))
            checks.append(dict(layer=name, frame=frame, **check))
            decoded.append(image)
            generated.append(path)
        images[name] = decoded
        animation = None
        if d.actions:
            assert index == 0 and len(d.actions) == 1
            action = d.actions[0]
            assert action['directions'] == 1 and action['interval_raw'] == 80
            assert action['loop_raw'] == 1 and action['frames_per_direction'] == 30
            animation = dict(action_index=0, interval_raw=80, loop_raw=1,
                frames=list(range(30)), first_frame_raw=action['first_frame'],
                action_raw_hex=d.raw_actions[0].hex(),
                counter_raw_34=raw[0x34], current_frame_raw_1d=u32(raw, 0x1d),
                clock='native elapsed-time gate; one increment per accepted call, no catch-up loop',
                runtime_clock_observed=False, evidence=evidence['animation'])
        layers.append(dict(id=Path(name).stem, role=['sky', 'ground', 'scene_object'][index],
            source=dict(path=f'Fight_Bk/{name}', sha256=d.sha256,
                        width=d.width, height=d.height, frame_count=d.frame_count,
                        anchor_raw=d.anchor_raw, header_raw_hex=d.header.hex()),
            scn=dict(record_index=index, offset=at, bytes=size, raw_hex=raw.hex(),
                     type_raw_00=raw[0], cached_asset_id_raw_15=u32(raw, 0x15),
                     cached_queue_index_raw_19=u32(raw, 0x19),
                     current_frame_raw_1d=u32(raw, 0x1d),
                     position_raw=dict(x=i32(raw, 0x21), y=i32(raw, 0x25), z=i32(raw, 0x29)),
                     cached_tick_raw_2d=u32(raw, 0x2d),
                     flags_raw_31_36=list(raw[0x31:0x37]),
                     sort_category_raw_36=raw[0x36],
                     remaining_raw_hex=raw[0x37:].hex()),
            frames=frames, animation=animation))
    assert layers[0]['scn']['current_frame_raw_1d'] == 28
    assert layers[2]['scn']['position_raw'] == dict(x=314, y=126, z=0)
    assert layers[2]['scn']['sort_category_raw_36'] == 1
    width, height, ground_height = 640, 480, layers[1]['source']['height']
    ground_x = (layers[1]['source']['width'] >> 1) - (width >> 1)
    ground_y = 0x5f
    ground_rows = ground_height - ground_y
    horizon = height - ground_rows
    assert (ground_x, ground_y, ground_rows, horizon) == (380, 95, 305, 175)
    ground = images['FG13A.DGP'][0].crop((ground_x, ground_y, ground_x + width, ground_height))
    ground_path = WEB / 'assets/forest_stage/ground_default.png'
    ground_asset = image_asset(ground, ground_path)
    generated.append(ground_path)
    foreground = layers[2]
    position, anchor = foreground['scn']['position_raw'], foreground['source']['anchor_raw']
    object_x = position['x'] - anchor[0]
    object_y = position['y'] + position['z'] + height - ground_height - anchor[1] - 32
    assert (object_x, object_y) == (-142, -185)
    composition = dict(viewport=dict(width=width, height=height, authority='initial GAME.exe global bytes',
                                    evidence=evidence['viewport']),
        camera=dict(x=0, y=0, z=0, authority='loader initializes camera offsets to zero'),
        sky=dict(layer_id='FS13A', initial_frame=28, source_rect=[0, 0, 640, 175],
                 destination_rect=[0, 0, 640, 175], clip_bottom=175,
                 origin_ignores_dgp_anchor=True, evidence=evidence['sky_draw']),
        ground=dict(layer_id='FG13A', frame=0, source_rect=[380, 95, 640, 305],
                    destination_rect=[0, 175, 640, 305], cropped_asset=ground_asset,
                    source_row_at_screen_y='source_y = screen_y - (viewport_height - ground_height)',
                    source_x_at_camera_zero=380, evidence=evidence['ground_scanlines']),
        scene_objects=[dict(layer_id='FB13A', frame=0, destination_rect=[object_x, object_y, 899, 399],
            source_rect=[0, 0, 899, 399], sort_category=1, sort_y=126,
            projection_at_camera_zero=dict(x='record.x - DGP.anchor.x',
                y='record.y + record.z + viewport.height - ground.height - DGP.anchor.y - 32'),
            placement_is_top_left=True, evidence=evidence['object_projection'])],
        draw_order='sky, ground, scenery textures, combat actors sorted by ground Y, then effects and HUD',
        scene_object_order='FB13A belongs to the background pass and is always below combat actors',
        native_queue_order='Retained category/source Y metadata; the browser scenery pass does not interleave textures with actors',
        sort_evidence=evidence['depth_sort'],
        browser_adapter='Scale one 640x480 coordinate system uniformly; draw natural source rectangles. Finish all scenery textures before combat actors, independent of formation or movement.',
        camera_limit_x=(1400 - 640) // 2 + 30,
        animated_camera_projection_implemented=False)
    preview = Image.new('RGBA', (width, height), 'black')
    preview.alpha_composite(images['FS13A.DGP'][28].crop((0, 0, width, horizon)), (0, 0))
    preview.alpha_composite(ground, (0, horizon))
    preview.paste(images['FB13A.DGP'][0], (object_x, object_y), images['FB13A.DGP'][0])
    preview_path = WEB / 'assets/forest_stage/default_composite.png'
    preview_asset = image_asset(preview, preview_path)
    generated.append(preview_path)
    out = WEB / 'data/forest_stage.json'
    save(out, dict(schema='seventh-seal-forest-stage', version=1, stage_id='stage13',
        source_scn=dict(path=paths[1], sha256=before[paths[1]], version_raw=2,
            header_raw_hex=scn[:0x4c].hex(), record_start=offset, record_bytes=size, record_count=count,
            opaque_block=dict(offset=0x4c, bytes=offset - 0x4c, sha256=sha(scn[0x4c:offset])),
            additional_objects_raw_34=u32(scn, 0x34), rendering_mode_raw_38=u32(scn, 0x38)),
        layers=layers, default_composition=composition, default_composite=preview_asset,
        source_hashes=before, native_evidence=evidence,
        native_bundle=dict(path=bundle.relative_to(ROOT).as_posix(), sha256=sha(bundle.read_bytes())),
        original_game_execution_observed=False,
        limitations=['Default zero-camera composition is statically derived, not a captured original battle.',
                     'Native dynamic camera movement, zoom, fade and exact live animation/audio clock are retained as unimplemented boundaries.',
                     'SCN cached frame/counter values are retained; the browser may label an alternate animation start as presentation policy.',
                     'The opaque SCN middle block is retained by offset/hash; its unknown editing metadata is not assigned invented semantics.']))
    generated.append(out)
    assert before == {p: sha((ROOT / p).read_bytes()) for p in paths}
    save(RUNTIME / 'evidence/forest_stage_export.json', dict(
        schema='seventh-seal-forest-stage-export', version=1, passed=True,
        source_hashes=before, original_sources_unchanged=True,
        independent_source_pixel_checks=len(checks), frames=checks,
        native_evidence=evidence, original_game_execution_observed=False,
        derived_default_composition=composition,
        output_hashes={p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in generated}))
    print(json.dumps(dict(passed=True, pixel_checks=len(checks),
        frame_counts={p['id']:len(p['frames']) for p in layers},
        ground_source_rect=[380, 95, 640, 305], object_top_left=[object_x, object_y],
        original_sources_unchanged=True)))

if __name__ == '__main__': main()
