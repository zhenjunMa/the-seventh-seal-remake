"""Append visible glyphs to fixed built-in atlases.

The font file must match the manifest's font_source SHA. This maintenance
command never resolves system fonts and is not part of normal media builds.
"""
import argparse
from copy import deepcopy
from functools import reduce
import hashlib
import io
import json
from math import gcd
from pathlib import Path
import unicodedata

from PIL import Image, ImageDraw, ImageFont, features

from incremental import write_bytes, write_json

RUNTIME = Path(__file__).resolve().parents[1]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def rasterize(font, character, baseline, cell):
    # Keep negative bearings and descenders before cropping to ink bounds.
    mask = Image.new('L', (cell * 4, cell * 4))
    origin = cell * 2
    ImageDraw.Draw(mask).text((origin, origin + baseline), character,
                              font=font, fill=255, anchor='ls')
    bounds = mask.getbbox()
    if bounds is None:
        raise ValueError(f'字符没有可见字形：{character!r}')
    return mask.crop(bounds), bounds[0] - origin, bounds[1] - origin


def prepare(folder, key, row, characters, font_directory):
    added = ''.join(c for c in characters if c not in row['glyphs'])
    if not added:
        return None
    source = row['font_source']
    font_path = font_directory / source['file']
    if sha(font_path.read_bytes()) != source['sha256']:
        raise ValueError(f'字体源 SHA 不符：{font_path}')
    if row['rasterizer']['backend'] != 'freetype' or row['rasterizer']['layout'] != 'basic':
        raise ValueError(f'不支持现有字形后端：{key}')
    if features.version('freetype2') != row['rasterizer']['freetype']:
        raise ValueError(f'FreeType 版本与已有图集不符：{key}')
    path = RUNTIME / 'builtin/fonts' / folder / (key + '.png')
    old_bytes = path.read_bytes()
    if sha(old_bytes) != row['sha256']:
        raise ValueError(f'内置图集与定义 SHA 不符：{path}')
    old = Image.open(io.BytesIO(old_bytes)).convert('RGBA')
    if old.size != (row['atlas_width'], row['atlas_height']):
        raise ValueError(f'内置图集与定义尺寸不符：{key}')
    cell_x = reduce(gcd, (g['x'] for g in row['glyphs'].values()))
    cell_y = reduce(gcd, (g['y'] for g in row['glyphs'].values()))
    if not cell_x or not cell_y or old.width % cell_x or old.height % cell_y:
        raise ValueError(f'无法从现有坐标确定网格：{key}')
    font = ImageFont.truetype(str(font_path), row['height'], layout_engine=ImageFont.Layout.BASIC)
    # Verify the fixed font, line origin, and rasterizer against existing ink.
    samples = [c for c, g in row['glyphs'].items()
               if unicodedata.east_asian_width(c) in 'FW' and g['width']][:8]
    if not samples:
        raise ValueError(f'该 profile 没有可核对的宽字符：{key}')
    for character in samples:
        glyph = row['glyphs'][character]
        mask, left, top = rasterize(font, character, row['baseline'], max(cell_x, cell_y))
        previous = old.crop((glyph['x'], glyph['y'], glyph['x'] + glyph['width'],
                             glyph['y'] + glyph['height'])).getchannel('A')
        if (left, top, mask.size, mask.tobytes()) != (
                glyph['offset_x'], glyph['offset_y'], previous.size, previous.tobytes()):
            raise ValueError(f'旧字形核对失败：{key}/{character}')
    columns = old.width // cell_x
    rows = (len(added) + columns - 1) // columns
    atlas = Image.new('RGBA', (old.width, old.height + rows * cell_y))
    atlas.paste(old, (0, 0))
    new_row = deepcopy(row)
    missing_mask, _, _ = rasterize(font, '\U0010ffff', row['baseline'], max(cell_x, cell_y))
    extra = row['glyphs'][samples[0]]['advance'] - row['height']
    if extra not in (0, 1):
        raise ValueError(f'无法确定既有宽字符步进：{key}')
    for index, character in enumerate(added):
        mask, left, top = rasterize(font, character, row['baseline'], max(cell_x, cell_y))
        if mask.size == missing_mask.size and mask.tobytes() == missing_mask.tobytes():
            raise ValueError(f'固定字体缺字：{character}')
        if mask.width > cell_x or mask.height > cell_y:
            raise ValueError(f'新字形超出既有网格：{key}/{character}')
        x, y = index % columns * cell_x, old.height + index // columns * cell_y
        ink = Image.new('RGBA', mask.size, (255, 255, 255, 255))
        ink.putalpha(mask)
        atlas.paste(ink, (x, y))
        glyph = dict(x=x, y=y, width=mask.width, height=mask.height,
                     offset_x=left, offset_y=top, advance=row['height'] + extra)
        if unicodedata.east_asian_width(character) not in 'FW':
            glyph['char_width'] = round(font.getlength(character))
            glyph['advance'] = glyph['char_width'] + extra
        new_row['glyphs'][character] = glyph
    if atlas.crop((0, 0, old.width, old.height)).tobytes() != old.tobytes():
        raise ValueError(f'旧图集像素发生变化：{key}')
    if any(new_row['glyphs'][c] != glyph for c, glyph in row['glyphs'].items()):
        raise ValueError(f'旧字形坐标或指标发生变化：{key}')
    encoded = io.BytesIO()
    atlas.save(encoded, format='PNG')
    png = encoded.getvalue()
    new_row.update(sha256=sha(png), atlas_height=atlas.height)
    run = dict(characters=added, backend='freetype', pillow=Image.__version__,
        freetype=features.version('freetype2'), layout='basic',
        font_source_sha256=source['sha256'], old_image_sha256=row['sha256'],
        old_region=[0, 0, old.width, old.height], old_region_rgba_sha256=sha(old.tobytes()),
        old_pixels_unchanged=True, old_glyphs_unchanged=True, calibration_characters=''.join(samples))
    new_row.setdefault('appended_glyph_runs', []).append(run)
    return path, png, new_row, dict(profile=key, **run, new_image_sha256=sha(png))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', choices=['menu', 'dialogue', 'prologue'], required=True)
    parser.add_argument('--font-directory', type=Path, required=True,
                        help='Directory containing the exact font_source filenames and bytes.')
    parser.add_argument('--keys', required=True, help='Comma-separated explicit font profile keys.')
    parser.add_argument('--characters', required=True, help='Visible characters to append.')
    parser.add_argument('--evidence', required=True, help='New JSON filename inside runtime/evidence.')
    args = parser.parse_args()
    characters = ''.join(dict.fromkeys(args.characters))
    if any(not c.isprintable() or c.isspace() for c in characters):
        parser.error('Only visible printable characters are supported.')
    evidence = RUNTIME / 'evidence' / args.evidence
    if evidence.parent.resolve() != (RUNTIME / 'evidence').resolve() or evidence.exists():
        parser.error('--evidence must be a new filename inside runtime/evidence')
    manifest = RUNTIME / 'web/data' / (args.manifest + '_fonts.json')
    document = json.loads(manifest.read_text('utf-8'))
    keys = list(dict.fromkeys(args.keys.split(',')))
    staged = [value for key in keys if (value := prepare(
        args.manifest, key, document['fonts'][key], characters, args.font_directory))]
    for path, png, row, report in staged:
        write_bytes(path, png)
        document['fonts'][report['profile']] = row
    if staged and args.manifest == 'menu':
        recipe_path = Path(__file__).with_name('menu_font_recipe.json')
        recipe = json.loads(recipe_path.read_text('utf-8'))
        text_keys = [row['key'] for row in recipe['fonts'] if row['kind'] == 'text']
        covered = ''.join(c for c in characters
                          if all(c in document['fonts'][key]['glyphs'] for key in text_keys))
        charset = document['text_charset']
        charset['characters'] += ''.join(c for c in covered if c not in charset['characters'])
        charset.update(character_count=len(charset['characters']), sha256=sha(charset['characters'].encode()))
        recipe['text_characters'] += ''.join(c for c in covered if c not in recipe['text_characters'])
        write_json(recipe_path, recipe)
        document['export_recipe']['sha256'] = sha(recipe_path.read_bytes())
    write_json(manifest, document)
    report = dict(schema='seventh-seal-builtin-glyph-append', manifest=str(manifest.relative_to(RUNTIME)),
        profiles=[value[3] for value in staged], requested_characters=characters,
        old_pixels_unchanged=True, old_glyphs_unchanged=True,
        normal_build_uses_fixed_png_bytes=True)
    write_json(evidence, report)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
