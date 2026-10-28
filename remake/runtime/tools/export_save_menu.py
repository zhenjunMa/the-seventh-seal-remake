"""Export the original three MNU save pages without changing original saves."""
from pathlib import Path
import hashlib
import json
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from incremental import write_json as incremental_json
from export_operation_menu import parse

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
NAMES = ('game_save_01', 'game_save_02', 'game_save_03')


def main():
    inputs = [ROOT / 'GAME.exe'] + [ROOT / 'SYSTEM' / (name + suffix)
              for name in NAMES for suffix in ('.mnu', '.CAP')]
    hashes = {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    menus = [parse((ROOT / 'SYSTEM' / (name + '.mnu')).resolve()) for name in NAMES]
    assert all(menu['eof_verified'] for menu in menus)
    manifest = dict(schema='seventh-seal-save-menu', version=1, slot_count=20,
                    canvas=dict(width=640, height=480), menus=menus,
                    native_handlers=dict(open='0x4794e0', key='0x479920', slot_writer='0x479610'),
                    source_hashes=hashes,
                    limits=['Static MNU pixels and hit rectangles; original game execution not observed.',
                            'Remake files use two-digit JSON slot names; native filename template is SaveGame%d.Dat.'])
    output = RUNTIME / 'web/data/save_menu.json'
    incremental_json(output, manifest)
    outputs = [output] + [p for name in NAMES for p in (RUNTIME / 'web/assets/menu' / name).rglob('*') if p.is_file()]
    unchanged = hashes == {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    report = dict(passed=unchanged, source_hashes=hashes,
                  output_hashes={p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in outputs},
                  menus=len(menus), limits=manifest['limits'])
    destination = RUNTIME / 'evidence/save_slots_20261023/resource_export.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    incremental_json(destination, report)
    assert unchanged
    print(json.dumps(dict(passed=True, menus=len(menus), images=sum(len(m['images']) for m in menus))))


if __name__ == '__main__':
    main()
