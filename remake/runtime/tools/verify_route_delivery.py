"""Pin the current route delivery without rewriting older release evidence."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json
RUNTIME=Path(__file__).resolve().parents[1]
ROOT=RUNTIME.parents[1]
WEB=RUNTIME/'web'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):return json.loads(p.read_text('utf-8'))
suite=read(RUNTIME/'evidence/route_test_suite_20261011.json')
assert suite['counts']['tests']==suite['counts']['pass'] and suite['counts']['fail']==0
for p,v in suite['code_data_hashes'].items():assert sha(RUNTIME/p)==v,('Changed since test',p)
sources={}
for name,key in [('route_export_20261011.json','source_hashes'),('route_resources_maps_20261011.json','source_hashes'),('route_pixels_20261011.json','source_hashes')]:
    report=read(RUNTIME/'evidence'/name)
    for p,s in report[key].items():assert sources.get(p,s)==s;sources[p]=s
for p,s in sources.items():assert sha(ROOT/p)==s,('Original input changed',p)
catalog=read(WEB/'data/catalog.json');assets={}
def asset(url,expected=None):
    p=ROOT/'remake/prototype/web'/url[len('/prototype/'):] if url.startswith('/prototype/') else WEB/url.lstrip('/')
    assert p.is_file(),url;actual=sha(p)
    if expected:assert actual==expected,url
    assets[url]=actual
for item in catalog['maps']:
    p=WEB/item['path'];assert sha(p)==item['sha256'];m=read(p);asset(m['background']['image'],m['background'].get('sha256'))
    for o in m['objects']:asset(o['image'],o['image_sha256'])
for r in catalog['roles']:
    for a in r['actions']:asset(a['sheet'])
for url,expected in read(RUNTIME/'evidence/route_resources_maps_20261011.json')['output_files'].items():asset(url,expected)
for e in read(WEB/catalog['events']):asset(e['npc']['resource']['sheet'])
for name in ['battle_view.json','forest_battle_view.json']:
    meta=read(WEB/'data'/name)
    for r in meta['roles']:
        for a in r['actions']:asset(a['sheet'],a['sha256'])
    for e in meta['effects']:asset(e['sheet'],e['sha256'])
for f in read(WEB/'data/yantu_layers.json')['frames']:
    for key in ['main','intrinsic']:asset('/'+f[key]['path'],f[key]['sha256'])
browser=read(RUNTIME/'evidence/route_browser_20261011.json');assert browser['success'] and browser['console_warning_error_count']==0
for p,s in browser['screenshot_sha256'].items():assert sha(RUNTIME/'evidence'/p)==s
out=RUNTIME/'evidence/route_delivery_20261011.json'
files=[p for p in RUNTIME.rglob('*') if p.is_file() and p!=out and '__pycache__' not in p.parts]
files += [ROOT/p for p in ['remake/README.txt','remake/assessment/validation_design.txt','remake/assessment/menu_alignment_workflow.txt','remake/archive/20261011_before_chapter/assessment/runtime_phase3_20261011.txt']]
out.write_text(json.dumps(dict(schema='seventh-seal-route-delivery',version=1,created_utc=datetime.now(timezone.utc).isoformat(),success=True,
    tests=suite['counts'],http=len(suite['http']),source_hashes=sources,asset_hashes=assets,output_hashes={p.relative_to(ROOT).as_posix():sha(p) for p in sorted(files)},
    original_game_execution_observed=False,scope='Post-story route, native source groups and bounded first-contact fixed-order combat; original opening/gauges/AI/multihit/rewards pending'),ensure_ascii=False,indent=2)+'\n','utf-8')
print(json.dumps(dict(success=True,sources=len(sources),assets=len(assets),files=len(files))))
