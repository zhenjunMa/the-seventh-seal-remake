"""Read the observed 19-record inventory in the original baseline.

This is a bounded, digest-checked observation, not a general save parser.
No write operations or skill-unlock assumptions are present.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

ROOT = Path(__file__).resolve().parent.parent
BASELINE_SHA = '25e0f6508ae1edd618a8da9f3175d616e16066d990bb02638061f06b801e5647'
DEFINITIONS_SHA = '9d38c8cda16a06549cb3d09547b7b69b6d9fec4ee03926aef862b8da25d078b8'

def uint(b, p):
    return struct.unpack_from('<I', b, p)[0]

def definitions():
    b = (ROOT/'SYSTEM'/'Object.ITM').read_bytes()
    assert hashlib.sha256(b).hexdigest() == DEFINITIONS_SHA
    assert len(b) == 0x61C + 416*0x3BF
    result = {}
    for j in range(416):
        p = 0x61C+j*0x3BF
        assert uint(b, p) == j+1
        result[j+1] = b[p+4:p+28].split(b'\0')[0].decode('cp936')
    return result

def baseline_inventory():
    b = (ROOT/'save_analysis_20261010'/'baseline_4herbs_SaveGame0.Dat').read_bytes()
    assert hashlib.sha256(b).hexdigest() == BASELINE_SHA
    names = definitions()
    assert uint(b, 0x4115D) == 19
    result = []
    for j in range(19):
        p = 0x41161+j*0xE5
        id_, value = uint(b, p), uint(b, p+4)
        assert id_ in names
        assert uint(b, p+8) == 204
        result.append({'index': j, 'record_offset': f'0x{p:X}',
                       'id': id_, 'name': names[id_],
                       'quantity': value,
                       'quantity_offset': f'0x{p+4:X}',
                       'quantity_status': 'confirmed by GAME.exe serialization and consume code; awaiting modified-save load test'})
    return result

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(baseline_inventory(), ensure_ascii=False, indent=2))
