"""Verify retained lifecycle UI observations; --record freezes this stage."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json

RUNTIME=Path(__file__).resolve().parents[1]
ROOT=RUNTIME.parent.parent
SCENE=RUNTIME/'evidence/battle_lifecycle_20261015'
REPORT=RUNTIME/'evidence/battle_lifecycle_browser_validation_20261015.json'
def read(path):return json.loads(path.read_text(encoding='utf-8-sig'))
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record',action='store_true')
    args=parser.parse_args()
    observation=read(SCENE/'browser_observation.json')
    fingerprints=read(SCENE/'replay_fingerprints.json')
    checks={}
    def check(name,ok):
        checks[name]=bool(ok)
        assert ok,name
    check('final-code-fingerprints-match',all(sha(ROOT/n)==h for n,h in fingerprints.items()))
    check('no-browser-errors',not observation['errors'])
    rows={r['name']:r for r in observation['checks']}
    entry=rows['entry_playback']['lifecycle']['active']
    check('source-entry-channel-captured',any(r['kind']=='entry' and r['actor_id'] in ['001','002'] for r in entry))
    corpse=rows['corpse_retained']
    check('dead-player-remains-on-battlefield',any(r['actor_id']=='002' for r in corpse['lifecycle']['held']) and any('HP 0/' in s for s in corpse['players']))
    revive=rows['revive_playback']
    check('revive-channel-replaces-old-death',any(r['actor_id']=='002' and r['kind']=='revive' and r['life_epoch']==1 for r in revive['lifecycle']['active']) and not revive['lifecycle']['held'])
    check('revival-hp-visible',any('HP 151/' in s for s in revive['players']))
    check('revive-animation-completes',not any(r['actor_id']=='002' for r in rows['revive_complete']['lifecycle']['active']) and not rows['revive_complete']['lifecycle']['held'])
    log=read(SCENE/'battle_log.json')
    check('real-effect-contact-revives-once',len([e for e in log['events'] if e['type']=='battle-impact' and e.get('skill_id')=='001_43' and e.get('hp_before')==0 and e.get('hp_after')==151])==1)
    for actor in ['001','002']:
        check(actor+'-source-entry-completes',any(e['type']=='battle-lifecycle-completed' and e['event']['kind']=='entry' and e['event']['actor_id']==actor for e in log['events']))
    check('player-death-completes',any(e['type']=='battle-lifecycle-completed' and e['event']['kind']=='death' and e['event']['actor_id']=='002' for e in log['events']))
    enemy_log=read(SCENE/'enemy_visual_log.json')
    check('enemy-source-death-completes',any(e['type']=='battle-death-finalized' and e['actor_id']=='enemy-0' and e['death']['source_skill_index']==2 for e in enemy_log['events']) and any(e['type']=='battle-lifecycle-completed' and e['event']['kind']=='death' and e['event']['actor_id']=='enemy-0' for e in enemy_log['events']))
    check('dead-enemy-hidden-on-stage','enemy-0' in read(SCENE/'enemy_observation.json')['lifecycle']['hidden'])
    check('no-battle-interruption',not any(e['type']=='battle-interrupted' for path in ['battle_log.json','revival_visual_log.json','enemy_visual_log.json'] for e in read(SCENE/path)['events']))
    for name in ['entry_playback.jpg','corpse_retained.jpg','revive_playback.jpg']:
        check(name+'-retained',(SCENE/name).stat().st_size>10000)
    check('existing-progress-restored',read(SCENE/'browser_progress_before.json')['payload']==read(SCENE/'browser_progress_restored.json')['payload'])
    audio=lambda name:{k:read(SCENE/name)['audio'][k] for k in ['muted','volume','channels']}
    check('audio-preferences-restored',audio('browser_log_before.json')==audio('browser_log_restored.json'))
    check('controlled-fixture-labelled',read(SCENE/'fixture.json')['natural_unlock_claimed'] is False)
    evidence={p.relative_to(ROOT).as_posix():sha(p) for p in SCENE.iterdir() if p.suffix in ['.json','.jpg']}
    if args.record:
        report=dict(schema='seventh-seal-battle-lifecycle-browser-validation',version=1,passed=True,checked_utc=datetime.now(timezone.utc).isoformat(),cases=len(checks),checks=checks,current_fingerprints=fingerprints,evidence_fingerprints=evidence,observation_path=(SCENE/'browser_observation.json').relative_to(ROOT).as_posix(),observation_sha256=sha(SCENE/'browser_observation.json'),scope=observation['scope'],original_game_execution_observed=False,limits=observation['limits'])
        REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    else:
        report=read(REPORT)
        assert report['passed'] and report['current_fingerprints']==fingerprints
        assert report['evidence_fingerprints']==evidence
    print(json.dumps(dict(passed=True,checks=len(checks))))
if __name__=='__main__':main()
