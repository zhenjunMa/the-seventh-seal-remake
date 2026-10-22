"""Prepare a private game/DxWnd copy; never edit original inputs or profiles."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import shutil

ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT/'remake/observation/original_window_20261011'
DXWND = Path('D:/game/dqfy/window')
GAME = DEST/'game'
LAUNCHER = DEST/'dxwnd'
REPORT = ROOT/'remake/runtime/evidence/original_window_preparation_20261011.json'


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8*1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    assert DEST.resolve().is_relative_to((ROOT/'remake').resolve())
    assert not DEST.exists(), 'Refuse to overwrite an existing observation copy'
    files = []
    for folder, dirs, names in os.walk(ROOT):
        if Path(folder) == ROOT:
            dirs[:] = [d for d in dirs if d not in ['remake', 'save_analysis_20261010', '.git', '.codex', '.agents']]
        for name in names:
            path = Path(folder)/name
            if len(path.relative_to(ROOT).parts) == 1 and path.suffix.lower() not in ['.exe', '.dll', '.sav', '.dat', '.dgp', '.ico']:
                continue
            assert not path.is_symlink()
            files.append(path)
    required = sum(p.stat().st_size for p in files)
    assert shutil.disk_usage(ROOT).free > required+512*1024*1024
    GAME.mkdir(parents=True)
    rows = []
    for index, path in enumerate(files):
        relative = path.relative_to(ROOT)
        output = GAME/relative
        output.parent.mkdir(parents=True, exist_ok=True)
        expected = sha(path)
        shutil.copy2(path, output)
        assert sha(output) == expected, relative
        rows.append(dict(path=relative.as_posix(), bytes=path.stat().st_size, sha256=expected))
        if index % 1000 == 0:
            print(f'Copied and verified {index+1}/{len(files)} source files', flush=True)
    LAUNCHER.mkdir()
    launcher_rows = []
    selected = [DXWND/'英文版.exe', *DXWND.glob('*.dll'), DXWND/'tweaks.ini', DXWND/'dxwanim.bmp']
    for path in selected:
        output = LAUNCHER/('dxwnd.exe' if path.name == '英文版.exe' else path.name)
        shutil.copy2(path, output)
        expected = sha(path)
        assert sha(output) == expected
        launcher_rows.append(dict(source=str(path), output=output.relative_to(DEST).as_posix(), sha256=expected))
    original_ini = DXWND/'dxwnd.ini'
    ini = original_ini.read_text(encoding='utf-8-sig')
    lines = []
    for line in ini.splitlines():
        if line.startswith('path0='):
            line = 'path0='+str(GAME/'GAME.exe')
        elif line.startswith('startfolder0='):
            line = 'startfolder0='+str(GAME)
        elif '=' in line and line.split('=', 1)[0][-1:] == '1':
            # Keep this task's game only; do not include the unrelated second game.
            continue
        lines.append(line)
    (LAUNCHER/'dxwnd.ini').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    report = dict(schema='seventh-seal-original-window-preparation', version=1,
                  prepared_utc=datetime.now(timezone.utc).isoformat(), copy_root=str(DEST),
                  game_root=str(GAME), launcher_root=str(LAUNCHER), game_files=rows,
                  game_file_count=len(rows), game_bytes=required, launcher_files=launcher_rows,
                  original_launcher=dict(path=str(DXWND/'第七封印-窗口化启动.cmd'),
                                         sha256=sha(DXWND/'第七封印-窗口化启动.cmd')),
                  original_profile=dict(path=str(original_ini), sha256=sha(original_ini)),
                  isolated_profile_sha256=sha(LAUNCHER/'dxwnd.ini'),
                  command=dict(executable=str(LAUNCHER/'dxwnd.exe'), arguments=['/R:1'],
                               working_directory=str(LAUNCHER)),
                  source_unchanged=True, original_game_execution_observed=False,
                  limits=['Original profile is copied; only task0 target and working directory change.',
                          'No original executable, resource, save or launcher profile is edited.',
                          'This preparation alone does not establish successful game execution.'])
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(dict(files=len(rows), bytes=required, copy_root=str(DEST)), ensure_ascii=False))


if __name__ == '__main__':
    main()
