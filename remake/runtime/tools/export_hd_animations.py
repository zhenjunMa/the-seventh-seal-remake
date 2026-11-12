"""离线生成可选的 2× 动画图集。输入为已构建的原版纹理页和动作清单。"""
import argparse
from collections import defaultdict
from fnmatch import fnmatchcase
from functools import lru_cache
from hashlib import sha256
import io
import json
from pathlib import Path
import re
from time import monotonic

from PIL import Image

from export_battle_packs import WEB, inventory, layout_pages
from incremental import build_lock, write_bytes, write_json

OUT = WEB / 'assets/hd/animations'
CACHE = WEB.parent / '.cache/hd_animations'
MODEL = 'RealESRGAN_x4plus_anime_6B'
SCALE = 2
MAX_TILE = 1023  # 2046 physical pixels and a one-pixel gutter on both sides.


def read(path):
    return json.loads((WEB / path.lstrip('/')).read_text(encoding='utf-8'))


def canonical(path):
    return '/' + path.lstrip('/')


def map_inventory():
    roles = [*read('data/catalog.json')['roles'], *read('data/story/shared.json')['roles'].values(),
             *read('data/opening_map_resources.json')['roles'].values()]
    for role in roles:
        for action in role['actions']:
            yield canonical(action['sheet']), role['frame_width'], role['frame_height']
    effects = read('data/map_effects.json')
    for role in effects['roles'].values():
        for action in role['actions']:
            if action.get('intrinsic_sheet'):
                yield canonical(action['intrinsic_sheet']), role['frame_width'], role['frame_height']
    for event in (WEB / 'data/events').glob('*.json'):
        resource = read(f'data/events/{event.name}').get('npc', {}).get('resource') or {}
        if resource.get('sheet'):
            yield canonical(resource['sheet']), resource['frame_width'], resource['frame_height']


def map_object_inventory(images):
    effects = read('data/map_effects.json')
    banks = {obj['bank'] for scene in effects['maps'].values() for obj in scene['objects']}
    for name in sorted(banks):
        bank = effects['object_banks'][name]
        for action in bank['actions']:
            for channel in ('main', 'intrinsic', 'shadow'):
                if path := action.get(f'{channel}_sheet'):
                    yield canonical(path), bank['frame_width'], bank['frame_height']
    for role in read('data/map_shadows.json')['roles'].values():
        for action in role['actions']:
            bounds = action['shadow_geometry']
            yield canonical(action['shadow_sheet']), bounds['width'], bounds['height']

    chapters = read('data/chapter_map_resources.json')['object_animations']
    for path in sorted((WEB / 'data/maps').glob('*.json')):
        scene = read(path.relative_to(WEB).as_posix())
        map_id = scene['id']
        moving = {obj['index'] for obj in effects['maps'].get(map_id, {}).get('objects', [])}
        objects = chapters.get(map_id, [])
        moving.update(obj['object_index_zero_based'] for obj in objects)
        for obj in scene.get('objects', []):
            if obj['index'] in moving:
                name = canonical(obj['image'])
                yield name, images[name]['width'], images[name]['height']
        for obj in objects:
            # Plot objects can display individual DGP frames during an action
            # and when restoring its finished pose from a save.
            for frame in obj['frames']:
                name = canonical(frame['image'])
                yield name, images[name]['width'], images[name]['height']


def stage_inventory(manifests):
    for reference in manifests.values():
        stage = reference['value']
        if 'stage_id' not in stage or 'default_composition' not in stage:
            continue
        composition = stage['default_composition']
        visible = {row['layer_id'] for row in [composition['sky'], *composition['scene_objects']]}
        for layer in stage['layers']:
            if layer['id'] not in visible or not layer.get('animation'):
                continue
            for index in sorted(set(layer['animation']['frames'])):
                frame = layer['frames'][index]
                for row in (frame, frame.get('intrinsic')):
                    if row:
                        yield canonical(row['path']), layer['source']['width'], layer['source']['height']


