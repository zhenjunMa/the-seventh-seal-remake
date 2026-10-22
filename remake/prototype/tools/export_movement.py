"""Export established M01010 terrain and static object layers, without changing inputs."""
from pathlib import Path
from datetime import datetime, timezone
from collections import Counter
import hashlib
import json
import struct
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dgp import DGP, DGPError, u32
from map_data import MapBackground
from map_objects import MapObjects

PROJECT = Path(__file__).resolve().parents[1]
ROOT = PROJECT.parents[1]
GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def export_movement(manifest, parsed=None):
    sources = ['GAME.exe', 'Map/m01010.dat', 'ROLE/001.dgp', 'ROLE/002.dgp']
    sources += [p.relative_to(ROOT).as_posix() for p in sorted((ROOT / 'mapm/m01010').glob('*.dgp'))]
    before = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sources}
    if before['GAME.exe'] != GAME_SHA:
        raise DGPError('Revalidate native movement evidence for this GAME.exe version')
    data = MapBackground(ROOT / 'Map/m01010.dat')
    if data.data[0x88] != 1 or data.data[0x142] != 3 or data.step != 2 or u32(data.data, 0x18) != 1:
        raise DGPError('Only the established rectangular M01010 branch is supported')
    terrain = []
    triggers = []
    # Native path expansion 0x48D050/0x48F920: cell byte +0x20 != 0 denies entry.
    # Keep role occupancy (+0x14) and object lookup (+0x2B) separate from terrain.
    transition_start = data.grid_end + 32 * 0x2a
    if transition_start + 32 * 0x42 > len(data.data):
        raise DGPError('Truncated transition descriptors')
    for y in range(data.height):
        row = ''
        for x in range(data.width):
            offset = 0x172 + (y * data.width + x) * 64
            flag = data.data[offset + 0x20]
            if flag not in (0, 1):
                raise DGPError(f'Unsupported terrain flag {flag} at {x},{y}')
            row += str(flag)
            trigger_id = u32(data.data, offset + 0x38)
            if trigger_id:
                if not 1 <= trigger_id <= 32:
                    raise DGPError('Transition descriptor index outside table')
                descriptor = data.data[transition_start + (trigger_id - 1) * 0x42:
                                       transition_start + trigger_id * 0x42]
                triggers.append(dict(x=x, y=y, id=trigger_id, state_raw=descriptor[0],
                    path_gate=descriptor[0] == 0 and descriptor[0x11] != 0,
                    descriptor_hex=descriptor.hex()))
        terrain.append(row)
    movement = dict(schema='seventh-seal-map-movement', version=1, map='M01010',
        source='Map/m01010.dat', source_sha256=before['Map/m01010.dat'],
        width=data.width, height=data.height, cell_size=16, native_coordinate_shift=3,
        native_to_pixel_scale=2, terrain_rows=terrain, triggers=triggers,
        terrain_rule='cell byte +0x20 == 0 permits terrain entry',
        transition_rule='0x4A80E0: +0x38 reference, descriptor[0]==0 and descriptor[0x11]!=0 is path-gated',
        policy='Preview stops at native path-gated transition cells; events and map changes are not executed',
        role_occupancy_rule='+0x14 is runtime role index + 1, not static terrain',
        object_lookup_rule='+0x2B is runtime object index + 1, not a second collision mask')
    movement_path = PROJECT / 'web/assets/m01010_movement.json'
    write_json(movement_path, movement)
    resources = {}
    for source in sources:
        if source.startswith('mapm/'):
            resources[Path(source).name.lower()] = (parsed or {}).get(source) or DGP(ROOT / source)
    table = MapObjects(ROOT / 'Map/m01010.dat')
    graphics = table.prepare_graphics(resources)
    objects = []
    for obj in graphics:
        dgp = resources[Path(obj['source']).name.lower()]
        target = PROJECT / 'web/assets/m01010_objects' / f"{Path(obj['source']).stem}_frame_000.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        dgp.decode(obj['frame']).save(target)
        objects.append({**obj, 'image': target.relative_to(PROJECT / 'web').as_posix()})
    scene = manifest['maps'][0]
    scene.update(movement='assets/m01010_movement.json', objects=objects,
                 role_layer_preview=2, role_layer_note='Same-layer preview; native role +0xF3 initialization not recovered')
    scene['movement_probes'] = [dict(name=name, x=x, y=y) for name, x, y in [
        ('起点 · 下方道路',330,1500), ('左侧路缘',168,1496),
        ('上方街道',408,1208), ('右侧街道',1048,1288), ('前景建筑',312,1640),
        ('斜角窄缝',648,1576)]]
    for point in scene['movement_probes']:
        if terrain[point['y']//16][point['x']//16] != '0' or any(
                t['path_gate'] and t['x']==point['x']//16 and t['y']==point['y']//16 for t in triggers):
            raise DGPError(f'Probe is blocked: {point}')
    for role in manifest['roles']:
        role['map_draw_offset'] = dict(x=16 - role['anchor_raw'][0], y=-role['anchor_raw'][1])
    after = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sources}
    counts = Counter(''.join(terrain))
    report = dict(created_utc=datetime.now(timezone.utc).isoformat(), input_hashes=before,
        source_bytes_unchanged=before == after, grid_cells=data.width * data.height,
        terrain_open=int(counts['0']), terrain_blocked=int(counts['1']),
        trigger_cells=len(triggers), path_gated_trigger_cells=sum(t['path_gate'] for t in triggers),
        object_count=len(objects), unique_object_images=len({o['image'] for o in objects}),
        native_functions=['0x48D050', '0x48F920', '0x484E80', '0x4A18F0', '0x4A80E0',
                          '0x422660', '0x4AA110', '0x4AE100', '0x4AE320', '0x54F68B'],
        limits=['Static code/data evidence; no original-game runtime comparison.',
                'Keyboard speed, no-slide stopping, conservative diagonal corners and camera are preview policy.',
                'Objects use initial frame 0; dynamic object states, terrain scale/effects and NPCs are omitted.',
                'Role layer is a same-layer preview pending native role +0xF3 initialization.'])
    if before != after:
        raise DGPError('Input hash changed during movement export')
    write_json(PROJECT / 'evidence/map_movement_export.json', report)
    return report


def main():
    path = PROJECT / 'web/manifest.json'
    manifest = json.loads(path.read_text(encoding='utf-8'))
    report = export_movement(manifest)
    write_json(path, manifest)
    print(json.dumps({k: v for k, v in report.items() if k != 'input_hashes'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
