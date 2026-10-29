"""Export native fresh-new-game state from CHR/ITM and retained GAME.exe proof.

Original saves are deliberately absent from this exporter. Gear is retained
as source metadata until the runtime equipment model is implemented.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
RUNTIME = ROOT / 'remake/runtime'
sys.path.insert(0, str(ROOT / "remake/runtime/tools"))
from source.combat_resources import CHR
from source.save_format import character_at_header
from source.native_item_init import initialize_existing_instance

GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'
ITM_SHA = '9d38c8cda16a06549cb3d09547b7b69b6d9fec4ee03926aef862b8da25d078b8'
WEAPONS = [1, 10, 39, 40, 41, 42]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def u32(data, at):
    return struct.unpack_from('<I', data, at)[0]


def export():
    proof_path = RUNTIME / 'evidence/opening_native.json'
    proof_bytes = proof_path.read_bytes()
    proof_records = json.loads(proof_bytes)['records']
    procedures = {
        'menu_new_game': ('procedure_pseudo_code', '0x419e90'),
        'clear_flags': ('procedure_pseudo_code', '0x443740'),
        'clear_events': ('procedure_pseudo_code', '0x40c160'),
        'reload_chr': ('procedure_pseudo_code', '0x4fdd00'),
        'equipment_initialize': ('read_function_instructions', '0x47ae20'),
        'item_initialize': ('procedure_pseudo_code', '0x47b3c0'),
        'party_initialize': ('procedure_pseudo_code', '0x4b6b30'),
        'entry_selection': ('procedure_pseudo_code', '0x4a5110'),
    }
    proof = {}
    for name, (op, at) in procedures.items():
        record = next(r for r in proof_records
                      if r['operation'] == op and r['parameters'].get('procedure') == at)
        assert record['subject']['digest']['sha256'] == GAME_SHA
        proof[name] = dict(operation=op, procedure=at, evidence_id=record['evidence_id'])
    global_record = next(r for r in proof_records
                         if r['operation'] == 'read_bytes'
                         and r['parameters'].get('address') == '0x679230'
                         and r['parameters'].get('length') == 12)
    assert global_record['subject']['digest']['sha256'] == GAME_SHA
    global_bytes = bytes.fromhex(global_record['normalized_result']['bytes_hex'])
    assert global_record['normalized_result']['complete'] and len(global_bytes) == 12
    marker, sort_code = struct.unpack_from('<2I', global_bytes)
    assert marker == 1 and sort_code == 1
    proof['entry_default_globals'] = dict(operation='read_bytes', address='0x679230',
                                         evidence_id=global_record['evidence_id'])
    original_sources = ['GAME.exe', 'SYSTEM/Object.ITM', 'Map/m72061.dat',
                        'Animate/Resurrect.ANM'] + [f'Fight_Role/{i:03d}.CHR' for i in range(1, 7)]
    source_bytes = {p: (ROOT / p).read_bytes() for p in original_sources}
    source_hashes = {p: sha(b) for p, b in source_bytes.items()}
    assert source_hashes['GAME.exe'] == GAME_SHA and source_hashes['SYSTEM/Object.ITM'] == ITM_SHA
    data = source_bytes['Map/m72061.dat']
    w, h = struct.unpack_from('<II', data, 0x146)
    shift = data[0x142] or 3
    assert u32(data, 0x14) == 6 and shift == 3 and data[0x145] == 1
    scanned = []
    for y in range(h):
        for x in range(w):
            at = 0x172 + (y * w + x) * 64
            if data[at + 0x21] == marker and len(scanned) < 4:
                scanned.append(dict(x=x, y=y, record_offset=at,
                                    marker_offset=at + 0x21))
    assert len(scanned) == 4 and scanned[0]['x'] == 29 and scanned[0]['y'] == 42
    # Native sort_code1 enters none of the three sort branches, and starts
    # with byte direction1. Keep row-major cell order, without centering.
    first = scanned[0]
    assert data[first['record_offset'] + 0x20] == 0
    assert u32(data, first['record_offset'] + 0x38) == 0
    location = dict(map_id='M72061', x=(first['x'] << shift) * 2,
                    y=(first['y'] << shift) * 2, direction=1)
    itm = source_bytes['SYSTEM/Object.ITM']
    assert len(itm) == 0x61c + 416 * 0x3bf
    role_definitions, equipment = {}, []
    for slot, item_id in enumerate(WEAPONS):
        ident = f'{slot+1:03d}'
        path = f'Fight_Role/{ident}.CHR'
        chr_ = CHR(ROOT / path)
        actor = character_at_header(chr_.data, 8)
        assert actor['end_offset'] == len(chr_.data)
        role_definitions[ident] = dict(id=ident, name=actor['name'],
            path=path, sha256=chr_.sha256, header_file_offset=8,
            header_raw_hex=chr_.header.hex(),
            stored={k: v for k, v in actor.items() if k not in ('skills', 'name')},
            skills=actor['skills'], active_in_opening_party=slot == 0)
        offset = 0x61c + (item_id-1)*0x3bf
        definition = itm[offset:offset+0x3bf]
        assert u32(definition, 0) == item_id
        # Native 47AE20 clears all equipment first, so even fields the item
        # initializer leaves untouched are source-backed zero bytes here.
        raw = initialize_existing_instance(bytes(0xe5), definition)
        crystal_header_offset = 0xe8 + slot*4
        crystal_id = u32(chr_.header, crystal_header_offset)
        assert crystal_id == 0, 'Nonzero native starting crystal needs its insertion port.'
        equipment.append(dict(role_id=ident, group_index=0, entry_index=0,
            item_id=item_id, name=definition[4:28].split(b'\0')[0].decode('cp936'),
            source_raw_hex=raw.hex(), instance_sha256=sha(raw),
            native_storage_address=hex(0x4f998a8+slot*0x5974),
            initializer='0x47b3c0 over a 0x47ae20 zero-cleared 0xe5-byte instance',
            initialization_rng_calls=0,
            definition_source=dict(path='SYSTEM/Object.ITM', record_offset=offset,
                                   record_bytes=0x3bf, sha256=sha(definition)),
            starting_crystal=dict(raw_id=crystal_id, chr_header_offset=crystal_header_offset,
                                  chr_file_offset=8+crystal_header_offset,
                                  native_read_address=hex(0x55dd969+slot*0x318))))
    leader = role_definitions['001']
    actor = leader['stored']
    seed = dict(schema='seventh-seal-world', version=1, revision=0,
        location=location, leader_id='001',
        party=[dict(id='001', name=leader['name'], level=actor['level'],
                    hp=actor['hp'], mp=actor['mp'],
                    attributes_stored=dict(attack=actor['attack'], defense=actor['defense']),
                    combat_progress=dict(header_raw_hex=leader['header_raw_hex']))],
        inventory=[], flags=[0]*2000, event_records=[[] for _ in range(2000)],
        object_states={}, money=50, reward_records=[],
        opening=dict(id='resurrect', status='pending'),
        source=dict(path='GAME.exe', sha256=GAME_SHA, kind='native-new-game',
                    seed_id='opening-new-game-v1', source_hashes=source_hashes,
                    native_bundle=dict(path=proof_path.relative_to(ROOT).as_posix(), sha256=sha(proof_bytes)),
                    native_evidence=proof,
                    entry_selection=dict(map_source='Map/m72061.dat', marker=marker,
                        default_sort_code=sort_code, default_direction=1,
                        scanned_cells=scanned, coordinate_shift=shift, native_to_pixel=2,
                        native_x=first['x'] << shift, native_y=first['y'] << shift,
                        scope='Pre-ANM entry selection; subsequently overwritten by the scripted cast.'),
                    role_definitions=role_definitions, initial_equipment=equipment,
                    scope='New-game flag/event/inventory reset, CHR stored role values and pending Resurrect opening; no historical save imported.',
                    limitations=['Gear is source metadata; effective equipment attributes await the runtime equipment model.',
                                 'Stored CHR attributes are retained without inventing effective recalculation.',
                                 'Original game execution comparison has not been observed.']))
    assert all((ROOT / p).read_bytes() == b for p, b in source_bytes.items())
    output = RUNTIME / 'web/data/opening_seed.json'
    output.write_text(json.dumps(seed, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    report = dict(schema='seventh-seal-opening-seed-export', version=1,
        source_bytes_unchanged=True, source_hashes=source_hashes,
        seed_path=output.relative_to(ROOT).as_posix(), seed_sha256=sha(output.read_bytes()),
        location=location, opening=seed['opening'], party_ids=['001'],
        flags_all_zero=True, event_record_count=0, inventory_count=0, money=50,
        retained_role_definitions=len(role_definitions), initial_weapon_ids=WEAPONS,
        equipment_instances=equipment, native_evidence=proof,
        original_save_used=False, original_game_execution_observed=False,
        limitations=seed['source']['limitations'])
    (RUNTIME / 'evidence/opening_seed_export_20261011.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({k: report[k] for k in ['source_bytes_unchanged', 'location',
          'party_ids', 'inventory_count', 'money', 'initial_weapon_ids', 'original_save_used']}))


if __name__ == '__main__':
    export()
