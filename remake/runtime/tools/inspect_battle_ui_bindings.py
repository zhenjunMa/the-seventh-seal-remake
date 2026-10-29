"""Read-only crosscheck of original serialized seven-slot command bindings."""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
from source.save_format import complete_layout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    observations = []
    paths = [ROOT/'SaveGame0.Dat', ROOT/'SaveGame1.Dat']
    before = {p.name:sha(p.read_bytes()) for p in paths}
    expected = [(2,1,0,0),(2,2,1,0),(2,3,2,0),(2,4,3,0)]
    for path in paths:
        data = path.read_bytes()
        layout = complete_layout(data)
        combo = next(x for x in layout['sections'] if x['section']=='combo_state')
        roles = []
        for role_index in (0,1):
            slots = []
            for slot in range(7):
                off = combo['offset'] + role_index*0x4c5 + 0x22 + slot*10
                raw = data[off:off+10]
                kind,ident,icon,color = struct.unpack('<IIBB',raw)
                slots.append(dict(slot=slot,source_offset=off,raw_hex=raw.hex(),
                    type=kind,index_one_based=ident,icon=icon,color=color))
            fixed = [(r['type'],r['index_one_based'],r['icon'],r['color']) for r in slots[3:]]
            if fixed != expected:
                raise ValueError('This source save no longer matches the observed default command slots')
            roles.append(dict(native_role_index=role_index,
                name=layout['characters'][role_index]['name'],slots=slots,
                default_command_slots_match=True))
        observations.append(dict(source=path.relative_to(ROOT).as_posix(),source_sha256=sha(data),
            bytes=len(data),combo_section=combo,full_save_parse_reached_eof=layout['reaches_eof'],roles=roles))
    after = {p.name:sha(p.read_bytes()) for p in paths}
    if before != after:
        raise ValueError('Original save changed during observation')
    result = dict(version=1,evidence_type='read-only-original-save-byte-observation',
        original_inputs_unchanged=True,original_game_execution_observed=False,
        record_format=dict(native_role_block_bytes=0x4c5,slot_table_relative_offset=0x22,
            slot_record_bytes=10,fields=['u32 type','u32 one-based command/skill id','u8 icon','u8 units']),
        source_hashes=before,observations=observations,
        native_initialization=dict(bundle='party_native.json',function='0x444590',
            evidence_id='ev_a40be7ba4dd6dea79df4e4272a0283350f97d1c78de8c29545a93fc279a5c7f6',
            formula='For slot=3..6: type=2,id=slot-2,icon=slot-3,units=0.'),
        defaults=[dict(slot=3,position='bottom',type=2,index_one_based=1,icon=0,command='使用招式'),
            dict(slot=4,position='lower_right',type=2,index_one_based=2,icon=1,command='使用物品'),
            dict(slot=5,position='upper_right',type=2,index_one_based=3,icon=2,command='防御'),
            dict(slot=6,position='center',type=2,index_one_based=4,icon=3,command='逃跑')],
        limits=['These save observations are from the existing original saves, not newly created games.',
            'The default initializer is historical static REA evidence, not rerun or executed by this tool.',
            'All seven slots are editable through original menu bindings; initial position is not a permanent action-to-position restriction.',
            'The slot format is tied to the complete save parser and native table bases. Uncovered special command behavior remains in the combat investigation.'])
    dest = RUNTIME/'evidence/battle_ui_slot_crosscheck.json'
    dest.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(dict(passed=True,saves=len(observations),roles=sum(len(r['roles']) for r in observations),
        original_inputs_unchanged=True,full_save_parse_reached_eof=True)))


if __name__ == '__main__':
    main()
