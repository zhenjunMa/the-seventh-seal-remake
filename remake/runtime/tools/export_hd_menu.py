"""从原版图集和字体轮廓生成缺少的 2× 静态高清素材。"""
import argparse
from contextlib import nullcontext
from functools import lru_cache
from hashlib import sha256
import io
import json
import re
from pathlib import Path
from statistics import median

from PIL import Image, ImageFont

from export_hd_animations import CACHE, MODEL, SCALE, WEB, canonical, read, upscaler
from incremental import build_lock, save_png, write_bytes, write_json

OUT = WEB / 'assets/hd'
MENU = '/assets/menu/'
BATTLE_RESULT = '/assets/battle_result/'
FONT_GROUPS = ('menu', 'dialogue', 'prologue')
WINDOWS_FONTS = {'宋体': ('simsun.ttc', 'SimSun'), 'Arial': ('arial.ttf', 'Arial')}
MAP_TILE_PIXELS = 1024
MAP_BACKGROUND = re.compile(r'/assets/maps/[a-z\d_-]+/background\.png', re.IGNORECASE)


def read_pack(path):
    if not path.exists():
        return {'version': 1, 'images': {}}
    pack = json.loads(path.read_text(encoding='utf-8'))
    if (pack.get('version') != 1 or not isinstance(pack.get('images'), dict)
            or not isinstance(pack.get('fonts', {}), dict)):
        raise ValueError(f'高清素材清单无效：{path}')
    return pack


def static_images():
    dialogue = read('data/dialogue_ui.json')['resources']
    for resource in dialogue.values():
        yield from (frame['image'] for frame in resource['frames'])
    for area in read('data/world_map_ui.json')['areas']:
        yield area['background']
        yield from (row[state] for row in area['destinations'] for state in ('normal', 'active', 'selected'))
    prologue = read('data/prologue_presentation.json')
    yield from (frame['image'] for frame in prologue['resources']['wait']['frames'])
    loading = prologue['loading']
    yield from (frame['image'] for frame in loading['backgrounds'])
    yield loading['frame']
    yield loading['fill']
    for name, asset in read('data/startup_menu.json')['assets'].items():
        if not name.startswith('menuspecial') or name in ('menuspecial00', 'menuspecial01', 'menuspecial30'):
            yield from (frame['path'] for frame in asset['frames'])

    map_effects = read('data/map_effects.json')['maps']
    chapter_objects = read('data/chapter_map_resources.json')['object_animations']
    placed, animated = set(), set()
    for path in sorted((WEB / 'data/maps').glob('*.json')):
        scene = read(path.relative_to(WEB).as_posix())
        background = scene['background']
        yield background['image'] if isinstance(background, dict) else background
        map_id = scene['id']
        moving = {obj['index'] for obj in map_effects.get(map_id, {}).get('objects', [])}
        moving.update(obj['object_index_zero_based'] for obj in chapter_objects.get(map_id, []))
        for obj in scene.get('objects', []):
            target = animated if obj['index'] in moving or obj.get('frame') != 0 else placed
            target.add(canonical(obj['image']))
    yield from sorted(placed - animated)

    stages = ['data/forest_stage.json', 'data/skill_test_stage.json', *(path.relative_to(WEB).as_posix()
               for path in sorted((WEB / 'data/stages').glob('stage*.json')))]
    for path in stages:
        for layer in read(path)['layers']:
            if not layer.get('animation') and layer['id'] != 'FSBLACK' and len(layer['frames']) == 1:
                frame = layer['frames'][0]
                yield frame['path']
                if frame.get('intrinsic'):
                    yield frame['intrinsic']['path']
    yield from battle_hud_images()
    yield from native_service_images()


