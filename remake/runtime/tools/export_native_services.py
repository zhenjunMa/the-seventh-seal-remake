"""Export original town-service MNU pixels and controls into a separate pack."""
from pathlib import Path
import hashlib
from io import BytesIO
import json
import struct
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from PIL import Image, ImageChops, ImageOps
from export_operation_menu import parse, decode_rows
from export_startup_menu import sprite
from incremental import save_png, write_json

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
NAMES = ('boss_main', 'boss_text_01', 'boss_text_02', 'boss_text_03',
         'boss_buy_01', 'boss_buy_02', 'boss_buy_03', 'boss_buy', 'boss_buy_03a')
STATUE_PACKS = ('WordDiscWord', 'WordDiscQ', 'WordDisc', 'WordDiscBack')
CASINO_PACKS = ('NumberDisc', 'NumberDiscNumber', 'LottoBack', 'LottoBall',
                'LottoButton', 'LottoDisc', 'LottoNumber', 'LottoPearl',
                'RotateBack', 'RotateBall', 'RotateButton', 'RotateDisc', 'RotateNumber',
                'SLottoBack', 'SLottoButton', 'SLottoDisc', 'SLottoNumber')
NAMED_PACK_COUNTS = dict(WordDiscWord=25, WordDiscBack=3, NumberDiscNumber=11,
    LottoBack=3, LottoPearl=25, RotateBack=6, RotateBall=66, RotateButton=4,
    RotateNumber=10, SLottoBack=5, SLottoButton=2, SLottoNumber=10)
INDEXED_PACK_COUNTS = dict(WordDiscQ=7, WordDisc=72, NumberDisc=30,
    LottoBall=42, LottoButton=8, LottoDisc=42, LottoNumber=10, RotateDisc=24, SLottoDisc=24)
CASINO_SOUND_TOKENS = {
    'random': ('sound/lotto/Random.wav', 'sound//lotto//Random.wav', 20712),
    'roll': ('sound/Lotto/roll.wav', 'sound//lotto//Roll.wav', 20744),
    'loss': ('sound/Lotto/loss.wav', 'sound//lotto//Loss.wav', 20772),
    'win': ('sound/Lotto/win.wav', 'sound//lotto//Win.wav', 20800),
    'click': ('sound/Lotto/click.wav', 'sound//lotto//Click.wav', 20828),
    'ballClick': ('sound/Lotto/ballclick.wav', 'sound//lotto//BallClick.wav', 20856),
    'roll2': ('sound/Lotto/roll2.wav', 'sound//lotto//Roll2.wav', 22088),
}
CODE_SOUND_TOKENS = {
    'roll': ('sound/NumberDisc/Roll.wav', 'sound//NumberDisc//Roll.wav', 21552),
    'rotateClick': ('sound/NumberDisc/RollClick.wav', 'sound//NumberDisc//RollClick.wav', 21588),
    'click': ('sound/NumberDisc/click.wav', 'sound//NumberDisc//Click.wav', 21628),
}
GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'
STATUE_CURSOR = dict(offset=92848, bytes=2220,
    payload_sha256='04dec0aaa8f3b0fda1cd31705eaf7e3031e29040b9c6cd53c763fcf536c60e73',
    resource_type='RT_CURSOR', resource_id=3, group_resource_id=135)
STATUE_SOUNDS = {
    'click': ('click.wav', 'Click.wav', 21424,
              '596fb866f8d83eba3183b481847bede427e5fad2d682e0db08e4e41ec946a1c7'),
    'rotate_step': ('RollClick.wav', 'RollClick.wav', 21384,
                    'c2c87893ccd91541394c12470d8630b7acd96da5232185d8de930463723c09d9'),
    'clue_toggle': ('Page.wav', 'Page.wav', 21352,
                    '463c992d862c3494066e710cc4ffa38962128e2a43b9ec8a85e1661c7d9d3fbc'),
    'rotate_hold': ('Roll.wav', 'Roll.wav', 21320,
                    '744c294607ca033e046697489fa354581001f6615f896683757d7618d4d62831'),
}
STATUE_SOUND_CALLS = {
    'click': (0x73d, [('load', 0x4d68fd, 'e8806c0500'),
                     ('play', 0x4dabb6, 'e88f2b0500'), ('stop_before_play', 0x4dab9f, 'e801290500')]),
    'rotate_step': (0x741, [('load', 0x4d6913, 'e86a6c0500'),
                           ('play', 0x4daf68, 'e8dd270500'), ('stop_before_play', 0x4daf51, 'e84f250500')]),
    'clue_toggle': (0x745, [('load', 0x4d6929, 'e8546c0500'),
                           ('play', 0x4daad1, 'e8742c0500'), ('stop_before_play', 0x4daaba, 'e8e6290500')]),
    'rotate_hold': (0x749, [('load', 0x4d693f, 'e83e6c0500'),
                           ('play', 0x4db438, 'e80d230500'), ('play_argument_99', 0x4db429, '6a63'),
                           ('stop_on_release', 0x4d9e91, 'e80f360500'), ('stop_on_cleanup', 0x4d7718, 'e8885d0500')]),
}
OUTPUT = RUNTIME / 'web/data/native_services.json'
REPORT = RUNTIME / 'evidence/ember_city_20261028/service_export.json'


