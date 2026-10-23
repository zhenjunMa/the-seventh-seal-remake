"""Restore forest skill layers/effects from read-only original DGP/CHR bytes."""
from pathlib import Path
import hashlib, json, struct, sys
sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME/'web'
sys.path.insert(0, str(ROOT / "remake/runtime/tools"))
from PIL import Image
from source.dgp import DGP
from source.combat_resources import CHR
from export_combat_presentation import indexed_contribution, native_frame_sequence, NATIVE_IDS
from export_skill_layers import SourceAudit, save_layer
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p, value):
    assert p.resolve().is_relative_to(RUNTIME)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', 'utf-8')
def enrich(meta):
    sources = {p:sha(ROOT/p) for p in ['GAME.exe','Fight_Role/001.CHR','Fight_Role/001.dgp']}
    role = next(r for r in meta['roles'] if r['id']=='001')
    skill = next(s for s in role['alternate_skills'] if s['runtime_skill_id']=='yanci')
    c, d = CHR(ROOT/'Fight_Role/001.CHR'), DGP(ROOT/'Fight_Role/001.dgp')
    audit = SourceAudit(d.data)
    assert c.skills[21]['name_cp936']==skill['name'] and c.skills[21]['id_raw']==skill['skill_id_raw']
    frames, checks = [], []
    for si, segment in enumerate(skill['segments']):
        raw = bytes.fromhex(c.skills[21]['actions'][segment['chr_record_index']]['raw_hex'])
        action = d.actions[segment['action_index']]
        assert action['directions']==1 and segment['frames']==native_frame_sequence(d.raw_actions[action['index']], segment['start'], segment['end_exclusive'], raw[0x1d])
        for frame in segment['frames']:
            source = action['first_frame']+frame
            main, intrinsic = d.decode(source), indexed_contribution(d, source)[0]
            a, ac = audit.sparse(source, False)
            b, bc = audit.sparse(source, True)
            prefix = WEB/f'assets/skills/xuanying/frame_{source:04}'
            prefix.parent.mkdir(parents=True, exist_ok=True)
            m = save_layer(main, Path(str(prefix)+'_main.png'), a, ac)
            i = save_layer(intrinsic, Path(str(prefix)+'_intrinsic.png'), b, bc)
            i['active'] = bool(d.indexed_auxiliary[source]['active_raw'])
            frames.append(dict(sequence_index=len(frames), segment_index=si, action_index=action['index'], action_frame=frame, source_frame=source, main=m, intrinsic=i))
            checks.append(dict(source_frame=source, main=ac, intrinsic=bc))
    layers_path = WEB/'data/xuanying_layers.json'
    save(layers_path, dict(schema='seventh-seal-skill-layers', version=1, id='yanci', name=skill['name'], role_id='001',
         frame_width=d.width, frame_height=d.height, anchor=role['anchor'], frames=frames,
         source_hashes=sources, evidence=[NATIVE_IDS['indexed_draw'],NATIVE_IDS['range'],NATIVE_IDS['events']],
         limits=['Source main/intrinsic pairs, additive Canvas approximation; original exact timing and RGB565 destination remain outside this view.']))
    skill['layers'] = dict(path='/data/xuanying_layers.json', sha256=sha(layers_path))
    effect_ids = {e['id'] for e in meta['effects'] if e['id'] not in ['BFr01_Nd','_DutyEg','_DutyEb']}
    effect_checks = []
    for r in meta['roles']:
        chr_path = ROOT/f"Fight_Role/{r['id']}.CHR"
        original = CHR(chr_path)
        sources[chr_path.relative_to(ROOT).as_posix()] = sha(chr_path)
        for s in [r['skill']]+r.get('alternate_skills', []):
            for seg in s['segments']:
                raw = bytes.fromhex(original.skills[s['chr_skill_index']]['actions'][seg['chr_record_index']]['raw_hex'])
                assert hashlib.sha256(raw).hexdigest()==seg['source']['raw_sha256']
                seg['movement_step_raw'] = struct.unpack_from('<i',raw,0x1e)[0]
                seg['movement_source_field'] = '0x1e'
                deferred = seg.get('deferred_effects', [])
                enabled = [e for e in deferred if e['slot']=='actor' or seg['event']]
                seg['effects'] += [e for e in enabled if e not in seg['effects']]
                seg['deferred_effects'] = [e for e in deferred if e not in enabled]
                for event in seg['effects']:
                    ident = event['asset_id']
                    if ident in effect_ids: continue
                    src = ROOT/f'Fight_Role/Effect/{ident}.dgp'
                    sources[src.relative_to(ROOT).as_posix()] = sha(src)
                    effect = DGP(src); independent = SourceAudit(src.read_bytes())
                    assert len(effect.actions)==1 and effect.actions[0]['directions']==1
                    assert sum(n for f in range(effect.frame_count) for _,spans in effect.rows(f) for _,n,_ in spans)==0
                    sheet = Image.new('RGBA',(effect.width*effect.frame_count,effect.height))
                    for f in range(effect.frame_count):
                        img, stats = indexed_contribution(effect,f)
                        rgba, checked = independent.sparse(f,True)
                        assert img.tobytes()==rgba
                        sheet.paste(img,(f*effect.width,0))
                        effect_checks.append(dict(effect=ident,frame=f,**checked))
                    out = WEB/f'assets/combat_effects/{ident}/action_00.png'
                    out.parent.mkdir(parents=True,exist_ok=True);sheet.save(out)
                    with Image.open(out) as stored: assert stored.convert('RGBA').tobytes()==sheet.tobytes()
                    meta['effects'] = [e for e in meta['effects'] if e['id']!=ident]
                    meta['effects'].append(dict(id=ident,source=src.relative_to(ROOT).as_posix(),source_sha256=sha(src),
                        frame_width=effect.width,frame_height=effect.height,frame_count=effect.frame_count,
                        anchor=dict(x=effect.anchor_raw[0],y=effect.anchor_raw[1]),sheet='/'+out.relative_to(WEB).as_posix(),sha256=sha(out),
                        frames=native_frame_sequence(effect.raw_actions[0],0,effect.frame_count,0),blend='lighter',evidence=[NATIVE_IDS['indexed_draw'],NATIVE_IDS['effect_action']]))
                    effect_ids.add(ident)
    meta['source_hashes'].update(sources)
    meta['policy']['contact_gap_raw']=128
    meta['policy']['contact_y_offset_raw']=1
    meta['policy']['contact_gap']=128*meta['policy']['sprite_scale']
    meta['policy']['contact_y_offset']=meta['policy']['sprite_scale']
    meta['policy']['contact_evidence']=['ev_f2a12d5f0dfede2c26a4b575da514cdd2c706f7afb4f4a955f7378e83470087a','ev_e7ebc40b1eb0efaa9d96ff7f3e6fc290955d8807dff0dc831ad32c06ceb45a70']
    meta['policy']['choreography']='Signed CHR +0x1e drives approach/return; native 0x51e2b0 target offsets X128/Y1 projected with sprite scale. Snow retains bounded lunge; frame interpolation/native path timing pending.'
    meta['limits']=[s for s in meta['limits'] if not s.startswith('Only player001')]
    meta['limits'].append('Forest group, player Yantu/Xuanyingzhan and fixed enemy first-contact skills; original full scheduler/AI/multihit remain pending.')
    assert all(sha(ROOT/p)==v for p,v in sources.items())
    save(RUNTIME/'evidence/forest_presentation_pixels_20261011.json',dict(success=True,source_hashes=sources,source_unchanged=True,
        player_frames=len(frames),active_intrinsic_frames=[f['source_frame'] for f in frames if f['intrinsic']['active']],
        layer_checks=checks,effect_frame_checks=effect_checks,original_game_execution_observed=False))
    return meta
def main():
    path = WEB/'data/forest_battle_view.json'
    save(path,enrich(json.loads(path.read_text('utf-8'))))
    print('Forest presentation: Xuanyingzhan same-source intrinsic and source actor/target effects restored.')
if __name__=='__main__': main()
