"""Export the recovered forest reward/growth contract; originals are read only."""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
RUNTIME = ROOT / 'remake/runtime'
sys.path.insert(0, str(RUNTIME / 'tools'))
sys.path.insert(0, str(ROOT / 'remake/prototype/tools'))
sys.path.insert(0, str(ROOT / 'save_analysis_20261010'))
from combat_resources import CHR
from save_format import complete_layout
from native_item_init import VALUE_PAIRS, initialize_existing_instance
from content_registration import role_ids


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def export():
    bundle_path = RUNTIME / 'evidence/forest_rewards_native_20261011.json'
    records = json.loads(bundle_path.read_text('utf-8'))['records']
    index = {(r['operation'], r['parameters'].get('procedure', '').lower()): r for r in records}
    procedures = {'death': '0x4ffe90', 'queue': '0x50cb60', 'drop': '0x50cc20',
                  'victory': '0x50d1c0', 'experience': '0x50e070', 'growth': '0x518b60',
                  'chain': '0x504b80', 'contact': '0x41d990', 'item_initialize': '0x47b3c0',
                  'item_buffer': '0x47ec20', 'item_stack': '0x47bdc0', 'money_save': '0x4785c0',
                  'victory_gate': '0x4ffa30', 'reward_display': '0x50e280'}
    proof = {}
    assemblies = {}
    for name, address in procedures.items():
        op = 'procedure_assembly' if name in ('drop', 'experience', 'growth', 'chain', 'contact', 'money_save') else 'procedure_pseudo_code'
        record = index[(op, address)]
        proof[name] = dict(procedure=address, evidence_id=record['evidence_id'], operation=op)
        if op == 'procedure_assembly':
            assemblies[address] = record['normalized_result'].splitlines()
    table = next(r for r in records if r['operation'] == 'read_bytes' and r['parameters'].get('address') == '0x679c78' and r['parameters'].get('length') == 880)
    table_bytes = bytes.fromhex(table['normalized_result']['bytes_hex'])
    assert table['normalized_result']['complete'] and len(table_bytes) == 880
    exp_a = list(struct.unpack_from('<100i', table_bytes, 0))
    exp_b = list(struct.unpack_from('<100i', table_bytes, 400))
    growth_rows = [list(struct.unpack_from('<10i', table_bytes, 800 + i * 40)) for i in range(2)]
    proof['tables'] = dict(address='0x679c78', evidence_id=table['evidence_id'], operation='read_bytes', length=880)
    sources = [ROOT / 'GAME.exe', ROOT / 'SYSTEM/Object.ITM', ROOT / 'save_analysis_20261010/verified_level12_SaveGame0.Dat']
    enemies = {}
    for key in role_ids('enemy'):
        path = ROOT / f'Fight_Role/{key}.CHR'
        role = CHR(path)
        sources.append(path)
        exp = struct.unpack_from('<i', role.header, 0x28)[0]
        slots = list(struct.unpack_from('<6i', role.header, 0xe8))
        enemies[key] = dict(id=key, name=role.name, experience=exp, reward_slots=slots,
                            source=dict(path=path.relative_to(ROOT).as_posix(), header_file_offset=8,
                                        experience_header_offset=0x28, reward_slots_header_offset=0xe8,
                                        raw_header_hex=role.header.hex()))
    item_bytes = (ROOT / 'SYSTEM/Object.ITM').read_bytes()
    assert len(item_bytes) == 0x61c + 416 * 0x3bf
    items = {}
    for item_id in sorted({v for e in enemies.values() for v in e['reward_slots'] if v > 0}):
        offset = 0x61c + (item_id - 1) * 0x3bf
        definition = item_bytes[offset:offset + 0x3bf]
        assert struct.unpack_from('<I', definition)[0] == item_id
        assert definition[0x24] >= 3 and definition[0x14b] == 0
        assert all(struct.unpack_from('<2i', definition, p)[0] == struct.unpack_from('<2i', definition, p)[1] for _, p in VALUE_PAIRS)
        instance = bytearray(initialize_existing_instance(bytes([0xcc]) * 0xe5, definition))
        struct.pack_into('<I', instance, 4, 1)
        items[str(item_id)] = dict(id=item_id, name=definition[4:28].split(b'\0')[0].decode('cp936'),
                                  drop_rate=struct.unpack_from('<i', definition, 0x158)[0], unique_raw=definition[0x14b],
                                  type_raw=definition[0x24], instance_raw_hex=instance.hex(), initialization_rng_calls=0,
                                  source=dict(path='SYSTEM/Object.ITM', definition_file_offset=offset, definition_raw_hex=definition.hex(),
                                              drop_rate_definition_offset=0x158, unique_definition_offset=0x14b))
    save = sources[2].read_bytes()
    roles = {}
    for role in complete_layout(save)['characters']:
        if role['state_byte'] and role['role_index'] in (0, 1):
            h = role['header_offset']
            roles[f"{role['role_index'] + 1:03d}"] = dict(name=role['name'], header_raw_hex=save[h:h + 0x30b].hex(),
                level=role['level'], experience=role['experience'], next_level_experience=role['next_level_experience'],
                experience_remaining_raw=role['experience_remaining'], growth_row=struct.unpack_from('<i', save, h + 0x60)[0],
                source_header_offset=h)
    hashes = {p.relative_to(ROOT).as_posix(): sha(p) for p in sources}
    value = dict(schema='seventh-seal-forest-rewards', version=1, enemies=enemies, items=items, initial_roles=roles,
        initial_money=struct.unpack_from('<I', save, 0x81)[0], source_hashes=hashes, evidence=proof,
        native_bundle=dict(path=bundle_path.relative_to(ROOT).as_posix(), sha256=sha(bundle_path)),
        tables=dict(exp_a=exp_a, exp_b=exp_b, growth_rows=growth_rows),
        chain_bonuses=[0,5,10,15,20,25,30,30,35,35,40,40,45,45,50,50,55,55,60,60]+[60]*21,
        skill_practice_bonuses=[0,10,20,30,40,50,60,70,80,90,100,120,140,200,260,320,400,480,580,700]+[700]*21,
        limits=['Only participating player 001 receives rewards; saved party member 002 is not a battle participant.',
                'Forest items all use inventory type >=3 and deterministic initialization; unique/equipment rewards require more ports.',
                'The original local chain bonus table admits k=0..40; higher values are rejected rather than invented.',
                'Native proficiency rewards 0x50C560 are separate from character experience; this contract exports their bonus table but does not assert a full proficiency port.',
                'Original game execution was not observed. Remake persistence and reward idempotency are explicit adapters.'])
    for p, v in [(RUNTIME / 'web/data/forest_rewards.json', value),
                 (RUNTIME / 'evidence/forest_rewards_instructions_20261011.json', dict(functions=assemblies, table=table['normalized_result'], evidence=proof))]:
        p.write_text(json.dumps(v, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    assert all(sha(ROOT / path) == digest for path, digest in hashes.items())
    report = dict(source_bytes_unchanged=True, source_hashes=hashes, source_count=len(hashes), enemy_count=len(enemies), item_count=len(items),
                  output_hashes={'web/data/forest_rewards.json': sha(RUNTIME / 'web/data/forest_rewards.json')},
                  initial_money=value['initial_money'], forest_money_rewards={k:sum(-x for x in v['reward_slots'] if x < 0) for k,v in enemies.items()},
                  evidence=proof, original_game_execution_observed=False)
    (RUNTIME / 'evidence/enemy_rewards_export.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', 'utf-8')
    print(json.dumps(dict(sources=len(hashes), enemies=len(enemies), items=len(items), initial_money=value['initial_money'], source_bytes_unchanged=True)))


if __name__ == '__main__':
    export()
