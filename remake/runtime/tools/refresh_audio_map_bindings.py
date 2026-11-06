"""Refresh admitted DAT/TLK audio bindings against fixed verified clips."""
import hashlib
import json
from pathlib import Path
import struct
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from content_registration import map_ids
from export_audio import GAME_SHA, original_text
from export_media import MediaBuilder
from export_native_services import statue_sounds, casino_sounds
from route_extract_resources import tlk_record
from source.dgp import DGP
from source.map_objects import MapObjects
from incremental import recipe_hash, resource, write_json

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def refresh_statue_clips(value, sources):
    """Add only the four fixed WordDisc carriers through the media PCM path."""
    services = json.loads((WEB / 'data/native_services.json').read_text('utf-8'))
    raw_game = (ROOT / 'GAME.exe').read_bytes()
    by_service = dict(statue=statue_sounds(raw_game), code=casino_sounds(raw_game, code=True),
                      lotto=casino_sounds(raw_game), roulette=casino_sounds(raw_game), smallLotto=casino_sounds(raw_game))
    if services['source_hashes'].get('GAME.exe') != GAME_SHA or any(
            services['special'][name]['sounds'] != rows for name, rows in by_service.items()):
        raise ValueError('WordDisc audio bindings need the current native-services source export')
    bindings = {row['clip']: row for rows in by_service.values() for row in rows.values() if row['clip']}
    builder = MediaBuilder(RUNTIME, (ROOT / 'GAME.exe').resolve().parent)
    if not builder.ffmpeg or not builder.ffprobe:
        raise ValueError('Existing ffmpeg and ffprobe are required for WordDisc audio export')
    encoders = {name: builder.run([tool, '-version']).decode('utf-8', 'replace').splitlines()[0]
                for name, tool in [('ffmpeg', builder.ffmpeg), ('ffprobe', builder.ffprobe)]}

    def pcm(path):
        return builder.run([builder.ffmpeg, '-v', 'error', '-nostdin', '-i', str(path),
                            '-map', '0:a:0', '-f', 'md5', '-']).decode('ascii').strip()

    for binding in bindings.values():
        source = binding['clip']
        path = ROOT / source
        raw = path.read_bytes()
        raw_sha = hashlib.sha256(raw).hexdigest()
        if not (raw.startswith(b'RIFF') and raw[8:12] == b'WAVE') or raw_sha != binding['source']['sha256']:
            raise ValueError(f'WordDisc PCM carrier changed: {source}')
        builder.source_paths[source] = path
        target = WEB / 'assets/audio' / Path(source).relative_to('sound')

        def produce(source=source, path=path, raw=raw, raw_sha=raw_sha, target=target):
            builder.transcode('/' + target.relative_to(WEB).as_posix(), dict(kind='audio', source=source), target)
            probe = json.loads(builder.run([builder.ffprobe, '-v', 'error', '-select_streams', 'a:0',
                '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_sample:format=duration',
                '-of', 'json', str(target)]))
            if len(probe['streams']) != 1:
                raise ValueError(f'WordDisc clip needs one audio stream: {source}')
            stream = probe['streams'][0]
            duration = float(probe['format']['duration'])
            if stream['codec_name'] != 'pcm_s16le' or duration <= 0:
                raise ValueError(f'WordDisc canonical PCM export failed: {source}')
            decoded = pcm(target)
            if pcm(path) != decoded:
                raise ValueError(f'WordDisc decoded audio changed: {source}')
            descriptor = dict(path='/' + target.relative_to(WEB).as_posix(), mime='audio/wav', sha256=digest(target),
                source=dict(path=source, sha256=raw_sha, bytes=len(raw), header_hex=raw[:16].hex(),
                            declared_extension=path.suffix, observed_encoding='RIFF/WAVE PCM'),
                audio=dict(codec=stream['codec_name'], sample_rate=int(stream['sample_rate']),
                           channels=stream['channels'], bits_per_sample=stream.get('bits_per_sample', 0),
                           duration_seconds=duration),
                export=dict(method='canonical PCM RIFF rewrap', decoded_pcm_md5=decoded, decoded_audio_unchanged=True))
            return descriptor, [target]

        value['clips'][source] = resource(RUNTIME, 'audio/' + source,
            dict(source=raw_sha, encoders=encoders),
            recipe_hash([Path(__file__), Path(__file__).with_name('export_media.py')]), produce)
        sources[source] = raw_sha
    value['native_services'] = by_service
    return len(bindings)


