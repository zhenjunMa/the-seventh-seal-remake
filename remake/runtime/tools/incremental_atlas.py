"""Append verified tiles without moving published atlas pages or coordinates."""
from collections import defaultdict, OrderedDict
from pathlib import Path
import io
import json
import os
from PIL import Image, ImageChops
from incremental import digest, file_hash, write_bytes, write_json


def build_atlas(data, *, runtime, web, out, layout_pages, packing_family, dependency_groups, repack=False):
    runtime, web, out = Path(runtime), Path(web), Path(out)
    manifest_path = web/'data/battle_packs.json'
    previous = json.loads(manifest_path.read_text('utf-8')) if manifest_path.is_file() and not repack else None
    pages = list(previous['pages']) if previous else []
    previous_images = previous['images'] if previous else {}
    index_path = runtime/'evidence/resource_cache/battle_tiles.json'
    index = json.loads(index_path.read_text('utf-8')) if index_path.is_file() and not repack else {}
    # Index entries are only trusted against the exact manifest they describe.
    trusted = bool(previous and index.get('manifest_sha256') == file_hash(manifest_path))
    tile_index = index.get('tiles', {}) if trusted else {}
    layouts = index.get('layouts', {}) if trusted else {}
    new_layouts, images, groups, sources = {}, {}, defaultdict(dict), {}
    decoded_pages = OrderedDict()
    counters = dict(reused_images=0, decoded_images=0, new_pages=0, repaired_pages=0)

    def local(name):
        path = (web/name.lstrip('/')).resolve()
        if not path.is_relative_to(web.resolve()):
            raise ValueError('Atlas resource leaves web: '+name)
        return path

    def page_image(number):
        if number in decoded_pages:
            decoded_pages.move_to_end(number)
            return decoded_pages[number]
        with Image.open(local(pages[number]['path'])) as opened:
            value = opened.convert('RGBA')
        decoded_pages[number] = value
        if len(decoded_pages) > 4:
            decoded_pages.popitem(last=False)
        return value

    def encode(image):
        stream = io.BytesIO()
        image.save(stream, format='PNG', compress_level=6)
        return stream.getvalue()

    # Repair the original page in place, at the original coordinates, using
    # retained verified source descriptors. No unrelated page is regenerated.
    for number, page in enumerate(pages):
        path = local(page['path'])
        if path.is_file() and file_hash(path) == page['sha256']:
            continue
        restored = Image.new('RGBA', (page['width'], page['height']))
        for name, descriptor in previous_images.items():
            regions = [r for r in descriptor['regions'] if r[4] == number]
            if not regions:
                continue
            source = local(name)
            if not source.is_file() or file_hash(source) != descriptor['sha256']:
                raise ValueError('Cannot repair retained atlas page from changed/missing source: '+name)
            with Image.open(source) as opened:
                image = opened.convert('RGBA')
            for ox, oy, w, h, _, px, py in regions:
                restored.paste(image.crop((ox, oy, ox+w, oy+h)), (px, py))
        raw = encode(restored)
        if digest(raw) != page['sha256']:
            raise ValueError('Retained atlas page cannot be reconstructed exactly: '+page['path'])
        write_bytes(path, raw)
        counters['repaired_pages'] += 1

    def tile_key(image):
        return digest(image.width.to_bytes(4, 'little') + image.height.to_bytes(4, 'little') + image.tobytes())

    # Adopt the existing published layout once, checking the page bytes above.
    # Only atlas pages are decoded; original image sheets are not re-exported.
    if previous and not trusted:
        retained_tiles = defaultdict(dict)
        for asset in data['assets']:
            old = previous_images.get(asset['path'])
            if not old or any(old[k] != asset[k] for k in ('sha256','width','height')):
                continue
            family = packing_family(asset)
            for _, _, w, h, number, px, py in old['regions']:
                retained_tiles[number][(family,px,py,w,h)] = None
        for number, locations in sorted(retained_tiles.items()):
            image = page_image(number)
            for family,px,py,w,h in locations:
                tile = image.crop((px, py, px+w, py+h))
                tile_index.setdefault(family,{})[tile_key(tile)] = [number, px, py, w, h]

    for asset in data['assets']:
        name = asset['path']
        source = local(name)
        if file_hash(source) != asset['sha256']:
            raise ValueError('Source image fingerprint mismatch: '+name)
        sources[source.relative_to(runtime.parents[1]).as_posix()] = asset['sha256']
        family = packing_family(asset)
        recipe = {key: asset.get(key) for key in ('tile_width','tile_height','trim')}
        recipe['family'] = family
        new_layouts[name] = recipe
        old = previous_images.get(name)
        unchanged = (old and all(old[k] == asset[k] for k in ('sha256','width','height'))
                     and (not trusted or layouts.get(name) == recipe))
        if unchanged:
            images[name] = old
            counters['reused_images'] += 1
            continue
        counters['decoded_images'] += 1
        with Image.open(source) as opened:
            image = opened.convert('RGBA')
        if image.size != (asset['width'], asset['height']):
            raise ValueError('Source image geometry mismatch: '+name)
        row = dict(sha256=asset['sha256'], width=image.width, height=image.height, regions=[])
        images[name] = row
        bank = tile_index.setdefault(family, {})
        for y in range(0, image.height, asset['tile_height']):
            for x in range(0, image.width, asset['tile_width']):
                tile = image.crop((x, y, min(image.width,x+asset['tile_width']), min(image.height,y+asset['tile_height'])))
                bounds = tile.getchannel('A').getbbox() if asset.get('trim', True) else (0,0,tile.width,tile.height)
                if bounds is None:
                    continue
                crop = tile.crop(bounds)
                key = tile_key(crop)
                region = [x+bounds[0], y+bounds[1], crop.width, crop.height, None, None, None]
                row['regions'].append(region)
                if key in bank:
                    number, px, py, w, h = bank[key]
                    if (w,h) != crop.size:
                        raise ValueError('Invalid retained tile index')
                    region[4:] = [number,px,py]
                else:
                    pending = groups[family]
                    if key not in pending:
                        pending[key] = dict(image=crop, width=crop.width, height=crop.height,
                                            references=[], owners=set(), key=key, family=family)
                    pending[key]['references'].append(region)
                    pending[key]['owners'].update(asset.get('owners', []))

    for group_name, tiles in sorted(dependency_groups(groups).items()):
        for placed, width, height in layout_pages(tiles.values()):
            atlas = Image.new('RGBA', (width,height))
            for tile, x, y in placed:
                atlas.paste(tile['image'],(x,y))
            raw = encode(atlas)
            checksum = digest(raw)
            path = out/(checksum[:24]+'.png')
            write_bytes(path,raw)
            number = len(pages)
            pages.append(dict(path='/'+path.relative_to(web).as_posix(),sha256=checksum,
                              width=width,height=height,group=group_name,bytes=len(raw)))
            counters['new_pages'] += 1
            for tile,x,y in placed:
                tile_index[tile['family']][tile['key']] = [number,x,y,tile['width'],tile['height']]
                for region in tile['references']:
                    region[4:] = [number,x,y]

    # New/changed images are reconstructed before publishing the manifest.
    # --force rechecks all original pixels while keeping the published layout.
    force = os.environ.get('SEVENTH_SEAL_FORCE_EXPORT') == '1'
    for asset in data['assets']:
        row = images[asset['path']]
        if not force and row is previous_images.get(asset['path']):
            continue
        restored = Image.new('RGBA', (row['width'],row['height']))
        for ox,oy,w,h,number,px,py in row['regions']:
            restored.paste(page_image(number).crop((px,py,px+w,py+h)),(ox,oy))
        with Image.open(local(asset['path'])) as opened:
            original = opened.convert('RGBA')
        if original.getchannel('A').tobytes() != restored.getchannel('A').tobytes():
            raise ValueError('Atlas alpha reconstruction differs: '+asset['path'])
        difference = ImageChops.difference(original.convert('RGB'),restored.convert('RGB'))
        occupied = original.getchannel('A').point(lambda v:255 if v else 0).convert('RGB')
        if ImageChops.multiply(difference,occupied).getbbox() is not None:
            raise ValueError('Atlas visible pixels differ: '+asset['path'])
    manifest = dict(schema='seventh-seal-battle-packs',version=1,pages=pages,images=images,manifests=data['manifests'])
    if manifest != previous:
        write_json(manifest_path,manifest,compact=True)
    write_json(index_path,dict(version=1,manifest_sha256=file_hash(manifest_path),tiles=tile_index,layouts=new_layouts))
    outputs = {local(page['path']).relative_to(runtime.parents[1]).as_posix():page['sha256'] for page in pages}
    outputs[manifest_path.relative_to(runtime.parents[1]).as_posix()] = file_hash(manifest_path)
    # Sources must still match after the computation.
    for asset in data['assets']:
        if file_hash(local(asset['path'])) != asset['sha256']:
            raise ValueError('Source image changed during atlas export: '+asset['path'])
    return manifest, sources, outputs, counters
