"""Prepare source-selected ANM video/sound carriers with complete decode checks.

Selection includes registered ANMs plus the declared Fire Valley late programs.
Preparing media does not register those programs or assert a playable story.
"""
from __future__ import annotations

import argparse
from fractions import Fraction
import json
import math
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from incremental import resource, recipe_hash, write_json as incremental_json, write_bytes
from content_registration import program_ids
from export_startup_media import sha, run, probe, video_frames, video_comparison

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
MANIFEST = WEB / 'data/story_media.json'
REPORT = RUNTIME / 'evidence/story_media_export.json'
SOURCE_PREPARATION_PROGRAMS = ('m17010-3', 'm17030-1')
AUDIO_PLAYBACK_GAIN = 2


def confined_file(directory: Path, name: str) -> Path:
    """Resolve literal native case spelling, rejecting aliases and traversal."""
    matches = [path for path in directory.iterdir() if path.name.casefold() == name.casefold() and path.is_file()]
    if len(matches) != 1:
        raise ValueError(f'Expected one literal source {directory.name}/{name}; found {len(matches)}')
    path = matches[0].resolve()
    if not path.is_relative_to(directory.resolve()):
        raise ValueError(f'Source escapes selected directory: {name}')
    return path


def discover(registered=None, source_programs=SOURCE_PREPARATION_PROGRAMS, root=ROOT) -> dict:
    registered = tuple(program_ids() if registered is None else registered)
    selected = sorted(set(registered) | set(source_programs))
    result = {'programs': [], 'videos': {}, 'sounds': {}, 'empty_sound_commands': []}
    for ident in selected:
        if not re.fullmatch(r'[a-z0-9_-]+', ident):
            raise ValueError(f'Invalid ANM identity: {ident}')
        path = confined_file(root / 'Animate', ident + '.anm')
        raw = path.read_bytes()
        if len(raw) < 67 or raw[:2] != b'\x03\x00' or len(raw) != 67 + struct.unpack_from('<I', raw, 2)[0] * 74:
            raise ValueError(f'ANM length mismatch: {ident}')
        source = {'path': path.relative_to(root).as_posix(), 'sha256': sha(path), 'bytes': len(raw)}
        authority = 'runtime-registered' if ident in registered else 'declared-source-preparation'
        result['programs'].append({'id': ident, 'selection_authority': authority, 'source': source})
        for index in range(struct.unpack_from('<I', raw, 2)[0]):
            offset = 67 + index * 74
            command = raw[offset:offset + 74]
            if command[0] not in (60, 62):
                continue
            token = command[54:74].split(b'\0', 1)[0].decode('ascii', 'strict')
            reference = {'program_id': ident, 'selection_authority': authority, 'command_index': index,
                         'opcode': command[0], 'mode_raw': command[29], 'source': {**source, 'offset': offset},
                         'filename_raw': token, 'raw_hex': command.hex()}
            if command[0] == 62 and not token:
                result['empty_sound_commands'].append(reference)
                continue
            extension = 'bik' if command[0] == 60 else 'wav'
            if not re.fullmatch(r'[A-Za-z0-9_-]+\.' + extension, token, re.IGNORECASE):
                raise ValueError(f'Unsafe or unsupported ANM media token {ident}:{index}: {token!r}')
            kind, directory = ('videos', 'Animate') if command[0] == 60 else ('sounds', 'sound')
            media = confined_file(root / directory, token)
            key = token.lower()
            row = result[kind].setdefault(key, {'source_path': media.relative_to(root).as_posix(), 'referenced_by': []})
            if row['source_path'] != media.relative_to(root).as_posix():
                raise ValueError(f'Native media key collision: {key}')
            row['referenced_by'].append(reference)
    return result


def source_files() -> tuple[str, ...]:
    selection = discover()
    return tuple(sorted({row['source']['path'] for row in selection['programs']}
                        | {row['source_path'] for kind in ('videos', 'sounds') for row in selection[kind].values()}))


