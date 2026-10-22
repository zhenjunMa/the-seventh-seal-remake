"""Verify retained save-list observations without running the browser."""
from pathlib import Path
from datetime import datetime, timezone
from io import BytesIO
import base64
import hashlib
import json
from PIL import Image

RUNTIME=Path(__file__).resolve().parents[1]
ROOT=RUNTIME.parents[1]
FOLDER=RUNTIME/'evidence/startup_save_preview_20261020'
def read(path): return json.loads(path.read_text('utf-8-sig'))
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    observation=read(FOLDER/'browser_observation.json')
    assert read(FOLDER/'storage_before.json')==read(FOLDER/'storage_after.json')
    assert observation['legacy']['textColor']=='rgb(255, 255, 255)'
    assert observation['legacy']['preview']=='reconstructed'
    assert observation['legacy']['scene']=='神殿大门' and observation['legacy']['phase']=='等待开始'
    assert observation['stored']['textColor']=='rgb(255, 255, 255)' and observation['stored']['preview']=='stored'
    assert observation['cancel_and_reenter'] and observation['stored_reload_load_succeeded']
    assert not observation['console_errors']
    envelope=read(FOLDER/'new_save_with_preview.json')
    assert hashlib.sha256(envelope['payload'].encode()).hexdigest()==envelope['sha256']
    preview=envelope['preview']
    assert preview['payload_sha256']==envelope['sha256'] and (preview['width'],preview['height'])==(104,76)
    picture=Image.open(BytesIO(base64.b64decode(preview['png'].split(',')[1])))
    assert picture.size==(104,76) and len(picture.convert('RGB').getcolors(104*76))>100
    oldlog=read(FOLDER/'legacy_preview_log.json')
    assert oldlog['world']['location']['map_id']=='M72061'
    assert any(e['type']=='save-preview-ready' and e['source']=='reconstructed' and e['map_id']=='M01030' for e in oldlog['events'])
    newlog=read(FOLDER/'stored_preview_log.json')
    assert any(e['type']=='save-preview-ready' and e['source']=='stored' and e['map_id']=='M01030' for e in newlog['events'])
    native=read(FOLDER/'native_evidence.json')
    procedures={r['parameters']['procedure']:r['normalized_result'] for r in native['records']}
    assert '0xffffff' in procedures['0x479d70']
    assert '0x68' in procedures['0x478410'] and '0x4c' in procedures['0x478410']
    original=read(RUNTIME/'evidence/startup_menu_export_20261020.json')['source_hashes']
    assert sha(ROOT/'GAME.exe')==original['GAME.exe']
    names=['web/startup_view.mjs','web/startup.css','web/map_scene_view.mjs','web/core/save_preview.mjs',
        'web/controllers/map.mjs','web/controllers/services.mjs','web/controllers/boot.mjs',
        'tests/test_startup.mjs','tests/test_save_preview.mjs','tools/verify_save_preview.py']
    fingerprints={(RUNTIME/n).relative_to(ROOT).as_posix():sha(RUNTIME/n) for n in names}
    report=dict(schema='seventh-seal-save-preview-browser-validation',version=1,passed=True,
        checked_utc=datetime.now(timezone.utc).isoformat(),
        scope='Save-list white body text, native thumbnail rectangle, read-only reconstruction for a legacy browser save, actual scene export, isolated 8768 save/reload/stored-image display/load, and 8767 saved progress/preferences preserved. No original game execution or native save edits. Earlier full-startup observations remain frozen.',
        checks=dict(white_body_text=True,native_thumbnail_rect=[17,97,104,76],legacy_preview_no_scene_commit=True,
            stored_preview_and_payload_bound=True,export_import_and_isolated_save_reload=True,original_browser_storage_unchanged=True,console_errors=[]),
        observation_path=(FOLDER/'browser_observation.json').relative_to(ROOT).as_posix(),observation_sha256=sha(FOLDER/'browser_observation.json'),
        current_fingerprints=fingerprints,evidence_fingerprints={p.relative_to(ROOT).as_posix():sha(p) for p in FOLDER.iterdir() if p.is_file()},
        limitations=['Legacy saves did not contain screenshots: their preview reconstructs saved scene/position/state; historic camera/animation cannot be recovered.',
            'PNG capture shares the current remake scene renderer; original RGB565 sampling and exact native metadata font remain outside this correction.'])
    target=RUNTIME/'evidence/startup_save_preview_browser_validation_20261020.json'
    target.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n','utf-8')
    print(json.dumps(dict(passed=True,preview_size=picture.size,original_browser_storage_unchanged=True,report=str(target)),ensure_ascii=False))

if __name__=='__main__':main()
