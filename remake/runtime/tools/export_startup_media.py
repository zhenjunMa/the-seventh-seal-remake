"""Export the three source startup Bink carriers without assuming runtime order.

H.264/AAC are browser-compatible lossy exports. Every decoded video frame is
checked; the source audio is retained only where an audio stream exists. The
report distinguishes media facts and retained native static calls from runtime
observation, which belongs to a separate investigation.
"""
from __future__ import annotations

import argparse
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageDraw

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
SOURCES = (
    ('gametitle', 'Gametitle.bik'),
    ('preopenpress', 'preopenpress.bik'),
    ('openpress', 'openpress.bik'),
)
GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def run(command: list[str], *, capture: bool = False):
    return subprocess.run(command, check=True, capture_output=capture,
                          text=capture, encoding='utf-8' if capture else None)


def probe(ffprobe: str, path: Path) -> dict:
    result = run([ffprobe, '-v', 'error', '-count_frames', '-show_streams',
                  '-show_format', '-of', 'json', str(path)], capture=True)
    data = json.loads(result.stdout)
    # Keep portable provenance; the paths are supplied separately in the report.
    data['format'].pop('filename', None)
    return data


def video_frames(ffmpeg: str, path: Path) -> list[str]:
    result = run([ffmpeg, '-v', 'error', '-xerror', '-i', str(path), '-map', '0:v:0',
                  '-an', '-pix_fmt', 'yuv420p', '-f', 'framemd5', '-'], capture=True)
    return [line for line in result.stdout.splitlines() if line and not line.startswith('#')]


def video_comparison(ffmpeg: str, source: Path, output: Path, rate: str) -> dict:
    time_base = str(1 / Fraction(rate))
    comparison = run([ffmpeg, '-v', 'info', '-xerror', '-i', str(source), '-i', str(output),
                      '-filter_complex',
                      f'[0:v]format=yuv420p,settb={time_base},setpts=N[s];'
                      f'[1:v]format=yuv420p,settb={time_base},setpts=N[d];[s][d]ssim',
                      '-an', '-f', 'null', '-'], capture=True)
    match = re.search(r'SSIM.*?All:([\d.]+)', comparison.stderr)
    assert match, comparison.stderr
    score = float(match[1])
    assert score > .99, f'{source.name}: SSIM {score}'
    return {'decoded_ssim_all': score, 'minimum_required_ssim': .99}


def audio_comparison(ffmpeg: str, source: Path, output: Path, channels: int,
                     sample_rate: int, temporary: Path) -> dict:
    paths = [temporary / 'source.f32le', temporary / 'output.f32le']
    for carrier, decoded in zip([source, output], paths):
        run([ffmpeg, '-v', 'error', '-xerror', '-y', '-i', str(carrier), '-map', '0:a:0',
             '-vn', '-c:a', 'pcm_f32le', '-f', 'f32le', str(decoded)])
    source_pcm, output_pcm = (np.memmap(p, dtype='<f4', mode='r') for p in paths)
    assert len(source_pcm) % channels == len(output_pcm) % channels == 0
    source_samples = len(source_pcm) // channels
    output_samples = len(output_pcm) // channels
    # AAC's trailing packet padding may add up to one 1024-sample frame. Initial
    # encoder delay is handled by the MP4 edit list and FFmpeg's skip metadata.
    assert source_samples <= output_samples <= source_samples + 1024
    signal_energy = noise_energy = squared_peak = 0.
    for offset in range(0, len(source_pcm), 1024 * 1024):
        a = np.asarray(source_pcm[offset:offset + 1024 * 1024], dtype='float64')
        b = np.asarray(output_pcm[offset:offset + len(a)], dtype='float64')
        difference = a - b
        signal_energy += float(np.sum(a * a))
        noise_energy += float(np.sum(difference * difference))
        squared_peak = max(squared_peak, float(np.max(difference * difference)))
    rms = math.sqrt(noise_energy / len(source_pcm))
    snr = 10 * math.log10(signal_energy / noise_energy) if noise_energy else None
    # Verify aligned real audio rather than a synthetic replacement or silence.
    assert signal_energy > 0 and snr is not None and snr > 25, snr
    return {
        'comparison_format': 'decoded float32 little-endian, original channel order',
        'source_pcm_sha256': sha(paths[0]),
        'output_pcm_sha256': sha(paths[1]),
        'source_samples_per_channel': source_samples,
        'output_samples_per_channel': output_samples,
        'source_decoded_duration_seconds': source_samples / sample_rate,
        'output_decoded_duration_seconds': output_samples / sample_rate,
        'trailing_aac_padding_samples': output_samples - source_samples,
        'aligned_source_prefix_snr_db': snr,
        'aligned_source_prefix_error_rms': rms,
        'aligned_source_prefix_error_peak': math.sqrt(squared_peak),
        'decoded_pcm_identical': sha(paths[0]) == sha(paths[1]),
        'source_audio_preserved_as_aac': True,
    }