def source_files():
    return tuple(f'SYSTEM/{name}{suffix}' for name in NAMES for suffix in ('.mnu', '.CAP')
                 if (ROOT / f'SYSTEM/{name}{suffix}').is_file()) + tuple(
                     f'Picture/{name}.pak' for name in STATUE_PACKS + CASINO_PACKS) + (
                         'Picture/NDBack.bmp', 'Picture/NoMoney.bmp', 'GAME.exe') + tuple(
                         f'sound/WordDisc/{row[0]}' for row in STATUE_SOUNDS.values()) + tuple(
                             row[0] for row in (*CASINO_SOUND_TOKENS.values(), *CODE_SOUND_TOKENS.values())
                             if (ROOT / row[0]).is_file())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pe_file_offset(raw, va, size):
    """Resolve a fixed native call VA through the original PE section table."""
    pe = struct.unpack_from('<I', raw, 0x3c)[0]
    if raw[:2] != b'MZ' or raw[pe:pe + 4] != b'PE\0\0':
        raise ValueError('Native sound source is not a PE executable')
    count, optional_bytes = struct.unpack_from('<H', raw, pe + 6)[0], struct.unpack_from('<H', raw, pe + 20)[0]
    optional = pe + 24
    if struct.unpack_from('<H', raw, optional)[0] != 0x10b:
        raise ValueError('Native sound source must be the original PE32 image')
    rva = va - struct.unpack_from('<I', raw, optional + 28)[0]
    for index in range(count):
        section = optional + optional_bytes + index * 40
        address, length, start = struct.unpack_from('<III', raw, section + 12)
        if address <= rva < rva + size <= address + length:
            offset = start + rva - address
            if offset + size <= len(raw):
                return offset
    raise ValueError(f'Native sound call is outside PE raw sections: {va:#x}')


def decode_pe_cursor(raw, source, width, height, hotspot):
    """Rebuild one CUR entry from its fixed PE RT_CURSOR payload."""
    offset, size = source['offset'], source['bytes']
    if raw[:2] != b'MZ' or len(raw) < 0x40:
        raise ValueError('Cursor source is not a PE executable')
    pe = struct.unpack_from('<I', raw, 0x3c)[0]
    if raw[pe:pe + 4] != b'PE\0\0' or not 0 <= offset < offset + size <= len(raw):
        raise ValueError('PE cursor payload is out of bounds')
    payload = raw[offset:offset + size]
    if hashlib.sha256(payload).hexdigest() != source['payload_sha256']:
        raise ValueError('PE cursor payload differs from the fixed source')
    if len(payload) < 44 or struct.unpack_from('<HH', payload) != (hotspot['x'], hotspot['y']):
        raise ValueError('PE cursor hotspot differs from the fixed source')
    if not (0 < width <= 256 and 0 < height <= 256 and
            0 <= hotspot['x'] < width and 0 <= hotspot['y'] < height):
        raise ValueError('Invalid cursor dimensions or hotspot')
    dib = payload[4:]
    if struct.unpack_from('<IiiHHI', dib) != (40, width, height * 2, 1, 8, 0):
        raise ValueError('PE cursor DIB geometry/encoding differs from the fixed source')
    header = struct.pack('<HHHBBBBHHII', 0, 2, 1, width % 256, height % 256,
                         0, 0, hotspot['x'], hotspot['y'], len(dib), 22)
    with Image.open(BytesIO(header + dib)) as opened:
        if opened.format != 'CUR' or opened.size != (width, height):
            raise ValueError('Decoded PE cursor geometry differs from the fixed source')
        return opened.convert('RGBA')