def compare_video_audio(ffmpeg, source, output, channels, sample_rate, temporary, playback_gain):
    """Compare restored playback amplitude, closing mmap handles even on failure.

    Some Bink float samples exceed full scale. AAC encoding uses explicit
    headroom; the browser's GainNode restores exactly the recorded amplitude.
    """
    paths = [temporary / 'source.f32le', temporary / 'output.f32le']
    for carrier, decoded in zip((source, output), paths):
        run([ffmpeg, '-v', 'error', '-xerror', '-y', '-i', str(carrier), '-map', '0:a:0',
             '-vn', '-c:a', 'pcm_f32le', '-f', 'f32le', str(decoded)])
    a = np.memmap(paths[0], dtype='<f4', mode='r')
    b = np.memmap(paths[1], dtype='<f4', mode='r')
    try:
        assert len(a) % channels == len(b) % channels == 0
        source_samples, output_samples = len(a) // channels, len(b) // channels
        assert source_samples <= output_samples <= source_samples + 1024
        signal_energy = noise_energy = squared_peak = 0.
        source_min = output_min = float('inf')
        source_max = output_max = float('-inf')
        for offset in range(0, len(a), 1024 * 1024):
            x = np.asarray(a[offset:offset + 1024 * 1024], dtype='float64')
            y = np.asarray(b[offset:offset + len(x)], dtype='float64')
            assert np.isfinite(x).all() and np.isfinite(y).all()
            difference = x - y * playback_gain
            signal_energy += float(np.sum(x * x)); noise_energy += float(np.sum(difference * difference))
            squared_peak = max(squared_peak, float(np.max(difference * difference)))
            source_min = min(source_min, float(x.min())); source_max = max(source_max, float(x.max()))
            output_min = min(output_min, float(y.min())); output_max = max(output_max, float(y.max()))
        snr = 10 * math.log10(signal_energy / noise_energy) if noise_energy else None
        result = {'comparison_format': 'Complete float32 PCM, original channel order, output multiplied by explicit playback gain',
                  'source_pcm_sha256': sha(paths[0]), 'output_pcm_sha256': sha(paths[1]),
                  'source_samples_per_channel': source_samples, 'output_samples_per_channel': output_samples,
                  'source_decoded_duration_seconds': source_samples / sample_rate,
                  'output_decoded_duration_seconds': output_samples / sample_rate,
                  'trailing_aac_padding_samples': output_samples - source_samples,
                  'source_pcm_minimum': source_min, 'source_pcm_maximum': source_max,
                  'source_pcm_peak': max(abs(source_min), abs(source_max)),
                  'output_pcm_minimum_before_playback_gain': output_min, 'output_pcm_maximum_before_playback_gain': output_max,
                  'encode_gain': 1 / playback_gain, 'playback_gain': playback_gain,
                  'restored_aligned_source_prefix_snr_db': snr, 'minimum_required_snr_db': 25,
                  'restored_aligned_source_prefix_error_rms': math.sqrt(noise_energy / len(a)),
                  'restored_aligned_source_prefix_error_peak': math.sqrt(squared_peak),
                  'source_audio_preserved_as_aac': True, 'sample_rate_unchanged': True, 'channels_unchanged': True}
    finally:
        a._mmap.close(); b._mmap.close()
    assert signal_energy > 0 and snr is not None and snr > 25, result
    return result


