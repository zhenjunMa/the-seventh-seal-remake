"""Export source map animation and its same-frame indexed light channel.

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
from source.dgp import DGP, DGPError
from source.map_objects import MapObjects
from export_combat_presentation import indexed_contribution, native_frame_sequence, NATIVE_IDS
from export_skill_layers import SourceAudit
from PIL import Image


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def validate_cf1_action(dgp):
    """The recovered 410850/4137C0 single-action ordinary-object contract."""
    if len(dgp.raw_actions) != 1:
        raise DGPError('CF1 map animation requires exactly one source action')
    raw = dgp.raw_actions[0]
    count = struct.unpack_from('<I', raw, 0x0e)[0]
    first = struct.unpack_from('<I', raw, 0x72)[0]
    interval = struct.unpack_from('<I', raw, 1)[0]
    if raw[0] != 0 or raw[0x0d] not in (0, 1) or not 0 < count <= 255 or first != 0 or count > dgp.frame_count:
        raise DGPError('CF1 map action direction/sequence mode is not recovered')
    logical_count = struct.unpack_from('<I', raw, 0x12)[0] if raw[0x0d] == 0 else count
    if not logical_count:
        raise DGPError('CF1 map action requires a nonempty native logical sequence')
    # 410850 uses this logical count for FF's initial modulo. 4137C0 wraps
    # +22 at that count, then resolves explicit mode0 through action+16.
    # Atlas columns remain physical frames; repeated sequence entries are not
    # expanded into duplicate pixels or mistaken for extra physical frames.
    native_frame_sequence(raw, 0, logical_count, 0)
    if interval == 1 or interval > 0x7fffffff:
        raise DGPError('CF1 source clock cannot be sampled safely')
    if any(raw[0x56:0x6a]) or raw[0x84]:
        raise DGPError('CF1 source sound/drawing effect is not recovered')
    # Some intrinsic-only light resources retain one empty shadow row per
    # geometry line. Parse every mask strictly; absent coverage has no visual
    # responsibility. Any actual animated shadow remains outside this adapter.
    if dgp.shadow_blobs and any(size for frame in range(dgp.frame_count)
                               for _, spans in dgp.shadow_rows(frame) for _, size in spans):
        raise DGPError('CF1 animated shadow presentation is not recovered')


def export_bank(dgp, source, key, include_main, *, force_main=False, web=None, checks=None, outputs=None):
    """Write one source-bound atlas bank; callers may use an isolated temp web."""
    web = WEB if web is None else Path(web)
    checks = [] if checks is None else checks
    outputs = {} if outputs is None else outputs
    if force_main:
        validate_cf1_action(dgp)
    if not force_main and not any(row['active_raw'] for row in dgp.indexed_auxiliary):
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
                # An absent indexed stream means transparent contribution, not
                # permission to skip the independent source/coverage audit.
                intrinsic = indexed_contribution(dgp, physical)[0] if dgp.indexed_auxiliary else Image.new('RGBA', (dgp.width, dgp.height))
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
                    source_action_raw_hex=dgp.raw_actions[action['index']].hex(),
                    logical_frames=native_frame_sequence(dgp.raw_actions[action['index']], 0,
                        struct.unpack_from('<I', dgp.raw_actions[action['index']], 0x12)[0]
                        if dgp.raw_actions[action['index']][0x0d] & 15 == 0 else n, 0))
        for channel, atlas in [('main', main), ('intrinsic', light)]:
            if atlas is None:
                continue
            out = web / f'assets/map_effects/{key}/action_{action["index"]:02}_{channel}.png'
            out.parent.mkdir(parents=True, exist_ok=True)
            atlas.save(out)
            assert Image.open(out).convert('RGBA').tobytes() == atlas.tobytes()
            item[channel + '_sheet'] = '/' + out.relative_to(web).as_posix()
            outputs[item[channel + '_sheet']] = sha(out)
        actions.append(item)
    return dict(source=dict(path=source, sha256=dgp.sha256), frame_width=dgp.width,
                frame_height=dgp.height, actions=actions)


def export():
    sources = {'GAME.exe': sha(ROOT / 'GAME.exe')}
    outputs, checks, cf1_checks, banks = {}, [], [], {}
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
    for filename in ['object_queue.json', 'object_queue_assembly.json', 'object_tick_4137c0_assembly.json']:
        record = json.loads((RUNTIME / 'evidence/fire_valley_20261025' / filename).read_text(encoding='utf-8'))
        native_records.append(record)
        wanted.add(record['evidence_id'])
    assert all(row['subject']['digest']['sha256'] == sources['GAME.exe'] for row in native_records)

    def bank(source, key, include_main, *, force_main=False):
        if key in banks:
            return banks[key]
        dgp = DGP(ROOT / source)
        sources[source] = dgp.sha256
        result = export_bank(dgp, source, key, include_main, force_main=force_main,
                             checks=cf1_checks if force_main else checks, outputs=outputs)
        if result is None:
            return None
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
        table = MapObjects(ROOT / current['source']['path']) if current.get('objects') else None
        for obj in current.get('objects', []):
            raw = bytes.fromhex(table.objects[obj['index']]['raw_hex'])
            if obj['source'].lower() != table.resource_source(struct.unpack_from('<I', raw, 0x1e)[0]).lower():
                raise DGPError('Map animation source disagrees with its DAT resource identifier')
            dgp_header = (ROOT / obj['source']).read_bytes()[:3]
            cf1 = raw[0xcf] == 1 and bool(dgp_header[2])
            value = bank(obj['source'], current['id'].lower() + '_' + Path(obj['source']).stem, True, force_main=cf1)
            if not value:
                continue
            source = current['source']['path']
            sources[source] = sha(ROOT / source)
            if cf1 and struct.unpack_from('<I', raw, 0xf6)[0]:
                raise DGPError('CF1 scripted interaction has not been recovered')
            objects.append(dict(index=obj['index'], bank=current['id'].lower() + '_' + Path(obj['source']).stem,
                behavior_raw_cf=raw[0xcf], source_record_offset=table.objects[obj['index']]['offset'],
                map_id=current['id'], source_record_raw_hex=raw.hex(), fixed_clock_raw_b4=raw[0xb4],
                initial_frame_raw=struct.unpack_from('<I', raw, 0x3c)[0]))
        if objects:
            maps[current['id']] = dict(map_flag_index=struct.unpack_from('<I', table.data, 0x92)[0], objects=objects)
    object_banks = {key: value for key, value in banks.items() if not key.startswith('role_')}
    manifest = WEB / 'data/map_effects.json'
    write(manifest, dict(schema='seventh-seal-map-effects', version=1, roles=roles, maps=maps,
        object_banks=object_banks, blend='lighter', evidence=sorted(wanted),
        limits=['Canvas additive RGB is an 8-bit presentation adaptation of native RGB565/555.',
                'CF1 visual clocks use scene-local CRT; the original full global CRT stream has not been observed. World/encounter RNG is unchanged.',
                'No original executable execution or pixel/time-identical comparison is claimed.']))
    outputs['/' + manifest.relative_to(WEB).as_posix()] = sha(manifest)
    assert all(sha(ROOT / source) == expected for source, expected in sources.items())
    folder = RUNTIME / 'evidence/map_effects_20261021'
    write(folder / 'native_retained.json', dict(authority='Retained native static evidence', records=native_records))
    write(folder / 'export.json', dict(passed=True, source_bytes_unchanged=True, source_hashes=sources,
        output_hashes=outputs, roles=list(roles), maps=maps, frame_checks=checks, cf1_frame_checks=cf1_checks,
        original_game_execution_observed=False))
    # Keep the same source-frame shadow channel when the registered map
    # presentation assets are rebuilt. This helper never rewrites main/light.
    from export_map_shadows import export as export_shadows
    export_shadows()
    print(json.dumps(dict(passed=True, roles=list(roles), maps=list(maps), checked_frames=len(checks), outputs=len(outputs))))


if __name__ == '__main__':
    export()
