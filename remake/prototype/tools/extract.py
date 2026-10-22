"""Reproducible first-slice export, with source hashes and explicit failures."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from PIL import Image
from dgp import DGP, DGPError, u32
from map_data import MapBackground
from export_movement import export_movement

PROJECT = Path(__file__).resolve().parents[1]
# Outputs stay inside remake/prototype; original inputs stay in the game root.
ROOT = PROJECT.parents[1]
OUTPUT = PROJECT / 'web' / 'assets'
EVIDENCE = PROJECT / 'evidence'
SOURCES = ['m01010.dgp', 'ROLE/001.dgp', 'ROLE/002.dgp']
SOURCES += [str(p.relative_to(ROOT)).replace('\\', '/') for p in sorted((ROOT / 'mapm/m01010').glob('*.dgp'))]
SOURCES += ['Fight_Role/012.dgp', 'Fight_Role/wolf.dgp']


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def relative(path):
    return path.relative_to(OUTPUT.parent).as_posix()


def export_actions(dgp, target):
    expected = 0
    for a in dgp.actions:
        count = a['directions'] * a['frames_per_direction']
        if not count or a['first_frame'] != expected:
            raise DGPError('Action groups do not form a contiguous frame partition; no guessed animation')
        expected += count
    if expected != dgp.frame_count:
        raise DGPError('Action group frame counts differ from total frames')
    exported = []
    for a in dgp.actions:
        n, dirs = a['frames_per_direction'], a['directions']
        sheet = Image.new('RGBA', (dgp.width * n, dgp.height * dirs))
        for direction in range(dirs):
            for k in range(n):
                i = a['first_frame'] + direction * n + k
                sheet.paste(dgp.decode(i), (k * dgp.width, direction * dgp.height))
        output = target / f"action_{a['index']:02d}.png"
        sheet.save(output)
        exported.append({**{k: v for k, v in a.items() if k != 'raw_hex'},
                         'sheet': relative(output), 'interval_ms_preview': a['interval_raw'] or 180})
    return exported


def export_pages(dgp, target):
    images = []
    for i, p in enumerate(dgp.raw_pages):
        w, h = u32(p, 2), u32(p, 6)
        if not (0 < w <= 8192 and 0 < h <= 8192):
            raise DGPError('Invalid atlas dimensions')
        images.append(Image.new('RGBA', (w, h)))
    for i, f in enumerate(dgp.frames):
        if f.page >= len(images) or f.x + dgp.width > images[f.page].width or f.y + dgp.height > images[f.page].height:
            raise DGPError(f'Frame {i}: invalid atlas position')
        images[f.page].paste(dgp.decode(i), (f.x, f.y))
    result = []
    for i, image in enumerate(images):
        output = target / f'page_{i:03d}.png'
        image.save(output)
        result.append(dict(image=relative(output), width=image.width, height=image.height))
    return result


def main():
    start = time.monotonic()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    inputs = SOURCES + ['Map/m01010.dat', 'GAME.exe', 'save_analysis_20261010/verified_ultimate_weapons_SaveGame0.Dat']
    before = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in inputs}
    if before['GAME.exe'] != 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18':
        raise DGPError('GAME.exe differs from the binary supplying the format evidence; revalidate this version first')
    manifest = dict(title='第七封印 · 地图移动验证 0.2', version=1, resources=[], roles=[], failures=[], warnings=[], maps=[])
    checks = []
    parsed = {}
    for source in SOURCES:
        try:
            dgp = DGP(ROOT / source)
            # Validate every row of every frame, not just displayed samples.
            decoded_pixels = 0
            for i in range(dgp.frame_count):
                for _, spans in dgp.rows(i):
                    cursor = 0
                    for x, count, _ in spans:
                        if x < cursor or x + count > dgp.width:
                            raise DGPError(f'Frame {i}: out-of-bounds span')
                        cursor = x + count
                        decoded_pixels += count
            color_check = dgp.verify_secondary()
            parsed[source] = dgp
            key = source.replace('/', '_').replace('.dgp', '')
            target = OUTPUT / key
            target.mkdir(parents=True, exist_ok=True)
            meta = dgp.metadata()
            meta['source'] = source
            meta['secondary_check'] = color_check
            write_json(EVIDENCE / f'{key}.json', meta)
            record = dict(id=key, source=source, name=meta['name_cp950'] or Path(source).stem,
                          frame_count=dgp.frame_count, frame_width=dgp.width, frame_height=dgp.height,
                          sha256=dgp.sha256, anchor_raw=dgp.anchor_raw)
            if dgp.actions:
                try:
                    record['actions'] = export_actions(dgp, target)
                except DGPError as exc:
                    if source.startswith('ROLE/'):
                        raise
                    record['pages'] = export_pages(dgp, target)
                    manifest['warnings'].append(dict(source=source, error=str(exc),
                                                      fallback='all pixels exported as atlas; animation interpretation omitted'))
            else:
                record['pages'] = export_pages(dgp, target)
            manifest['resources'].append(record)
            if source in ('ROLE/001.dgp', 'ROLE/002.dgp'):
                record['name'] = {'ROLE/001.dgp': '英格妮', 'ROLE/002.dgp': '凯'}[source]
                manifest['roles'].append(record)
            checks.append(dict(source=source, frames=dgp.frame_count, decoded_pixels=decoded_pixels,
                               eof=True, all_rows=True, secondary=color_check))
            print(f'PASS {source}: {dgp.frame_count} frames, {decoded_pixels} opaque pixels', flush=True)
        except (DGPError, OSError, ValueError) as exc:
            manifest['failures'].append(dict(source=source, error=str(exc)))
            print(f'FAIL {source}: {exc}', flush=True)
    try:
        data = MapBackground(ROOT / 'Map/m01010.dat')
        image, assembly = data.compose(parsed['m01010.dgp'])
        output = OUTPUT / 'm01010_background.png'
        image.save(output)
        meta = {**data.metadata(), **assembly}
        meta['source'] = 'Map/m01010.dat'
        write_json(EVIDENCE / 'map_m01010.json', meta)
        manifest['maps'].append(dict(id='m01010', name='M01010', image=relative(output),
                                     width=image.width, height=image.height, source='Map/m01010.dat',
                                     start_preview=dict(x=330, y=1500), assembly=assembly))
        export_movement(manifest, parsed)
        print(f'PASS background: {image.width}x{image.height}, {assembly["referenced_frames"]} referenced frames', flush=True)
    except (DGPError, OSError, KeyError, ValueError) as exc:
        manifest['failures'].append(dict(source='Map/m01010.dat', error=str(exc)))
    after = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in inputs}
    report = dict(created_utc=datetime.now(timezone.utc).isoformat(), input_hashes=before,
                  source_bytes_unchanged=before == after, changed_inputs=[p for p in inputs if before[p] != after[p]],
                  checks=checks, failures=manifest['failures'], map_success=bool(manifest['maps']),
                  elapsed_seconds=round(time.monotonic() - start, 2),
                  limits=['No original-game screenshot comparison yet.',
                          'Terrain and initial map objects exported; events, NPCs and battle are not implemented.',
                          'Keyboard speed, corner policy, camera and role layer need original runtime comparison.',
                          'Preview state uses its own schema; original save import/export is not implemented.'])
    manifest['verification'] = dict(successful_sources=len(checks), decoded_frames=sum(c['frames'] for c in checks),
                                    unchanged=report['source_bytes_unchanged'], original_comparison=False)
    write_json(OUTPUT.parent / 'manifest.json', manifest)
    write_json(EVIDENCE / 'verification.json', report)
    print(json.dumps(manifest['verification'], ensure_ascii=False), flush=True)
    return 0 if before == after and manifest['maps'] and len(manifest['roles']) == 2 else 1


if __name__ == '__main__':
    sys.exit(main())