def statue_cursor(raw):
    source = dict(path='GAME.exe', sha256=GAME_SHA, **STATUE_CURSOR)
    hotspot = dict(x=2, y=1)
    image = decode_pe_cursor(raw, source, 32, 32, hotspot)
    path = RUNTIME / 'web/assets/native_services/statue/cursor.png'
    save_png(image, path)
    return dict(image=path.relative_to(RUNTIME / 'web').as_posix(), width=32, height=32,
                hotspot=hotspot, png_sha256=digest(path), source=source), path


def statue_sounds(raw):
    sounds = {}
    for action, (filename, token_name, offset, expected) in STATUE_SOUNDS.items():
        token = 'sound//Worddisc//' + token_name
        token_raw = token.encode('ascii') + b'\0'
        if raw[offset:offset + len(token_raw)] != token_raw:
            raise ValueError(f'WordDisc native sound token changed: {token}')
        source = f'sound/WordDisc/{filename}'
        if digest(ROOT / source) != expected:
            raise ValueError(f'WordDisc sound carrier changed: {source}')
        field, calls = STATUE_SOUND_CALLS[action]
        native_calls = []
        for purpose, va, raw_hex in calls:
            expected_call = bytes.fromhex(raw_hex)
            call_offset = pe_file_offset(raw, va, len(expected_call))
            if raw[call_offset:call_offset + len(expected_call)] != expected_call:
                raise ValueError(f'WordDisc native sound call changed: {purpose} at {va:#x}')
            native_calls.append(dict(purpose=purpose, va=hex(va), offset=call_offset,
                                     bytes=len(expected_call), raw_hex=raw_hex))
        sounds[action] = dict(clip=source,
            source=dict(path=source, sha256=expected),
            native_source=dict(path='GAME.exe', sha256=GAME_SHA, offset=offset,
                               bytes=len(token_raw), token=token, raw_hex=token_raw.hex(), calls=native_calls),
            native_sound_id_field=field, native_sound_ids_one_based=True,
            native_api=dict(load='0x52d582', play='0x52d74a', stop='0x52d4a5',
                            play_stop_index='stored sound ID minus one'),
            native_playback=dict(loop=action == 'rotate_hold', already_playing_does_not_restart=True,
                                 stop_before_each_play=action != 'rotate_hold'))
    return sounds


def casino_sounds(raw, code=False):
    result = {}
    for name, (source, token, offset) in (CODE_SOUND_TOKENS if code else CASINO_SOUND_TOKENS).items():
        token_raw = token.encode('ascii') + b'\0'
        if raw[offset:offset + len(token_raw)] != token_raw:
            raise ValueError(f'Casino sound token changed: {token}')
        present = (ROOT / source).is_file()
        result[name] = dict(clip=source if present else None, missing=not present,
            source=dict(path=source, **(dict(sha256=digest(ROOT / source)) if present else {})),
            native_source=dict(path='GAME.exe', sha256=GAME_SHA, offset=offset,
                               bytes=len(token_raw), token=token, raw_hex=token_raw.hex()))
    return result


def decode_image(raw, record):
    offset = record['source_offset'] + 20
    size, width, height = record['stream_bytes'], record['width'], record['height']
    image = decode_rows(raw[offset:offset + size], width, height)[0]
    if record['alpha_bytes']:
        alpha = Image.frombytes('L', (width, height), raw[offset + size * 2:offset + size * 2 + record['alpha_bytes']])
        image.putalpha(ImageChops.multiply(image.getchannel('A'), ImageOps.invert(alpha)))
    return image


