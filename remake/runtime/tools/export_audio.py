"""Read-only export of registered music, battle actions and effect sounds.

The original .wav suffix is not an encoding claim: music and several battle
sounds contain MPEG frames/ID3. MP3 is copied byte-for-byte with a truthful
suffix; legacy PCM RIFF is rewrapped and its decoded PCM digest cross-checked.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
sys.path.insert(0, str(RUNTIME / 'tools'))
from incremental import resource, recipe_hash, write_json, write_bytes
GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'
from source.combat_resources import CHR


def sha(raw): return hashlib.sha256(raw).hexdigest()
def save(path, value):
    assert path.resolve().is_relative_to(RUNTIME.resolve())
    write_json(path, value)


def original_text(raw, offset, size):
    value = raw[offset:offset+size].split(b'\0')[0].decode('ascii', 'strict')
    assert not any(c in value for c in '/\\') and value not in ['.', '..']
    return value


def evidence_record(filename, procedure):
    path = ROOT / filename
    obj = json.loads(path.read_text('utf-8'))
    records = [r for r in obj['records'] if r.get('parameters', {}).get('procedure', '').lower() == procedure.lower()]
    assert records and all(r['subject']['digest']['sha256'] == GAME_SHA for r in records)
    preferred = next((r for r in records if r['operation'] in ['procedure_pseudo_code', 'analyze_function']), records[0])
    return preferred


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--ffmpeg', default=shutil.which('ffmpeg'))
    parser.add_argument('--ffprobe', default=shutil.which('ffprobe')); args = parser.parse_args()
    assert args.ffmpeg and args.ffprobe, 'Existing ffmpeg and ffprobe are required; no dependency installation is performed'
    encoders = {tool: subprocess.run([getattr(args,tool), '-version'], check=True,
                capture_output=True, text=True).stdout.splitlines()[0] for tool in ('ffmpeg','ffprobe')}
    sources = {}
    def read(path):
        p = ROOT / path; raw = p.read_bytes(); sources[path] = sha(raw); return raw
    assert sha(read('GAME.exe')) == GAME_SHA
    native = [evidence_record('remake/runtime/evidence/opening_native.json', '0x4c1d47'),
              evidence_record('remake/runtime/evidence/source/combat_presentation_native_20261011.json', '0x512210'),
              evidence_record('remake/runtime/evidence/chapter_map_native.json', '0x4a5f00'),
              evidence_record('remake/runtime/evidence/forest_ai_rules_native_20261011.json', '0x49ffa0')]
    native_paths = ['remake/runtime/evidence/opening_native.json', 'remake/runtime/evidence/source/combat_presentation_native_20261011.json',
                    'remake/runtime/evidence/chapter_map_native.json', 'remake/runtime/evidence/forest_ai_rules_native_20261011.json']
    native_ref = {p:sha((ROOT/p).read_bytes()) for p in native_paths}
    carrier_bundle = 'remake/runtime/evidence/party_magic_native.json'
    native.append(evidence_record(carrier_bundle, '0x5074c0'))
    native_ref[carrier_bundle] = sha((ROOT/carrier_bundle).read_bytes())
    extra_path = RUNTIME / 'evidence/audio_native.json'
    if extra_path.exists():
        extra = json.loads(extra_path.read_text('utf-8'))
        assert all(r['subject']['digest']['sha256'] == GAME_SHA for r in extra['records'])
        native.extend(extra['records']); native_ref[extra_path.relative_to(ROOT).as_posix()] = sha(extra_path.read_bytes())
    evidence = {r['parameters'].get('procedure', r['operation']).lower():r['evidence_id'] for r in native}
    assert all(key in evidence for key in ['0x4a09c0','0x50aacf','0x51c48f','0x50f377']), 'Retained native music and frame-sound execution evidence is required'
    def media_probe(path):
        result = subprocess.run([args.ffprobe, '-v', 'error', '-select_streams', 'a:0', '-show_entries',
            'stream=codec_name,sample_rate,channels,bits_per_sample:format=duration', '-of', 'json', str(path)],
            check=True, capture_output=True, text=True)
        info = json.loads(result.stdout); assert len(info['streams']) == 1
        stream = info['streams'][0]; duration = float(info['format']['duration']); assert duration > 0
        return dict(codec=stream['codec_name'], sample_rate=int(stream['sample_rate']), channels=stream['channels'],
                    bits_per_sample=stream.get('bits_per_sample', 0), duration_seconds=duration)
    def pcm_digest(path):
        result = subprocess.run([args.ffmpeg, '-v', 'error', '-i', str(path), '-map', '0:a:0', '-f', 'md5', '-'],
                                check=True, capture_output=True, text=True)
        return result.stdout.strip()
    clips, tokens, missing = {}, {}, []
    def clip(source):
        if source in clips: return source
        p = ROOT/source
        if not p.is_file():
            if source not in missing: missing.append(source)
            return None
        raw = read(source)
        def produce_clip():
            actual = media_probe(p)
            is_riff = raw.startswith(b'RIFF') and raw[8:12] == b'WAVE'
            is_mpeg = raw.startswith(b'ID3') or len(raw)>1 and raw[0]==0xff and raw[1]&0xe0==0xe0
            assert is_riff or is_mpeg, f'Unrecognized original encoding {source}'
            if is_mpeg:
                assert actual['codec'] == 'mp3'
                extension, mime = '.mp3', 'audio/mpeg'
            else:
                assert actual['codec'].startswith('pcm_')
                extension, mime = '.wav', 'audio/wav'
            out = WEB/'assets/audio'/Path(source).relative_to('sound').with_suffix(extension)
            out.parent.mkdir(parents=True, exist_ok=True)
            if is_mpeg: write_bytes(out, raw)
            else:
                temporary = out.with_name(out.stem + '.encoding.wav')
                try:
                    subprocess.run([args.ffmpeg, '-v', 'error', '-y', '-i', str(p), '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', str(temporary)], check=True)
                    write_bytes(out, temporary.read_bytes())
                finally:
                    temporary.unlink(missing_ok=True)
            decoded_source, decoded_output = pcm_digest(p), pcm_digest(out)
            assert decoded_source == decoded_output, f'Decoded audio changed: {source}'
            if is_mpeg: assert out.read_bytes() == raw
            exported_probe = media_probe(out)
            descriptor = dict(path='/'+out.relative_to(WEB).as_posix(), mime=mime, sha256=sha(out.read_bytes()),
                source=dict(path=source, sha256=sha(raw), bytes=len(raw), header_hex=raw[:16].hex(), declared_extension=p.suffix,
                            observed_encoding='MPEG Layer III' if is_mpeg else 'RIFF/WAVE PCM'),
                audio=exported_probe, export=dict(method='byte-preserving MPEG suffix correction' if is_mpeg else 'canonical PCM RIFF rewrap',
                                                 decoded_pcm_md5=decoded_output, decoded_audio_unchanged=True))
            return descriptor, [out]
        clips[source] = resource(RUNTIME, 'audio/'+source, {'source':sha(raw),'encoders':encoders},
            recipe_hash([Path(__file__)]), produce_clip)
        return source
    maps = {}
    from content_registration import map_ids, stage_exports
    for ident in map_ids():
        path = f'Map/{ident.lower()}.dat'; raw = read(path); assert struct.unpack_from('<I', raw, 0x14)[0] == 6
        token = original_text(raw, 0x44, 0x40); assert token.lower().endswith('.wav')
        maps[ident] = dict(clip=clip('sound/'+token), source=dict(path=path, sha256=sha(raw), offset=0x44, bytes=0x40, token=token),
            evidence=[evidence['0x4a5f00'],evidence['0x4a09c0']], confidence='source DAT+0x44 and confirmed native same-track/load branch')
    encounters = json.loads((WEB/'data/encounters.json').read_text('utf-8'))
    battles = {}
    stage_sources={entry['stage']:entry['evidence'] for entry in encounters['maps'].values()}
    for stage,row in stage_exports().items():
        if row['export']=='source':stage_sources.setdefault(stage+'.scn',[])
    for stage, stage_evidence in stage_sources.items():
        path='Fight_Bk/'+stage; raw=read(path); token=original_text(raw,0x1c,20)
        # 0x50AA80 enumerates at most ten *.WAV and chooses rand()%count when
        # SCN+0x1C is empty. Order below is deterministic remake enumeration;
        # the original Windows filesystem enumeration order was not observed.
        pool = [clip(p.relative_to(ROOT).as_posix()) for p in sorted((ROOT/'sound/Fight').glob('*.wav'))[:10]] if not token else None
        battles[stage] = dict(clip=clip('sound/'+token) if token else None,
            source=dict(path=path, sha256=sha(raw), offset=0x1c, bytes=20, token=token),
            evidence=list(stage_evidence)+[evidence['0x51c48f'],evidence['0x50aacf']],
            confidence='source SCN field and confirmed native fallback pool', **(dict(pool=pool,selection='source default pool; fresh browser random selection') if pool else {}))
    for ident,entry in encounters['maps'].items():
        stage=entry['stage'];battles[ident] = dict(battles[stage], stage_id=stage)
    # Keep the older standalone menu clip, but operation MNU controls use the
    # separate five-entry native562EF0 table, not that older menu implementation.
    confirm = clip('sound/menu/mDecide.wav')
    menu_rules_path=WEB/'data/menu_audio_rules.json';menu_rules=json.loads(menu_rules_path.read_text('utf-8'))
    assert menu_rules['schema']=='seventh-seal-menu-audio' and menu_rules['version']==1 and menu_rules['game_sha256']==GAME_SHA
    bundle_path=ROOT/menu_rules['native_bundle'];assert sha(bundle_path.read_bytes())==menu_rules['native_bundle_sha256']
    retained=json.loads(bundle_path.read_text('utf-8'))['records']
    assert set(menu_rules['evidence'].values())<={r['evidence_id'] for r in retained}
    assert [r['source'] for r in menu_rules['banks']]==['sound/menu/'+name for name in ['cancel.wav','decide.wav','select.wav','open.wav','close.wav']]
    native_ref[menu_rules['native_bundle']]=menu_rules['native_bundle_sha256']
    native_ref[menu_rules_path.relative_to(ROOT).as_posix()]=sha(menu_rules_path.read_bytes())
    menu_clips=[clip(row['source']) for row in menu_rules['banks']]
    cues={'legacyMenuConfirm':dict(clip=confirm,evidence=[evidence['0x4c1d47']],policy='Retained standalone menu source; operation controls use decide.wav.')}
    for name,index in menu_rules['cue_indices'].items():
        cues[name]=dict(clip=menu_clips[index],native_index=index,evidence=list(menu_rules['evidence'].values()),
            source=menu_rules['banks'][index]['source'],policy='Native operation menu cue table; cancel is also the invalid-operation sound.')
    assert b'%smworld.wav' in (ROOT/'GAME.exe').read_bytes()
    world_map = dict(clip=clip('sound/mworld.wav'),evidence=[evidence['0x49ffa0']],source_string='%smworld.wav',
                     confidence='native world-map open/close pauses/resumes map music')
    meta_path=WEB/'data/party_battle_view.json'; meta=json.loads(meta_path.read_text('utf-8')); action_sources=[]; frame_sounds={}
    lifecycle_path=WEB/'data/battle_lifecycle.json';lifecycle_meta=json.loads(lifecycle_path.read_text('utf-8'))
    assert lifecycle_meta['schema']=='seventh-seal-battle-lifecycle' and lifecycle_meta['version']==2
    lifecycle_roles={role['id']:role for role in lifecycle_meta['roles']}
    item_path=WEB/'data/item_presentation.json';item_meta=json.loads(item_path.read_text('utf-8')) if item_path.exists() else None
    reference_hashes={meta_path.relative_to(ROOT).as_posix():sha(meta_path.read_bytes())}
    reference_hashes[lifecycle_path.relative_to(ROOT).as_posix()]=sha(lifecycle_path.read_bytes())
    item_roles={}
    if item_meta:
        assert item_meta['schema']=='seventh-seal-item-presentation' and item_meta['version']==1
        assert item_meta['source_hashes']['GAME.exe']==GAME_SHA
        for path, expected in item_meta['source_hashes'].items():assert sha(read(path))==expected
        reference_hashes[item_path.relative_to(ROOT).as_posix()]=sha(item_path.read_bytes())
        item_roles={role['id']:role for role in item_meta['roles']}
    for role in meta['roles']:
        path=f"Fight_Role/{role['id']}.CHR"; read(path); chr_=CHR(ROOT/path)
        indices={s['chr_skill_index'] for s in [role['skill'],*role.get('alternate_skills',[]),*role.get('response_skills',[])]}
        lifecycle_role=lifecycle_roles.get(role['id'])
        if lifecycle_role:
            assert lifecycle_role['source_chr_sha256']==chr_.sha256
            indices.update(skill['chr_skill_index'] for skill in lifecycle_role['skills'])
        if role['id'] in item_roles:indices.add(item_roles[role['id']]['chr_skill_index'])
        groups={action['index'] for action in item_roles.get(role['id'],{}).get('actions',[])}
        for index in sorted(indices):
            for action in chr_.skills[index]['actions']:
                raw=bytes.fromhex(action['raw_hex'])
                if raw[0] != 0: continue
                groups.add(struct.unpack_from('<I',raw,1)[0])
                token=original_text(raw,0x7a,20)
                if not token: continue
                assert token.lower().endswith('.wav')
                tokens[token]=clip('sound/'+token)
                action_sources.append(dict(role_id=role['id'],skill_index=index,record_index=action['index'],
                    source_path=path, source_sha256=chr_.sha256, offset=action['offset'],raw_sha256=sha(raw),
                    token_offset=0x7a, token=token, logical_frame_offset=0x8e, logical_frame=struct.unpack_from('<I',raw,0x8e)[0]))
        dgp_path=f"Fight_Role/{role['id']}.dgp"; dgp_raw=read(dgp_path); assert dgp_raw[0]==9
        role_sounds={}
        for group in sorted(groups):
            assert 0<=group<dgp_raw[2]
            offset=0x43+group*0xac; raw=dgp_raw[offset:offset+0xac];token=original_text(raw,0x56,20)
            if not token: continue
            role_sounds[str(group)]=dict(clip=clip('sound/'+token),token=token,logical_frame=struct.unpack_from('<I',raw,0x6a)[0],
                source=dict(path=dgp_path,sha256=sha(dgp_raw),offset=offset,bytes=0xac,raw_sha256=sha(raw),token_offset=0x56,logical_frame_offset=0x6a),
                evidence=[evidence['0x50f377']])
        frame_sounds[role['id']]=role_sounds
    effect_sounds={};item_effects={}
    for presentation in [meta,lifecycle_meta,*([item_meta] if item_meta else [])]:
        for effect in presentation['effects']:
            path=effect['source'];raw=read(path);assert sha(raw)==effect['source_sha256'] and raw[0]==9 and raw[2]==1
            record=raw[0x43:0x43+0xac]
            if 'native_raw_hex' in effect:assert record.hex()==effect['native_raw_hex']
            token=original_text(record,0x56,20)
            if 'sound_token_raw_56' in effect:assert token==effect['sound_token_raw_56']
            entry=dict(clip=clip('sound/'+token) if token else None,token=token,
                logical_frame=struct.unpack_from('<I',record,0x6a)[0],interval_ms=struct.unpack_from('<I',record,1)[0],
                source=dict(path=path,sha256=sha(raw),offset=0x43,bytes=0xac,raw_sha256=sha(record),token_offset=0x56,logical_frame_offset=0x6a),
                evidence=[*effect['evidence'],evidence['0x5074c0']],confidence='source DGP+0x56/+0x6A and native 5074C0 carrier audio; playback follows visited logical frames')
            if effect['id'] in effect_sounds:assert effect_sounds[effect['id']]['source']==entry['source']
            effect_sounds[effect['id']]=entry
    if item_meta:
        for item_id,item in item_meta['items'].items():
            source=item['source'];raw=read(source['path']);assert sha(raw)==source['sha256']
            record=raw[source['record_offset']:source['record_offset']+0x3bf];assert sha(record)==source['record_sha256']
            token=original_text(record,source['effect_field_offset'],source['effect_field_bytes'])
            assert token==item['effect_token_raw_126'] and Path(token).stem==item['effect_id'] and item['effect_id'] in effect_sounds
            item_effects[item_id]=dict(effect_id=item['effect_id'],source=source,evidence=[item['settlement']['evidence']['evidence_id']])
    limitations=['Static source reconstruction; original GAME.exe audio playback has not been observed.',
        'Browser looping, global volume, mute, eight transient voices and resume position are remake policies.',
        'Empty stage13 music uses the confirmed original Fight WAV pool; deterministic sorted enumeration and fresh browser RNG do not reproduce original rand state or Windows enumeration order.',
        'CHR and actor DGP filenames/logical frames are retained; exact original mixer scheduling, voice priorities and inhibited-actor flag transitions remain outside the browser adapter.',
        'Skill/carrier, item and lifecycle audio share the source-backed controller; lifecycle callbacks observe live entry immunity and use CHR logical cursors rather than physical DGP frame-table values.',
        'Missing original voice clips are recorded and skipped; no replacement sound is fabricated.',
        'Operation menu open/select/confirm/cancel use the confirmed native five-entry table. Missing close.wav is retained as unavailable, without substituting _close.wav or close.mp3.',
        'Browser feedback coalesces keyboard/click handling to one cue per gesture; exact original nested-panel mixer timing is not reproduced.']
    manifest=dict(schema='seventh-seal-audio',version=1,clips=clips,maps=maps,battles=battles,cues=cues,world_map=world_map,action_tokens=tokens,frame_sounds=frame_sounds,
        effect_sounds=effect_sounds,item_effects=item_effects,reference_hashes=reference_hashes,
        action_sources=action_sources,source_hashes=sources,native_evidence=evidence,native_bundle_hashes=native_ref,
        missing_original_files=missing,limitations=limitations)
    save(WEB/'data/audio.json',manifest)
    assert all(sha((ROOT/p).read_bytes())==value for p,value in sources.items()), 'Original source changed during export'
    save(RUNTIME/'evidence/audio_export.json',dict(success=True,original_source_unchanged=True,original_game_execution_observed=False,
        clips=len(clips),maps=len(maps),source_action_records=len(action_sources),source_hashes=sources,
        missing_original_files=missing,manifest_sha256=sha((WEB/'data/audio.json').read_bytes()),
        decoded_audio_unchanged=all(c['export']['decoded_audio_unchanged'] for c in clips.values()),limitations=limitations))
    print(json.dumps(dict(clips=len(clips),maps=len(maps),action_records=len(action_sources),missing=missing)))


if __name__ == '__main__': main()
