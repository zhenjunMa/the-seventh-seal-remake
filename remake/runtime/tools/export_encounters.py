"""Export registered maps' native global STG encounter pools; no route guesses."""
from pathlib import Path
import hashlib
import json
import re
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
sys.path.insert(0, str(RUNTIME / 'tools'))
from source.combat_resources import CHR
from content_registration import definition, map_ids, role_ids


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def map_pool(ident, admitted, stages):
    dat, stg = ROOT / f'Map/{ident.lower()}.dat', ROOT / f'Map/{ident.lower()}.STG'
    h = dat.read_bytes()
    if len(h) < 0x172: raise ValueError(f'Map {ident}: truncated DAT')
    if not h[0x140]: return None
    b = stg.read_bytes()
    if len(b) != 932 or struct.unpack_from('<II', b) != (1, 0) or b[8] != 1 or not 1 <= b[209] <= 36:
        raise ValueError(f'Map {ident}: unsupported global STG format')
    width, height = struct.unpack_from('<II', h, 0x146)
    if 0x172 + width * height * 64 > len(h) or any(struct.unpack_from('<I', h, 0x172+i*64+0x3c)[0] for i in range(width*height)):
        raise ValueError(f'Map {ident}: local encounter-zone overrides need a handler')
    stage = b[9:209].split(b'\0')[0].decode('ascii')
    if Path(stage).stem not in stages: raise ValueError(f'Map {ident}: stage not registered: {stage}')
    def source(path, **fields): return dict(path=path.relative_to(ROOT).as_posix(), sha256=sha(path), **fields)
    members = []
    for index in range(b[209]):
        offset = 210 + index*20
        token = b[offset:offset+20].split(b'\0')[0].decode('ascii')
        if not re.fullmatch(r'[0-9]{3}\.dgp', token, re.IGNORECASE): raise ValueError(f'Invalid STG member: {token}')
        role_id = Path(token).stem
        if role_id not in admitted: raise ValueError(f'Map {ident}: enemy {role_id} not registered')
        c = CHR(ROOT / f'Fight_Role/{role_id}.CHR')
        category = struct.unpack_from('<I', c.header, 0x18)[0]
        members.append(dict(id=role_id, name=c.name, pool='A' if category >= 2 else 'B', class_raw=category,
            source=source(stg, filename_offset=offset), chr_source=source(c.path, header_class_offset=8+0x18)))
    return dict(frequency=h[0x140], stage=stage, members=members, source=[source(dat, frequency_offset=0x140), source(stg)])


def export():
    path = WEB / 'data/encounters.json'
    value = json.loads(path.read_text('utf-8'))
    evidence = next(iter(value['maps'].values()))['evidence']
    value['maps'] = {ident: dict(pool, evidence=evidence) for ident in map_ids()
                     if (pool := map_pool(ident, role_ids('enemy'), definition()['stages'])) is not None}
    sources = {value['source']['path']: value['source']['sha256']}
    for row in value['maps'].values():
        for source in [*row['source'], *[m['chr_source'] for m in row['members']]]: sources[source['path']] = source['sha256']
    if any(sha(ROOT / p) != digest for p, digest in sources.items()): raise ValueError('Original encounter source changed')
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', 'utf-8')
    report = dict(schema='seventh-seal-encounter-export', version=1, passed=True, source_unchanged=True,
        source_hashes=sources, output_hashes={path.relative_to(RUNTIME).as_posix(): sha(path)}, maps=list(value['maps']),
        original_game_execution_observed=False)
    (RUNTIME/'evidence/encounter_export.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', 'utf-8')
    print(json.dumps(dict(passed=True, maps=list(value['maps']))))


if __name__ == '__main__': export()
