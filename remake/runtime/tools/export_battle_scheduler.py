"""Source-backed fresh forest scheduler contract; original inputs are read only."""
from pathlib import Path
import hashlib,json,struct,sys
RUNTIME=Path(__file__).resolve().parents[1]
ROOT=RUNTIME.parents[1]
sys.path.insert(0,str(ROOT/'remake/prototype/tools'))
sys.path.insert(0,str(ROOT/'save_analysis_20261010'))
from combat_resources import CHR
from save_format import complete_layout
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):return json.loads(p.read_text('utf-8'))
def save(p,d):p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n','utf-8')
def main():
    bundle=RUNTIME/'evidence/forest_scheduler_native_20261011.json';records=read(bundle)['records']
    def native(op,fn):
        return next(e for e in records if e['operation']==op and e['parameters'].get('procedure','').lower()==fn.lower())
    proof={name:native(op,fn)['evidence_id'] for name,op,fn in [
        ('initialize','procedure_pseudo_code','0x50ac80'),('zero_slots','procedure_pseudo_code','0x519a80'),
        ('clock','procedure_pseudo_code','0x51bb90'),('charge','procedure_assembly','0x502f30'),
        ('dispatch','procedure_assembly','0x5036d0'),('select_skill','procedure_pseudo_code','0x501cc0'),
        ('idle','procedure_pseudo_code','0x519dd0')]}
    paths=[ROOT/'GAME.exe',ROOT/'save_analysis_20261010/verified_level12_SaveGame0.Dat',*[ROOT/f'Fight_Role/{i}.CHR' for i in ['001','011','012','013']]]
    before={p.relative_to(ROOT).as_posix():digest(p) for p in paths}
    assert before['GAME.exe']=='fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'
    saved=paths[1].read_bytes();role=complete_layout(saved)['characters'][0];idles={}
    for ident in ['001','011','012','013']:
        path=ROOT/f'Fight_Role/{ident}.CHR';c=CHR(path);skill=c.skills[0]
        if ident=='001':
            offset=role['skills'][0]['record_offset'];raw=saved[offset:offset+0x41d];source=paths[1]
        else:offset=skill['offset'];raw=bytes.fromhex(skill['fixed_raw_hex']);source=path
        action=bytes.fromhex(skill['actions'][0]['raw_hex'])
        idles[ident]=dict(id=ident+'_idle',actor_id=ident,name=raw[1:0x15].split(b'\0')[0].decode('cp936'),
            fixed_raw_hex=raw.hex(),class_raw=action[0x24],action_mask_raw=action[0x78],
            source=dict(path=source.relative_to(ROOT).as_posix(),sha256=digest(source),offset=offset,bytes=0x41d),evidence=[proof['idle']])
    data=dict(schema='seventh-seal-battle-scheduler',version=1,mode_raw=0,tick_interval_ms=20,average_speed_factor=200,
        initial_gauge=0,initial_delay=0,initial_side_priority=0,idle_skills=idles,evidence=proof,
        source_hashes=before,native_bundle=dict(path=bundle.relative_to(ROOT).as_posix(),sha256=digest(bundle)),
        policy=dict(selection='Native mode0 maximum-ready gauge, source candidate-position side priority including its index behavior.',
            clock='One charge update when elapsed>=20ms; no elapsed-time catch-up. Charge continues during presented actions.',
            commands='Remake pauses for one player command between completed player actions; this input boundary is not original active-menu timing.',
            enemies='Fixed source command/first contact retained until two learned skills, 20% combination branch and all contacts are integrated together.',
            side_priority='Controlled initial0, carried across live forest battles; original serialized global state not imported.',
            initialization='Fresh one-player source roster. Original prologue, equipment statuses, opening animations and full party not replayed.'),
        original_game_execution_observed=False)
    save(RUNTIME/'web/data/battle_scheduler.json',data)
    assemblies={fn:native('procedure_assembly',fn)['normalized_result'].splitlines() for fn in ['0x502f30','0x5036d0','0x503600']}
    save(RUNTIME/'evidence/forest_scheduler_instructions_20261011.json',dict(functions=assemblies,evidence=proof,native_bundle=data['native_bundle']))
    assert all(digest(ROOT/p)==s for p,s in before.items())
    save(RUNTIME/'evidence/forest_scheduler_export_20261011.json',dict(success=True,source_hashes=before,idle_roles=list(idles),evidence=proof,original_game_execution_observed=False))
    print(json.dumps(dict(success=True,sources=len(before),idle_roles=len(idles))))
if __name__=='__main__':main()
