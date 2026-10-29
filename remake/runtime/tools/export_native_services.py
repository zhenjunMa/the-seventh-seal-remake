"""Export original town-service MNU pixels and controls into a separate pack."""
from pathlib import Path
import hashlib
import json
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from PIL import Image, ImageChops, ImageOps
from export_operation_menu import parse, decode_rows
from incremental import save_png, write_json

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
NAMES = ('boss_main', 'boss_text_01', 'boss_text_02', 'boss_text_03',
         'boss_buy_01', 'boss_buy_02', 'boss_buy_03', 'boss_buy', 'boss_buy_03a')
OUTPUT = RUNTIME / 'web/data/native_services.json'
REPORT = RUNTIME / 'evidence/ember_city_20261028/service_export.json'


def source_files():
    return tuple(f'SYSTEM/{name}{suffix}' for name in NAMES for suffix in ('.mnu', '.CAP')
                 if (ROOT / f'SYSTEM/{name}{suffix}').is_file())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def decode_image(raw, record):
    offset = record['source_offset'] + 20
    size, width, height = record['stream_bytes'], record['width'], record['height']
    image = decode_rows(raw[offset:offset + size], width, height)[0]
    if record['alpha_bytes']:
        alpha = Image.frombytes('L', (width, height), raw[offset + size * 2:offset + size * 2 + record['alpha_bytes']])
        image.putalpha(ImageChops.multiply(image.getchannel('A'), ImageOps.invert(alpha)))
    return image


def export():
    hashes = {name: digest(ROOT / name) for name in source_files()}
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
    manifest = dict(schema='seventh-seal-native-services', version=1,
                    canvas=dict(width=640, height=480), menus=menus, source_hashes=hashes,
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
                  menus=len(menus), images=sum(len(menu['images']) for menu in menus), limits=manifest['limits'])
    write_json(REPORT, report)
    assert unchanged, 'Original service sources changed during export'
    print(json.dumps(dict(passed=True, menus=len(menus), images=report['images'])))


if __name__ == '__main__':
    export()
