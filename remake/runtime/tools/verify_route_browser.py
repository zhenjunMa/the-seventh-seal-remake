"""Check exported real browser runs separately from synthetic lifecycle tests."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib, json
RUNTIME = Path(__file__).resolve().parents[1]
E = RUNTIME / 'evidence'
def read(name): return json.loads((E/name).read_text('utf-8'))
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def save(name):
    envelope = read(name)
    assert hashlib.sha256(envelope['payload'].encode('utf-8')).hexdigest() == envelope['sha256']
    return json.loads(envelope['payload'])
checks = []
def check(name, passed):
    assert passed, name
    checks.append(dict(name=name, passed=True))
run = read('route_browser_log_20261011.json')
ret = read('route_return_log_20261011.json')
final = read('route_final_ui_log_20261011.json')
seed = json.loads((RUNTIME/'web/data/route_seed.json').read_text('utf-8'))
world = save('route_victory_save_20261011.json')
restored = save('route_restored_save_20261011.json')
encounters = [e for e in run['events'] if e['type'] == 'field-encounter']
check('one natural field encounter', len(encounters) == 1)
enc = encounters[0]
check('native group retains duplicate hunters', [m['id'] for m in enc['group']['members']] == ['012','013','013'])
check('original frequency threshold and reset', enc['group']['trigger_roll']['threshold'] == 998 and enc['group']['trigger_roll']['value'] == 999 and enc['counter_after'] == 0)
check('forest entry uses actual marker', any(e['type']=='scene-enter' and e.get('reason')=='world-map' and e['map_id']=='M70010' and (e['x'],e['y'],e['direction'])==(272,736,2) for e in run['events']))
check('original fire exit commands', next(e for e in run['events'] if e['type']=='world-map-open')['commands'] == [{'mode':1,'area':0,'destination':6},{'mode':1,'area':0,'destination':4},{'mode':0,'area':0,'destination':4}])
check('one completed battle', len(run['battle_history']) == 1)
result, battle = run['battle_history'][0]['result'], run['battle_history'][0]['battle']
check('victory after all three enemies die', result['outcome']=='victory' and result['rounds']==12 and all(a['hp']['current']==0 for a in battle['actors'] if a['side']=='enemy'))
history = battle['history']
check('32 unique commands and impacts', result['actions']==32 and len(history)==32 and len({h['action_id'] for h in history})==32 and all(h['impact'] for h in history) and len([e for e in run['events'] if e['type']=='battle-impact'])==32)
check('dead snow monster skips round three onward', all(h['round']<3 for h in history if h['actor_id']=='enemy-0'))
check('dead first hunter skips round eight onward', all(h['round']<8 for h in history if h['actor_id']=='enemy-1'))
check('live target selection after deaths', [h['target_id'] for h in history if h['actor_id']=='001']==['enemy-0']*3+['enemy-1']*5+['enemy-2']*4)
check('one world resource commit', len([e for e in run['events'] if e['type']=='battle-world-commit'])==1)
player = next(a for a in battle['actors'] if a['id']=='001')
check('effective HP182 maps to raw86 and MP72', player['hp']['current']==182 and result['resources']=={'hp':86,'mp':72} and world['party'][0]['hp']['current']==86 and world['party'][0]['mp']['current']==72)
check('return preserves frozen encounter location', world['location']==enc['location'])
check('no guessed rewards or story mutations', not result['rewards_applied'] and all(world[k]==seed[k] for k in ['inventory','flags','event_records','object_states']) and world['party'][1]==seed['party'][1])
check('encounter stream persists through battle', world['encounters']=={'rng_state':3091582542,'counters':{'001':0,'002':0},'remainders':{'001':0,'002':0}})
check('save reload preserves exact world payload', read('route_victory_save_20261011.json')['payload']==read('route_restored_save_20261011.json')['payload'] and world==restored)
check('forest exit opens native destination six', next(e for e in ret['events'] if e['type']=='world-map-open')['commands']==[{'mode':0,'area':0,'destination':6}])
check('world map returns to native fire entry', ret['world']['location']=={'map_id':'M17010','x':1232,'y':1456,'direction':2} and ret['world']['party']==world['party'])
latest = final['battle_history'][0]
check('final UI repeats natural three-enemy group', [m['id'] for m in next(e for e in final['events'] if e['type']=='field-encounter')['group']['members']]==['012','013','013'])
check('final roster provenance and zero-action exit', latest['battle']['source']['order']['actors']==['001','enemy-0','enemy-1','enemy-2'] and latest['result']['actions']==0 and final['world']['party']==seed['party'])
console = read('route_console_20261011.json')
check('no browser warnings or errors', sum(map(len,console.values()))==0)
shots = ['route_victory_20261011.png','route_enemy_group_20261011.png','route_world_map_20261011.png','route_restored_20261011.png']
report = dict(schema='seventh-seal-route-browser', version=1, created_utc=datetime.now(timezone.utc).isoformat(), success=True,
    checks=checks, console_warning_error_count=0, screenshot_sha256={p:sha(E/p) for p in shots},
    log_sha256={p:sha(E/p) for p in ['route_browser_log_20261011.json','route_return_log_20261011.json','route_final_ui_log_20261011.json','route_console_20261011.json']},
    current_code_hashes={p.relative_to(RUNTIME).as_posix():sha(p) for p in (RUNTIME/'web').rglob('*') if p.suffix in ['.js','.mjs','.html','.css','.json']},
    initial_code_hash_record='route_browser_initial_code_20261011.json',
    scope='Actual remake browser: original exit -> world map -> forest natural encounter -> 12-round three-enemy victory -> one commit -> save/reload -> forest exit -> fire. Development relocation used only to approach original exit tiles.',
    latest_ui='Repeated natural encounter and zero-action exit after correcting original skill/menu wording and source.order actor listing. Numeric rules and animations unchanged; the full battle is the separately fingerprinted earlier run.',
    preserved_user_save='127.0.0.1 cached save was not overwritten; save/reload tested under independent localhost origin. Final visible page imports retained victory evidence without saving over the old cache.',
    limitations=['Historical post-story level12 fixture, not new game or complete opening story.','Controlled encounter initial seed/counter and movement mapping.','Player-first fixed learned commands and first contact only; gauges/full AI/multihit/rewards pending.','Original game executable was not run.'], original_game_execution_observed=False)
(E/'route_browser_20261011.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n','utf-8')
print(json.dumps(dict(success=True,checks=len(checks),rounds=result['rounds'],actions=result['actions'],effective_hp=player['hp']['current'])))