def battle_hud_images():
    hud = read('data/battle_ui.json')
    for menu in hud['menus']:
        if menu['id'] == 'fight_char':
            continue
        yield menu['images'][0]['image']
        for widget in menu['widgets']:
            name = widget['name'].lower()
            if menu['id'] == 'fight_stat' and name in ('hp_bar', 'mp_bar'):
                yield widget['normal_images'][0]
            if menu['id'] in ('fight001', 'fight002') and re.fullmatch(r'list[1-6]', name):
                yield widget['active_images'][0]
            if menu['id'] == 'fight001' and name in ('001', '002', '003'):
                yield (widget['selected_images'] or widget['active_images'])[-1]

    animated = ('fight_mark', 'fight_cursor1', 'fight_cursor2', 'hit', 'magic_ball1', 'name_ball',
                'other_ball', 'magic_ball1_num', 'board_bright', 'fight_var_text', 'fight_var_textb', 'fight_miss_text')
    single = ('time_bar', 'time_glass', 'fight_board_mask', 'fight_board_disable')
    for name in (*animated, *single, 'fight_role_name', *(f'h{i}' for i in range(10))):
        frames = hud['assets'][name]['frames']
        if name in single:
            frames = frames[:1]
        elif name == 'fight_role_name':
            frames = frames[:2]
        for frame in frames:
            yield frame.get('inverse_mask_image', frame['image']) if name == 'time_glass' else frame['image']
            if frame.get('indexed_image'):
                yield frame['indexed_image']


def native_service_images():
    services = read('data/native_services.json')
    controls = {'boss_main': r'0[1-4]', 'boss_buy_01': r'list\d+|up|dn',
                'boss_buy_02': r'list\d+|up|dn', 'boss_buy_03a': r'OK|CANCEL'}
    for menu in services['menus']:
        name = menu['id']
        if name == 'boss_buy_03':
            continue
        yield menu['images'][0]['image']
        pattern = r'0[1-3]' if name.startswith('boss_text_') else controls.get(name)
        for widget in menu['widgets']:
            if pattern and re.fullmatch(pattern, widget['name'], re.I):
                for state in ('normal_images', 'active_images', 'selected_images'):
                    if widget[state] and (state != 'selected_images' or widget['name'].lower().startswith('list')):
                        yield widget[state][-1]
    for service in services['special'].values():
        for rows in service.values():
            for row in rows if isinstance(rows, list) else [rows]:
                if isinstance(row, dict) and row.get('image'):
                    yield row['image']


def result_images():
    for asset in read('data/battle_result.json')['assets'].values():
        for frame in asset['frames']:
            yield frame.get('render_image', frame['image'])
            if frame.get('indexed_image'):
                yield frame['indexed_image']


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
    return valid_png(path, (width * scale, height * scale))


def valid_png(path, size):
    try:
        with Image.open(path) as image:
            if image.format != 'PNG' or image.size != size:
                return False
            image.verify()
    except (OSError, SyntaxError):
        return False
    return True


def repack_maps(out, pack, originals):
    changed = 0
    verified = set()
    for name, entry in pack['images'].items():
        if not MAP_BACKGROUND.fullmatch(name) or entry.get('rect') is not None:
            continue
        original = originals.get(name)
        source = out / name.removeprefix('/assets/')
        if (not original or entry.get('scale') not in (2, 3, 4)
                or max(original['width'], original['height']) * entry['scale'] <= 2048
                or not valid_image(source, original, entry)):
            continue
        width, height, scale = (entry[key] for key in ('width', 'height', 'scale'))
        digest = sha256(source.read_bytes()).hexdigest()
        size = MAP_TILE_PIXELS // scale
        coordinates = [(x, y, min(size, width-x), min(size, height-y))
                       for y in range(0, height, size) for x in range(0, width, size)]
        tiles = dict(sourceSha256=digest, size=size)
        folder = out / 'map_tiles' / f'{digest}-{size}'
        missing = [(x, y, w, h) for x, y, w, h in coordinates
                   if folder not in verified and not valid_png(folder / f'{x}-{y}.png', (w*scale, h*scale))]
        if missing:
            with Image.open(source) as image:
                image = image.convert('RGBA')
                for x, y, w, h in missing:
                    page = image.crop((x*scale, y*scale, (x+w)*scale, (y+h)*scale))
                    target = folder / f'{x}-{y}.png'
                    save_png(page, target)
                    if not valid_png(target, page.size):
                        raise ValueError(f'高清地图分页无效：{target}')
        verified.add(folder)
        if missing or entry.get('tiles') != tiles:
            entry['tiles'] = tiles
            changed += 1
    return changed