def source_contact_sheet(ffmpeg: str, source: Path, key: str, count: int,
                         width: int, height: int, rate: str, temporary: Path) -> Path:
    frame_indices = sorted({round((count - 1) * i / 7) for i in range(8)})
    selection = '+'.join(f'eq(n\\,{i})' for i in frame_indices)
    pattern = temporary / 'preview_%02d.png'
    run([ffmpeg, '-v', 'error', '-xerror', '-y', '-i', str(source), '-vf', f'select={selection}',
         '-fps_mode', 'passthrough', '-an', str(pattern)])
    cell_width, cell_height = 320, round(height * 320 / width)
    caption_height, columns = 24, 4
    rows = math.ceil(len(frame_indices) / columns)
    sheet = Image.new('RGB', (columns * cell_width, rows * (cell_height + caption_height)), '#161616')
    painter = ImageDraw.Draw(sheet)
    for i, frame_index in enumerate(frame_indices):
        with Image.open(temporary / f'preview_{i + 1:02d}.png') as frame:
            sheet.paste(frame.convert('RGB').resize((cell_width, cell_height)),
                        ((i % columns) * cell_width, (i // columns) * (cell_height + caption_height)))
        x, y = (i % columns) * cell_width, (i // columns) * (cell_height + caption_height) + cell_height
        seconds = frame_index / float(Fraction(rate))
        painter.text((x + 5, y + 5), f'{key} | frame {frame_index} | {seconds:.3f}s', fill='white')
    output = RUNTIME / f'evidence/startup_media_{key}_source_frames.png'
    sheet.save(output)
    return output


def native_reference() -> dict:
    path = RUNTIME / 'evidence/opening_native.json'
    records = json.loads(path.read_text('utf-8'))['records']
    record = next(r for r in records if r['evidence_id'] ==
                  'ev_905d4b6c0b30f6fd5f7dbb4db43cafd792235e891c7bf9fe828f331035bb8a96')
    normalized = record['normalized_result']
    pseudo = normalized['pseudocode'] if isinstance(normalized, dict) else normalized
    assert all(name in pseudo for name in ['GameTitle_bik', 'preOpenPress_bik', 'OpenPress_bik'])
    assert record['subject']['digest']['sha256'] == GAME_SHA
    return {'bundle': 'remake/runtime/evidence/opening_native.json', 'bundle_sha256': sha(path),
            'evidence_id': record['evidence_id'], 'procedure': '0x4323c0',
            'conditional_static_call_order': ['gametitle', 'preopenpress', 'openpress'],
            'condition': 'DAT_00673e44 != 0',
            'authority': 'retained native pseudocode; original execution not observed by this exporter',
            'placement_and_skip_controls': 'Not established by media decoding; see native/runtime investigation.'}


def verify_existing(ffmpeg: str, ffprobe: str) -> None:
    """Verify the retained export without rewriting reports or media."""
    evidence = RUNTIME / 'evidence/startup_media_export.json'
    report = json.loads(evidence.read_text('utf-8'))
    assert report['schema'] == 'seventh-seal-startup-media-export' and report['success']
    assert sha(ROOT / 'GAME.exe') == report['game_source_sha256'] == GAME_SHA
    manifest_path = ROOT / report['manifest']['path']
    assert sha(manifest_path) == report['manifest']['sha256']
    manifest = json.loads(manifest_path.read_text('utf-8'))
    assert set(manifest['media']) == {key for key, _ in SOURCES}
    assert len(report['assets']) == len(SOURCES)
    for record in report['assets']:
        source = ROOT / record['source']['path']
        output = RUNTIME / 'web' / record['output']['path'].lstrip('/')
        assert sha(source) == record['source']['sha256']
        assert sha(output) == record['output']['sha256'] == manifest['media'][record['id']]['sha256']
        for carrier, stored in [(source, record['source']), (output, record['output'])]:
            live = probe(ffprobe, carrier)
            live_video = next(s for s in live['streams'] if s['codec_type'] == 'video')
            stored_video = next(s for s in stored['probe']['streams'] if s['codec_type'] == 'video')
            for field in ['width', 'height', 'r_frame_rate', 'nb_read_frames', 'duration']:
                assert live_video[field] == stored_video[field]
            assert video_frames(ffmpeg, carrier) == stored['decoded_video_frames']
        preview = ROOT / record['source_contact_sheet']['path']
        assert sha(preview) == record['source_contact_sheet']['sha256']
        if record['validation']['source_audio_present']:
            with tempfile.TemporaryDirectory(prefix='seventh_seal_verify_audio_') as name:
                audio = manifest['media'][record['id']]['audio']
                verified = audio_comparison(ffmpeg, source, output, audio['channels'],
                                            audio['sample_rate'], Path(name))
                for field in ['source_pcm_sha256', 'output_pcm_sha256',
                              'source_samples_per_channel', 'output_samples_per_channel']:
                    assert verified[field] == record['validation']['audio'][field]
        print(json.dumps({'id': record['id'], 'hashes_match': True,
                          'complete_decode_matches_retained_evidence': True}), flush=True)
    reference = native_reference()
    assert reference == report['native_reference']
    print(json.dumps({'success': True, 'assets': len(report['assets']),
                      'verification_only': True, 'original_source_unchanged': True}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg', default=shutil.which('ffmpeg'))
    parser.add_argument('--ffprobe', default=shutil.which('ffprobe'))
    parser.add_argument('--reuse-existing', action='store_true',
                        help='Reuse existing MP4s after all decode, duration, frame and quality checks.')
    parser.add_argument('--verify-only', action='store_true',
                        help='Read-only verification of retained sources, manifests, hashes and full media decode.')
    args = parser.parse_args()
    assert args.ffmpeg and args.ffprobe, 'FFmpeg and FFprobe are required.'
    if args.verify_only:
        verify_existing(args.ffmpeg, args.ffprobe)
        return
    assert sha(ROOT / 'GAME.exe') == GAME_SHA
    source_hashes = {name: sha(ROOT / 'Animate' / name) for _, name in SOURCES}
    output_dir = RUNTIME / 'web/assets/video/startup'
    output_dir.mkdir(parents=True, exist_ok=True)
    report = {'schema': 'seventh-seal-startup-media-export', 'version': 1,
              'success': False, 'native_reference': native_reference(), 'assets': [],
              'original_game_execution_observed_by_exporter': False,
              'limitations': [
                  'H.264/AAC are lossy browser exports. Their decoded video SSIM and audio PCM difference are recorded.',
                  'Source dimensions, video rate and every decoded video frame are retained; no crop, resize or synthetic audio is added.',
                  'Bink audio has no duration field. Decoded sample counts record its actual length separately from the video.',
                  'The manifest lists media carriers, not a claim that they were observed in this order on Windows.',
                  'Display position, repetition, key skipping and transitions need separate native/runtime evidence.',
              ]}
    manifest = {'schema': 'seventh-seal-startup-media', 'version': 1,
                'export_evidence': 'remake/runtime/evidence/startup_media_export.json',
                'media_order_authority': 'No observed sequence asserted by this media manifest.',
                'media': {}}
    for key, name in SOURCES:
        source, output = ROOT / 'Animate' / name, output_dir / f'{key}.mp4'
        original = probe(args.ffprobe, source)
        source_video = next(s for s in original['streams'] if s['codec_type'] == 'video')
        source_audio = [s for s in original['streams'] if s['codec_type'] == 'audio']
        assert source_video['codec_name'] == 'binkvideo' and len(source_audio) <= 1
        command = [args.ffmpeg, '-v', 'error', '-xerror', '-y', '-i', str(source), '-map', '0:v:0',
                   '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-profile:v', 'high',
                   '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough']
        if source_audio:
            command += ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '256k']
        else:
            command += ['-an']
        command += ['-movflags', '+faststart', str(output)]
        if args.reuse_existing and output.exists():
            print(f'Validating retained {key}.mp4...', flush=True)
        else:
            print(f'Converting {name}...', flush=True)
            run(command)
        converted = probe(args.ffprobe, output)
        output_video = next(s for s in converted['streams'] if s['codec_type'] == 'video')
        output_audio = [s for s in converted['streams'] if s['codec_type'] == 'audio']
        assert output_video['codec_name'] == 'h264'
        for field in ['width', 'height', 'r_frame_rate', 'nb_read_frames']:
            assert source_video[field] == output_video[field], (name, field)
        assert Fraction(source_video['time_base']) * int(source_video['duration_ts']) == \
            Fraction(output_video['time_base']) * int(output_video['duration_ts'])
        assert len(source_audio) == len(output_audio)
        if source_audio:
            assert output_audio[0]['codec_name'] == 'aac'
            for field in ['sample_rate', 'channels', 'channel_layout']:
                assert source_audio[0][field] == output_audio[0][field]
        source_frames, output_frames = video_frames(args.ffmpeg, source), video_frames(args.ffmpeg, output)
        assert len(source_frames) == len(output_frames) == int(source_video['nb_read_frames'])
        validation = video_comparison(args.ffmpeg, source, output, source_video['r_frame_rate'])
        validation.update({'same_dimensions': True, 'same_video_frame_rate': True,
                           'same_video_frame_count': True, 'same_video_duration': True,
                           'decoded_video_frames_identical': source_frames == output_frames,
                           'source_audio_present': bool(source_audio),
                           'synthetic_audio_added': False, 'complete_media_decode_succeeded': True})
        with tempfile.TemporaryDirectory(prefix=f'seventh_seal_{key}_') as temporary_name:
            temporary = Path(temporary_name)
            if source_audio:
                validation['audio'] = audio_comparison(args.ffmpeg, source, output,
                    source_audio[0]['channels'], int(source_audio[0]['sample_rate']), temporary)
            preview = source_contact_sheet(args.ffmpeg, source, key, len(source_frames),
                source_video['width'], source_video['height'], source_video['r_frame_rate'], temporary)
        record = {'id': key,
                  'source': {'path': f'Animate/{name}', 'sha256': source_hashes[name],
                             'probe': original, 'decoded_video_frames': source_frames},
                  'output': {'path': f'/assets/video/startup/{key}.mp4', 'sha256': sha(output),
                             'probe': converted, 'decoded_video_frames': output_frames},
                  'encoding': {'video': 'H.264 high, yuv420p, CRF 12, slow preset',
                               'audio': 'AAC 256 kbit/s, original sample rate/channels' if source_audio else 'No audio stream'},
                  'validation': validation,
                  'source_contact_sheet': {'path': preview.relative_to(ROOT).as_posix(), 'sha256': sha(preview)}}
        report['assets'].append(record)
        manifest['media'][key] = {
            'url': record['output']['path'], 'mime': 'video/mp4', 'sha256': record['output']['sha256'],
            'source': record['source']['path'], 'source_sha256': record['source']['sha256'],
            'width': source_video['width'], 'height': source_video['height'],
            'fps': str(Fraction(source_video['r_frame_rate'])),
            'frames': len(source_frames), 'video_duration_seconds': float(source_video['duration']),
            'container_duration_seconds': float(converted['format']['duration']),
            'audio': None if not source_audio else {
                'codec': 'aac', 'sample_rate': int(source_audio[0]['sample_rate']),
                'channels': source_audio[0]['channels'], 'channel_layout': source_audio[0]['channel_layout'],
                'source_decoded_duration_seconds': validation['audio']['source_decoded_duration_seconds'],
                'source_samples_per_channel': validation['audio']['source_samples_per_channel'],
            },
            'lossy_conversion': True,
        }
        print(json.dumps({'id': key, 'frames': len(source_frames), 'video_seconds': source_video['duration'],
                          'audio': bool(source_audio), 'ssim': validation['decoded_ssim_all'],
                          'bytes': output.stat().st_size}), flush=True)
    assert all(sha(ROOT / 'Animate' / name) == expected for name, expected in source_hashes.items())
    assert sha(ROOT / 'GAME.exe') == GAME_SHA
    report.update({'success': True, 'original_source_unchanged': True,
                   'source_hashes_after_export': source_hashes,
                   'game_source_sha256': GAME_SHA,
                   'exporter': {'path': Path(__file__).relative_to(ROOT).as_posix(),
                                'sha256': sha(Path(__file__))}})
    manifest_path = RUNTIME / 'web/data/startup_media.json'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    report['manifest'] = {'path': manifest_path.relative_to(ROOT).as_posix(), 'sha256': sha(manifest_path)}
    evidence = RUNTIME / 'evidence/startup_media_export.json'
    evidence.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    print(json.dumps({'success': True, 'manifest': str(manifest_path), 'report': str(evidence)}), flush=True)


if __name__ == '__main__':
    main()
