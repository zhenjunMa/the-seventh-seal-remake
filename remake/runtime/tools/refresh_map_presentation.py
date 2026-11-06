"""Add admitted maps to fixed effect/shadow tables using existing source decoders.

Unchanged banks and historical native references are retained. New physical
frames still pass the production exporter's independent source pixel/mask
checks; this does not recreate the unavailable historical native queries.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import struct
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from content_registration import definition
from export_map_effects import export_bank
from export_map_shadows import export_shadow_role, GAME_SHA
from source.dgp import DGP
from source.map_objects import MapObjects
from incremental import write_json

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    return json.loads(path.read_text('utf-8'))


def refresh():
    if digest(ROOT / 'GAME.exe') != GAME_SHA:
        raise ValueError('Map presentation refresh requires the exact verified executable')
    effects = load(WEB / 'data/map_effects.json')
    shadows = load(WEB / 'data/map_shadows.json')
    catalog = load(WEB / 'data/catalog.json')
    baseline_maps = {row['id'] for row in catalog['maps']}
    admitted = definition()['maps']
    new_maps = sorted(set(admitted) - baseline_maps)
    sources, outputs, checks = {'GAME.exe': GAME_SHA}, {}, []

    def verify(source):
        path, expected = source['path'], source['sha256']
        if digest(ROOT / path) != expected:
            raise ValueError(f'Fixed presentation source changed: {path}')
        sources[path] = expected

    for row in [*effects['roles'].values(), *effects['object_banks'].values(), *shadows['roles'].values()]:
        verify(row['source'])
    # Existing object clocks/state records remain pinned to actual DAT bytes.
    for map_id, table in effects['maps'].items():
        raw = (ROOT / f'Map/{map_id.lower()}.dat').read_bytes()
        for obj in table['objects']:
            at = obj['source_record_offset']
            if raw[at:at + 0x112].hex() != obj['source_record_raw_hex']:
                raise ValueError(f'Fixed object presentation source changed: {map_id}:{obj["index"]}')

    roles = {}
    for name in ['opening_map_resources.json', 'chapter_map_resources.json']:
        roles.update(load(WEB / 'data' / name)['roles'])
    added_roles = []
    for ident, role in sorted(roles.items()):
        verify(role['source'])
        if ident not in effects['roles']:
            dgp = DGP(ROOT / role['source']['path'])
            bank = export_bank(dgp, role['source']['path'], 'role_' + ident, False,
                               checks=checks, outputs=outputs)
            if bank is not None:
                effects['roles'][ident] = bank
                added_roles.append(ident)
        if ident not in shadows['roles']:
            generated = export_shadow_role(ident, dict(source=role['source']['path'],
                actions={a['index'] for a in role['actions']}, event_only=False))
            if generated['role'] is not None:
                shadows['roles'][ident] = generated['role']
            outputs.update(generated['outputs'])
            checks.extend(generated['checks'])

    for ident in new_maps:
        current = load(WEB / f'data/maps/{ident.lower()}.json')
        verify(current['source'])
        table = MapObjects(ROOT / current['source']['path'])
        objects = []
        for obj in current.get('objects', []):
            source_obj = table.objects[obj['index']]
            raw = bytes.fromhex(source_obj['raw_hex'])
            if obj['source'].lower() != table.resource_source(struct.unpack_from('<I', raw, 0x1e)[0]).lower():
                raise ValueError(f'New map object resource differs from DAT: {ident}:{obj["index"]}')
            dgp = DGP(ROOT / obj['source'])
            sources[obj['source']] = dgp.sha256
            behavior = raw[0xcf]
            force = behavior in (1, 2, 7) and bool(dgp.data[2])
            key = ident.lower() + '_' + Path(obj['source']).stem
            bank = effects['object_banks'].get(key)
            if bank is None:
                bank = export_bank(dgp, obj['source'], key, True, force_main=force,
                                   behavior_raw_cf=behavior, checks=checks, outputs=outputs)
            if bank is None:
                continue
            if force and behavior == 1 and struct.unpack_from('<I', raw, 0xf6)[0] and raw[0xd0] != 0:
                raise ValueError('CF1 scripted state is outside the recovered presentation contract')
            effects['object_banks'][key] = bank
            objects.append(dict(index=obj['index'], bank=key, behavior_raw_cf=behavior,
                source_record_offset=source_obj['offset'], map_id=ident,
                source_record_raw_hex=raw.hex(), fixed_clock_raw_b4=raw[0xb4],
                initial_frame_raw=struct.unpack_from('<I', raw, 0x3c)[0]))
        if objects:
            effects['maps'][ident] = dict(map_flag_index=struct.unpack_from('<I', table.data, 0x92)[0], objects=objects)

    limitation = 'Admission refresh reused fixed native references; missing historical queries were not recovered or rerun.'
    for value in [effects, shadows]:
        if limitation not in value['limits']:
            value['limits'].append(limitation)
    if any(digest(ROOT / path) != expected for path, expected in sources.items()):
        raise ValueError('Original source changed during map presentation refresh')
    write_json(WEB / 'data/map_effects.json', effects)
    write_json(WEB / 'data/map_shadows.json', shadows)
    outputs['/data/map_effects.json'] = digest(WEB / 'data/map_effects.json')
    outputs['/data/map_shadows.json'] = digest(WEB / 'data/map_shadows.json')
    report = dict(schema='seventh-seal-map-presentation-refresh', version=1, passed=True,
        new_map_ids=new_maps, added_intrinsic_role_ids=added_roles, source_hashes=sources,
        source_bytes_unchanged=True, output_hashes=outputs, independent_source_frame_checks=checks,
        original_game_executed=False, limitations=[limitation])
    write_json(RUNTIME / 'evidence/map_presentation_refresh.json', report)
    print(json.dumps(dict(passed=True, new_maps=new_maps, outputs=len(outputs), frame_checks=len(checks))))


if __name__ == '__main__':
    refresh()
