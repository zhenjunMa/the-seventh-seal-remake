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
    if not h[0x140] and not h[0x13f]: return None
    width, height = struct.unpack_from('<II', h, 0x146)
    if 0x172 + width * height * 64 > len(h) or any(struct.unpack_from('<I', h, 0x172+i*64+0x3c)[0] for i in range(width*height)):
        raise ValueError(f'Map {ident}: local encounter-zone overrides need a handler')
    def source(path, **fields): return dict(path=path.relative_to(ROOT).as_posix(), sha256=sha(path), **fields)
    row = dict(frequency=h[0x140], global_pool_load_raw=h[0x13f], members=[],
        source=[source(dat, frequency_offset=0x140, global_pool_load_offset=0x13f)])
    # 4A5F00 calls 444D10 only for DAT+13F != 0. A zero byte retains the
    # previous global pool; +140 is its independent movement-roll frequency.
    if not h[0x13f]: return row
    # 444D10 clears its 0x39C global before CreateFile: an absent STG clears
    # the pool rather than inheriting the previous one.
    if not stg.is_file(): return dict(row, missing_stg=stg.relative_to(ROOT).as_posix())
    b = stg.read_bytes()
    if len(b) != 932 or struct.unpack_from('<II', b) != (1, 0) or b[8] not in (0, 1) or b[209] > 36:
        raise ValueError(f'Map {ident}: unsupported global STG format')
    row.update(global_pool_enabled_raw=b[8], source=[*row['source'], source(stg)])
    # A disabled STG still replaces the old global block. 445390 tests +8
    # before reading stage/members; M01060 and M01020A supply this empty form.
    if not b[8]: return row
    if not b[209]: raise ValueError(f'Map {ident}: active global STG has no members')
    stage = b[9:209].split(b'\0')[0].decode('ascii')
    if Path(stage).stem not in stages: raise ValueError(f'Map {ident}: stage not registered: {stage}')
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
    return dict(row, stage=stage, members=members)


def export():
    path = WEB / 'data/encounters.json'
    value = json.loads(path.read_text('utf-8'))
    evidence = list(dict.fromkeys([*next(iter(value['maps'].values()))['evidence'],
        'ev_18893b05019e3c8a7fc6989b91972feddeb54b0118896397c96cacc974e60f1a',
        'ev_a9a200bd29900c56f97d559b79156b468bf62591a77515a7e0f57a459a3b9aa9']))
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
