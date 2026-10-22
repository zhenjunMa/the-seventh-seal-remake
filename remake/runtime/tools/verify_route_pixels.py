"""Independent sparse source bytes versus exported new forest atlas crops."""
from pathlib import Path
import json,hashlib,sys
sys.dont_write_bytecode=True
RUNTIME=Path(__file__).resolve().parents[1]
ROOT=RUNTIME.parents[1]
sys.path.insert(0,str(RUNTIME/'tools'))
from export_skill_layers import SourceAudit
from PIL import Image
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
meta=json.loads((RUNTIME/'web/data/forest_battle_view.json').read_text('utf-8'))
checks=[];sources={};outputs={}
for role in meta['roles']:
    src=ROOT/'Fight_Role'/(role['id']+'.dgp');sources[src.relative_to(ROOT).as_posix()]=sha(src);audit=SourceAudit(src.read_bytes())
    for action in role['actions']:
        if not action['sheet'].startswith('/assets/forest_roles/'):continue
        p=RUNTIME/'web'/action['sheet'].lstrip('/');outputs[action['sheet']]=sha(p);assert sha(p)==action['sha256']
        im=Image.open(p).convert('RGBA');w,h=role['frame_width'],role['frame_height']
        assert im.size==(w*action['frame_count'],h*action['directions'])
        for direction in range(action['directions']):
            for frame in range(action['frame_count']):
                b,check=audit.sparse(action['first_frame']+direction*action['frame_count']+frame,indexed=False)
                assert im.crop((frame*w,direction*h,(frame+1)*w,(direction+1)*h)).tobytes()==b
                checks.append(dict(role=role['id'],action=action['index'],frame=frame,direction=direction,**check))
assert all(sha(ROOT/p)==s for p,s in sources.items())
p=RUNTIME/'evidence/route_pixels_20261011.json'
p.write_text(json.dumps(dict(frames=len(checks),checks=checks,source_hashes=sources,output_hashes=outputs,source_unchanged=True,
    independent_decoder='SourceAudit explicit LE sparse spans compared with exported PNG crops',
    original_game_execution_observed=False,limits='Primary sprite pixels only; alternate intrinsic and new enemy effects not composited'),indent=2)+'\n','utf-8')
print('Independent sparse/PNG checks',len(checks))
