"""Keep this correction's verification separate from the historical route release."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,re,subprocess,sys,urllib.request
RUNTIME=Path(__file__).resolve().parents[1]
ROOT=RUNTIME.parents[1]
E=RUNTIME/'evidence'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):return json.loads(p.read_text('utf-8'))
def save(name,v):(E/name).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n','utf-8')
def code_hashes():
    return {p.relative_to(RUNTIME).as_posix():sha(p) for folder in ['web','tests','tools'] for p in (RUNTIME/folder).rglob('*') if p.suffix in ['.js','.mjs','.py','.html','.css','.json']}
test_path=E/'forest_presentation_tests_20261011.json'
if '--finalize' not in sys.argv:
    before=code_hashes();historical={p:sha(p) for p in E.glob('*.json') if p!=test_path}
    command=['node','--import','./remake/runtime/tests/preserve_history.mjs','--test','--test-reporter=spec',*[p.relative_to(ROOT).as_posix() for p in sorted((RUNTIME/'tests').glob('test_*.mjs'))]]
    ran=subprocess.run(command,cwd=ROOT,capture_output=True,encoding='utf-8');out=ran.stdout+ran.stderr
    counts={k:int(re.search(r'(?:#|ℹ)\s+'+k+r'\s+(\d+)',out)[1]) for k in ['tests','pass','fail']}
    assert ran.returncode==0 and counts['tests']==counts['pass'] and not counts['fail'],out
    assert before==code_hashes() and all(sha(p)==s for p,s in historical.items())
    http=[]
    for path in ['/','/app.js','/battle_view.mjs','/data/forest_battle_view.json','/data/xuanying_layers.json','/assets/skills/xuanying/frame_0326_intrinsic.png','/assets/combat_effects/BFr01_Nd/action_00.png','/assets/combat_effects/_DutyEg/action_00.png','/assets/combat_effects/_DutyEb/action_00.png']:
        with urllib.request.urlopen('http://127.0.0.1:8767'+path,timeout=5) as r:
            b=r.read();assert r.status==200 and b;http.append(dict(path=path,status=r.status,sha256=hashlib.sha256(b).hexdigest()))
    save(test_path.name,dict(success=True,created_utc=datetime.now(timezone.utc).isoformat(),counts=counts,http=http,code_data_hashes=before,historical_reports_unchanged=True,original_game_execution_observed=False))
    (E/'forest_presentation_tests_20261011.txt').write_text(out,'utf-8')
    print(json.dumps(dict(tests=counts,http=len(http))))
else:
    suite=read(test_path);assert suite['success'] and suite['code_data_hashes']==code_hashes()
    pixels=read(E/'forest_presentation_pixels_20261011.json')
    sources={**read(E/'route_delivery_20261011.json')['source_hashes'],**pixels['source_hashes']}
    assert all(sha(ROOT/p)==s for p,s in sources.items())
    meta=read(RUNTIME/'web/data/forest_battle_view.json');assets={}
    def asset(path,expected):
        p=RUNTIME/'web'/path[11:] if path.startswith('/prototype/') else RUNTIME/'web'/path.lstrip('/')
        assert sha(p)==expected,path;assets[path]=expected
    for r in meta['roles']:
        for a in r['actions']:asset(a['sheet'],a['sha256'])
        for skill in [r['skill']]+r.get('alternate_skills',[]):
            if 'layers' in skill:
                asset(skill['layers']['path'],skill['layers']['sha256']);layers=read(RUNTIME/'web'/skill['layers']['path'].lstrip('/'))
                for f in layers['frames']:
                    for key in ['main','intrinsic']:asset('/'+f[key]['path'],f[key]['sha256'])
    for effect in meta['effects']:asset(effect['sheet'],effect['sha256'])
    log=read(E/'forest_presentation_browser_log_20261011.json');events=log['events']
    presentations=[e for e in events if e['type']=='battle-presentation']
    assert len(presentations)==4 and len({e['action_id'] for e in presentations})==4
    assert len([e for e in events if e['type']=='battle-impact'])==4
    player=presentations[0]['observations'];assert player['intrinsic_source_frames']==list(range(323,332)) and 'BFr01_Nd' in player['effect_ids']
    assert player['origin_slot']==player['last_slot']==[720,350]
    for e in presentations[2:]:
        o=e['observations'];assert o['last_slot']==o['origin_slot'] and o['contact_slot']==[572.8,351.15]
        assert set(o['effect_ids'])=={'_DutyEg','BNo01_Nm','_DutyEb'}
    assert not read(E/'forest_presentation_console_20261011.json')
    assert log['current_battle']['phase']=='command' and log['current_battle']['round']==2
    screenshots={p.name:sha(p) for p in E.glob('forest_fix_frame_*_20261011.png')}
    screenshots['forest_fix_proof_20261011.png']=sha(E/'forest_fix_proof_20261011.png')
    browser=dict(success=True,scope='One actual natural-encounter browser round: Xuanyingzhan against selected hunter, snow attack and both hunters approach/attack/return; no original executable run.',
        presentations=presentations,console_warning_error_count=0,screenshot_sha256=screenshots,log_sha256=sha(E/'forest_presentation_browser_log_20261011.json'),current_code_hashes=suite['code_data_hashes'])
    save('forest_presentation_browser_20261011.json',browser)
    docs=['README.md','remake/archive/20261011_before_chapter/assessment/runtime_forest_presentation_fix_20261011.txt','remake/assessment/testing_strategy.md','remake/assessment/validation_design.md']
    save('forest_presentation_delivery_20261011.json',dict(success=True,created_utc=datetime.now(timezone.utc).isoformat(),tests=suite['counts'],http=len(suite['http']),
         source_hashes=sources,asset_hashes=assets,code_data_hashes=suite['code_data_hashes'],document_hashes={p:sha(ROOT/p) for p in docs},browser=browser,
         pixel_frames=dict(player_pairs=pixels['player_frames'],active_intrinsic=len(pixels['active_intrinsic_frames']),new_effect_frames=len(pixels['effect_frame_checks'])),
         limitations=['Frame interpolation, coordinate projection and Canvas additive blend remain preview policies.','Full native path timing/gauges/AI/multihit/rewards/opening pending.'],original_game_execution_observed=False))
    print(json.dumps(dict(success=True,sources=len(sources),assets=len(assets),drawn_actions=len(presentations))))
