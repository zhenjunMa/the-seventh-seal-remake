"""Read-only full CHR skill export for contact reactions and counter playback.

001 reaction records use the CHR source; its two exposed attack skills still use
the existing saved-skill export. No save, resource or old manifest is written.
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

GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'
EXPECTED = {
    'GAME.exe': GAME_SHA,
    'Fight_Role/001.CHR': '37ce92ab57622d2cce022b4a9b8add9b29789f89d82bc369ea7352f38ca75c0a',
    'Fight_Role/011.CHR': '01625263cd7226760c8bb11067878285c5835ba4a43efbcab68020201c698ec4',
    'Fight_Role/012.CHR': '4c9d1ef867222a8ffbdfea2e231f7500f30e0d7fec4fbfa1ab18b2dc874061a0',
    'Fight_Role/013.CHR': '5e3a7e65761a52b1653a40bc20ae130072af5c4f704b0cb389bbb239a1cd8ef6',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    assert path.resolve().is_relative_to(RUNTIME.resolve())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'utf-8')


def main():
    before = {p: sha((ROOT / p).read_bytes()) for p in EXPECTED}
    assert before == EXPECTED, 'Reaction source hashes changed'
    roles = {}
    for ident in ('001', '011', '012', '013'):
        source = f'Fight_Role/{ident}.CHR'
        chr_data = CHR(ROOT / source)
        assert chr_data.parsed_end == len(chr_data.data)
        skills = []
        for skill in chr_data.skills:
            fixed = bytes.fromhex(skill['fixed_raw_hex'])
            actions = []
            for a in skill['actions']:
                raw = bytes.fromhex(a['raw_hex'])
                actions.append(dict(index=a['index'], offset=a['offset'], bytes=0xb0,
                                    type_raw=raw[0], u32_at_0x01_raw=struct.unpack_from('<I', raw, 1)[0],
                                    duration_ticks_u32_0x01=struct.unpack_from('<I', raw, 1)[0],
                                    movement_i32_raw_0x1e=struct.unpack_from('<i', raw, 0x1e)[0],
                                    class_raw=raw[0x24], action_mask_raw=raw[0x78],
                                    reaction_mode_raw_0x77=raw[0x77], contact_u32_raw_0x49=struct.unpack_from('<I', raw, 0x49)[0],
                                    raw_hex=raw.hex(), raw_sha256=sha(raw)))
            assert actions, 'Source skill has no action records'
            mp_delta = struct.unpack_from('<i', fixed, 0x14f)[0]
            skills.append(dict(id=f'{ident}_reaction_source_{skill["index"]}', actor_id=ident,
                               index=skill['index'], original_skill_index=skill['index'], original_id_raw=fixed[0],
                               name=fixed[1:0x15].split(b'\0')[0].decode('cp936'),
                               fixed_raw_hex=fixed.hex(), fixed_bytes=0x41d, record_sha256=sha(fixed),
                               memory_stride_bytes=0x421, source_record_offset=skill['offset'],
                               mp_delta_raw=mp_delta, mp_cost=max(0, -mp_delta),
                               charge_i32_0x2e=struct.unpack_from('<i', fixed, 0x2e)[0],
                               type_flags_u32_0x32=struct.unpack_from('<I', fixed, 0x32)[0],
                               class_raw=actions[0]['class_raw'], action_mask_raw=actions[0]['action_mask_raw'],
                               actions=actions, source=dict(path=source, sha256=chr_data.sha256,
                                                           fixed_record_offset=skill['offset'], fixed_bytes=0x41d)))
        by_id = {str(n): [s['index'] for s in skills if s['original_id_raw'] == n]
                 for n in (0, 1, 2, 3, 9, 12, 18, 19)}
        assert all(by_id[str(n)] for n in (0, 1, 2, 3, 9, 18, 19))
        roles[ident] = dict(id=ident, name=chr_data.name, skill_count=chr_data.skill_count,
                            header_raw_hex=chr_data.header.hex(), header_sha256=sha(chr_data.header),
                            source=dict(path=source, sha256=chr_data.sha256, header_offset=8, header_bytes=0x30b),
                            skills=skills, reaction_id_indices=by_id)
    # The bundle and exact instruction exports are added after the source-backed
    # reaction investigation has been retained; missing evidence fails closed.
    evidence_dir = RUNTIME / 'evidence'
    bundle_path = evidence_dir / 'forest_death_reactions_native_20261011.json'
    bundle = json.loads(bundle_path.read_text('utf-8'))
    functions, evidence = {}, {}
    for address in ('0x50b520', '0x41ef00', '0x50b770', '0x5016b0', '0x51c640', '0x50b3e0', '0x41c610', '0x4ffd40', '0x4ffe90'):
        record = next(r for r in bundle['records'] if r['operation'] == 'procedure_assembly'
                      and r['parameters'].get('procedure', '').lower() == address)
        assert record['subject']['digest']['sha256'] == GAME_SHA
        functions[address] = record['normalized_result'].splitlines()
        evidence[address] = record['evidence_id']
    output = RUNTIME / 'web/data/forest_reactions.json'
    save(output, dict(schema='seventh-seal-forest-reactions', version=1, roles=roles,
                      source_hashes=before, evidence=evidence,
                      native_bundle=dict(path=bundle_path.relative_to(RUNTIME).as_posix(), sha256=sha(bundle_path.read_bytes())),
                      timing=dict(source_tick_ms=20, authority='Native source action tick conversion; preview wall clock is separate.'),
                      policy=dict(player_attack_skills='Existing verified saved yantu/xuanying exports remain authoritative.',
                                  target_reference='Caller supplies current_target_id for native F68E; guard and death finalization preserve it including null.',
                                  death_finalization='0x4FFE90 clears status, selects id12 or id2 with original lookup draws, or draws enemy fade increment modulo7 plus1.',
                                  original_game_execution_observed=False),
                      limits=['Original fixed/action records only; renderer/OS timing is not executed.',
                              'Attack effects/status application and resource submission belong to separate modules.']))
    instructions = evidence_dir / 'forest_reactions_instructions_20261011.json'
    save(instructions, dict(schema='seventh-seal-forest-reactions-instruction-oracle', version=1,
                            game_sha256=GAME_SHA, functions=functions, evidence=evidence,
                            source_bundle=bundle_path.relative_to(RUNTIME).as_posix(), source_bundle_sha256=sha(bundle_path.read_bytes()),
                            original_game_execution_observed=False))
    assert {p: sha((ROOT / p).read_bytes()) for p in EXPECTED} == before
    save(evidence_dir / 'forest_reactions_export_20261011.json', dict(
        schema='seventh-seal-forest-reactions-export-verification', version=1, passed=True,
        source_unchanged=True, source_hashes=before, metadata_sha256=sha(output.read_bytes()),
        instructions_sha256=sha(instructions.read_bytes()), skills=sum(r['skill_count'] for r in roles.values()),
        reaction_indices={k: r['reaction_id_indices'] for k, r in roles.items()}, original_game_execution_observed=False))
    print('Forest reactions: four roles, 113 complete skill/action records exported read-only.')


if __name__ == '__main__':
    main()
