"""Export the two native Locate menus without modifying original inputs.

Native entry/keyboard/destination callbacks: 49f340, 49f580, 49f940, 49ffa0.
MNU widget order binds to the seven native destination records, not image order.
"""
from pathlib import Path
import hashlib
import json
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
sys.path.insert(0, str(RUNTIME / 'tools'))
import export_operation_menu as menu
from PIL import Image


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    sources = [ROOT / 'GAME.exe', *[ROOT / 'SYSTEM' / f'locate_00{i}.mnu' for i in (1, 2)],
               *[ROOT / 'SYSTEM' / f'locate_00{i}.CAP' for i in (1, 2)]]
    before = {p.relative_to(ROOT).as_posix(): sha(p) for p in sources}
    world = json.loads((WEB / 'data/world_map.json').read_text('utf-8'))
    assert before['GAME.exe'] == world['source']['sha256']
    menu.OUT = WEB / 'assets/world_map'
    areas = []
    for area in world['areas']:
        parsed = menu.parse(ROOT / 'SYSTEM' / f"locate_00{area['id'] + 1}.mnu")
        assert parsed['eof_verified'] and parsed['widget_count'] == 8
        assert (parsed['width'], parsed['height']) == (641, 481)
        destinations = []
        preview = Image.open(WEB / parsed['images'][0]['image']).convert('RGBA')
        for destination, widget in zip(area['destinations'], parsed['widgets'][1:], strict=True):
            assert widget['name'] == f"{destination['index'] + 1:03d}"
            assert widget['type_raw'] == 2
            assert 0 < widget['values_at_25_raw'][0] <= 255
            assert str(widget['values_at_25_raw'][0]) in parsed['sensor']['value_counts']
            normal, active, selected = widget['bitmap_indices_raw']
            groups = parsed['groups']
            assert all(groups[i - 1]['frame_count'] == 1 for i in (normal, active, selected))
            destinations.append(dict(index=destination['index'], map_id=destination['map_id'],
                widget_index=widget['index'], point=widget['draw_point_raw'], rect=widget['rect'],
                normal=widget['normal_images'][0], active=widget['active_images'][0],
                selected=widget['selected_images'][0],
                sensor_value=widget['values_at_25_raw'][0], source_offset=widget['source_offset']))
            preview.alpha_composite(Image.open(WEB / widget['normal_images'][0]),
                (widget['draw_point_raw']['x'], widget['draw_point_raw']['y']))
        preview = preview.crop((0, 0, 640, 480))
        preview.save(RUNTIME / 'evidence/world_map_alignment_20261021' / f"area_{area['id']}_all_locations.png")
        areas.append(dict(id=area['id'], background=parsed['images'][0]['image'],
            source=parsed['source'], source_sha256=parsed['source_sha256'],
            sensor=parsed['sensor'], destinations=destinations))
    manifest = dict(schema='seventh-seal-world-map-ui', version=1, width=640, height=480,
        areas=areas, source_hashes=before,
        evidence_file='remake/runtime/evidence/route_native_20261011.json',
        evidence_procedures=['0x49f340', '0x49f580', '0x49f940', '0x49ffa0'],
        boundary='Read-only source MNU pixels and widget coordinates; 641x481 editor plane clipped to native 640x480. No original executable runtime observed.')
    output = WEB / 'data/world_map_ui.json'
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    assert all(sha(ROOT / p) == digest for p, digest in before.items())
    report = dict(passed=True, original_inputs_unchanged=True, source_hashes=before,
        output_hashes={p.relative_to(ROOT).as_posix(): sha(p) for p in [output, *menu.OUT.rglob('*.png')]},
        areas=len(areas), destinations=sum(len(a['destinations']) for a in areas))
    (RUNTIME / 'evidence/world_map_alignment_20261021/export.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    print(json.dumps({k: report[k] for k in ['passed', 'areas', 'destinations', 'original_inputs_unchanged']}))


if __name__ == '__main__':
    (RUNTIME / 'evidence/world_map_alignment_20261021').mkdir(parents=True, exist_ok=True)
    main()
