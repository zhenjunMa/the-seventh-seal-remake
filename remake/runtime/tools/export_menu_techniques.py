"""Supplement the frozen operation_menu manifest with source technique resources."""
from pathlib import Path
import hashlib
import json
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from incremental import write_json as incremental_json, recipe_hash, cached_png
from export_operation_menu import ROOT, RUNTIME, OUT, parse, DGP


def main():
    sources = [ROOT / 'SYSTEM/game002d.mnu', ROOT / 'SYSTEM/game002e.mnu', ROOT / 'SYSTEM/game004.mnu']
    before = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}
    result = dict(version=1, native_canvas=[640, 480],
        evidence_type='source-resource-and-native-static',
        menus=[parse(path) for path in sources],
        origins=dict(header=dict(x=-6,y=-10), use=dict(x=20,y=145),
            composition_board=dict(x=8,y=43), actions=dict(x=350,y=35),
            categories=dict(x=20,y=170), shortcuts=dict(x=350,y=40)),
        native_functions=['0x44E550','0x450BE0','0x44E3B0','0x44E9B0','0x44F3B0','0x42A910'],
        icons={})
    charset = json.loads((RUNTIME / 'evidence/menu_technique_name_charset_20261013.json').read_text(encoding='utf-8'))
    executable = ROOT / 'GAME.exe'
    before[str(executable)] = hashlib.sha256(executable.read_bytes()).hexdigest()
    if before[str(executable)] != charset['subject']['digest']['sha256']:
        raise ValueError('Name charset evidence does not match original executable')
    chars = bytes.fromhex(charset['normalized_result']['bytes_hex'])
    result['name_charset'] = dict(evidence_id=charset['evidence_id'], source_sha256=charset['subject']['digest']['sha256'],
        address='0x673c84', code_base=1, maximum_length=8,
        characters=[chars[i:i+2].decode('cp936') for i in range(0,len(chars),2)])
    for name in ['char_ball', 'magic_ball1', 'magic_ball1_num', 'magic_ball1_attr',
                 'name_ball', 'name_text', 'name_cursor', 'name_mark',
                 'other_ball', 'board_bright', 'board_brightB', 'use_ball', 'use_ball_num']:
        source = ROOT / f'Fight_Role/combo/{name}.dgp'
        before[str(source)] = hashlib.sha256(source.read_bytes()).hexdigest()
        bank = DGP(source)
        target = OUT / 'techniques' / name
        target.mkdir(parents=True, exist_ok=True)
        frames = []
        for i in range(bank.frame_count):
            dest = target / f'frame_{i:03}.png'
            cached_png(RUNTIME, dest, bank.sha256, {'frame':i}, recipe_hash([Path(__file__),Path(__file__).parent/'source/dgp.py']), lambda: bank.decode(i))
            frames.append(dest.relative_to(RUNTIME / 'web').as_posix())
        result['icons'][name] = dict(source=source.relative_to(ROOT).as_posix(),
            sha256=bank.sha256, width=bank.width, height=bank.height,
            anchor=bank.anchor_raw, frames=frames, actions=bank.actions,
            secondary_verification=bank.verify_secondary())
        print(f'{name}: {bank.width}x{bank.height}, {bank.frame_count} frames')
    after = {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in before}
    if before != after:
        raise ValueError('Original input changed during export')
    result['original_inputs_unchanged'] = True
    data = RUNTIME / 'web/data/operation_techniques.json'
    incremental_json(data, result)
    evidence = RUNTIME / 'evidence/menu_technique_export_20261013.json'
    output_files=[data,*[p for directory in [OUT/'techniques',OUT/'game002d',OUT/'game002e',OUT/'game004'] for p in directory.rglob('*') if p.is_file()]]
    incremental_json(evidence, dict(input_sha256=before, original_inputs_unchanged=True,
        source_hashes={Path(path).relative_to(ROOT).as_posix():value for path,value in before.items()},
        output_hashes={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in output_files},
        manifest='web/data/operation_techniques.json',
        manifest_sha256=hashlib.sha256(data.read_bytes()).hexdigest(),
        limitations=['No original files are edited.', 'Source sprites do not establish battle handlers.']))


if __name__ == '__main__':
    main()