def sources(catalog, battle, patterns=(), *, skip_action_effects=False):
    images = catalog['images']
    records = {}

    def add(path, width, height, *, sha=None, map_sprite=False):
        if patterns and not any(fnmatchcase(path, pattern) for pattern in patterns):
            return
        original = images[path]
        if (sha and sha != original['sha256']) or original['width'] % width or original['height'] % height:
            raise ValueError(f'动作网格或源图指纹与原图集不一致：{path}')
        row = (width, height, map_sprite)
        if path in records and records[path] != row:
            raise ValueError(f'同一素材有不同的动作网格：{path}')
        records[path] = row

    for path, width, height in map_inventory():
        add(path, width, height, map_sprite=True)
    for path, width, height in map_object_inventory(images):
        add(path, width, height, map_sprite=True)
    for path, width, height in stage_inventory(battle['manifests']):
        add(path, width, height)

    for row in battle['assets']:
        path, group = row['path'], row['group']
        if not group.startswith(('role-', 'effect-')) or Path(path).stem.endswith('_mask'):
            continue
        if skip_action_effects and group.startswith('effect-') and not group.startswith('effect-status-'):
            continue
        add(path, row['tile_width'], row['tile_height'], sha=row['sha256'])

    images_out, groups = {}, defaultdict(list)
    for path, (width, height, map_sprite) in sorted(records.items()):
        original = images[path]
        columns = original['width'] // width
        frames = defaultdict(list)
        for region in original['regions']:
            x, y, w, h = region[:4]
            column, direction = x // width, y // height
            if (x+w-1)//width != column or (y+h-1)//height != direction:
                raise ValueError(f'原图集裁片跨帧：{path}')
            index = direction * columns + column
            frames[index].append(region)
        if not frames:
            continue
        images_out[path] = {**{k: original[k] for k in ('width', 'height', 'sha256')},
                            'frameWidth': width, 'frameHeight': height, 'frames': {}}
        for index, regions in sorted(frames.items()):
            groups[(map_sprite, regions[0][4])].append((path, index, regions))
    return images_out, groups


def png(image):
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    return stream.getvalue()


def upscaler(weights, cache, *, preserve_alpha=False):
    import cv2
    import numpy as np
    import torch
    from basicsr.archs.rrdbnet_arch import RRDBNet
    from realesrgan import RealESRGANer

    device = 'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu'
    torch.set_num_threads(5)
    model = RRDBNet(3, 3, num_feat=64, num_block=6, num_grow_ch=32, scale=4)
    half = preserve_alpha and device == 'mps'
    runner = RealESRGANer(scale=4, model_path=str(weights), model=model, tile=320, tile_pad=40,
                        pre_pad=0, half=half, device=torch.device(device))
    recipe = f'{MODEL}:{sha256(weights.read_bytes()).hexdigest()}:tile320:pad40:rgba-lanczos-v1:{device}'
    original_cache = cache / sha256(recipe.encode()).hexdigest()[:24]
    if preserve_alpha:
        recipe += f':source-alpha-v1:half={half}'
    cache = cache / sha256(recipe.encode()).hexdigest()[:24]
    print(f'{MODEL} · {device}', flush=True)
    inferred = 0

    def enhance(image):
        nonlocal inferred
        key = sha256(f'{image.width},{image.height}:'.encode() + image.tobytes()).hexdigest()
        path = cache / (key + '.png')
        size = (image.width * SCALE, image.height * SCALE)
        for candidate in (path, original_cache / path.name) if preserve_alpha else (path,):
            if candidate.is_file():
                try:
                    with Image.open(candidate) as stored:
                        if stored.size == size and stored.mode == 'RGBA':
                            result = stored.copy()
                            if preserve_alpha and candidate != path:
                                result.putalpha(image.getchannel('A').resize(size, Image.Resampling.BICUBIC))
                            return result
                except OSError:
                    pass
        alpha = image.getchannel('A') if preserve_alpha else None
        conversion = cv2.COLOR_RGBA2BGR if preserve_alpha else cv2.COLOR_RGBA2BGRA
        raw, mode = runner.enhance(cv2.cvtColor(np.asarray(image), conversion), outscale=4)
        if mode != ('RGB' if preserve_alpha else 'RGBA') or raw.shape[:2] != (image.height * 4, image.width * 4):
            raise ValueError('模型输出的尺寸或透明通道无效')
        if alpha is None:
            rgba = Image.fromarray(cv2.cvtColor(raw, cv2.COLOR_BGRA2RGBA)).convert('RGBa')
            result = rgba.resize(size, Image.Resampling.LANCZOS).convert('RGBA')
        else:
            result = Image.fromarray(cv2.cvtColor(raw, cv2.COLOR_BGR2RGB)).resize(size, Image.Resampling.LANCZOS)
            result.putalpha(alpha.resize(size, Image.Resampling.BICUBIC))
        write_bytes(path, png(result))
        inferred += 1
        if device == 'mps' and inferred % 256 == 0:
            torch.mps.empty_cache()
        return result

    return enhance


def frame_bounds(regions):
    return (min(r[0] for r in regions), min(r[1] for r in regions),
            max(r[0]+r[2] for r in regions), max(r[1]+r[3] for r in regions))


def frame_fits(parts, regions, pages):
    if not parts:
        return False
    left, top, right, bottom = frame_bounds(regions)
    covered, area = [], 0
    for x, y, w, h, name, px, py in parts:
        page = pages.get(name)
        if (not page or not all(type(v) is int for v in (x, y, w, h, px, py))
                or not (left <= x < x+w <= right and top <= y < y+h <= bottom)
                or not (0 <= px < px+w*SCALE <= page['width'] and 0 <= py < py+h*SCALE <= page['height'])
                or any(x < r and y < b and x+w > l and y+h > t for l, t, r, b in covered)):
            return False
        covered.append((x, y, x+w, y+h))
        area += w*h
    return area == (right-left)*(bottom-top)


