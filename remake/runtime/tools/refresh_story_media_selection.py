"""Refresh ANM media callers against already verified fixed media carriers.

New present carriers require the full media exporter. Explicitly absent sound
operands remain declared and silent; missing videos are always rejected by
the shared source discovery routine.
"""
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_story_media import discover
from export_maps import GAME_SHA
from incremental import write_json

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def refresh():
    if digest(ROOT / 'GAME.exe') != GAME_SHA:
        raise ValueError('Story media refresh requires the exact verified executable')
    output = WEB / 'data/story_media.json'
    previous = json.loads(output.read_text('utf-8'))
    media_manifest_path = WEB / 'assets/media_manifest.json'
    media_manifest = json.loads(media_manifest_path.read_text('utf-8')) if media_manifest_path.is_file() else {}
    selection = discover()
    sources = {'GAME.exe': GAME_SHA}
    reused, current_carriers = [], {}
    for kind in ['videos', 'sounds']:
        result = {}
        for name, selected in selection[kind].items():
            old = previous[kind].get(name)
            source = ROOT / selected['source_path']
            if not old or old['source']['sha256'] != digest(source):
                raise ValueError(f'New or changed story carrier needs full export/verification: {selected["source_path"]}')
            actual = digest(WEB / old['path'].lstrip('/'))
            if actual != old['sha256']:
                # First-install media exports record their actual encoder
                # output independently of the fixed historical MP4 digest.
                # Keep the historical descriptor bytes and require the exact
                # current source/output binding from that completed export.
                if (not media_manifest.get('complete')
                        or media_manifest.get('files', {}).get(old['path']) != actual
                        or media_manifest.get('sources', {}).get(selected['source_path']) != old['source']['sha256']):
                    raise ValueError(f'Fixed story carrier output changed without a verified media export: {old["path"]}')
            current_carriers[old['path']] = actual
            result[name] = {**old, 'referenced_by': selected['referenced_by']}
            sources[selected['source_path']] = old['source']['sha256']
            reused.append(old['path'])
        previous[kind] = result
    for row in selection['programs']:
        sources[row['source']['path']] = row['source']['sha256']
    previous['missing_sounds'] = selection['missing_sounds']
    previous['authority'] = 'Source ANM caller refresh; fixed verified carriers retained without re-encoding.'
    if any(digest(ROOT / name) != expected for name, expected in sources.items()):
        raise ValueError('Story media input changed during refresh')
    write_json(output, previous)
    report = dict(schema='seventh-seal-story-media-selection-refresh', version=1, passed=True,
        source_hashes=sources, selection=selection, reused_carriers=reused,
        current_media_carrier_hashes=current_carriers,
        missing_original_files=[row['source_path'] for row in selection['missing_sounds'].values()],
        output_sha256=digest(output), source_bytes_unchanged=True, original_game_executed=False,
        limitations=['Earlier full frame/PCM verification references are retained; this refresh checks current source/output hashes.',
                     'Explicitly absent original sounds are silent; no similar filename is substituted.'])
    write_json(RUNTIME / 'evidence/story_media_selection_refresh.json', report)
    print(json.dumps(dict(passed=True, reused_carriers=len(reused), missing_original_files=report['missing_original_files'])))


if __name__ == '__main__':
    refresh()