def statue_carrier(name):
    """Decode the two shipped PAK variants without assigning textual symbols."""
    source = f'Picture/{name}.pak'
    raw = (ROOT / source).read_bytes()
    frames = []
    if name in NAMED_PACK_COUNTS:
        if len(raw) < 5 or raw[0] != 1:
            raise ValueError(f'{source}: named BMP header mismatch')
        count = struct.unpack_from('<I', raw, 1)[0]
        expected = NAMED_PACK_COUNTS[name]
        if count != expected or len(raw) < 5 + count * 72:
            raise ValueError(f'{source}: named BMP table mismatch')
        for index in range(count):
            offset, size = struct.unpack_from('<II', raw, 5 + index * 72)
            token = raw[13 + index * 72:77 + index * 72].split(b'\0')[0].decode('ascii')
            if offset < 5 + count * 72 or offset + size > len(raw) or raw[offset:offset + 2] != b'BM':
                raise ValueError(f'{source}: BMP frame {index} is out of bounds')
            with Image.open(BytesIO(raw[offset:offset + size])) as opened:
                image = opened.convert('RGBA')
            info = dict(source_name=token, source_offset=offset, source_bytes=size)
            if name == 'SLottoBack' and token.lower() == 'continue.bmp':
                info['transparent_color'] = 0
                pixels = image.load()
                for y in range(image.height):
                    for x in range(image.width):
                        if pixels[x, y][:3] == (0, 0, 0):
                            pixels[x, y] = (0, 0, 0, 0)
            frames.append((image, info))
    else:
        count, size = struct.unpack_from('<II', raw)
        expected = INDEXED_PACK_COUNTS[name]
        if count != expected:
            raise ValueError(f'{source}: indexed frame count mismatch')
        offsets = list(struct.unpack_from(f'<{count}I', raw, 8))
        start = 8 + count * 4
        if offsets[0] != 0 or offsets != sorted(set(offsets)) or len(raw) != start + size + count * 1536:
            raise ValueError(f'{source}: indexed frame table mismatch')
        palette = start + size
        blend = palette + count * 512
        for index, offset in enumerate(offsets):
            end = offsets[index + 1] if index + 1 < count else size
            if not offset < end <= size:
                raise ValueError(f'{source}: indexed frame {index} is out of bounds')
            image, info = sprite(raw[start + offset:start + end],
                                 raw[palette + index * 512:palette + (index + 1) * 512],
                                 raw[blend + index * 1024:blend + (index + 1) * 1024])
            frames.append((image, dict(info, source_offset=start + offset, source_bytes=end - offset,
                                       palette_offset=palette + index * 512,
                                       blend_palette_offset=blend + index * 1024)))
    result, outputs = [], []
    for index, (image, info) in enumerate(frames):
        path = RUNTIME / f'web/assets/native_services/{name.lower()}/frame_{index:03}.png'
        save_png(image, path)
        result.append(dict(info, id=index + 1 if name == 'WordDiscQ' else index,
                           image=path.relative_to(RUNTIME / 'web').as_posix(),
                           width=image.width, height=image.height, png_sha256=digest(path),
                           source=source, source_frame=index,
                           source_sha256=hashlib.sha256(raw).hexdigest()))
        outputs.append(path)
    return result, outputs


def casino_bitmap(name):
    source = f'Picture/{name}.bmp'
    with Image.open(ROOT / source) as opened:
        image = opened.convert('RGBA')
    path = RUNTIME / f'web/assets/native_services/{name.lower()}.png'
    save_png(image, path)
    return dict(image=path.relative_to(RUNTIME / 'web').as_posix(), width=image.width,
                height=image.height, png_sha256=digest(path), source=source,
                source_sha256=digest(ROOT / source)), path