def valid_page(path, page):
    raw = path.read_bytes()
    if sha256(raw).hexdigest() != path.stem:
        raise ValueError(f'高清纹理页指纹不符：{path.name}')
    with Image.open(io.BytesIO(raw)) as bitmap:
        if (bitmap.format != 'PNG' or bitmap.mode != 'RGBA' or bitmap.size != (page['width'], page['height'])
                or max(bitmap.size) > 2048):
            raise ValueError(f'高清纹理页格式或尺寸不符：{path.name}')
        bitmap.verify()
    return raw


def resume_frames(out, images, groups):
    path = out / 'manifest.json'
    if not path.is_file():
        return groups, {}
    existing = json.loads(path.read_text(encoding='utf-8'))
    if (existing['version'], existing['scale'], existing['model']) != (1, SCALE, MODEL):
        return groups, {}
    old_pages, old_images = existing['pages'], existing['images']
    pages, pending = {}, defaultdict(list)

    @lru_cache(maxsize=None)
    def usable(name):
        if not re.fullmatch(r'[a-f0-9]{64}\.png', name):
            return False
        try:
            valid_page(out / name, old_pages[name])
        except (OSError, ValueError, SyntaxError):
            return False
        return True

    for group, frames in groups.items():
        for path, index, regions in frames:
            row = images[path]
            old = old_images.get(path, {})
            parts = old.get('frames', {}).get(str(index))
            if (any(old.get(key) != value for key, value in row.items() if key != 'frames')
                    or not frame_fits(parts, regions, old_pages)
                    or group[0] and len(parts) != 1
                    or not all(usable(part[4]) for part in parts)):
                pending[group].append((path, index, regions))
                continue
            row['frames'][str(index)] = parts
            pages.update((part[4], old_pages[part[4]]) for part in parts)
    return pending, pages


def build(catalog, images, groups, enhance, out, pages=None):
    @lru_cache(maxsize=6)
    def source_page(index):
        page = catalog['pages'][index]
        raw = (WEB / page['path'].lstrip('/')).read_bytes()
        if sha256(raw).hexdigest() != page['sha256']:
            raise ValueError(f'原图集页指纹不符：{page["path"]}')
        with Image.open(io.BytesIO(raw)) as source:
            if source.size != (page['width'], page['height']):
                raise ValueError(f'原图集页尺寸不符：{page["path"]}')
            return source.convert('RGBA')

    checkpoint = pages is not None
    pages = {} if pages is None else pages
    last_checkpoint = monotonic()

    def publish():
        ready = {path: row for path, row in images.items() if row['frames']}
        write_json(out / 'manifest.json', dict(version=1, scale=SCALE, model=MODEL, pages=pages, images=ready), compact=True)
        return ready

    for number, ((map_sprite, _), frames) in enumerate(groups.items(), 1):
        tiles, dedup = [], {}
        for path, index, regions in frames:
            left, top, right, bottom = frame_bounds(regions)
            width, height = right-left, bottom-top
            if map_sprite and max(width, height) > MAX_TILE:
                raise ValueError(f'探索精灵超过单纹理页尺寸：{path}#{index}')
            stem = Path(path).stem
            shadow = stem == 'shadow' or stem.endswith('_shadow')
            crops = tuple(sorted((x-left, y-top, w, h, page, px, py) for x, y, w, h, page, px, py in regions))
            token = shadow, crops
            if token not in dedup:
                frame = Image.new('RGBA', (width, height))
                for x, y, w, h, page, px, py in crops:
                    frame.paste(source_page(page).crop((px, py, px+w, py+h)), (x, y))
                hd = frame.resize((width*SCALE, height*SCALE), Image.Resampling.BICUBIC) if shadow else enhance(frame)
                parts = []
                for ty in range(0, height, MAX_TILE):
                    for tx in range(0, width, MAX_TILE):
                        w, h = min(MAX_TILE, width-tx), min(MAX_TILE, height-ty)
                        bitmap = hd.crop((tx*SCALE, ty*SCALE, (tx+w)*SCALE, (ty+h)*SCALE))
                        parts.append(dict(x=tx, y=ty, w=w, h=h, width=bitmap.width, height=bitmap.height,
                                          image=bitmap, uses=[]))
                tiles.extend(parts)
                dedup[token] = parts
            for tile in dedup[token]:
                tile['uses'].append((path, index, left, top))
        for placed, width, height in layout_pages(tiles):
            atlas = Image.new('RGBA', (width, height))
            for tile, x, y in placed:
                atlas.paste(tile['image'], (x, y))
            raw = png(atlas)
            file = sha256(raw).hexdigest() + '.png'
            write_bytes(out / file, raw)
            pages[file] = dict(width=width, height=height)
            for tile, x, y in placed:
                for path, index, left, top in tile['uses']:
                    images[path]['frames'].setdefault(str(index), []).append([
                        left+tile['x'], top+tile['y'], tile['w'], tile['h'], file, x, y
                    ])
        if number == len(groups) or number % 10 == 0:
            print(f'处理纹理组 {number}/{len(groups)} · 输出 {len(pages)} 页', flush=True)
        if checkpoint and monotonic() - last_checkpoint >= 60:
            publish()
            last_checkpoint = monotonic()
    images = publish()
    print(json.dumps(dict(images=len(images), frames=sum(len(r['frames']) for r in images.values()),
                          pages=len(pages)), ensure_ascii=False), flush=True)


