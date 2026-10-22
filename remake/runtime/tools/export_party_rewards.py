"""Export new-game party rewards from untouched CHR and retained native proof.

The forest death/drop/growth tables remain the previously recovered contract.
This export replaces only the role fallback origin, and retains the complete
victory loop plus status/HP eligibility functions for independent verification.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
from content_registration import role_ids


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'utf-8')


def export():
    base_path = RUNTIME / 'web/data/forest_rewards.json'
    native_path = RUNTIME / 'evidence/forest_rewards_native_20261011.json'
    base = json.loads(base_path.read_text('utf-8'))
    table_path = RUNTIME / 'evidence/content_workflow_20261021/growth_native.json'
    table_record = json.loads(table_path.read_text('utf-8'))
    assert table_record['subject']['digest']['sha256'] == base['source_hashes']['GAME.exe'] == sha(ROOT / 'GAME.exe')
    raw_table = table_record['normalized_result']
    assert raw_table['address'] == '0x679c78' and raw_table['complete'] and raw_table['returned_bytes'] == 1040
    table_bytes = bytes.fromhex(raw_table['bytes_hex'])
    assert len(table_bytes) == 1040
    growth_rows = [list(struct.unpack_from('<10i', table_bytes, 800 + i * 40)) for i in range(6)]
    assert list(struct.unpack_from('<100i', table_bytes)) == base['tables']['exp_a']
    assert list(struct.unpack_from('<100i', table_bytes, 400)) == base['tables']['exp_b']
    assert growth_rows[:2] == base['tables']['growth_rows'][:2]
    records = json.loads(native_path.read_text('utf-8'))['records']
    selected = {}
    for operation, procedure in [('procedure_assembly', '0x50d1c0'),
                                 ('procedure_pseudo_code', '0x50a710'),
                                 ('procedure_pseudo_code', '0x500350')]:
        selected[procedure] = next(r for r in records if r['operation'] == operation
                                  and r['parameters'].get('procedure', '').lower() == procedure)
    roles = {}
    hashes = dict(base['source_hashes'])
    for ident in role_ids('player'):
        path = ROOT / f'Fight_Role/{ident}.CHR'
        raw = path.read_bytes()
        assert raw[:4] == struct.pack('<I', 8)
        header = raw[8:8 + 0x30b]
        assert len(header) == 0x30b
        get = lambda at: struct.unpack_from('<i', header, at)[0]
        growth = get(0x60)
        assert 0 <= growth < len(growth_rows)
        relative = path.relative_to(ROOT).as_posix()
        hashes[relative] = sha(path)
        roles[ident] = dict(name=header[4:24].split(b'\0')[0].decode('cp936'),
                           header_raw_hex=header.hex(), level=get(0x24),
                           experience=get(0x28), next_level_experience=get(0x2c),
                           experience_remaining_raw=get(0x64), growth_row=growth,
                           source=dict(path=relative, sha256=hashes[relative],
                                       header_file_offset=8, header_bytes=0x30b))
    value = dict(base)
    value['tables'] = dict(base['tables'], growth_rows=growth_rows)
    value.update(schema='seventh-seal-party-rewards', version=1,
                 initial_roles=roles, source_hashes=hashes,
                 world_source=dict(path='GAME.exe', sha256=hashes['GAME.exe'],
                                   kind='native-new-game', seed_id='opening-new-game-v1'),
                 distribution=dict(pool='full enemy experience pool per eligible player actor',
                                   order='native battle actor index order', split=False,
                                   defeated_player_experience=0,
                                   eligibility=['side_raw != 0', 'immune_raw == 0',
                                                'state_raw != 11', '0x50A710 == 0',
                                                '0x500350 effective HP > 0']),
                 limits=['Registered player roles use their source CHR growth-row selector and retained executable tables.',
                         'Only forest death/drop rewards are covered; other enemy pools and unique/equipment drops remain outside this contract.',
                         'Native skill proficiency rewards 0x50C560 are still separate from character experience.',
                         'Original executable was not run. World/reward persistence is an atomic remake adapter.'])
    proof_names = {'0x50d1c0': 'victory_assembly', '0x50a710': 'eligibility_status', '0x500350': 'eligibility_hp'}
    value['evidence'] = dict(base['evidence'])
    value['evidence']['party_growth_tables'] = dict(procedure='0x679c78', evidence_id=table_record['evidence_id'], operation='read_bytes')
    value['growth_table_source'] = dict(path=table_path.relative_to(RUNTIME).as_posix(), sha256=sha(table_path), address='0x679c78', bytes=1040)
    for address, record in selected.items():
        value['evidence'][proof_names[address]] = dict(procedure=address,
            evidence_id=record['evidence_id'], operation=record['operation'])
    value['base_contract'] = dict(path=base_path.relative_to(ROOT).as_posix(), sha256=sha(base_path))
    output = RUNTIME / 'web/data/party_rewards.json'
    write(output, value)
    instructions = RUNTIME / 'evidence/party_rewards_instructions.json'
    write(instructions, dict(schema='seventh-seal-party-reward-proof', version=1,
        source_sha256=hashes['GAME.exe'], evidence=value['evidence'],
        records=list(selected.values()), functions={
            '0x50d1c0': selected['0x50d1c0']['normalized_result'].splitlines()}))
    assert all(sha(ROOT / relative) == digest for relative, digest in hashes.items())
    report = dict(source_bytes_unchanged=True, source_hashes=hashes,
                  output_hashes={p.relative_to(ROOT).as_posix(): sha(p) for p in [output, instructions]},
                  role_ids=list(roles), levels={key: r['level'] for key, r in roles.items()},
                  growth_rows={key: r['growth_row'] for key, r in roles.items()},
                  distribution=value['distribution'], evidence=value['evidence'],
                  original_game_execution_observed=False)
    write(RUNTIME / 'evidence/party_rewards_export.json', report)
    print(json.dumps(dict(role_ids=list(roles), source_count=len(hashes), source_bytes_unchanged=True)))


if __name__ == '__main__':
    export()
