"""Pin one complete automated run of this bounded runtime slice."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
TESTS = ['test_runtime.mjs', 'test_slice.mjs', 'test_combat.mjs',
         'test_combat_rules.mjs', 'test_combat_sample.mjs',
         'test_battle_view.mjs', 'test_turn_sample.mjs','test_skill_config.mjs']
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

code = list((RUNTIME/'web').glob('*.mjs')) + list((RUNTIME/'web/core').glob('*.mjs'))
code += list((RUNTIME/'tests').glob('*.mjs'))
before = {path.relative_to(RUNTIME).as_posix(): sha(path) for path in sorted(code)}
command = ['node', '--test', '--test-reporter=spec',
           *[(RUNTIME/'tests'/name).relative_to(ROOT).as_posix() for name in TESTS]]
result = subprocess.run(command, cwd=ROOT, capture_output=True, encoding='utf-8')
output = result.stdout + result.stderr
counts = {key: int(re.search(r'(?:#|ℹ)\s+'+key+r'\s+(\d+)', output)[1])
          for key in ['tests', 'pass', 'fail']}
after = {path.relative_to(RUNTIME).as_posix(): sha(path) for path in sorted(code)}
assert result.returncode == 0 and counts['fail'] == 0 and counts['tests'] == counts['pass'], output
assert before == after, 'Code changed during the automated run'
report = dict(schema='seventh-seal-runtime-test-suite', version=1,
              created_utc=datetime.now(timezone.utc).isoformat(), success=True,
              command=command, returncode=result.returncode, counts=counts,
              code_hashes=after,
              authority='Runtime tests; numeric comparisons use bounded static instruction replay, not original gameplay execution',
              original_game_execution_observed=False)
(RUNTIME/'evidence/test_suite_20261011.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
(RUNTIME/'evidence/test_suite_20261011.txt').write_text(output, encoding='utf-8')
print(json.dumps(counts))