def install(staged, out, images, groups):
    """Check coverage against today's original atlas before publishing a new index."""
    manifest = json.loads((staged / 'manifest.json').read_text(encoding='utf-8'))
    if (manifest['version'], manifest['scale'], manifest['model']) != (1, SCALE, MODEL):
        raise ValueError('高清动画清单的版本、倍率或模型不符')
    pages, variants = manifest['pages'], manifest['images']
    if variants.keys() != images.keys():
        raise ValueError('高清包的素材路径与当前导出范围不一致')

    expected = defaultdict(set)
    used_pages = set()
    for frames in groups.values():
        for path, index, regions in frames:
            key = str(index)
            expected[path].add(key)
            row = variants[path]
            if any(row[k] != images[path][k] for k in ('width', 'height', 'sha256', 'frameWidth', 'frameHeight')):
                raise ValueError(f'高清帧源图或网格已变化：{path}')
            parts = row['frames'].get(key)
            if not frame_fits(parts, regions, pages):
                raise ValueError(f'高清裁片缺失或覆盖不完整：{path}#{key}')
            used_pages.update(part[4] for part in parts)
    if any(row['frames'].keys() != expected[path] for path, row in variants.items()) or used_pages != pages.keys():
        raise ValueError('高清帧或纹理页存在多余登记')

    out.mkdir(parents=True, exist_ok=True)
    total_bytes = 0
    for name, page in pages.items():
        if not re.fullmatch(r'[a-f0-9]{64}\.png', name):
            raise ValueError(f'高清纹理页文件名无效：{name}')
        source = staged / name
        raw = valid_page(source, page)
        total_bytes += len(raw)
        target = out / name
        if staged.resolve() == out.resolve():
            continue
        if not target.exists():
            try:
                target.hardlink_to(source)
                continue
            except OSError:
                pass
        write_bytes(target, raw)

    write_json(out / 'manifest.json', manifest, compact=True)
    print(json.dumps(dict(installed=str(out), images=len(variants), frames=sum(map(len, expected.values())),
                          pages=len(pages), png_bytes=total_bytes), ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--weights', type=Path, help=f'{MODEL}.pth 的本地路径')
    parser.add_argument('--out', type=Path, default=OUT)
    parser.add_argument('--cache', type=Path, default=CACHE)
    parser.add_argument('--skip-action-effects', action='store_true', help='招式和道具的施放特效沿用原帧，仍导出角色动作和状态特效')
    parser.add_argument('--include', action='append', default=[], help='按原素材路径筛选，可重复，可用通配符')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--plan', action='store_true', help='只统计现有素材范围')
    mode.add_argument('--install-from', type=Path, help='校验已生成的图集，然后发布到 --out')
    args = parser.parse_args()
    if not (args.plan or args.install_from) and not (args.weights and args.weights.is_file()):
        parser.error('生成图集需要 --weights 指向本地模型文件')
    catalog = read('assets/image_catalog.json')
    images, groups = sources(catalog, inventory(['--plan']), args.include, skip_action_effects=args.skip_action_effects)
    if not groups:
        parser.error('所选范围没有可用的动画帧')
    print(f'选中 {len(images)} 个图条或独立帧 · {sum(map(len, groups.values()))} 个非空帧 · {len(groups)} 组', flush=True)
    if args.plan:
        return
    with build_lock(args.out / '.build'):
        if args.install_from:
            install(args.install_from, args.out, images, groups)
            return
        pages = None
        if not args.include:
            planned = sum(map(len, groups.values()))
            groups, pages = resume_frames(args.out, images, groups)
            pending = sum(map(len, groups.values()))
            print(f'已校验并复用 {planned-pending} 帧 · 待生成 {pending} 帧', flush=True)
        enhance = upscaler(args.weights, args.cache, preserve_alpha=not args.include) if groups else None
        build(catalog, images, groups, enhance, args.out, pages)


if __name__ == '__main__':
    main()