def verify_video(ffmpeg, ffprobe, source, output, playback_gain=AUDIO_PLAYBACK_GAIN):
    original, converted = probe(ffprobe, source), probe(ffprobe, output)
    source_video = [stream for stream in original['streams'] if stream['codec_type'] == 'video']
    output_video = [stream for stream in converted['streams'] if stream['codec_type'] == 'video']
    source_audio = [stream for stream in original['streams'] if stream['codec_type'] == 'audio']
    output_audio = [stream for stream in converted['streams'] if stream['codec_type'] == 'audio']
    assert len(source_video) == len(output_video) == 1 and len(source_audio) == len(output_audio) <= 1
    a, b = source_video[0], output_video[0]
    assert a['codec_name'] == 'binkvideo' and b['codec_name'] == 'h264'
    for field in ('width', 'height', 'r_frame_rate', 'nb_read_frames'):
        assert a[field] == b[field], (source.name, field, a[field], b[field])
    assert Fraction(a['time_base']) * int(a['duration_ts']) == Fraction(b['time_base']) * int(b['duration_ts'])
    for x, y in zip(source_audio, output_audio):
        assert y['codec_name'] == 'aac'
        for field in ('sample_rate', 'channels', 'channel_layout'):
            assert x[field] == y[field], (source.name, field)
    source_frames, output_frames = video_frames(ffmpeg, source), video_frames(ffmpeg, output)
    assert len(source_frames) == len(output_frames) == int(a['nb_read_frames'])
    validation = {**video_comparison(ffmpeg, source, output, a['r_frame_rate']),
                  'same_dimensions': True, 'same_video_frame_rate': True,
                  'same_video_frame_count': True, 'same_video_duration': True,
                  'complete_media_decode_succeeded': True, 'synthetic_audio_added': False,
                  'source_audio_present': bool(source_audio),
                  'decoded_video_frames_identical': source_frames == output_frames}
    if source_audio:
        with tempfile.TemporaryDirectory(prefix='seventh_seal_story_audio_') as name:
            validation['audio'] = compare_video_audio(ffmpeg, source, output, source_audio[0]['channels'],
                                                       int(source_audio[0]['sample_rate']), Path(name), playback_gain)
    return {'source_probe': original, 'output_probe': converted,
            'source_decoded_video_frames': source_frames, 'output_decoded_video_frames': output_frames,
            'validation': validation}


def pcm_digest(ffmpeg, path):
    # FFmpeg decodes the full stream to one fixed PCM format, never a sample.
    return run([ffmpeg, '-v', 'error', '-xerror', '-i', str(path), '-map', '0:a:0', '-vn',
                '-c:a', 'pcm_s16le', '-f', 'hash', '-hash', 'sha256', '-'], capture=True).stdout.strip()


def export_sound(ffmpeg, ffprobe, source, output_stem, reuse=False):
    with source.open('rb') as stream:
        header = stream.read(16)
    original = probe(ffprobe, source)
    streams = original['streams']
    assert len(streams) == 1 and streams[0]['codec_type'] == 'audio'
    is_mpeg = header.startswith(b'ID3') or len(header) > 1 and header[0] == 0xff and header[1] & 0xe0 == 0xe0
    if is_mpeg:
        assert streams[0]['codec_name'] == 'mp3'
        output, mime = output_stem.with_suffix('.mp3'), 'audio/mpeg'
        if not (reuse and output.exists()):
            shutil.copyfile(source, output)
        assert sha(source) == sha(output)
    else:
        assert header.startswith(b'RIFF') and header[8:12] == b'WAVE' and streams[0]['codec_name'].startswith('pcm_')
        output, mime = output_stem.with_suffix('.wav'), 'audio/wav'
        if not (reuse and output.exists()):
            run([ffmpeg, '-v', 'error', '-xerror', '-y', '-i', str(source), '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', str(output)])
    converted = probe(ffprobe, output)
    for field in ('sample_rate', 'channels'):
        assert streams[0][field] == converted['streams'][0][field]
    source_pcm, output_pcm = pcm_digest(ffmpeg, source), pcm_digest(ffmpeg, output)
    assert source_pcm == output_pcm, f'Full decoded PCM differs: {source.name}'
    return output, {'mime': mime, 'source_probe': original, 'output_probe': converted,
                    'validation': {'full_decoded_pcm_sha256': output_pcm, 'decoded_pcm_identical': True,
                                   'complete_media_decode_succeeded': True, 'byte_preserving_mpeg': is_mpeg,
                                   'observed_source_encoding': streams[0]['codec_name'], 'source_header_hex': header.hex()}}