def export():
    hashes = {name: digest(ROOT / name) for name in source_files()}
    if hashes['GAME.exe'] != GAME_SHA:
        raise ValueError('Native services require the exact verified executable')
    game_raw = (ROOT / 'GAME.exe').read_bytes()
    menus, outputs = [], []
    for name in NAMES:
        path = ROOT / f'SYSTEM/{name}.mnu'
        menu, raw = parse(path, export=False), path.read_bytes()
        target = RUNTIME / f'web/assets/native_services/{name}'
        replacements, decoded = {}, {}
        for record in menu['images']:
            image = decode_image(raw, record)
            output = target / f'image_{record["index"]:03}.png'
            save_png(image, output)
            old = record['image']
            record['image'] = output.relative_to(RUNTIME / 'web').as_posix()
            record['png_sha256'] = digest(output)
            record['rgb_image'] = record['alpha_image'] = None
            replacements[old], decoded[record['index']] = record['image'], image
            outputs.append(output)
        for widget in menu['widgets']:
            for state in ('normal_images', 'active_images', 'selected_images'):
                widget[state] = [replacements[value] for value in widget[state]]
        composed = decoded[0].copy()
        for widget in menu['widgets'][1:]:
            if widget['normal_images']:
                group = menu['groups'][widget['bitmap_indices_raw'][0] - 1]
                point = widget['draw_point_raw']
                composed.alpha_composite(decoded[group['images'][0]], (point['x'], point['y']))
        composed_path = target / 'composed.png'
        save_png(composed, composed_path)
        menu['composed'] = composed_path.relative_to(RUNTIME / 'web').as_posix()
        outputs.append(composed_path)
        sensor_path = target / 'sensor.png'
        sensor = menu['sensor']
        save_png(Image.frombytes('L', (menu['width'], menu['height']), raw[sensor['source_offset']:sensor['source_offset'] + sensor['bytes']]), sensor_path)
        menu['sensor']['image'] = sensor_path.relative_to(RUNTIME / 'web').as_posix()
        outputs.append(sensor_path)
        menus.append(menu)
    statue = {}
    for field, name in [('symbols', 'WordDiscWord'), ('questions', 'WordDiscQ'),
                        ('disc', 'WordDisc'), ('backgrounds', 'WordDiscBack')]:
        statue[field], generated = statue_carrier(name)
        outputs.extend(generated)
    statue['sequence_length'] = 6
    statue['blank_symbol_id'] = 24
    statue['symbol_encoding'] = 'Original image indices 0..23; no Unicode mapping is inferred.'
    statue['cursor'], cursor_output = statue_cursor(game_raw)
    outputs.append(cursor_output)
    statue['sounds'] = statue_sounds(game_raw)
    casino = {}
    for mode, fields in {
        'code': [('disc', 'NumberDisc'), ('numbers', 'NumberDiscNumber')],
        'lotto': [('backgrounds', 'LottoBack'), ('buttons', 'LottoButton'), ('numbers', 'LottoNumber'),
                  ('balls', 'LottoBall'), ('disc', 'LottoDisc'), ('rewards', 'LottoPearl')],
        'roulette': [('backgrounds', 'RotateBack'), ('buttons', 'RotateButton'),
                     ('numbers', 'RotateNumber'), ('balls', 'RotateBall'), ('disc', 'RotateDisc')],
        'smallLotto': [('backgrounds', 'SLottoBack'), ('buttons', 'SLottoButton'),
                       ('digits', 'SLottoNumber'), ('disc', 'SLottoDisc')],
    }.items():
        casino[mode] = dict(cursor=statue['cursor'])
        casino[mode]['sounds'] = casino_sounds(game_raw, code=mode == 'code')
        for field, pack in fields:
            casino[mode][field], generated = statue_carrier(pack)
            outputs.extend(generated)
    casino['code']['background'], generated = casino_bitmap('NDBack')
    outputs.append(generated)
    no_money, generated = casino_bitmap('NoMoney')
    outputs.append(generated)
    for mode in ('lotto', 'roulette', 'smallLotto'):
        casino[mode]['noMoney'] = no_money
    manifest = dict(schema='seventh-seal-native-services', version=1,
                    canvas=dict(width=640, height=480), menus=menus, source_hashes=hashes,
                    special=dict(statue=statue, **casino),
                    origins=dict(header=dict(x=0, y=0), listing=dict(x=10, y=50)),
                    layout_evidence=['economy_4360e0.json: FUN_0055ecf0(DAT_02b92f04,10,0x32)',
                                     'economy_437af0.json: FUN_0055ecf0(DAT_02b92f08,10,0x32)',
                                     'economy_438a30.json: FUN_0055ecf0(DAT_02b92f0c,10,0x32)'],
                    limits=['Original MNU pixels and widget rectangles; runtime text, state and transactions are supplied by the service controller.',
                            'No original game execution is claimed by this export.'])
    write_json(OUTPUT, manifest)
    outputs.append(OUTPUT)
    unchanged = hashes == {name: digest(ROOT / name) for name in hashes}
    report = dict(schema='seventh-seal-native-services-export', version=1, passed=unchanged,
                  source_bytes_unchanged=unchanged, source_hashes=hashes,
                  output_hashes={path.relative_to(ROOT).as_posix(): digest(path) for path in outputs},
                  menus=len(menus), images=sum(len(menu['images']) for menu in menus),
                  special_images=sum(len(statue[field]) for field in ('symbols', 'questions', 'disc', 'backgrounds')),
                  limits=manifest['limits'])
    write_json(REPORT, report)
    assert unchanged, 'Original service sources changed during export'
    print(json.dumps(dict(passed=True, menus=len(menus), images=report['images'], special_images=report['special_images'])))


if __name__ == '__main__':
    export()
