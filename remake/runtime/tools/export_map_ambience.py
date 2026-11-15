"""从原版地图物件导出定位环境音和浏览器可直接播放的原声文件。"""
import argparse
import io
import json
from pathlib import Path
import re
import wave

from content_registration import map_ids
from incremental import build_lock, digest, write_bytes, write_json
from media_definitions import OriginalFiles
from source.map_objects import MapObjects, i32


RUNTIME = Path(__file__).resolve().parents[1]
MAP_AMBIENCE_FILE = 'map_ambience.json'
ASSET_PREFIX = '/assets/audio/ambience/'


def read_map_ambience(original, ids):
    clips, maps, missing = {}, {}, set()
    for ident in ids:
        source = f'Map/{ident.lower()}.dat'
        table = MapObjects(original.path(source))
        emitters = []
        for obj in table.objects:
            raw = bytes.fromhex(obj['raw_hex'])
            # Game.exe 0x410350 loads the filename at +0x7c independently of
            # the DGP action sounds. +0xc6 selects grouped loops or a timer.
            token = raw[0x7c:0x9a].split(b'\0', 1)[0].decode('ascii')
            if not token:
                continue
            if not re.fullmatch(r'[\w-]+\.wav', token, re.ASCII | re.IGNORECASE):
                raise ValueError(f'地图环境音文件名无效：{source} 物件 {obj["index"]}')
            name = 'sound/' + token.lower()
            if name not in clips and name not in missing:
                try:
                    raw_sound = original.path(name).read_bytes()
                except FileNotFoundError:
                    missing.add(name)
                else:
                    mime, suffix = audio_format(raw_sound, name)
                    checksum = digest(raw_sound)
                    clips[name] = dict(path=f'{ASSET_PREFIX}{Path(token).stem.lower()}{suffix}',
                                       mime=mime, sha256=checksum, source=dict(path=name, sha256=checksum))
            emitters.append(dict(object_index=obj['index'], resource_id=obj['resource_identifier_raw'],
                                 x=obj['x_native'], y=obj['y_native'], interval_ms=i32(raw, 0xc6),
                                 token=token, clip=name if name in clips else None))
        if emitters:
            maps[ident] = dict(source=dict(path=source, sha256=digest(table.data)),
                               coordinate_shift=table.coordinate_shift, emitters=emitters)
    return dict(schema='seventh-seal-map-ambience', version=1, maps=maps, clips=clips,
                missing_original_files=sorted(missing))


def audio_format(raw, source):
    if raw[:4] == b'RIFF' and raw[8:12] == b'WAVE':
        try:
            with wave.open(io.BytesIO(raw), 'rb') as clip:
                channels, width, _, frames, _, _ = clip.getparams()
                if channels in (1, 2) and width in (1, 2, 3, 4) and frames > 0:
                    if len(clip.readframes(frames)) == frames * channels * width:
                        return 'audio/wav', '.wav'
        except (wave.Error, EOFError):
            pass
    if raw.startswith(b'ID3') or len(raw) > 1 and raw[0] == 0xff and raw[1] & 0xe0 == 0xe0:
        return 'audio/mpeg', '.mp3'
    raise ValueError(f'地图环境音格式不支持：{source}')


def export_map_ambience(runtime, original_dir, ids):
    original = OriginalFiles(original_dir)
    manifest = read_map_ambience(original, ids)
    web = runtime / 'web'
    definition = web / 'data' / MAP_AMBIENCE_FILE
    cache = runtime / '.cache/media'
    cache.mkdir(parents=True, exist_ok=True)
    with build_lock(cache):
        for clip in manifest['clips'].values():
            raw = original.path(clip['source']['path']).read_bytes()
            if digest(raw) != clip['sha256']:
                raise ValueError('导出时原版环境音发生变化：' + clip['source']['path'])
            write_bytes(web / clip['path'].lstrip('/'), raw)
        write_json(definition, manifest)
        media_path = web / 'assets/media_manifest.json'
        if media_path.is_file():
            # Publish the same entries as a full build without rebuilding any
            # image atlases or updating their source verification.
            media = json.loads(media_path.read_text('utf-8'))
            media['definitions']['data/' + MAP_AMBIENCE_FILE] = digest(definition.read_bytes())
            media['files'] = {path: sha for path, sha in media['files'].items() if not path.startswith(ASSET_PREFIX)}
            media['files'].update({clip['path']: clip['sha256'] for clip in manifest['clips'].values()})
            write_json(media_path, media, compact=True)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original-dir', required=True, type=Path)
    args = parser.parse_args()
    manifest = export_map_ambience(RUNTIME, args.original_dir, map_ids())
    print(f'地图环境音已导出：{len(manifest["maps"])} 张地图，{len(manifest["clips"])} 个音频文件')
    if manifest['missing_original_files']:
        print('原版安装缺少：' + '、'.join(manifest['missing_original_files']))