def write_json(path, data):
    incremental_json(path, data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg', default=shutil.which('ffmpeg'))
    parser.add_argument('--ffprobe', default=shutil.which('ffprobe'))
    parser.add_argument('--source-program', action='append', default=[],
                        help='Additionally prepare this literal source ANM without admitting it to runtime.')
    parser.add_argument('--reuse-existing', action='store_true', help='Reuse carrier outputs only after the same complete validation.')
    parser.add_argument('--verify-only', action='store_true', help='Read-only hashes, source selection, complete frame/quality and PCM verification.')
    args = parser.parse_args()
    assert args.ffmpeg and args.ffprobe, 'FFmpeg and FFprobe are required; no dependency installation is performed.'
    selected = discover(source_programs=(*SOURCE_PREPARATION_PROGRAMS, *args.source_program))
    source_paths = {row['source']['path'] for row in selected['programs']}
    source_paths.update(row['source_path'] for kind in ('videos', 'sounds') for row in selected[kind].values())
    source_hashes = {path: sha(ROOT / path) for path in sorted(source_paths)}
    if args.verify_only:
        report = json.loads(REPORT.read_text('utf-8'))
        manifest = json.loads(MANIFEST.read_text('utf-8'))
        assert report['success'] and report['selection'] == selected and report['source_hashes'] == source_hashes
        assert report['manifest']['sha256'] == sha(MANIFEST)
        assert all(set(manifest[kind]) == set(selected[kind]) for kind in ('videos', 'sounds'))
        for record in report['assets']:
            output = WEB / record['output']['path'].lstrip('/')
            assert sha(output) == record['output']['sha256'] == manifest[record['kind']][record['id']]['sha256']
            source = ROOT / record['source']['path']
            if record['kind'] == 'videos':
                assert verify_video(args.ffmpeg, args.ffprobe, source, output) == record['verification']
            else:
                assert pcm_digest(args.ffmpeg, source) == pcm_digest(args.ffmpeg, output) == record['verification']['validation']['full_decoded_pcm_sha256']
            print(json.dumps({'id': record['id'], 'complete_decode_verified': True}), flush=True)
        assert all(sha(ROOT / path) == digest for path, digest in source_hashes.items())
        print(json.dumps({'success': True, 'verification_only': True, 'original_source_unchanged': True}), flush=True)
        return
    report = {'schema': 'seventh-seal-story-media-export', 'version': 1, 'success': False, 'selection': selected,
              'source_hashes': source_hashes, 'assets': [], 'original_game_execution_observed': False,
              'authority': 'Source ANM operand extraction and complete media decode/quality verification only.',
              'audio_encoding': {'codec': 'AAC', 'requested_bitrate': 384000,
                                 'encode_gain': 1 / AUDIO_PLAYBACK_GAIN, 'required_browser_playback_gain': AUDIO_PLAYBACK_GAIN,
                                 'resampling': False, 'channel_remapping': False,
                                 'reason': 'Source Bink float PCM exceeds full scale; explicit reversible amplitude headroom avoids AAC distortion.',
                                 'diagnostics': 'remake/runtime/evidence/fire_valley_20261025/story_audio_candidates/comparison.json'},
              'limits': ['Declared source preparation does not register an ANM, enable a story branch or claim original gameplay observation.',
                         'H.264/AAC video exports are lossy; every decoded frame and aligned audio samples are checked.',
                         'Bink audio may exceed full-scale float PCM. Encoding uses explicit half-amplitude headroom; a browser GainNode must restore audio.playback_gain=2 without resampling.',
                         'Native wav keys retain literal script identity; MPEG carriers use a truthful mp3 output suffix.']}
    manifest = {'schema': 'seventh-seal-story-media', 'version': 1, 'videos': {}, 'sounds': {},
                'export_evidence': REPORT.relative_to(ROOT).as_posix(), 'authority': report['authority']}
    encoders = {tool: subprocess.run([getattr(args,tool), '-version'], check=True, capture_output=True, text=True).stdout.splitlines()[0] for tool in ('ffmpeg','ffprobe')}
    try:
        for kind in ('videos', 'sounds'):
            directory = WEB / ('assets/video/story' if kind == 'videos' else 'assets/audio/story')
            directory.mkdir(parents=True, exist_ok=True)
            for key, row in selected[kind].items():
                source = ROOT / row['source_path']
                print(f'Preparing and fully verifying {kind}: {row["source_path"]}', flush=True)
                def produce_media():
                    with tempfile.TemporaryDirectory(prefix='.encoding-',dir=directory) as temporary:
                        work = Path(temporary)
                        if args.reuse_existing:
                            for suffix in ('.mp4','.mp3','.wav'):
                                old = directory/(Path(key).stem+suffix)
                                if old.is_file(): shutil.copyfile(old,work/old.name)
                        if kind == 'videos':
                            output = work / (Path(key).stem + '.mp4')
                            original = probe(args.ffprobe, source)
                            audio = [stream for stream in original['streams'] if stream['codec_type'] == 'audio']
                            if not (args.reuse_existing and output.exists()):
                                command = [args.ffmpeg, '-v', 'error', '-xerror', '-y', '-i', str(source), '-map', '0:v:0',
                                           '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough']
                                command += ['-map', '0:a:0', '-af', 'volume=0.5', '-c:a', 'aac', '-b:a', '384k'] if audio else ['-an']
                                run([*command, '-movflags', '+faststart', str(output)])
                            verification = verify_video(args.ffmpeg, args.ffprobe, source, output)
                            stream = next(stream for stream in verification['source_probe']['streams'] if stream['codec_type'] == 'video')
                            properties = {'mime': 'video/mp4', 'width': stream['width'], 'height': stream['height'],
                                          'fps': str(Fraction(stream['r_frame_rate'])), 'frames': int(stream['nb_read_frames']),
                                          'duration_seconds': float(stream['duration']), 'lossy_conversion': True,
                                          'audio': None if not audio else {'playback_gain': AUDIO_PLAYBACK_GAIN,
                                              'encode_gain': 1 / AUDIO_PLAYBACK_GAIN, 'codec': 'aac',
                                              'sample_rate': int(audio[0]['sample_rate']), 'channels': audio[0]['channels']}}
                        else:
                            output, verification = export_sound(args.ffmpeg, args.ffprobe, source, work / Path(key).stem, args.reuse_existing)
                            properties = {'mime': verification['mime'], 'sample_rate': int(verification['source_probe']['streams'][0]['sample_rate']),
                                          'channels': verification['source_probe']['streams'][0]['channels']}
                        published = directory/output.name
                        write_bytes(published,output.read_bytes())
                        if 'filename' in verification.get('output_probe',{}).get('format',{}):
                            verification['output_probe']['format']['filename'] = str(published)
                        output = published
                    return {'output':output.relative_to(WEB).as_posix(),'verification':verification,'properties':properties}, [output]
                cached = resource(RUNTIME,'story-media/'+kind+'/'+key,
                    {'source':source_hashes[row['source_path']],'encoding':report['audio_encoding'],'encoders':encoders},
                    recipe_hash([Path(__file__),Path(__file__).with_name('export_startup_media.py')]),produce_media)
                output, verification, properties = WEB/cached['output'], cached['verification'], cached['properties']
                source_reference = {'path': row['source_path'], 'sha256': source_hashes[row['source_path']], 'bytes': source.stat().st_size}
                output_reference = {'path': '/' + output.relative_to(WEB).as_posix(), 'sha256': sha(output), 'bytes': output.stat().st_size}
                manifest[kind][key] = {**output_reference, **properties, 'source': source_reference, 'referenced_by': row['referenced_by']}
                report['assets'].append({'id': key, 'kind': kind, 'source': source_reference, 'output': output_reference, 'verification': verification})
                print(json.dumps({'id': key, 'verified': True, 'bytes': output.stat().st_size}), flush=True)
        assert all(sha(ROOT / path) == digest for path, digest in source_hashes.items())
        report.update(success=True, original_source_unchanged=True,
                      exporter={'path': Path(__file__).relative_to(ROOT).as_posix(), 'sha256': sha(Path(__file__))})
        write_json(MANIFEST, manifest)
        report['manifest'] = {'path': MANIFEST.relative_to(ROOT).as_posix(), 'sha256': sha(MANIFEST)}
        write_json(REPORT, report)
    except Exception as error:
        report['failure'] = {'type': type(error).__name__, 'message': str(error)}
        write_json(RUNTIME / 'evidence/story_media_export_failed.json', report)
        raise
    print(json.dumps({'success': True, 'videos': len(manifest['videos']), 'sounds': len(manifest['sounds']), 'original_source_unchanged': True}), flush=True)


if __name__ == '__main__':
    main()
