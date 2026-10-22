"""Export all current forest learned skill timelines; leave historical manifests intact."""
from pathlib import Path
import hashlib,json,struct,sys
sys.dont_write_bytecode=True
RUNTIME=Path(__file__).resolve().parents[1];ROOT=RUNTIME.parents[1];WEB=RUNTIME/'web'
sys.path.insert(0,str(ROOT/'remake/prototype/tools'))
sys.path.insert(0,str(RUNTIME/'tools'))
from PIL import Image
from combat_resources import CHR
from dgp import DGP
from export_battle_view import sequence
from export_combat_presentation import indexed_contribution,native_frame_sequence,NATIVE_IDS
from export_skill_layers import SourceAudit,save_layer
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p,v):
    assert p.resolve().is_relative_to(RUNTIME)
    p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n','utf-8')
def main():
    meta=json.loads((WEB/'data/forest_battle_view.json').read_text('utf-8'))
    sources=dict(meta['source_hashes']);checks=[];response_layers=None
    for role in meta['roles']:
        ident=role['id'];cp=ROOT/f'Fight_Role/{ident}.CHR';dp=ROOT/f'Fight_Role/{ident}.dgp';c=CHR(cp);d=DGP(dp)
        sources[cp.relative_to(ROOT).as_posix()]=sha(cp);sources[dp.relative_to(ROOT).as_posix()]=sha(dp)
        if ident!='001':
            indices=[14,15] if ident in ['011','012'] else [15,16]
            views=[sequence(c,d,k) for k in indices]
            for v in views:v['runtime_skill_id']=f"{ident}_skill_{v['chr_skill_index']}"
            role['skill']=views[0];role['alternate_skills']=views[1:]
        role['response_skills']=[sequence(c,d,k) for k,s in enumerate(c.skills) if s['id_raw'] in [1,2,3,9,18,19]]
        all_views=[role['skill']]+role.get('alternate_skills',[])+role['response_skills']
        for skill in all_views:
            for seg in skill['segments']:
                seg.pop('deferred_effects',None);seg.pop('deferred_source_event',None)
                raw=bytes.fromhex(c.skills[skill['chr_skill_index']]['actions'][seg['chr_record_index']]['raw_hex'])
                seg['raw_hex']=raw.hex();seg['source_skill_index']=skill['chr_skill_index']
                assert hashlib.sha256(raw).hexdigest()==seg['source']['raw_sha256']
        used={s['action_index'] for v in all_views for s in v['segments']}|{role['idle']['action_index'],role['reaction']['action_index']}
        role['actions']=[a for a in role['actions'] if a['index'] in used]
        for index in sorted(used):
            a=d.actions[index];old=next((x for x in role['actions'] if x['index']==index),None)
            if old is None:
                out=WEB/f'assets/forest_full_roles/{ident}/action_{index:02}.png';out.parent.mkdir(parents=True,exist_ok=True)
                sheet=Image.new('RGBA',(d.width*a['frames_per_direction'],d.height*a['directions']))
                for direction in range(a['directions']):
                    for frame in range(a['frames_per_direction']):sheet.paste(d.decode(a['first_frame']+direction*a['frames_per_direction']+frame),(frame*d.width,direction*d.height))
                sheet.save(out)
                with Image.open(out) as b:assert b.convert('RGBA').tobytes()==sheet.tobytes()
                old=dict(index=index,sheet='/'+out.relative_to(WEB).as_posix(),sha256=sha(out),frame_count=a['frames_per_direction'],directions=a['directions'],first_frame=a['first_frame']);role['actions'].append(old)
            old['native_raw_hex']=d.raw_actions[index].hex()
        if ident=='001':
            bank=[];audit=SourceAudit(d.data)
            physical=sorted({d.actions[s['action_index']]['first_frame']+f for v in role['response_skills'] for s in v['segments'] for f in s['frames']})
            for source in physical:
                out=WEB/f'assets/forest_response_layers/frame_{source:04}';out.parent.mkdir(parents=True,exist_ok=True)
                a,ac=audit.sparse(source,False);b,bc=audit.sparse(source,True)
                m=save_layer(d.decode(source),Path(str(out)+'_main.png'),a,ac);i=save_layer(indexed_contribution(d,source)[0],Path(str(out)+'_intrinsic.png'),b,bc);i['active']=bool(d.indexed_auxiliary[source]['active_raw'])
                bank.append(dict(source_frame=source,main=m,intrinsic=i));checks.append(dict(role=ident,source_frame=source,main=ac,intrinsic=bc))
            response_layers=dict(schema='seventh-seal-native-layer-bank',version=1,role_id='001',frame_width=d.width,frame_height=d.height,anchor=role['anchor'],frames=bank,source_hashes=sources)
    known={e['id'] for e in meta['effects']}
    for role in meta['roles']:
        for skill in [role['skill']]+role.get('alternate_skills',[])+role.get('response_skills',[]):
            for seg in skill['segments']:
                for event in seg['effects']:
                    if event['asset_id'] in known:continue
                    ident=event['asset_id'];p=ROOT/f'Fight_Role/Effect/{ident}.dgp';d=DGP(p);audit=SourceAudit(p.read_bytes())
                    sources[p.relative_to(ROOT).as_posix()]=sha(p)
                    assert len(d.actions)==1 and d.actions[0]['directions']==1
                    assert sum(n for f in range(d.frame_count) for _,spans in d.rows(f) for _,n,_ in spans)==0
                    sheet=Image.new('RGBA',(d.width*d.frame_count,d.height))
                    for f in range(d.frame_count):
                        image,stat=indexed_contribution(d,f);rgba,check=audit.sparse(f,True);assert image.tobytes()==rgba;sheet.paste(image,(f*d.width,0));checks.append(dict(effect=ident,frame=f,**check))
                    out=WEB/f'assets/forest_full_effects/{ident}/action_00.png';out.parent.mkdir(parents=True,exist_ok=True);sheet.save(out)
                    meta['effects'].append(dict(id=ident,source=p.relative_to(ROOT).as_posix(),source_sha256=sha(p),frame_width=d.width,frame_height=d.height,frame_count=d.frame_count,
                        anchor=dict(x=d.anchor_raw[0],y=d.anchor_raw[1]),sheet='/'+out.relative_to(WEB).as_posix(),sha256=sha(out),frames=native_frame_sequence(d.raw_actions[0],0,d.frame_count,0),blend='lighter',evidence=[NATIVE_IDS['indexed_draw'],NATIVE_IDS['effect_action']]))
                    known.add(ident)
    meta['source_hashes']=sources;meta['policy']['complete_contacts']=True
    meta['policy']['death']='Native id12/id2 lookup and fade draws are settled by battle_reactions; Canvas fade and death pose timing remain previews.'
    meta['policy']['choreography']='Signed CHR +0x1e and native target offsets drive every full forest approach/return; frame interpolation and independent path clocks remain previews.'
    if response_layers:
        p=WEB/'data/forest_response_layers.json';save(p,response_layers);meta['extra_layers']=dict(path='/data/forest_response_layers.json',sha256=sha(p))
    meta['policy']['enemy_contacts']='All source contact events for both learned skills of each forest enemy; native combination record composition is performed at runtime.'
    meta['limits']=['Original sprites and all source contact events for the currently exposed two player skills and six learned forest enemy skills.','Coordinate projection, interpolation and additive Canvas remain presentation policies; original renderer and OS animation clocks are not executed.']
    assert all(sha(ROOT/p)==v for p,v in sources.items())
    save(WEB/'data/forest_full_battle_view.json',meta)
    save(RUNTIME/'evidence/forest_full_skills_export_20261011.json',dict(success=True,source_hashes=sources,source_unchanged=True,skills=sum(1+len(r.get('alternate_skills',[])) for r in meta['roles']),
        contacts={f"{r['id']}:{s['chr_skill_index']}":sum(bool(x['event']) for x in s['segments']) for r in meta['roles'] for s in [r['skill']]+r.get('alternate_skills',[])},effect_frame_checks=checks,original_game_execution_observed=False))
    print('Full forest skills exported: eight skills, every original contact, isolated metadata.')
if __name__=='__main__':main()
