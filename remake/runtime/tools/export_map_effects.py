"""Export the same-frame indexed light channel used by native map drawing.

Original DAT/DGP/EXE inputs are read-only. Main and indexed pixels are checked
against the independent sparse decoder before atlas assembly.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
sys.path.insert(0, str(ROOT / "remake/runtime/tools"))
from source.dgp import DGP
from source.map_objects import MapObjects
from export_combat_presentation import indexed_contribution, native_frame_sequence, NATIVE_IDS
from export_skill_layers import SourceAudit
from PIL import Image


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def export():
    sources = {'GAME.exe': sha(ROOT / 'GAME.exe')}
    outputs, checks, banks = {}, [], {}
    native_records = []
    wanted = {NATIVE_IDS['indexed_draw'], NATIVE_IDS['pixel_format'],
              'ev_02ca024fc6f9093e9bd38f06052ee2a4f2b2671240c4df2293cf1a50c4e2ae02',
              'ev_7ff7092a0522a10920b1c81430af56c62cb116c3d66a5af86a35ecb5e9498a5c'}
    for file in ['remake/runtime/evidence/source/combat_presentation_indexed_native_20261011.json',
                 'remake/runtime/evidence/source/map_layers_native_new.json',
                 'remake/runtime/evidence/chapter_native.json']:
        for row in json.loads((ROOT / file).read_text(encoding='utf-8'))['records']:
            if row['evidence_id'] in wanted:
                native_records.append(row)
    assert {row['evidence_id'] for row in native_records} == wanted
    assert all(row['subject']['digest']['sha256'] == sources['GAME.exe'] for row in native_records)

    def bank(source, key, include_main):
        if key in banks:
            return banks[key]
        dgp = DGP(ROOT / source)
        sources[source] = dgp.sha256
        if not any(row['active_raw'] for row in dgp.indexed_auxiliary):
            return None
        audit = SourceAudit(dgp.data)
        actions = []
        for action in dgp.actions:
            n, dirs = action['frames_per_direction'], action['directions']
            physicals = [action['first_frame'] + direction * n + frame
                         for direction in range(dirs) for frame in range(n)]
            if not include_main and not any(dgp.indexed_auxiliary[f]['active_raw'] for f in physicals):
                continue
            main = Image.new('RGBA', (dgp.width * n, dgp.height * dirs)) if include_main else None
            light = Image.new('RGBA', (dgp.width * n, dgp.height * dirs))
            for direction in range(dirs):
                for frame in range(n):
                    physical = action['first_frame'] + direction * n + frame
                    intrinsic, stats = indexed_contribution(dgp, physical)
                    pixels, checked = audit.sparse(physical, True)
                    assert intrinsic.tobytes() == pixels
                    check = dict(source=source, action=action['index'], frame=physical, intrinsic=checked)
                    light.paste(intrinsic, (frame * dgp.width, direction * dgp.height))
                    if main is not None:
                        image = dgp.decode(physical)
                        main_pixels, main_check = audit.sparse(physical, False)
                        assert image.tobytes() == main_pixels
                        main.paste(image, (frame * dgp.width, direction * dgp.height))
                        check['main'] = main_check
                    checks.append(check)
            item = dict(index=action['index'], frame_count=n, directions=dirs,
                        interval_raw=action['interval_raw'], first_frame=action['first_frame'],
                        logical_frames=native_frame_sequence(dgp.raw_actions[action['index']], 0,
                            struct.unpack_from('<I', dgp.raw_actions[action['index']], 0x12)[0]
                            if dgp.raw_actions[action['index']][0x0d] & 15 == 0 else n, 0))
            for channel, atlas in [('main', main), ('intrinsic', light)]:
                if atlas is None:
                    continue
                out = WEB / f'assets/map_effects/{key}/action_{action["index"]:02}_{channel}.png'
                out.parent.mkdir(parents=True, exist_ok=True)
                atlas.save(out)
                assert Image.open(out).convert('RGBA').tobytes() == atlas.tobytes()
                item[channel + '_sheet'] = '/' + out.relative_to(WEB).as_posix()
                outputs[item[channel + '_sheet']] = sha(out)
            actions.append(item)
        result = dict(source=dict(path=source, sha256=dgp.sha256), frame_width=dgp.width,
                      frame_height=dgp.height, actions=actions)
        banks[key] = result
        return result

    roles = {}
    role_ids = set()
    for file in ['opening_map_resources.json', 'chapter_map_resources.json']:
        role_ids.update(json.loads((WEB / 'data' / file).read_text(encoding='utf-8'))['roles'])
    for ident in sorted(role_ids):
        value = bank(f'ROLE/{ident}.dgp', f'role_{ident}', False)
        if value:
            roles[ident] = value
    maps = {}
    for file in sorted((WEB / 'data/maps').glob('*.json')):
        current = json.loads(file.read_text(encoding='utf-8'))
        objects = []
        table = None
        for obj in current.get('objects', []):
            value = bank(obj['source'], current['id'].lower() + '_' + Path(obj['source']).stem, True)
            if not value:
                continue
            if table is None:
                source = current['source']['path']
                sources[source] = sha(ROOT / source)
                table = MapObjects(ROOT / source)
            raw = bytes.fromhex(table.objects[obj['index']]['raw_hex'])
            objects.append(dict(index=obj['index'], bank=current['id'].lower() + '_' + Path(obj['source']).stem,
                behavior_raw_cf=raw[0xcf], source_record_offset=table.objects[obj['index']]['offset'],
                initial_frame_raw=struct.unpack_from('<I', raw, 0x3c)[0]))
        if objects:
            maps[current['id']] = dict(map_flag_index=struct.unpack_from('<I', table.data, 0x92)[0], objects=objects)
    object_banks = {key: value for key, value in banks.items() if not key.startswith('role_')}
    manifest = WEB / 'data/map_effects.json'
    write(manifest, dict(schema='seventh-seal-map-effects', version=1, roles=roles, maps=maps,
        object_banks=object_banks, blend='lighter', evidence=sorted(wanted),
        limits=['Canvas additive RGB is an 8-bit presentation adaptation of native RGB565/555.',
                'No original executable execution or pixel/time-identical comparison is claimed.']))
    outputs['/' + manifest.relative_to(WEB).as_posix()] = sha(manifest)
    assert all(sha(ROOT / source) == expected for source, expected in sources.items())
    folder = RUNTIME / 'evidence/map_effects_20261021'
    write(folder / 'native_retained.json', dict(authority='Retained native static evidence', records=native_records))
    write(folder / 'export.json', dict(passed=True, source_bytes_unchanged=True, source_hashes=sources,
        output_hashes=outputs, roles=list(roles), maps=maps, frame_checks=checks,
        original_game_execution_observed=False))
    # Keep the same source-frame shadow channel when the registered map
    # presentation assets are rebuilt. This helper never rewrites main/light.
    from export_map_shadows import export as export_shadows
    export_shadows()
    print(json.dumps(dict(passed=True, roles=list(roles), maps=list(maps), checked_frames=len(checks), outputs=len(outputs))))


if __name__ == '__main__':
    export()
