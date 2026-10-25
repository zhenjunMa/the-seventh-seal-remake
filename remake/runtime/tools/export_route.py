"""Bind the recovered post-story route; originals are read-only.

The historical level-12 fixture already has flags48 bit1 and51 bit1. Relocation
does not replay the opening story. Native movement/group rules are separate
from the bounded battle's fixed command/order and first-contact presentation.
"""
from pathlib import Path
import hashlib,json,struct,sys
sys.dont_write_bytecode=True
RUNTIME=Path(__file__).resolve().parents[1]
ROOT=RUNTIME.parents[1]
WEB=RUNTIME/'web'
sys.path.insert(0,str(RUNTIME/'tools'))
from source.combat_resources import CHR
from source.dgp import DGP
from PIL import Image
import export_combat_sample as combat
from export_battle_view import sequence
from save_format import complete_layout

def sha(b):return hashlib.sha256(b).hexdigest()
def read(p):return json.loads(p.read_text('utf-8'))
def save(p,v):
    assert p.resolve().is_relative_to(RUNTIME)
    p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n','utf-8')
def src(p,**kw):return dict(path=p.relative_to(ROOT).as_posix(),sha256=sha(p.read_bytes()),**kw)
def main():
    bundle=read(RUNTIME/'evidence/route_native_20261011.json')
    def native(op,address):
        return next(r for r in bundle['records'] if r['operation']==op and
                    address.lower() in [str(v).lower() for v in r['parameters'].values()])
    game=ROOT/'GAME.exe';assert sha(game.read_bytes())==combat.EXPECTED['GAME.exe']
    records=[native('read_bytes',a) for a in ['0x678ff8','0x6790e4','0x673e78']]
    before={p:sha((ROOT/p).read_bytes()) for p in ['GAME.exe','Map/m17010.dat','Map/m70010.dat','Map/m17010.TLK','Map/m70010.TLK','Map/m70010.STG']}
    areas=[]
    for ident,r in enumerate(records[:2]):
        b=bytes.fromhex(r['normalized_result']['bytes_hex'])
        # The provider's raw-byte offset is not assumed to include PE sections.
        offset=game.read_bytes().find(b);assert offset>=0 and game.read_bytes().find(b,offset+1)<0
        assert b[5]==7
        dest=[]
        for index in range(7):
            at=6+index*23;name=b[at+1:at+21].split(b'\0')[0].decode('ascii');mid=Path(name).stem.upper()
            dat=ROOT/'Map'/name
            title=dat.read_bytes()[0x1c:0x30].split(b'\0')[0].decode('cp936') if dat.exists() else mid
            dest.append(dict(index=index,name=title or mid,map_id=mid,entry_marker=b[at+21],sort_code=b[at+22],
                             source=src(game,file_offset=offset+at,raw_hex=b[at:at+23].hex()),evidence=[r['evidence_id']]))
        areas.append(dict(id=ident,selected_index=b[4],statuses=[b[6+i*23] for i in range(7)],destinations=dest))
    wm=dict(source=src(game),evidence=[r['evidence_id'] for r in records[:2]],areas=areas)
    save(WEB/'data/world_map.json',wm)
    resources=read(RUNTIME/'evidence/route_resources_20261011.json')
    maps=read(RUNTIME/'evidence/route_resources_maps_20261011.json')['maps']
    tlks={Path(t['path']).stem.upper():t for t in resources['selected_tlks']}
    route_events={}
    for m in maps:
        mid=m['id'];ids=([41,42,43,46,48] if mid=='M17010' else [1,15,16,17])
        records_tlk=[r for r in tlks[mid]['records'] if r['id'] in ids]
        for r in records_tlk:r.pop('raw_hex',None)
        route_events[mid]=dict(source={k:tlks[mid][k] for k in ['path','sha256']},records=records_tlk,
                              authority='Static TLK chain and native type9 handler; no original execution observed')
        descriptor=next(d for d in m['unresolved_triggers'] if d['id']==(10 if mid=='M17010' else 4))
        assert descriptor['state_raw']==2
        m['exits'].append(dict(id=descriptor['id'],state='ready',kind='world-map-event',cells=descriptor['cells'],
                              record_id=descriptor['field_26_raw'],source=descriptor))
        m['unresolved_triggers']=[d for d in m['unresolved_triggers'] if d['id']!=descriptor['id']]
        m['probes']=[dict(name='大地图出口 · 向下' if mid=='M17010' else '大地图出口 · 向左',
                         x=1304 if mid=='M17010' else 168,y=1536 if mid=='M17010' else 816,direction=7 if mid=='M17010' else 5,
                         purpose='Development relocation only; terrain checked before use'),
                     dict(name='地图原入口',x=m['route_entry']['x'],y=m['route_entry']['y'],direction=2)]
        save(WEB/f'data/maps/{mid.lower()}.json',m)
    save(WEB/'data/route_events.json',route_events)
    stg=ROOT/'Map/m70010.STG';b=stg.read_bytes();assert len(b)==932 and struct.unpack_from('<II',b)==(1,0) and b[8]==1 and b[209]==3
    members=[];actors={};skills={};meta=read(WEB/'data/battle_view.json');role_views=[meta['roles'][0]]
    for i in range(b[209]):
        filename=b[210+i*20:230+i*20].split(b'\0')[0].decode('ascii');ident=Path(filename).stem
        cpath=ROOT/'Fight_Role'/(ident+'.CHR');chr_=CHR(cpath);combat.EXPECTED[cpath.relative_to(ROOT).as_posix()]=sha(cpath.read_bytes())
        before[cpath.relative_to(ROOT).as_posix()]=sha(cpath.read_bytes())
        category=struct.unpack_from('<I',chr_.header,0x18)[0]
        members.append(dict(id=ident,name=chr_.name,pool='A' if category>=2 else 'B',class_raw=category,
                            source=src(stg,filename_offset=210+i*20),chr_source=src(cpath,header_class_offset=8+0x18)))
        selected=14 if ident in ['011','012'] else 15
        s=chr_.skills[selected];impacts=[a['index'] for a in s['actions'] if struct.unpack_from('<I',bytes.fromhex(a['raw_hex']),0x49)[0]]
        assert impacts
        alias=ident+'_attack'
        skill=combat.skill_record(alias,ident,bytes.fromhex(s['fixed_raw_hex']),s['offset'],selected,cpath,s['actions'],impacts[0])
        skill['bounded_contact_policy']='Fixed learned enemy skill, first source contact per command; complete multihit/AI deferred'
        skills[alias]=skill
        actors[ident]=combat.actor_record(ident,'enemy',chr_.header,cpath,8,{combat.address(n):0 for n in combat.LINK_FIELDS},skill)
        dpath=ROOT/'Fight_Role'/filename;dgp=DGP(dpath);before[dpath.relative_to(ROOT).as_posix()]=sha(dpath.read_bytes())
        idle=sequence(chr_,dgp,0)['segments'][0];reaction=sequence(chr_,dgp,1)['segments'][0];skill_view=sequence(chr_,dgp,selected)
        event_seen=False
        for seg in skill_view['segments']:
            if seg['event']:
                if event_seen:seg['deferred_source_event']=seg.pop('event');seg['event']=None
                event_seen=True
            # Additional enemy effect compositing needs its own pixel/field audit.
            seg['deferred_effects']=seg['effects'];seg['effects']=[]
        actions=[]
        for index in sorted({idle['action_index'],reaction['action_index']}|{s['action_index'] for s in skill_view['segments']}):
            a=dgp.actions[index];sheet=Image.new('RGBA',(dgp.width*a['frames_per_direction'],dgp.height*a['directions']))
            for direction in range(a['directions']):
                for frame in range(a['frames_per_direction']):
                    sheet.paste(dgp.decode(a['first_frame']+direction*a['frames_per_direction']+frame),(frame*dgp.width,direction*dgp.height))
            p=WEB/f'assets/forest_roles/{ident}/action_{index:02}.png';p.parent.mkdir(parents=True,exist_ok=True);sheet.save(p)
            actions.append(dict(index=index,sheet='/'+p.relative_to(WEB).as_posix(),sha256=sha(p.read_bytes()),frame_count=a['frames_per_direction'],directions=a['directions'],first_frame=a['first_frame']))
        skill_view['runtime_skill_id']=alias
        role_views.append(dict(id=ident,name=chr_.name,frame_width=dgp.width,frame_height=dgp.height,cursor_height_raw=dgp.cursor_height_raw,anchor=dict(x=dgp.anchor_raw[0],y=dgp.anchor_raw[1]),
                               mirror=False,direction=0,idle=idle,reaction=reaction,actions=actions,skill=skill_view))
    groupbytes=bytes.fromhex(records[2]['normalized_result']['bytes_hex'])
    rows=[list(struct.unpack_from('<III',groupbytes,i*12)) for i in range(13)]
    assert rows[:6]==[[0,0,i] for i in range(1,7)] and all(x[1]==0 for x in rows)
    h=(ROOT/'Map/m70010.dat').read_bytes()
    width,height=struct.unpack_from('<II',h,0x146)
    assert all(struct.unpack_from('<I',h,0x172+i*64+0x3c)[0]==0 for i in range(width*height)), 'Local encounter-zone overrides require a separate adapter'
    enc=dict(schema='seventh-seal-encounters',version=1,maps={'M70010':dict(frequency=h[0x140],stage=b[9:209].split(b'\0')[0].decode('ascii'),members=members,
        source=[src(ROOT/'Map/m70010.dat',frequency_offset=0x140),src(stg)],evidence=[native('procedure_pseudo_code','0x444d10')['evidence_id'],native('procedure_pseudo_code','0x445390')['evidence_id']])},
        compositions=rows,source=src(game),evidence=[records[2]['evidence_id']],
        policy=dict(step_pixels=16,step_measure='Chebyshev accepted travel distance accumulated from continuous keyboard motion; native grid completion mapped to 16px, original keyboard timing pending',
                    initial_counter=0,initial_rng_state=0x20261011,equipment_bonus=0,buff_bonus=0,
                    initialization='Controlled fresh encounter counter/RNG and zero encounter modifiers. Not native new-game or imported global RNG state.',
                    original_game_execution_observed=False))
    save(WEB/'data/encounters.json',enc)
    # Yantu's mask5 rejects a flying target class1. The same verified saved
    # player has learned skill21 (Xuanyingzhan), mask6, whose one contact can hit it.
    saved_path=ROOT/'save_analysis_20261010/verified_level12_SaveGame0.Dat';raw_saved=saved_path.read_bytes();saved_role=complete_layout(raw_saved)['characters'][0]
    selected=saved_role['skills'][21];off=selected['record_offset'];actions=[]
    for index in range(selected['action_record_count']):
        at=off+0x41d+index*0xb0;raw=raw_saved[at:at+0xb0]
        actions.append(dict(index=index,offset=at,bytes=0xb0,type_raw=raw[0],u32_at_0x01_raw=struct.unpack_from('<I',raw,1)[0],raw_hex=raw.hex()))
    yanci=combat.skill_record('yanci','001',raw_saved[off:off+0x41d],off,21,saved_path,actions,3)
    assert yanci['action_mask_raw']==6 and yanci['eligibility']['learned_flag_raw']==1
    cpath=ROOT/'Fight_Role/001.CHR';dpath=ROOT/'Fight_Role/001.dgp';c=CHR(cpath);d=DGP(dpath)
    assert [a['raw_hex'] for a in actions]==[a['raw_hex'] for a in c.skills[21]['actions']]
    alt=sequence(c,d,21);alt['runtime_skill_id']='yanci';role_views[0]['alternate_skills']=[alt]
    for index in sorted({s['action_index'] for s in alt['segments']}):
        if any(a['index']==index for a in role_views[0]['actions']):continue
        a=d.actions[index];sheet=Image.new('RGBA',(d.width*a['frames_per_direction'],d.height*a['directions']))
        for direction in range(a['directions']):
            for frame in range(a['frames_per_direction']):sheet.paste(d.decode(a['first_frame']+direction*a['frames_per_direction']+frame),(frame*d.width,direction*d.height))
        p=WEB/f'assets/forest_roles/001/action_{index:02}.png';p.parent.mkdir(parents=True,exist_ok=True);sheet.save(p)
        role_views[0]['actions'].append(dict(index=index,sheet='/'+p.relative_to(WEB).as_posix(),sha256=sha(p.read_bytes()),frame_count=a['frames_per_direction'],directions=a['directions'],first_frame=a['first_frame']))
    # Alternate intrinsic layer/effects remain explicitly uncomposited.
    for seg in alt['segments']:seg['deferred_effects']=seg['effects'];seg['effects']=[]
    for p in [saved_path,cpath,dpath]:before[p.relative_to(ROOT).as_posix()]=sha(p.read_bytes())
    save(WEB/'data/forest_combat.json',dict(schema='seventh-seal-forest-combat',version=1,actors=actors,skills=skills,player_skills={'yanci':yanci},source=enc,
         limits=['One saved player; full 1-4 source-generated enemies. Fixed player-first order and learned enemy commands, first source contact only. Original scheduler, full skill semantics, AI and rewards are deferred.']))
    meta['roles']=role_views;meta['policy']['roster']='forest-source-group';meta['policy']['enemy_contacts']='first source contact only, fixed commands; later source contacts retained as deferred_source_event'
    from export_forest_presentation import enrich
    save(WEB/'data/forest_battle_view.json',enrich(meta))
    seed=read(WEB/'data/world_seed.json');assert seed['flags'][48]&1 and seed['flags'][51]&1
    entry=next(m for m in maps if m['id']=='M17010')['route_entry'];seed['location']={k:entry[k] for k in ['x','y','direction']}|dict(map_id='M17010');seed['leader_id']='001'
    seed['source']['route_scope']='Development relocation of verified historical post-story level12 save; flags48/51 are unmodified. Opening story and new-game not replayed.'
    seed['world_map']=dict(areas=[{k:a[k] for k in ['id','selected_index','statuses']} for a in areas])
    save(WEB/'data/route_seed.json',seed)
    assert all(sha((ROOT/p).read_bytes())==s for p,s in before.items())
    save(RUNTIME/'evidence/route_export_20261011.json',dict(source_hashes=before,source_unchanged=True,world_map_records=14,forest_members=members,
        original_game_execution_observed=False,battle_limits=read(WEB/'data/forest_combat.json')['limits'],route_entry=seed['location'],gate_flags={str(n):seed['flags'][n] for n in [48,51]}))
    print('Route exported: 2 maps, 14 destinations, three forest actors, native 1-4 enemy generation; read-only sources unchanged.')
if __name__=='__main__':main()
