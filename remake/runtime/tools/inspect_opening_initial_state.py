"""Read-only opening-state source audit; writes evidence, never a runtime seed.

Game.SAV contains progressed flags and party state. Retained opening-native
evidence establishes it as the F4/F5 quick-save/load path, independently of
the menu's new-game initializer. CHR values below are resource defaults.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / 'remake/runtime/evidence'
sys.path.insert(0, str(ROOT / 'save_analysis_20261010'))
sys.path.insert(0, str(ROOT / 'remake/prototype/tools'))
from save_format import complete_layout, inventory, character_at_header
from inspect_equipment import describe_equipment
from combat_resources import CHR

EXPECTED = {
    'GAME.exe': 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18',
    'Game.SAV': 'daad0e0f3cf8fbcafa972fce4395b86fc909a4f25fad26f56c29863363572b2c',
    'SYSTEM/Object.ITM': '9d38c8cda16a06549cb3d09547b7b69b6d9fec4ee03926aef862b8da25d078b8',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def u32(data, at):
    return struct.unpack_from('<I', data, at)[0]


def text_field(data, at, length, encoding):
    raw = data[at:at + length].split(b'\0')[0]
    return dict(offset=at, offset_hex=hex(at), encoding=encoding,
                raw_hex=raw.hex(), value=raw.decode(encoding, 'strict'))


def actor_fields(data, actor):
    h = actor['header_offset']
    offsets = {'level': 0x24, 'experience': 0x28,
               'next_level_experience': 0x2c, 'hp_current': 0x30,
               'hp_maximum': 0x34, 'mp_current': 0x38, 'mp_maximum': 0x3c,
               'attack_current': 0x40, 'attack_base': 0x44,
               'defense_current': 0x48, 'defense_base': 0x4c,
               'attribute_0x58_current': 0x58, 'attribute_0x5c_base': 0x5c,
               'growth_index_raw': 0x60, 'experience_remaining': 0x64}
    return {name: dict(offset=h + rel, header_relative_offset=rel,
                       raw_u32=u32(data, h + rel)) for name, rel in offsets.items()}


def audit():
    source_paths = list(EXPECTED) + [
        'SYSTEM/System.MAG', 'SYSTEM/System.TXT', 'SYSTEM/Object.TXT',
        'save_analysis_20261010/save_format.py',
        'save_analysis_20261010/inspect_equipment.py',
        'save_analysis_20261010/read_inventory.py',
        'save_analysis_20261010/rea_format_evidence.json',
        'remake/prototype/tools/combat_resources.py',
        'remake/runtime/evidence/route_resources_20261011.json',
    ] + [f'Fight_Role/{i:03d}.CHR' for i in range(1, 7)]
    before = {p: sha((ROOT / p).read_bytes()) for p in source_paths}
    for p, expected in EXPECTED.items():
        if before[p] != expected:
            raise ValueError(f'Source differs from audited artifact: {p}')
    data = (ROOT / 'Game.SAV').read_bytes()
    layout = complete_layout(data)
    sections = {s['section']: s for s in layout['sections']}
    flags_at = sections['flags']['offset']
    flags = list(struct.unpack_from('<2000I', data, flags_at))
    counts_at = sections['events']['offset']
    counts = list(struct.unpack_from('<2000I', data, counts_at))
    cursor = counts_at + 8000
    events = []
    for index, count in enumerate(counts):
        records = [dict(offset=cursor + j * 14,
                        raw_hex=data[cursor + j * 14:cursor + (j + 1) * 14].hex())
                   for j in range(count)]
        if records:
            events.append(dict(index=index, count=count, records=records))
        cursor += count * 14
    assert cursor == counts_at + sections['events']['length']
    map_at = sections['map_objects']['offset']
    map_npcs_at = map_at + 4 + 10 * 0x4c5
    dynamic_at = map_npcs_at + 4
    leader = u32(data, map_at)
    objects = []
    for i in range(10):
        at = dynamic_at + i * 0x4c5
        objects.append(dict(slot=i, offset=at, record_bytes=0x4c5,
                            resource_id_raw=dict(offset=at + 0x28, value=u32(data, at + 0x28)),
                            x_native=dict(offset=at + 0x6f, value=u32(data, at + 0x6f)),
                            y_native=dict(offset=at + 0x73, value=u32(data, at + 0x73)),
                            direction_raw=dict(offset=at + 0x45, value=data[at + 0x45]),
                            raw_sha256=sha(data[at:at + 0x4c5])))
    chr_defaults = []
    for i in range(1, 7):
        p = ROOT / f'Fight_Role/{i:03d}.CHR'
        chr_ = CHR(p)
        actor = character_at_header(chr_.data, 8)
        chr_defaults.append(dict(path=p.relative_to(ROOT).as_posix(),
                                 sha256=chr_.sha256, bytes=len(chr_.data),
                                 parser_reaches_eof=chr_.parsed_end == len(chr_.data),
                                 header_raw_hex=chr_.header.hex(),
                                 actor=actor, fields=actor_fields(chr_.data, actor),
                                 authority='Resource definition only; new-game use remains unverified.'))
    actors = []
    for actor in layout['characters']:
        actors.append(dict(actor=actor, fields=actor_fields(data, actor),
                           state_byte_offset=actor['record_offset']))
    native_path = EVIDENCE / 'opening_native.json'
    native_bytes = native_path.read_bytes()
    native_records = json.loads(native_bytes)['records']
    native_proof = {}
    for name, address in [('quick_save_load', '0x41b080'), ('menu', '0x419e90'),
                          ('reload_chr', '0x4fdd00'), ('clear_flags', '0x443740'),
                          ('clear_events', '0x40c160'), ('inventory_reset', '0x47ae20')]:
        record = next(r for r in native_records
                      if r['operation'] == 'procedure_pseudo_code'
                      and r['parameters'].get('procedure') == address)
        assert record['subject']['digest']['sha256'] == EXPECTED['GAME.exe']
        native_proof[name] = dict(procedure=address, evidence_id=record['evidence_id'])
    report = dict(
        schema='seventh-seal-opening-initial-state-evidence', version=1,
        authority='Read-only shipped-resource audit using retained native serializers.',
        source_hashes=before, source_bytes_unchanged=True,
        native_bundle=dict(path=native_path.relative_to(ROOT).as_posix(), sha256=sha(native_bytes)),
        native_evidence=native_proof,
        save=dict(path='Game.SAV', sha256=before['Game.SAV'], bytes=len(data),
                  parser_reaches_eof=layout['reaches_eof'], sections=layout['sections'],
                  map_resource=text_field(data, 0x39, 20, 'ascii'),
                  map_display_label=text_field(data, 0x4d, 20, 'cp936'),
                  header_globals_raw={hex(o): dict(offset=o, value=u32(data, o))
                                      for o in (0x61, 0x65, 0x69, 0x7d, 0x81, 0x85)},
                  leader_slot=dict(offset=map_at, value=leader),
                  map_npc_count=dict(offset=map_npcs_at, value=u32(data, map_npcs_at)),
                  dynamic_party_objects=objects, actors=actors,
                  flag_table=dict(offset=flags_at, count=2000, values=flags,
                                  nonzero=[dict(index=i, offset=flags_at+i*4, value=v)
                                           for i, v in enumerate(flags) if v]),
                  events=dict(counts_offset=counts_at, record_bytes=14,
                              total=sum(counts), tables=events),
                  inventory=inventory(data), equipment=describe_equipment(ROOT / 'Game.SAV')),
        chr_defaults=chr_defaults,
        input_path_correction='ROLE/001.CHR does not exist; Fight_Role/001.CHR is the packaged role definition.',
        findings=[
            dict(status='observed', claim='Game.SAV is a complete v2 serialized world; its map is M01030.DAT / 焰坛连回道.'),
            dict(status='observed', claim='Game.SAV has two active roles, 20 inventory instances and 538 event records; flags48=3 and51=1.'),
            dict(status='inference', claim='The current Game.SAV contents carry completed fire-valley equipment/join flags. Directly using these bytes for an opening would skip those predicates.',
                 support='remake/runtime/evidence/route_resources_20261011.json findings F6/F7'),
            dict(status='observed', claim='CHR resource defaults themselves put 英格妮 at level11 and 凯 at level10; do not infer level1 from genre conventions.'),
            dict(status='native-static-confirmed', claim='Game.SAV is the F4/F5 quick-save/load path in0x41B080, not the menu new-game seed. Menu0x419E90 selects the separate native reset/init chain.'),
        ],
        game_sav_is_new_game_source=False,
        new_game_exporter='remake/runtime/tools/export_opening_seed.py',
        new_game_seed='remake/runtime/web/data/opening_seed.json',
        unknowns=[
            'Effective equipment attributes are separate from stored CHR fields.',
            'Serialized map objects are partially recomputed by 0x4B2960; raw records are not a full runtime import.',
            'System.MAG and TXT have been fingerprinted only; their new-game initialization role is not established.',
        ],
        original_game_execution_observed=False,
        original_inputs_modified=False,
    )
    if before != {p: sha((ROOT / p).read_bytes()) for p in source_paths}:
        raise ValueError('Read-only source changed during audit')
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / 'opening_initial_state.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    # Reproducible, correctly encoded full parse for further investigation.
    (EVIDENCE / 'opening_GameSAV_parsed.json').write_text(
        json.dumps(dict(path=str((ROOT / 'Game.SAV').resolve()), length=len(data),
                        inventory=inventory(data), characters=layout['characters'],
                        layout={k: v for k, v in layout.items() if k != 'characters'}),
                   ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(dict(save_parser_reaches_eof=True, source_bytes_unchanged=True,
                          chr_defaults=len(chr_defaults), game_sav_is_new_game_source=False)))


if __name__ == '__main__':
    audit()
