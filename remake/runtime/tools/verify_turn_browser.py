"""Verify observed UI records, then pin the browser-tested files and screenshots."""
from pathlib import Path
import hashlib
import json
RUNTIME = Path(__file__).resolve().parents[1]
EVIDENCE = RUNTIME/'evidence'
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
observed = json.loads((EVIDENCE/'turn_browser_observations_20261011.json').read_text(encoding='utf-8'))
cases = observed['cases']
assert len(cases) == 8 and not observed['console']
entry = cases[0]['state']
assert entry['playerHp'] == 'HP 1056 / 1056' and entry['playerMp'] == 'MP 79 / 79'
assert entry['enemyHp'] == 'HP 1362 / 1362' and entry['enemyMp'] == 'MP 24 / 24'
assert entry['cost'] == '燕突 · MP 0' and entry['saveDisabled']
round2 = cases[1]['state']
assert (round2['phase'], round2['round'], round2['impacts'], round2['frame']) == ('command', '2', '2', '91')
assert round2['playerHp'] == 'HP 996 / 1056' and round2['enemyHp'] == 'HP 863 / 1362'
assert all(cases[2]['state'].values())
win = cases[3]['state']
assert (win['phase'], win['round'], win['impacts'], win['frame'], win['actor']) == ('victory', '3', '5', '338', '001')
assert win['enemyHp'] == 'HP 0 / 1362' and win['playerHp'] == 'HP 932 / 1056' and not win['returnDisabled']
before, back = cases[4]['before'], cases[4]['after']
assert before['map'] == back['map'] == 'M01030 · 1680.0, 480.0'
assert before['inventory'] == back['inventory'] and back['saveEnabled'] and back['battleHidden']
restored = cases[5]['state']
assert all(restored[key] == back[key] for key in ['map', 'party', 'inventory', 'battleHidden'])
assert cases[6]['text'] == '侦探：别忘了，想要我调查的话，记得来找我啊！'
assert cases[7]['before'] == cases[7]['after']
smoke = observed['final_frozen_code_smoke']
assert smoke['state']=={'playerHp':'HP 996 / 1056','enemyHp':'HP 863 / 1362','impacts':'2','round':'2'}
assert 'HP 932 / 1056' in smoke['restored_party']
paths = ['web/app.js', 'web/index.html', 'web/style.css', 'web/battle_shell.css',
         'web/battle_view.mjs', 'web/combat_sample.mjs', 'web/core/combat.mjs',
         'web/core/combat_rules.mjs', 'web/core/scenes.mjs', 'web/data/catalog.json',
         'web/data/combat_sample.json', 'web/data/battle_view.json']
report = dict(schema='seventh-seal-turn-browser-verification', version=1, success=True,
              checks=8, observations_sha256=sha(EVIDENCE/'turn_browser_observations_20261011.json'),
              console_warning_error_count=0,
              final_ui_code_sha256={p:sha(RUNTIME/p) for p in paths},
              screenshot_sha256={p:sha(EVIDENCE/p) for p in observed['screenshots']},
              original_game_execution_observed=False,
              limits=['Defeat and interrupted animations are tested by automated contracts, not clicked in this browser run.',
                      'This proves the controlled one-on-one runtime sample, not original action-gauge timing, AI, rewards or encounter flow.'])
(EVIDENCE/'turn_browser_verification_20261011.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
print(json.dumps(dict(checks=8, success=True, console_warning_error_count=0)))