def refresh():
    if digest(ROOT / 'GAME.exe') != GAME_SHA:
        raise ValueError('Audio binding refresh requires the exact verified executable')
    output = WEB / 'data/audio.json'
    value = json.loads(output.read_text('utf-8'))
    sources = value['source_hashes']
    for path, expected in sources.items():
        if digest(ROOT / path) != expected:
            raise ValueError(f'Fixed audio source changed: {path}')
    statue_clips = refresh_statue_clips(value, sources)
    missing = set(value['missing_original_files'])
    missing.update(row['source']['path'] for rows in value['native_services'].values()
                   for row in rows.values() if row.get('missing'))

    def clip(source):
        path = ROOT / source
        if not path.is_file():
            missing.add(source)
            return None
        descriptor = value['clips'].get(source)
        if descriptor is None:
            raise ValueError(f'Present audio carrier needs full export/verification: {source}')
        if descriptor['source']['sha256'] != digest(path):
            raise ValueError(f'Fixed audio clip source changed: {source}')
        sources[source] = descriptor['source']['sha256']
        return source

    music_evidence = next(iter(value['maps'].values()))['evidence']
    maps, sounds, sound_sources, objects = {}, {}, [], []
    for ident in map_ids():
        path = f'Map/{ident.lower()}.dat'
        raw = (ROOT / path).read_bytes()
        sources[path] = hashlib.sha256(raw).hexdigest()
        token = original_text(raw, 0x44, 0x40)
        maps[ident] = dict(clip=clip('sound/' + token) if token else None,
            source=dict(path=path, sha256=sources[path], offset=0x44, bytes=0x40, token=token),
            evidence=music_evidence, confidence='source DAT+0x44 with retained fixed native same-track/load rule')
        if not token:
            maps[ident]['inherit'] = True
        table = MapObjects(ROOT / path)
        for obj in table.objects:
            record = bytes.fromhex(obj['raw_hex'])
            if record[0xcf] not in (1, 2) or not struct.unpack_from('<I', record, 0x9e)[0]:
                continue
            source = table.resource_source(struct.unpack_from('<I', record, 0x1e)[0])
            dgp = DGP(ROOT / source)
            sources[source] = dgp.sha256
            action = dgp.raw_actions[0]
            token = original_text(action, 0x56, 20)
            objects.append(dict(map_id=ident, object_index=obj['index'], behavior_raw_cf=record[0xcf],
                clip=clip('sound/' + token) if token else None, token=token,
                logical_frame=struct.unpack_from('<I', action, 0x6a)[0],
                object_source=dict(path=path, sha256=sources[path], offset=obj['offset'],
                    raw_sha256=hashlib.sha256(record).hexdigest(), sound_enabled_raw=struct.unpack_from('<I', record, 0x9e)[0]),
                action_source=dict(path=source, sha256=dgp.sha256, offset=67, raw_sha256=hashlib.sha256(action).hexdigest()),
                evidence=['ev_7ff7092a0522a10920b1c81430af56c62cb116c3d66a5af86a35ecb5e9498a5c']))
    for ident in map_ids('story'):
        path = f'Map/{ident.lower()}.TLK'
        raw = (ROOT / path).read_bytes()
        sources[path] = hashlib.sha256(raw).hexdigest()
        for record in tlk_record(ROOT / path)['records']:
            if record['kind'] != 6:
                continue
            record_raw = bytes.fromhex(record['raw_hex'])
            token = original_text(record_raw, 0x37, 0x100)
            sounds[token] = clip('sound/' + token) if token else None
            sound_sources.append(dict(map_id=ident, record_id=record['id'], token=token, clip=sounds[token],
                source=dict(path=path, sha256=sources[path], offset=record['offset'], bytes=0x66f,
                    raw_sha256=hashlib.sha256(record_raw).hexdigest(), token_offset=0x37),
                evidence=[value['native_evidence']['0x4bafa0']],
                policy='Native TLK kind6 starts an independent effect voice and immediately continues next; no completion wait.'))
    value.update(maps=maps, object_sounds=objects, native_sound_tokens=sounds, native_sound_sources=sound_sources,
                 missing_original_files=sorted(missing))
    if any(digest(ROOT / name) != expected for name, expected in sources.items()):
        raise ValueError('Audio source changed during binding refresh')
    write_json(output, value)
    report = dict(schema='seventh-seal-audio-map-binding-refresh', version=1, passed=True,
        source_hashes=sources, output_sha256=digest(output), source_bytes_unchanged=True,
        maps=len(maps), tlk_sound_references=len(sound_sources), object_sound_references=len(objects),
        statue_clips=statue_clips,
        missing_original_files=sorted(missing), original_game_executed=False,
        limitations=['Fixed clip carrier verification and historical native rules were retained; current DAT/TLK/object bindings were refreshed.',
                     'The four exact WordDisc PCM carriers use the existing media transcoder, with decoded source/output PCM equality; no original runtime execution is claimed.'])
    write_json(RUNTIME / 'evidence/audio_map_binding_refresh.json', report)
    print(json.dumps(dict(passed=True, maps=len(maps), tlk_sound_references=len(sound_sources))))


if __name__ == '__main__':
    refresh()
