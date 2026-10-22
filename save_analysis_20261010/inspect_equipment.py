"""Read the equipment groups serialized by GAME.exe 0x47AB20/0x47ACE0.

Reports raw group/entry indices without inventing meanings for unused fields.
Each role owns ten groups of ten 0xE5-byte item instances. No writes occur.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from save_format import complete_layout
from read_inventory import definitions


def describe_equipment(path):
    data = Path(path).read_bytes()
    layout = complete_layout(data)
    section = next(s for s in layout['sections'] if s['section'] == 'equipment')
    names = definitions()
    roles = []
    for role in layout['characters']:
        base = section['offset'] + role['role_index'] * 0x5974
        groups = []
        for group in range(10):
            entries = []
            for entry in range(10):
                offset = base + group * 0x8F2 + entry * 0xE5
                record = data[offset:offset + 0xE5]
                item_id = struct.unpack_from('<I', record)[0]
                if item_id == 0:
                    continue
                entries.append({
                    'entry_index': entry, 'record_offset': offset,
                    'item_id': item_id, 'name': names.get(item_id),
                    'raw_instance_hex': record.hex(),
                })
            if entries:
                groups.append({'group_index': group, 'entries': entries})
        roles.append({'role_index': role['role_index'], 'name': role['name'],
                      'state_byte': role['state_byte'], 'groups': groups})
    return {'path': str(Path(path).resolve()),
            'sha256': hashlib.sha256(data).hexdigest(),
            'equipment_offset': section['offset'], 'roles': roles}


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) != 2:
        raise SystemExit('Usage: inspect_equipment.py SAVE_FILE')
    print(json.dumps(describe_equipment(sys.argv[1]), ensure_ascii=False, indent=2))
