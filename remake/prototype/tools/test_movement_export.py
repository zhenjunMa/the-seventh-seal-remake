"""Independently compare all exported cells and placements with source bytes."""
from pathlib import Path
import json
import struct
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from dgp import DGP
from export_movement import ROOT, PROJECT

b = (ROOT / 'Map/m01010.dat').read_bytes()
data = json.loads((PROJECT / 'web/assets/m01010_movement.json').read_text(encoding='utf-8'))
w,h = struct.unpack_from('<II',b,0x146)
assert (w,h) == (data['width'],data['height']) == (80,108)
for y in range(h):
    for x in range(w):
        offset = 0x172 + (y*w+x)*64
        assert int(data['terrain_rows'][y][x]) == b[offset+0x20]
triggers = {(t['x'],t['y']):t for t in data['triggers']}
transition_start = 0x172 + w*h*64 + 32*0x2a
for y in range(h):
    for x in range(w):
        trigger_id = struct.unpack_from('<I',b,0x172+(y*w+x)*64+0x38)[0]
        assert bool(trigger_id) == ((x,y) in triggers)
        if trigger_id:
            t = triggers[x,y]
            assert t['id'] == trigger_id
            raw = b[transition_start+(trigger_id-1)*0x42:transition_start+trigger_id*0x42]
            assert raw.hex() == t['descriptor_hex']
            assert t['path_gate'] == (raw[0]==0 and raw[0x11]!=0)
manifest = json.loads((PROJECT / 'web/manifest.json').read_text(encoding='utf-8'))
from PIL import Image
for obj in manifest['maps'][0]['objects']:
    dgp = DGP(ROOT / obj['source'])
    output = Image.open(PROJECT / 'web' / obj['image']).convert('RGBA')
    assert output.size == (dgp.width,dgp.height)
    assert output.tobytes() == dgp.decode(obj['frame']).tobytes()
    assert obj['draw_x'] == obj['x_world'] - struct.unpack_from('<i',dgp.extra_header,16)[0]
    assert obj['draw_y'] == obj['y_world'] - struct.unpack_from('<i',dgp.extra_header,20)[0]
    assert obj['sort_y'] == obj['y_world'] + (obj['width_cells']+obj['height_cells'])*16
for role in manifest['roles']:
    dgp = DGP(ROOT / role['source'])
    assert role['map_draw_offset'] == dict(x=16-dgp.anchor_raw[0],y=-dgp.anchor_raw[1])
print(f'PASS {w*h} terrain cells, {len(triggers)} trigger references, 16 object pixel/placement checks and 2 role anchor offsets')