def image_signature(row):
    return row['sha256'], row['width'], row['height']


def copy_variant(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        target.hardlink_to(source)
    except OSError:
        write_bytes(target, source.read_bytes())


def reusable_images(out, originals, entries, missing):
    wanted = {image_signature(row) for row in missing.values()}
    sources = {}
    for name, entry in entries.items():
        if name in originals and name not in missing:
            signature = image_signature(originals[name])
            path = out / name.removeprefix('/assets/')
            if signature in wanted and signature not in sources and valid_image(path, originals[name], entry):
                sources[signature] = path, entry
    return {name: sources[image_signature(row)] for name, row in missing.items() if image_signature(row) in sources}


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

    def original_image(original):
        source = Image.new('RGBA', (original['width'], original['height']))
        for x, y, w, h, index, px, py in original['regions']:
            source.paste(source_page(index).crop((px, py, px+w, py+h)), (x, y))
        return source

    generated = {}
    for number, (path, original) in enumerate(missing.items(), 1):
        width, height = original['width'], original['height']
        entry = dict(width=width, height=height, scale=SCALE, sourceSha256=original['sha256'])
        target = out / path.removeprefix('/assets/')
        signature = image_signature(original)
        static = not path.startswith((MENU, BATTLE_RESULT))
        if static and (previous := generated.get(signature)):
            copy_variant(previous, target)
        else:
            source = original_image(original)
            box = source.getchannel('A').getbbox()
            if path.startswith((MENU + 'standing_actors/', BATTLE_RESULT)) and box and box != (0, 0, width, height):
                left, top, right, bottom = box
                entry['rect'] = [left, top, right-left, bottom-top]
                source = source.crop(box)
            result = enhance(source) if box else Image.new('RGBA', (width*SCALE, height*SCALE))
            if path.startswith(BATTLE_RESULT):
                result.putalpha(source.getchannel('A').resize(result.size, Image.Resampling.BICUBIC))
            save_png(result, target)
            if static:
                generated[signature] = target
        if not valid_image(target, original, entry):
            raise ValueError(f'生成的高清图无效：{target}')
        if number % 25 == 0 or number == len(missing):
            print(f'已生成 {number}/{len(missing)} 张高清图', flush=True)
        yield path, entry


def font_profiles():
    for group in FONT_GROUPS:
        for suffix in ('', '_windows'):
            yield from read(f'data/{group}_fonts{suffix}.json')['fonts'].values()


def valid_font(path, row, source_sha):
    if source_sha != row['sha256']:
        return False
    try:
        data = json.loads(path.with_suffix('.json').read_text(encoding='utf-8'))
        width, height = data['width'], data['height']
        if data['scale'] != SCALE or not all(type(size) is int and size > 0 for size in (width, height)):
            return False
        for char in row['glyphs']:
            glyph = data['glyphs'][char]
            x, y, w, h, dx, dy = (glyph[k] for k in ('x', 'y', 'width', 'height', 'offset_x', 'offset_y'))
            if (not all(type(n) is int for n in (x, y, w, h, dx, dy))
                    or min(x, y, w, h) < 0 or x + w > width or y + h > height):
                return False
        return valid_png(path, (width, height))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def font_spec(row):
    if source := row.get('font_source'):
        return source['file'], row['face_resolved'], source['sha256']
    file, face = WINDOWS_FONTS[row['face_resolved']]
    return file, face, None


def font_loader(rows, directories):
    paths = {}
    for directory in directories:
        for path in sorted(directory.iterdir()):
            if path.is_file():
                paths.setdefault(path.name.casefold(), path)

    @lru_cache(maxsize=None)
    def open_outline(file, face, digest, height):
        path = paths.get(file.casefold())
        if path is None:
            raise ValueError(f'缺少字体轮廓 {file}，请通过 --font-dir 指定所在目录')
        if digest is not None and outline_digest(path) != digest:
            raise ValueError(f'字体轮廓指纹不符：{path}')
        font = ImageFont.truetype(str(path), height * SCALE, layout_engine=ImageFont.Layout.BASIC)
        if font.getname()[0] != face:
            raise ValueError(f'字体轮廓应为 {face}：{path}')
        return font

    for row in rows:
        open_outline(*font_spec(row), row['height'])
        if not row.get('font_source') and row['face_resolved'] == 'Arial':
            open_outline(*WINDOWS_FONTS['宋体'], None, row['height'])
    return open_outline


@lru_cache(maxsize=None)
def outline_digest(path):
    return sha256(path.read_bytes()).hexdigest()


def glyph_mask(font, char):
    mask, (x, y) = font.getmask2(char, mode='L', anchor='ls')
    if not all(mask.size):
        return None
    image = Image.frombytes('L', mask.size, bytes(mask))
    if bounds := image.getbbox():
        return image.crop(bounds), x + bounds[0], y + bounds[1]
    return None


def outline_glyph(font, missing_mask, char):
    glyph = glyph_mask(font, char)
    if glyph and (missing_mask is None or glyph[0] != missing_mask[0]):
        return glyph
    return None


def export_font(path, row, out, open_outline):
    font = open_outline(*font_spec(row), row['height'])
    missing_mask = glyph_mask(font, '\U0010ffff')
    glyphs = row['glyphs']
    outlines = {char: outline_glyph(font, missing_mask, char) for char, glyph in glyphs.items()
                if glyph['width'] and glyph['height']}
    baseline = row.get('baseline')
    if baseline is None:
        # GDI profiles record glyph offsets without a shared baseline.
        offsets = [glyphs[char]['offset_y'] * SCALE - value[2] for char, value in outlines.items()
                   if value and char.isalnum()]
        baseline = round(median(offsets)) if offsets else font.getmetrics()[0]
    else:
        baseline *= SCALE

    linked = None
    if not row.get('font_source') and row['face_resolved'] == 'Arial':
        linked = open_outline(*WINDOWS_FONTS['宋体'], None, row['height'])
    linked_missing = glyph_mask(linked, '\U0010ffff') if linked else None
    original_alpha = None
    width = 1536
    x = y = shelf_height = 0
    layout, tiles = {}, []
    for char, glyph in glyphs.items():
        if char not in outlines:
            layout[char] = dict(x=0, y=0, width=0, height=0, offset_x=0, offset_y=0)
            continue
        if outline := outlines[char]:
            mask, left, top = outline
            top += baseline
        elif linked and ord(char) > 127 and (outline := outline_glyph(linked, linked_missing, char)):
            mask, left, _ = outline
            top = glyph['offset_y'] * SCALE
        else:
            if original_alpha is None:
                relative = path.removeprefix('/assets/')
                original = WEB.parent / 'builtin' / relative
                if not original.is_file():
                    original = WEB / path.lstrip('/')
                raw = original.read_bytes()
                if sha256(raw).hexdigest() != row['sha256']:
                    raise ValueError(f'原字库指纹不符：{original}')
                with Image.open(io.BytesIO(raw)) as image:
                    original_alpha = image.convert('RGBA').getchannel('A')
            gx, gy, gw, gh = (glyph[k] for k in ('x', 'y', 'width', 'height'))
            mask = original_alpha.crop((gx, gy, gx + gw, gy + gh))
            mask = mask.resize((gw * SCALE, gh * SCALE), Image.Resampling.NEAREST)
            left, top = glyph['offset_x'] * SCALE, glyph['offset_y'] * SCALE
        if x + mask.width > width:
            x, y, shelf_height = 0, y + shelf_height, 0
        layout[char] = dict(x=x, y=y, width=mask.width, height=mask.height, offset_x=left, offset_y=top)
        tiles.append((mask, x, y))
        x += mask.width + 1
        shelf_height = max(shelf_height, mask.height + 1)

    height = max(1, y + shelf_height)
    alpha = Image.new('L', (width, height))
    for mask, x, y in tiles:
        alpha.paste(mask, (x, y))
    atlas = Image.new('RGBA', alpha.size, (255, 255, 255, 0))
    atlas.putalpha(alpha)
    destination = out / path.removeprefix('/assets/')
    save_png(atlas, destination)
    write_json(destination.with_suffix('.json'), dict(width=width, height=height, scale=SCALE, glyphs=layout), compact=True)
    return row['sha256']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--weights', type=Path, help=f'{MODEL}.pth 的本地路径')
    parser.add_argument('--out', type=Path, default=OUT)
    parser.add_argument('--cache', type=Path, default=CACHE)
    parser.add_argument('--font-dir', type=Path, action='append', default=[], help='字体轮廓目录，可重复指定')
    parser.add_argument('--plan', action='store_true', help='只核对缺少的图片和字库数量')
    parser.add_argument('--reuse-only', action='store_true', help='只发布同源高清图，无需运行模型')
    parser.add_argument('--repack-maps', action='store_true', help='从已安装的高清大地图生成纹理页，无需模型或字体')
    args = parser.parse_args()
    if args.repack_maps and (args.plan or args.reuse_only):
        parser.error('--repack-maps 请单独使用')

    with nullcontext() if args.plan else build_lock(args.out / '.build'):
        manifest = args.out / 'manifest.json'
        pack = read_pack(manifest)
        catalog = read('assets/image_catalog.json')
        originals = catalog['images']
        if args.repack_maps:
            changed = repack_maps(args.out, pack, originals)
            if changed:
                write_json(manifest, pack)
            print(f'已分页 {changed} 张高清大地图', flush=True)
            return
        paths = {path for path in originals if path.startswith(MENU) and path.endswith('.png')}
        paths.update(map(canonical, static_images()))
        paths.update(map(canonical, result_images()))
        missing = {path: originals[path] for path in sorted(paths) if originals[path]['regions']
                   and not valid_image(args.out / path.removeprefix('/assets/'), originals[path], pack['images'].get(path))}
        reusable = reusable_images(args.out, originals, pack['images'], missing)
        print(f'需补齐 {len(missing)} 张高清图，其中 {len(reusable)} 张可复用', flush=True)

        fonts = {}
        registered = pack.get('fonts', {})
        for row in font_profiles():
            path = canonical(row['image'])
            if not valid_font(args.out / path.removeprefix('/assets/'), row, registered.get(path)):
                fonts[path] = row
        print(f'需补齐 {len(fonts)} 份高清字库', flush=True)
        if args.plan:
            return

        for name, (source, entry) in reusable.items():
            copy_variant(source, args.out / name.removeprefix('/assets/'))
            pack['images'][name] = dict(entry, sourceSha256=missing.pop(name)['sha256'])
        if reusable:
            write_json(manifest, pack)
            print(f'已发布 {len(reusable)} 张同源高清图', flush=True)
        if args.reuse_only:
            return
        if missing and not (args.weights and args.weights.is_file()):
            parser.error('生成图片需要 --weights 指向本地模型文件')
        if fonts:
            try:
                open_outline = font_loader(fonts.values(), args.font_dir)
            except (OSError, ValueError) as error:
                parser.error(str(error))
        if missing:
            enhance = upscaler(args.weights, args.cache)
            for number, (path, entry) in enumerate(export(catalog, missing, args.out, enhance), 1):
                pack['images'][path] = entry
                if number % 50 == 0:
                    write_json(manifest, pack)
            write_json(manifest, pack)
            print(f'已发布 {len(missing)} 张高清图', flush=True)
        for path, row in fonts.items():
            pack.setdefault('fonts', {})[path] = export_font(path, row, args.out, open_outline)
            write_json(manifest, pack)
        if fonts:
            print(f'已发布 {len(fonts)} 份高清字库', flush=True)
        changed = repack_maps(args.out, pack, originals)
        if changed:
            write_json(manifest, pack)
            print(f'已分页 {changed} 张高清大地图', flush=True)


if __name__ == '__main__':
    main()
