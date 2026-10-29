"""Build a bounded, source-backed development world; not a new-game initializer."""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
RUNTIME = ROOT / 'remake/runtime'
sys.path.insert(0, str(RUNTIME / 'tools'))
from source.save_format import complete_layout, inventory

SOURCE = ROOT / 'save_analysis_20261010/verified_level12_SaveGame0.Dat'
EXPECTED = 'f720fdd2eb0353f67b3acdb598bb3e2cbf24be438bca96a13967da71bec70706'

def export():
    data = SOURCE.read_bytes()
    assert hashlib.sha256(data).hexdigest() == EXPECTED
    layout = complete_layout(data)
    sections = {item['section']: item for item in layout['sections']}
    flags = list(struct.unpack_from('<2000I', data, sections['flags']['offset']))
    count_start = sections['events']['offset']
    counts = struct.unpack_from('<2000I', data, count_start)
    cursor = count_start + 8000
    events = []
    for count in counts:
        events.append([data[cursor+i*14:cursor+(i+1)*14].hex() for i in range(count)])
        cursor += count * 14
    assert cursor == count_start + sections['events']['length']
    party = []
    for actor in layout['characters']:
        if actor['state_byte'] and actor['role_index'] in (0,1):
            party.append(dict(id=f"{actor['role_index']+1:03d}", name=actor['name'],
                              hp=actor['hp'], mp=actor['mp'], level=actor['level'],
                              source_header_offset=actor['header_offset'],
                              attributes_stored={key:actor[key] for key in ('attack','defense')}))
    items = []
    for item in inventory(data)['items']:
        offset = item['record_offset']
        items.append(dict(instance_id=f"legacy-{offset}", id=item['id'], name=item['name'],
                          quantity=item['quantity'], source_raw_hex=data[offset:offset+0xE5].hex()))
    leader_slot = struct.unpack_from('<I', data, sections['map_objects']['offset'])[0]
    assert leader_slot in (0,1)
    seed = dict(schema='seventh-seal-world', version=1, revision=0, leader_id=f'{leader_slot+1:03d}',
                location=dict(map_id='M01010',x=330,y=1500,direction=7),
                party=party,inventory=items,flags=flags,event_records=events,object_states={},
                source=dict(path=SOURCE.relative_to(ROOT).as_posix(),sha256=EXPECTED,
                            original_map=data[0x39:0x4D].split(b'\0')[0].decode('ascii'),
                            scope='Historical saved flags, raw event records, stored party values and inventory; development relocation to M01010; no full original save import.'))
    sample_path = RUNTIME/'web/data/events/detective.json'
    if sample_path.is_file():
        event = json.loads(sample_path.read_text(encoding='utf-8'))
        overrides=[]
        for bit in event['sample_initial_flags']:
            assert 0 <= bit['index'] < 2000 and 1 <= bit['bit'] <= 32 and bit['value'] is False
            before=flags[bit['index']]
            flags[bit['index']] &= ~(1 << (bit['bit']-1))
            overrides.append(dict(index=bit['index'],bit=bit['bit'],before=before,after=flags[bit['index']]))
        seed['source']['development_flag_overrides']=overrides
        seed['source']['event_sample']=event['id']
        seed['source']['event_sample_source']=event['source']
        seed['source']['scope'] += ' Four source-backed event predicate bits are cleared for the controlled first/repeat detective sample; not original new-game state.'
    assert SOURCE.read_bytes() == data
    output = RUNTIME/'web/data/world_seed.json'
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(seed,ensure_ascii=False,indent=2),encoding='utf-8')
    report=dict(source=seed['source'],source_unchanged=True,parser_reaches_eof=layout['reaches_eof'],
                flag_count=len(flags),event_record_count=sum(counts),party_count=len(party),inventory_count=len(items),
                limits=['Development sample is relocated from M01060; it is not original new-game state.',
                        'Stored character values are not a recovered battle effective-attribute calculation.',
                        'Original event record bytes are retained without claiming all fields have semantics.'])
    evidence=RUNTIME/'evidence/world_seed_20261011.json'
    evidence.parent.mkdir(parents=True,exist_ok=True)
    evidence.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k not in ('source','limits')},ensure_ascii=False))

if __name__ == '__main__': export()
