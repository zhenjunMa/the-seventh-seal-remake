"""New route-suite report; preserve previous phase test reports."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,re,subprocess,urllib.request
RUNTIME=Path(__file__).resolve().parents[1]
ROOT=RUNTIME.parents[1]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
code=[p for folder in ['web','web/core','tests','tools'] for p in (RUNTIME/folder).glob('*') if p.suffix in ['.mjs','.js','.py']]
code.extend((RUNTIME/'web/data').rglob('*.json'))
before={p.relative_to(RUNTIME).as_posix():sha(p) for p in sorted(code)}
historical={p:sha(p) for p in (RUNTIME/'evidence').glob('*verification*.json')}
tests=sorted((RUNTIME/'tests').glob('test_*.mjs'))
command=['node','--import','./remake/runtime/tests/preserve_history.mjs','--test','--test-reporter=spec',*[p.relative_to(ROOT).as_posix() for p in tests]]
r=subprocess.run(command,cwd=ROOT,capture_output=True,encoding='utf-8');out=r.stdout+r.stderr
counts={k:int(re.search(r'(?:#|ℹ)\s+'+k+r'\s+(\d+)',out)[1]) for k in ['tests','pass','fail']}
assert r.returncode==0 and counts['tests']==counts['pass'] and counts['fail']==0,out
assert all(sha(p)==v for p,v in historical.items()),'Historical report changed'
http=[]
for path in ['/','/app.js','/data/catalog.json','/data/route_seed.json','/data/maps/m17010.json','/data/maps/m70010.json','/data/world_map.json','/data/encounters.json','/data/forest_combat.json','/data/forest_battle_view.json','/assets/maps/m17010/background.png','/assets/maps/m70010/background.png']:
    with urllib.request.urlopen('http://127.0.0.1:8767'+path,timeout=5) as response:
        b=response.read();assert response.status==200 and b
        http.append(dict(path=path,status=response.status,bytes=len(b),sha256=hashlib.sha256(b).hexdigest()))
after={p.relative_to(RUNTIME).as_posix():sha(p) for p in sorted(code)};assert before==after
report=dict(schema='seventh-seal-route-test-suite',version=1,created_utc=datetime.now(timezone.utc).isoformat(),counts=counts,command=command,
    code_data_hashes=after,http=http,historical_reports_unchanged=True,original_game_execution_observed=False,
    authority='Static-source reconstruction, lifecycle/instruction unit tests and local HTTP; browser report separate')
(RUNTIME/'evidence/route_test_suite_20261011.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n','utf-8')
(RUNTIME/'evidence/route_test_suite_20261011.txt').write_text(out,'utf-8')
print(json.dumps(dict(counts=counts,http=len(http),historical_reports_unchanged=True)))
