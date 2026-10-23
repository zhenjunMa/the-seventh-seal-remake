"""Export read-only CHR inputs and retained native enemy-selection instructions.

The two learned commands per forest enemy retain complete fixed/action bytes.
Other original fixed/action records are also retained because combination setup
uses parameter skill index zero for target side and code lookup scans all skills.
This export does not execute GAME.exe or change any battle/runtime controller.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(ROOT / "remake/runtime/tools"))
from source.combat_resources import CHR
import export_combat_sample as combat

EVIDENCE = RUNTIME / 'evidence'
WEB = RUNTIME / 'web'
GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    assert path.resolve().is_relative_to(RUNTIME.resolve())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'utf-8')


def role_record(chr_data):
    ident = chr_data.path.stem
    source_path = chr_data.path.relative_to(ROOT).as_posix()
    path = chr_data.path
    combat.EXPECTED[source_path] = chr_data.sha256
    skills = []
    for skill in chr_data.skills:
        fixed = bytes.fromhex(skill['fixed_raw_hex'])
        actions = []
        for original in skill['actions']:
            raw = bytes.fromhex(original['raw_hex'])
            actions.append(dict(index=original['index'], offset=original['offset'], bytes=0xb0,
                                type_raw=raw[0], u32_at_0x01_raw=struct.unpack_from('<I', raw, 1)[0],
                                movement_i32_raw_0x1e=struct.unpack_from('<i', raw, 0x1e)[0],
                                combination_body_raw_0x2e=raw[0x2e], raw_hex=raw.hex(),
                                raw_sha256=sha(raw)))
        index = skill['index']
        learned = fixed[0x23]
        if learned:
            impact = next((a['index'] for a in actions if struct.unpack_from('<I', bytes.fromhex(a['raw_hex']), 0x49)[0]), None)
            if impact is None:
                raise ValueError(f'Enemy {ident} skill {index}: no supported contact action')
            item = combat.skill_record(f"{ident}_skill_{index}", ident, fixed,
                                       skill['offset'], index, path, actions, impact)
        else:
            item = dict(id=f"{ident}_skill_{index}", actor_id=ident,
                        name=skill['name_cp936'], original_skill_index=index,
                        fixed_raw_hex=fixed.hex(), fixed_bytes=0x41d, actions=actions,
                        source=dict(path=source_path, sha256=chr_data.sha256,
                                    fixed_record_offset=skill['offset'], fixed_bytes=0x41d))
        item.update(index=index, source_record_offset=skill['offset'], record_sha256=sha(fixed),
                    code_raw_0x19=fixed[0x19], learned_raw_0x23=learned,
                    target_side_raw_0x25=fixed[0x25], weight_raw_0x27=fixed[0x27],
                    charge_i32_0x2e=struct.unpack_from('<i', fixed, 0x2e)[0],
                    type_flags_u32_0x32=struct.unpack_from('<I', fixed, 0x32)[0],
                    mp_delta_i32_0x14f=struct.unpack_from('<i', fixed, 0x14f)[0])
        skills.append(item)
    learned_indices = [s['index'] for s in skills if s['learned_raw_0x23']]
    return dict(id=ident, name=chr_data.name,
        source=dict(path=source_path, sha256=chr_data.sha256, header_offset=8, header_bytes=0x30b),
        header_raw_hex=chr_data.header.hex(), header_sha256=sha(chr_data.header),
        skill_count=chr_data.skill_count, side_raw=chr_data.header[0x19],
        category_raw=chr_data.header[0x18], learned_indices=learned_indices, skills=skills)


def main():
    findings_path = EVIDENCE / 'forest_ai_findings_20261011.json'
    native_path = EVIDENCE / 'forest_ai_rules_native_20261011.json'
    findings = json.loads(findings_path.read_text('utf-8'))
    bundle = json.loads(native_path.read_text('utf-8'))
    assert findings['game_sha256'] == GAME_SHA == sha((ROOT / 'GAME.exe').read_bytes())
    functions, refs = {}, {}
    for address in ('0x5029a0', '0x5014c0'):
        record = next(r for r in bundle['records'] if r['operation'] == 'procedure_assembly'
                      and r['parameters'].get('procedure', '').lower() == address)
        assert record['subject']['digest']['sha256'] == GAME_SHA
        functions[address] = record['normalized_result'].splitlines()
        refs[address] = record['evidence_id']
    sources = {'GAME.exe': GAME_SHA}
    roles = {}
    learned_checks = []
    for expected in findings['roles']:
        path = ROOT / expected['source']
        chr_data = CHR(path)
        assert chr_data.sha256 == expected['sha256']
        sources[expected['source']] = chr_data.sha256
        combat.EXPECTED[expected['source']] = chr_data.sha256
        role = role_record(chr_data)
        skills, learned_indices = role['skills'], role['learned_indices']
        assert learned_indices == [s['index'] for s in expected['skills']]
        for expected_skill in expected['skills']:
            item = skills[expected_skill['index']]
            for key in ('name', 'source_record_offset', 'record_sha256', 'code_raw_0x19',
                        'learned_raw_0x23', 'target_side_raw_0x25', 'weight_raw_0x27',
                        'charge_i32_0x2e', 'type_flags_u32_0x32', 'mp_delta_i32_0x14f'):
                assert item[key] == expected_skill[key], (expected['id'], key)
            learned_checks.append(dict(role_id=expected['id'], index=item['index'], name=item['name'],
                                       fixed_bytes=len(bytes.fromhex(item['fixed_raw_hex'])),
                                       actions=len(item['actions']), source_matches_findings=True))
        roles[expected['id']] = dict(id=expected['id'], name=chr_data.name,
                                    source=dict(path=expected['source'], sha256=chr_data.sha256,
                                                header_offset=8, header_bytes=0x30b),
                                    header_raw_hex=chr_data.header.hex(), header_sha256=sha(chr_data.header),
                                    skill_count=chr_data.skill_count, side_raw=chr_data.header[0x19],
                                    category_raw=chr_data.header[0x18], learned_indices=learned_indices,
                                    skills=skills)
    metadata = dict(schema='seventh-seal-forest-ai', version=1, roles=roles,
                    source_hashes=sources, evidence=refs,
                    references={p.relative_to(RUNTIME).as_posix(): sha(p.read_bytes())
                                for p in (findings_path, native_path)},
                    policy=dict(skill_selector='0x5029A0', target_selector='0x5014C0',
                                combination_setup='0x501E90', combination_parameter_skill_index=0,
                                initialization='Caller supplies fresh native status_flags_raw and reaction_busy_raw explicitly.',
                                rng='Caller-owned original CRT stream; selection and targeting consume it in source order.',
                                original_game_execution_observed=False),
                    limits=['Selection and target identity only; no animation, skill execution, gauge, MP or reward mutation.',
                            'Two learned source commands per forest enemy are covered; full source records retained for lookup.',
                            'Original live RNG seed and battle execution are not observed.'])
    assert sources == {p: sha((ROOT / p).read_bytes()) for p in sources}
    data_path = WEB / 'data/forest_ai.json'
    save(data_path, metadata)
    instructions_path = EVIDENCE / 'forest_ai_instructions_20261011.json'
    save(instructions_path, dict(schema='seventh-seal-forest-ai-instruction-oracle', version=1,
                                 game_sha256=GAME_SHA, functions=functions, evidence=refs,
                                 source_bundle=native_path.relative_to(RUNTIME).as_posix(),
                                 source_bundle_sha256=sha(native_path.read_bytes()),
                                 original_game_execution_observed=False))
    save(EVIDENCE / 'forest_ai_export_20261011.json', dict(
        schema='seventh-seal-forest-ai-export-verification', version=1, passed=True,
        source_hashes=sources, original_sources_unchanged=True,
        metadata_sha256=sha(data_path.read_bytes()), instructions_sha256=sha(instructions_path.read_bytes()),
        learned_skills=learned_checks, original_game_execution_observed=False))
    print('Forest AI: 3 original roles, 6 learned full commands and 2 retained instruction functions exported.')


if __name__ == '__main__':
    main()
