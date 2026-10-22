"""Lossless, source-checked cropped battle atlases. Existing exports stay untouched."""
from pathlib import Path
from collections import defaultdict
import hashlib
import json
import subprocess
from PIL import Image, ImageChops

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
OUT = WEB / 'assets/battle_packs'
REPORT = RUNTIME / 'evidence/battle_loading_20261021/pack_export.json'
PAGE = 2048


def sha(data):
    return hashlib.sha256(data).hexdigest()


def local(url):
    if url.startswith('/prototype/'):
        return RUNTIME.parent / 'prototype/web' / url[len('/prototype/'):]
    return WEB / url.lstrip('/')


def build():
    result = subprocess.run(['node', str(RUNTIME / 'tools/battle_pack_inventory.mjs')],
                            cwd=ROOT, capture_output=True, check=True)
    inventory = json.loads(result.stdout)
    sources = {}
    images = {}
    groups = defaultdict(dict)
    input_pixels = 0
    for asset in inventory['assets']:
        source = local(asset['path'])
        raw = source.read_bytes()
        assert sha(raw) == asset['sha256'], asset['path']
        sources[source.relative_to(ROOT).as_posix()] = sha(raw)
        with Image.open(source) as opened:
            image = opened.convert('RGBA')
        assert image.size == (asset['width'], asset['height']), asset['path']
        input_pixels += image.width * image.height
        row = dict(sha256=asset['sha256'], width=image.width, height=image.height, regions=[])
        images[asset['path']] = row
        for y in range(0, image.height, asset['tile_height']):
            for x in range(0, image.width, asset['tile_width']):
                tile = image.crop((x, y, min(image.width, x + asset['tile_width']), min(image.height, y + asset['tile_height'])))
                bounds = tile.getchannel('A').getbbox() if asset.get('trim', True) else (0, 0, tile.width, tile.height)
                if bounds is None:
                    continue
                crop = tile.crop(bounds)
                assert crop.width + 2 <= PAGE and crop.height + 2 <= PAGE, asset['path']
                key = sha(crop.width.to_bytes(4, 'little') + crop.height.to_bytes(4, 'little') + crop.tobytes())
                group = groups[asset['group']]
                if key not in group:
                    group[key] = dict(image=crop, references=[])
                region = [x + bounds[0], y + bounds[1], crop.width, crop.height, None, None, None]
                row['regions'].append(region)
                group[key]['references'].append(region)
    for name, entry in inventory['manifests'].items():
        sources[local(name).relative_to(ROOT).as_posix()] = entry['sha256']
    OUT.mkdir(parents=True, exist_ok=True)
    pages = []
    output_hashes = {}
    unique_tiles = 0
    for group_name, tiles in sorted(groups.items()):
        pending = sorted(tiles.values(), key=lambda t: (-t['image'].height, -t['image'].width))
        while pending:
            atlas = Image.new('RGBA', (PAGE, PAGE))
            placed, remaining = [], []
            x = y = 1
            shelf = used_x = used_y = 0
            for tile in pending:
                crop = tile['image']
                if x + crop.width + 1 > PAGE:
                    x = 1
                    y += shelf
                    shelf = 0
                if y + crop.height + 1 > PAGE:
                    remaining.append(tile)
                    continue
                atlas.paste(crop, (x, y))
                placed.append((tile, x, y))
                used_x = max(used_x, x + crop.width + 1)
                used_y = max(used_y, y + crop.height + 1)
                x += crop.width + 2
                shelf = max(shelf, crop.height + 2)
            assert placed, group_name
            atlas = atlas.crop((0, 0, used_x, used_y))
            # Name pages by actual encoded content, allowing immutable HTTP cache.
            import io
            encoded = io.BytesIO()
            atlas.save(encoded, format='PNG', compress_level=6)
            raw = encoded.getvalue()
            digest = sha(raw)
            target = OUT / (digest[:24] + '.png')
            if not target.exists() or target.read_bytes() != raw:
                target.write_bytes(raw)
            page_index = len(pages)
            pages.append(dict(path='/' + target.relative_to(WEB).as_posix(), sha256=digest,
                              width=atlas.width, height=atlas.height, group=group_name, bytes=len(raw)))
            output_hashes[target.relative_to(ROOT).as_posix()] = digest
            for tile, px, py in placed:
                for region in tile['references']:
                    region[4:] = [page_index, px, py]
            unique_tiles += len(placed)
            pending = remaining
    # Decode generated pages and reconstruct every original tile. Alpha-zero RGB
    # is immaterial to Canvas source-over/lighter; HUD masks are kept untrimmed.
    decoded = [Image.open(local(p['path'])).convert('RGBA') for p in pages]
    for asset in inventory['assets']:
        row = images[asset['path']]
        restored = Image.new('RGBA', (row['width'], row['height']))
        for ox, oy, w, h, page, px, py in row['regions']:
            restored.paste(decoded[page].crop((px, py, px+w, py+h)), (ox, oy))
        with Image.open(local(asset['path'])) as opened:
            original = opened.convert('RGBA')
        assert original.getchannel('A').tobytes() == restored.getchannel('A').tobytes(), asset['path']
        difference = ImageChops.difference(original.convert('RGB'), restored.convert('RGB'))
        occupied = original.getchannel('A').point(lambda value: 255 if value else 0).convert('RGB')
        assert ImageChops.multiply(difference, occupied).getbbox() is None, asset['path']
    manifest = dict(schema='seventh-seal-battle-packs', version=1, pages=pages, images=images,
                    manifests=inventory['manifests'])
    target = WEB / 'data/battle_packs.json'
    target.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    output_hashes[target.relative_to(ROOT).as_posix()] = sha(target.read_bytes())
    assert all(sha((ROOT / name).read_bytes()) == digest for name, digest in sources.items())
    report = dict(schema='seventh-seal-battle-pack-export', version=1, source_unchanged=True,
                  source_hashes=sources, output_hashes=output_hashes, images=len(images), pages=len(pages),
                  unique_tiles=unique_tiles, source_rgba_bytes=input_pixels * 4,
                  atlas_rgba_bytes=sum(p['width'] * p['height'] * 4 for p in pages),
                  png_bytes=sum(p['bytes'] for p in pages), pixel_reconstruction_passed=True,
                  policy='Lossless visible RGBA, source alpha, original geometry and source hashes retained. HUD masks remain full rectangles.')
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: report[k] for k in ['images', 'pages', 'unique_tiles', 'source_rgba_bytes', 'atlas_rgba_bytes', 'png_bytes', 'pixel_reconstruction_passed']}), flush=True)


if __name__ == '__main__':
    build()
