"""按现有位图字库的全部字符和原版字体参数生成独立 Windows GDI 字库。"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_menu_font_gdi as gdi
from incremental import write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original-dir', type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'win32':
        parser.error('生成需要 Windows；生成后的 PNG 可跨平台使用')
    original = args.original_dir / 'GAME.exe'
    original_sha = hashlib.sha256(original.read_bytes()).hexdigest()
    runtime = Path(__file__).resolve().parents[1]
    summary = {}
    for group in ('menu', 'dialogue', 'prologue'):
        source = runtime / 'web/data' / (group + '_fonts.json')
        raw = source.read_bytes()
        noto = json.loads(raw)
        gdi.OUT = runtime / 'web/assets/fonts/windows' / group
        gdi.MANIFEST = runtime / 'web/data' / (group + '_fonts_windows.json')
        for index, (key, profile) in enumerate(noto['fonts'].items()):
            extra = 0 if group != 'menu' and key != 'map_name18' else 1
            gdi.export([(key, profile['face_requested'], profile['height'])],
                       charset=''.join(profile['glyphs']), preserve=index > 0,
                       cell_width=40, cell_height=40, columns=32, character_extra=extra)
        document = json.loads(gdi.MANIFEST.read_text(encoding='utf-8'))
        document.update(font_set='windows', original_executable_sha256=original_sha,
                        character_source={'path': source.relative_to(runtime).as_posix(),
                                          'sha256': hashlib.sha256(raw).hexdigest()},
                        native_procedure='0x5358c4' if group == 'menu' else '0x466450')
        if group != 'menu':
            document['native_evidence_id'] = 'ev_5a71b46ca5199b02cf3a94ce5e5813a9a8647ec44453f5de9fe51b21c877610e'
            document['parameters']['shadow_offsets'] = [[1, 1]]
        document['parameters']['character_extra'] = 'Per-profile character_extra'
        for key, profile in document['fonts'].items():
            profile['character_extra'] = 0 if group != 'menu' and key != 'map_name18' else 1
            destination = runtime / 'builtin/fonts/windows' / group / (key + '.png')
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(runtime / 'web' / profile['image'], destination)
        write_json(gdi.MANIFEST, document)
        summary[group] = {'profiles': len(document['fonts']),
                          'characters': len(set().union(*(set(p['glyphs']) for p in document['fonts'].values()))),
                          'resolved_faces': sorted({(p['face_requested'], p['face_resolved'])
                                                    for p in document['fonts'].values()})}
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
