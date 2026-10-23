"""Read-only export of the eight forest skill effect blocks and status43.

Native instruction/pseudocode records are retained from the existing pipeline
bundle. This exporter does not execute GAME.exe or touch original resources.
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
from source.dgp import DGP

EXPECTED = {
    'GAME.exe': 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18',
    'Fight_Role/001.CHR': '37ce92ab57622d2cce022b4a9b8add9b29789f89d82bc369ea7352f38ca75c0a',
    'Fight_Role/011.CHR': '01625263cd7226760c8bb11067878285c5835ba4a43efbcab68020201c698ec4',
    'Fight_Role/012.CHR': '4c9d1ef867222a8ffbdfea2e231f7500f30e0d7fec4fbfa1ab18b2dc874061a0',
    'Fight_Role/013.CHR': '5e3a7e65761a52b1653a40bc20ae130072af5c4f704b0cb389bbb239a1cd8ef6',
    'Fight_Role/Status/043.dgp': '88ece0118d4323e8f0ce7c41237541fd59ed3db39e2becc23736d39d3c279c62',
}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def save(path, value):
    assert path.resolve().is_relative_to(RUNTIME.resolve())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'utf-8')


def i32(raw, offset):
    return struct.unpack_from('<i', raw, offset)[0]


def main():
    before = {p: sha((ROOT / p).read_bytes()) for p in EXPECTED}
    assert before == EXPECTED, 'Native status source hashes changed'
    skills = {}
    for role, indices in [('001', (21, 22)), ('011', (14, 15)), ('012', (14, 15)), ('013', (15, 16))]:
        source = f'Fight_Role/{role}.CHR'
        chr_data = CHR(ROOT / source)
        assert chr_data.parsed_end == len(chr_data.data)
        for index in indices:
            skill = chr_data.skills[index]
            fixed = bytes.fromhex(skill['fixed_raw_hex'])
            effect = fixed[0x16b:0x231]
            assert len(effect) == 0xc6
            key = f'{role}:{index}'
            skills[key] = dict(actor_id=role, original_skill_index=index,
                               name=fixed[1:0x15].split(b'\0')[0].decode('cp936'),
                               fixed_raw_hex=fixed.hex(), effect_raw_hex=effect.hex(),
                               effect_id_raw=effect[1], mode_raw=effect[0xb],
                               nonzero_bytes={f'0x{o:02x}': b for o, b in enumerate(effect) if b},
                               source=dict(path=source, sha256=before[source],
                                           fixed_offset=skill['offset'], block_offset=skill['offset']+0x16b,
                                           fixed_bytes=0x41d, effect_bytes=0xc6))
    enabled = [key for key, value in skills.items() if value['effect_id_raw']]
    assert len(skills) == 8 and enabled == ['012:14']
    block = bytes.fromhex(skills['012:14']['effect_raw_hex'])
    assert (block[1], block[0xb], i32(block, 2), i32(block, 6), block[0x10], block[0x11],
            i32(block, 0x17), i32(block, 0x1b), i32(block, 0x8f), i32(block, 0xb8)) == (43, 0, 10, 500, 0, 80, 0, 0, 200, 0)
    assert set(skills['012:14']['nonzero_bytes']) == {'0x00', '0x01', '0x02', '0x06', '0x07', '0x11', '0x8f'}
    assert all(v['mode_raw'] == 0 for v in skills.values())
    # Nonzero hunter payload bytes remain serialized, but effect id zero skips
    # every RNG and aggregate branch in 508BB0.
    assert i32(bytes.fromhex(skills['013:15']['effect_raw_hex']), 0xc) == 1
    assert struct.unpack_from('<h', bytes.fromhex(skills['013:16']['effect_raw_hex']), 0x21)[0] == -50
    status = DGP(ROOT / 'Fight_Role/Status/043.dgp')
    assert len(status.actions) == 1
    interval = i32(status.raw_actions[0], 1)
    frames = status.actions[0]['frames_per_direction']
    assert interval == 80 and frames == 10
    bundle_path = RUNTIME / 'evidence/forest_status_native_20261011.json'
    bundle = json.loads(bundle_path.read_text('utf-8'))
    evidence, instructions, pseudocode = {}, {}, {}
    for address, operation in [('0x508bb0', 'procedure_assembly'), ('0x508300', 'procedure_assembly'),
                               ('0x509e10', 'procedure_assembly'), ('0x507e20', 'procedure_pseudo_code'),
                               ('0x508a90', 'procedure_assembly')]:
        record = next(r for r in bundle['records'] if r['operation'] == operation
                      and r['parameters'].get('procedure', '').lower() == address)
        assert record['subject']['digest']['sha256'] == before['GAME.exe']
        evidence[address] = record['evidence_id']
        if operation == 'procedure_assembly':
            instructions[address] = record['normalized_result'].splitlines()
        else:
            pseudocode[address] = record['normalized_result']
    # 508300: sixteen scalar i32 fields, two groups of five, ten elements,
    # one final i32 and byte. All additions wrap at their native field width.
    aggregation = [dict(block_offset=0x23+i*4, address=f'0x{0x521f551+i*4:08x}', bits=32) for i in range(16)]
    aggregation += [dict(block_offset=o+i*4, address=f'0x{a+i*4:08x}', bits=32)
                    for o, a, count in [(0x63, 0x521f591, 5), (0x77, 0x521f5a5, 5), (0x8b, 0x521f5b9, 10)] for i in range(count)]
    aggregation += [dict(block_offset=0xb3, address='0x0521f5e1', bits=32), dict(block_offset=0xb7, address='0x0521f5e5', bits=8)]
    output = RUNTIME / 'web/data/forest_status.json'
    metadata = dict(schema='seventh-seal-forest-status', version=1, skills=skills,
                    source_hashes=before, evidence=evidence, slots=100, effect_bytes=0xc6,
                    skill_block_offset=0x16b, aggregation=aggregation,
                    native_bundle=dict(path=bundle_path.relative_to(RUNTIME).as_posix(), sha256=sha(bundle_path.read_bytes())),
                    status43=dict(id_raw=43, mode_raw=0, effect_raw_hex=block.hex(), interval_ms=interval,
                                  frame_count=frames, duration_count_raw=10, gauge_increment_raw=500,
                                  probability_raw=80, aggregate_address='0x0521f5bd', aggregate_add_raw=200,
                                  source=dict(path='Fight_Role/Status/043.dgp', sha256=before['Fight_Role/Status/043.dgp'],
                                              action_raw_hex=status.raw_actions[0].hex())),
                    policy=dict(application_order='after damage native_return!=-1: 508A90,508BB0,before5005C0 HP',
                                initial_timestamp='Original block +0x17 is copied as zero; apply does not set now.',
                                chance='rand%100<=80; duplicate id/mode returns0 before RNG; id0/mode0 returns1 without RNG.',
                                tick='one interval per call, timestamp=now; threshold resets gauge0 and decrements count; spill discarded.',
                                clear='507E20 on fresh initialization, finalized death and battle cleanup before role writeback.',
                                scope='Current eight source skills, fresh slots: mode0 effect43 only; dormant id0 payload ignored.',
                                original_game_execution_observed=False),
                    limits=['Other game status ids/modes are unsupported; mode2 removal draws cannot be omitted if introduced.',
                            'Status43 is numeric only here; original status sprite rendering is not replayed.'])
    save(output, metadata)
    oracle = RUNTIME / 'evidence/forest_status_instructions_20261011.json'
    save(oracle, dict(schema='seventh-seal-forest-status-instruction-oracle', version=1,
                      game_sha256=before['GAME.exe'], evidence=evidence, instructions=instructions, pseudocode=pseudocode,
                      source_bundle=bundle_path.relative_to(RUNTIME).as_posix(), source_bundle_sha256=sha(bundle_path.read_bytes())))
    assert {p: sha((ROOT / p).read_bytes()) for p in EXPECTED} == before
    save(RUNTIME / 'evidence/forest_status_export_20261011.json', dict(
        passed=True, source_unchanged=True, source_hashes=before, skills_checked=8,
        enabled_effects=['012:14:43'], mode2_slots_present=False,
        metadata_sha256=sha(output.read_bytes()), oracle_sha256=sha(oracle.read_bytes())))
    save(RUNTIME / 'evidence/forest_status_source_bounds_20261011.json', dict(
        schema='seventh-seal-forest-status-source-bounds', version=1,
        authority='Original CHR/DGP bytes and retained static GAME.exe instructions; bounded instruction replay, no original battle execution.',
        native_bundle=bundle_path.relative_to(RUNTIME).as_posix(), native_bundle_sha256=sha(bundle_path.read_bytes()),
        metadata_sha256=sha(output.read_bytes()), original_inputs_unchanged=True,
        enabled_effects=['012:14 effect43 mode0'], dormant_id0=['001:21','001:22','011:14','011:15','012:15','013:15','013:16'],
        actor_storage=dict(slots='native_status_slots: 100 objects with complete C6 raw_hex',
                           aggregate='native_status_aggregate_raw_hex: complete C6',
                           flag_aliases=['status_flags_raw', 'status_by_address[0x0521f52a]']),
        controller_contract=dict(
            initialization='initializeNativeStatuses(actor,data) returns a cleared actor copy.',
            application='After native_return!=-1 and before HP submission, applyNativeSkillStatus returns actor copy/native_return/applied/cancel_command/trace.',
            ticking='tickNativeStatuses uses battle elapsed i32 time and the original global gauge threshold; no RNG for status43.',
            finalization='After finalized death, clearNativeStatuses must clear the actual native_status_slots, not only status_flags_raw.',
            battle_exit='507E20 clear before map role writeback; status43 does not persist to map.',
            command_callback='When cancel_command=true, controller clears this player actor pending command/UI (42FE40 case5).',
            metadata='Validated metadata is deep-frozen then cached by object identity; cloned inputs validate independently.'),
        exact_rules=dict(duplicate='same id/mode returns0 before RNG; no refresh',chance='rand%100<=80',
                         zero_id='id0/mode0 returns1 without RNG or payload processing',initial_last_tick=0,
                         period_ms=80,gauge_increment=500,count=10,element_address='0x0521f5bd',element_delta=200,
                         tick='elapsed>=80: one update, last=now; gauge threshold resets to0 and decrements count; count0 clears wholeC6'),
        excluded=['Unexported status ids/modes including mode2 removal RNG','Controlling-status tick branch',
                  'Periodic HP/MP or resurrection/counteracting effects','Original status overlay renderer and OS clock'],
        target_initialization=dict(allocation='519A80 memset entire actor gives F68E=0 at allocation.',
                                   allocation_evidence='ev_2c00f87a5a3b457786ca5e8e5c6f94374d1a24e2c8be051b913b1d6b012d8c17',
                                   idle_guard='519DD0 and50B520 preserveF68E; normal51C640 sets-1.',
                                   gap='Role-resource-load bulk overwrite after allocation not additionally established.'),
        verification='forest_status_verification_20261011.json: 9 tests;26 apply+126 tick x86 comparisons plus30 continuous RNG comparisons'))
    print('Forest status: all eight blocks retained; only snow skill14 enables43; original inputs unchanged.')


if __name__ == '__main__':
    main()
