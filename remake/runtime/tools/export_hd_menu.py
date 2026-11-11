"""从游戏原版图集生成缺少的 2× 菜单素材。"""
import argparse
from functools import lru_cache
from hashlib import sha256
import io
import json
from pathlib import Path

from PIL import Image

from export_hd_animations import CACHE, MODEL, SCALE, WEB, read, upscaler
from incremental import save_png, write_json

OUT = WEB / 'assets/hd'
MENU = '/assets/menu/'


def read_pack(path):
    if not path.exists():
        return {'version': 1, 'images': {}}
    pack = json.loads(path.read_text(encoding='utf-8'))
    if pack.get('version') != 1 or not isinstance(pack.get('images'), dict):
        raise ValueError(f'高清素材清单无效：{path}')
    return pack


def valid_image(path, original, entry):
    if not entry or any(entry.get(key) != original[key] for key in ('width', 'height')):
        return False
    if entry.get('sourceSha256', original['sha256']) != original['sha256']:
        return False
    scale = entry.get('scale')
    if scale not in (2, 3, 4):
        return False
    width, height = original['width'], original['height']
    rect = entry.get('rect')
    if rect is not None:
        if not isinstance(rect, list) or len(rect) != 4 or any(type(value) is not int for value in rect):
            return False
        x, y, w, h = rect
        if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > width or y + h > height:
            return False
        width, height = w, h
    try:
        with Image.open(path) as image:
            if image.format != 'PNG' or image.size != (width * scale, height * scale):
                return False
            image.verify()
    except (OSError, SyntaxError):
        return False
    return True


def export(catalog, missing, out, enhance):
    @lru_cache(maxsize=8)
    def source_page(index):
        page = catalog['pages'][index]
        path = WEB / page['path'].lstrip('/')
        raw = path.read_bytes()
        if sha256(raw).hexdigest() != page['sha256']:
            raise ValueError(f'原版纹理页指纹不符：{path}')
        with Image.open(io.BytesIO(raw)) as image:
            return image.convert('RGBA')

    entries = {}
    for number, (path, original) in enumerate(missing.items(), 1):
        width, height = original['width'], original['height']
        source = Image.new('RGBA', (width, height))
        for x, y, w, h, index, px, py in original['regions']:
            source.paste(source_page(index).crop((px, py, px+w, py+h)), (x, y))
        entry = dict(width=width, height=height, scale=SCALE, sourceSha256=original['sha256'])
        box = source.getchannel('A').getbbox()
        if path.startswith(MENU + 'standing_actors/') and box and box != (0, 0, width, height):
            left, top, right, bottom = box
            entry['rect'] = [left, top, right-left, bottom-top]
            source = source.crop(box)
        result = enhance(source) if box else Image.new('RGBA', (width*SCALE, height*SCALE))
        target = out / path.removeprefix('/assets/')
        save_png(result, target)
        if not valid_image(target, original, entry):
            raise ValueError(f'生成的菜单高清图无效：{target}')
        entries[path] = entry
        if number % 25 == 0 or number == len(missing):
            print(f'已生成 {number}/{len(missing)} 张菜单高清图', flush=True)
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--weights', type=Path, help=f'{MODEL}.pth 的本地路径')
    parser.add_argument('--out', type=Path, default=OUT)
    parser.add_argument('--cache', type=Path, default=CACHE)
    parser.add_argument('--plan', action='store_true', help='只核对缺少的素材数量')
    args = parser.parse_args()

    catalog = read('assets/image_catalog.json')
    path = args.out / 'manifest.json'
    images = read_pack(path)['images']
    missing = {name: original for name, original in sorted(catalog['images'].items())
               if name.startswith(MENU) and name.endswith('.png') and
               not valid_image(args.out / name.removeprefix('/assets/'), original, images.get(name))}
    print(f'需补齐 {len(missing)} 张菜单高清图', flush=True)
    if args.plan or not missing:
        return
    if not args.weights or not args.weights.is_file():
        parser.error('生成菜单素材需要 --weights 指向本地模型文件')

    entries = export(catalog, missing, args.out, upscaler(args.weights, args.cache))
    pack = read_pack(path)
    pack['images'].update(entries)
    write_json(path, pack)
    print(f'已发布 {len(entries)} 张菜单高清图', flush=True)


if __name__ == '__main__':
    main()
