"""Export two native-new-game player attribute templates, without using saves.

Initial equipment is the retained 47AE20 / 47B3C0 zero-cleared instance;
47CC30 computes its linked bonuses from each CHR header. Original inputs are
only read. Battle status, stance and command selection remain fresh remake
initialization, rather than a claimed capture of original execution.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
RUNTIME = ROOT / 'remake/runtime'
sys.path.insert(0, str(RUNTIME / 'tools'))
from export_combat_sample import (equipment_table, HEADER_BASE, HEADER_FIELDS,
                                  STATUS_FIELDS, address)
sys.path.insert(0, str(ROOT / 'save_analysis_20261010'))
from source.combat_resources import CHR
from native_item_init import initialize_existing_instance
from content_registration import role_ids

GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'
EVIDENCE_REQUESTS = {
    'equipment': ('turn_actor_native_20261011.json', 'procedure_assembly', '0x47cc30'),
    'hp_getter': ('turn_actor_native_20261011.json', 'procedure_pseudo_code', '0x500350'),
    'mp_getter': ('turn_actor_native_20261011.json', 'procedure_pseudo_code', '0x500480'),
    'hp_commit': ('turn_actor_native_20261011.json', 'procedure_assembly', '0x5005c0'),
    'effective': ('turn_actor_native_20261011.json', 'procedure_assembly', '0x41c610'),
    'equipment_initialize': ('opening_native.json', 'read_function_instructions', '0x47ae20'),
    'item_initialize': ('opening_native.json', 'procedure_pseudo_code', '0x47b3c0'),
    'reload_chr': ('opening_native.json', 'procedure_pseudo_code', '0x4fdd00'),
}


def sha(raw): return hashlib.sha256(raw).hexdigest()
def i32(raw, offset): return struct.unpack_from('<i', raw, offset)[0]


def export():
    seed_path = RUNTIME / 'web/data/opening_seed.json'
    seed_bytes = seed_path.read_bytes()
    seed = json.loads(seed_bytes)
    source = seed['source']
    assert source['kind'] == 'native-new-game' and source['sha256'] == GAME_SHA
    source_paths = ['GAME.exe', 'SYSTEM/Object.ITM', *[f'Fight_Role/{ident}.CHR' for ident in role_ids('player')]]
    before = {p: (ROOT / p).read_bytes() for p in source_paths}
    hashes = {p: sha(raw) for p, raw in before.items()}
    assert hashes == {p: source['source_hashes'][p] for p in source_paths}
    evidence, bundle_hashes = {}, {}
    for name, (filename, operation, procedure) in EVIDENCE_REQUESTS.items():
        path = RUNTIME / 'evidence' / filename
        raw = path.read_bytes()
        record = next(r for r in json.loads(raw)['records']
                      if r['operation'] == operation
                      and r['parameters'].get('procedure', '').lower() == procedure)
        assert record['subject']['digest']['sha256'] == GAME_SHA
        evidence[name] = dict(evidence_id=record['evidence_id'], procedure=procedure,
                              bundle=path.relative_to(ROOT).as_posix(), operation=operation)
        bundle_hashes[path.relative_to(ROOT).as_posix()] = sha(raw)
    actors, equipment_instances, reaches_eof = {}, [], {}
    for ident in role_ids('player'):
        role = source['role_definitions'][ident]
        chr_ = CHR(ROOT / role['path'])
        header = chr_.header
        assert role['header_raw_hex'] == header.hex() and role['sha256'] == chr_.sha256
        assert chr_.parsed_end == len(chr_.data)
        reaches_eof[ident] = True
        entries = [row for row in source['initial_equipment'] if row['role_id'] == ident]
        assert len(entries) == 1 and entries[0]['group_index'] == entries[0]['entry_index'] == 0
        entry = entries[0]
        definition_source = entry['definition_source']
        at = definition_source['record_offset']
        definition = before['SYSTEM/Object.ITM'][at:at + 0x3bf]
        assert sha(definition) == definition_source['sha256']
        raw = initialize_existing_instance(bytes(0xe5), definition)
        assert raw.hex() == entry['source_raw_hex'] and sha(raw) == entry['instance_sha256']
        assert entry['starting_crystal']['raw_id'] == 0
        adapted = {k: v for k, v in entry.items() if k != 'group_index'}
        adapted['raw_instance_hex'] = adapted.pop('source_raw_hex')
        link, equipment = equipment_table(header, {'groups':[{'group_index':0, 'entries':[adapted]}]})
        equipment['source'] = 'native new-game initialized weapon instance'
        slot = int(ident) - 1
        hp, mp = i32(header, 0x30), i32(header, 0x38)
        bonuses = dict(hp_current=link[address(0x4f99088)], hp_maximum=link[address(0x4f9908c)],
                       mp_current=link[address(0x4f99090)], mp_maximum=link[address(0x4f99094)])
        assert header[0x18] == header[0x19] == 1
        actors[ident] = dict(id=ident, resource_id=ident, side='player', name=chr_.name,
            level=i32(header, 0x24), raw_hp=hp, raw_mp=mp,
            raw_hp_maximum=i32(header, 0x34), raw_mp_maximum=i32(header, 0x3c),
            hp=dict(current=hp + bonuses['hp_current'], maximum=i32(header, 0x34) + bonuses['hp_maximum']),
            mp=dict(current=mp + bonuses['mp_current'], maximum=i32(header, 0x3c) + bonuses['mp_maximum']),
            resource_bonuses=bonuses, role_kind_raw=header[0x18], side_raw=header[0x19],
            native_role_slot_zero_based=slot, role_link_raw=slot + 1,
            native_linked_stat_base=address(0x4f99088 + slot * 0xd0),
            raw_by_address={address(HEADER_BASE + o):i32(header, o) for o in HEADER_FIELDS},
            linked_by_address=link, status_by_address={address(n):0 for n in STATUS_FIELDS},
            state_raw=0, settled_raw=0, immune_raw=0, reaction_inhibit_raw=0,
            defense_half_raw=0, stance_raw=1, class_raw=0, action_mask_raw=0,
            header_raw_hex=header.hex(), equipment=equipment,
            source=dict(path=role['path'], sha256=role['sha256'], header_offset=8, header_bytes=0x30b),
            initialization=dict(authority='source-backed new-game header/equipment; fresh remake battle gates',
                header_role_kind_offset=0x18, header_side_offset=0x19,
                role_link='Fixed character slot plus one, independent of current party ordering',
                stance='neutral stance 1', status_table='fresh all-zero battle-owned table',
                current_skill='Assigned by the source-backed command adapter; no fabricated default skill',
                limit='Static reconstruction; original game execution was not observed.'))
        equipment_instances.append(entry)
    result = dict(schema='seventh-seal-party-combat', version=1, actors=actors,
        initial_equipment=equipment_instances, source_hashes=hashes, evidence=evidence,
        source=dict(required_world_source=dict(kind='native-new-game', path='GAME.exe', sha256=GAME_SHA),
            required_seed_id=source['seed_id'], seed_path=seed_path.relative_to(ROOT).as_posix(),
            seed_sha256=sha(seed_bytes), native_bundle_hashes=bundle_hashes,
            original_game_executed=False,
            scope='Current 001/002 party; source initialized equipment plus saved native growth header',
            limitations=['Initial equipment only; inventory rewards are not automatically equipped.',
                         'Fresh status and neutral stance are remake battle initialization.',
                         'Skill/animation selection is supplied separately; no historical save participates.']))
    assert all((ROOT / p).read_bytes() == raw for p, raw in before.items())
    output = RUNTIME / 'web/data/party_combat.json'
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    report = dict(source_bytes_unchanged=True, source_hashes=hashes, chr_parser_reaches_eof=reaches_eof,
        output_path=output.relative_to(ROOT).as_posix(), output_sha256=sha(output.read_bytes()),
        effective_resources={k:dict(hp=a['hp'], mp=a['mp'], resource_bonuses=a['resource_bonuses']) for k, a in actors.items()},
        native_evidence=evidence, original_game_execution_observed=False)
    report_path = RUNTIME / 'evidence/party_combat_export.json'
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report['effective_resources'], ensure_ascii=False))


if __name__ == '__main__': export()
