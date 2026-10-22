"""Retain bounded, read-only route resource evidence without executing scripts.

Recovered v6 DAT/TLK layouts are reused from the existing exporters. ANM
record partitioning is a structural candidate, and no opcode meaning is
assigned here. Map labels and file numbering never confirm a route by itself.
"""
from __future__ import annotations

from collections import defaultdict
import hashlib
import json
from pathlib import Path
import re
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
OUT = RUNTIME / "evidence/route_resources_20261011.json"


def u32(b, o):
    return struct.unpack_from("<I", b, o)[0]


def sha(b):
    return hashlib.sha256(b).hexdigest()


def relative(p):
    return p.relative_to(ROOT).as_posix()


def strings(b):
    return [dict(offset=m.start(), text=m.group().decode("ascii"))
            for m in re.finditer(rb"[A-Za-z0-9_\-]+\.(?:dat|tlk|anm|dgp|scn)", b, re.I)]


def map_record(path, detailed=False):
    b = path.read_bytes()
    if len(b) < 0x172 or u32(b, 0x14) != 6:
        return dict(path=relative(path), sha256=sha(b), bytes=len(b), unsupported="not established v6 DAT")
    w, h = struct.unpack_from("<II", b, 0x146)
    grid_end = 0x172 + w*h*64
    if not w or not h or grid_end > len(b):
        return dict(path=relative(path), sha256=sha(b), bytes=len(b), unsupported="no explicit bounded dimensions")
    rec = dict(path=relative(path), id=path.stem.upper(), sha256=sha(b), bytes=len(b),
               name=b[0x1C:0x7C].split(b"\0")[0].decode("gbk", "replace"),
               name_offset=0x1C, flag_index=u32(b, 0x92), width_cells=w, height_cells=h,
               rectangular=b[0x88], blend=b[0x89], coordinate_shift=b[0x142],
               projection=b[0x143], scale=b[0x145], grid_end=grid_end,
               background_resources=[b[0x9A+i*20:0x9A+(i+1)*20].split(b"\0")[0].decode("ascii", "replace")
                                     for i in range(min(u32(b, 0x96), 8))])
    if not detailed:
        return rec
    rec["header_hex"] = b[:0x172].hex()
    rec["header_route_unknown_raw"] = dict(offset=0x13A, hex=b[0x13A:0x146].hex())
    marker_cells, trigger_cells = defaultdict(list), defaultdict(list)
    for y in range(h):
        for x in range(w):
            o = 0x172 + (y*w+x)*64
            cell = dict(x=x, y=y, offset=o, terrain=b[o+0x20], raw_hex=b[o:o+64].hex())
            if b[o+0x21]:
                marker_cells[b[o+0x21]].append(cell)
            if u32(b, o+0x38):
                trigger_cells[u32(b, o+0x38)].append(cell)
    rec["entry_markers"] = dict(marker_cells)
    rec["trigger_cells"] = dict(trigger_cells)
    at = grid_end
    sections = []
    sizes = [0x2A, 0x42 if u32(b, 0x18) == 1 else 0x2B, 0x1B, 0x110]
    for si, size in enumerate(sizes):
        records = []
        for i in range(32):
            o = at+i*size
            raw = b[o:o+size]
            if len(raw) != size:
                raise ValueError(f"Truncated fixed map section {path}")
            if any(raw):
                d = dict(id=i+1, offset=o, raw_hex=raw.hex())
                if si == 1 and size == 0x42:
                    d.update(state_raw=raw[0], filename_raw=raw[0x11:0x26].split(b"\0")[0].decode("ascii", "replace"),
                             field_26_raw=u32(raw, 0x26), field_2a_raw=u32(raw, 0x2A), field_2e_raw=u32(raw, 0x2E))
                records.append(d)
        sections.append(dict(index=si, offset=at, count=32, record_bytes=size, nonzero_records=records))
        at += 32*size
    rec["fixed_sections"] = sections
    rec["object_table"] = dict(offset=at, count=u32(b, 0x82), record_bytes=0x112)
    at += u32(b, 0x82)*0x112
    npcs = []
    for i in range(b[0x86]):
        o = at+i*0x4C5
        raw = b[o:o+0x4C5]
        if len(raw) != 0x4C5:
            raise ValueError(f"Truncated role table {path}")
        npcs.append(dict(slot_zero_based=i+10, offset=o, resource_id=u32(raw, 0x28),
                         name_cp950=raw[0x14:0x28].split(b"\0")[0].decode("cp950", "replace"),
                         x_native=struct.unpack_from("<i", raw, 0x6F)[0],
                         y_native=struct.unpack_from("<i", raw, 0x73)[0], direction=raw[0x45],
                         raw_hex=raw.hex()))
    rec["npc_table"] = dict(offset=at, count=b[0x86], count_offset=0x86,
                            record_bytes=0x4C5, records=npcs,
                            authority="Retained native role-table layout; script-dependent relocation remains unknown")
    at += b[0x86]*0x4C5
    tail = b[at:]
    rec["post_npc_tail"] = dict(offset=at, bytes=len(tail), sha256=sha(tail), all_zero=not any(tail),
                                candidate="144x92 RGB565 map thumbnail" if len(tail)==144*92*2 else None,
                                candidate_status="structural inference; not a confirmed encounter table")
    return rec


def tlk_record(path):
    b = path.read_bytes()
    index_count, count = struct.unpack_from("<II", b, 2)
    base = 0x1A+index_count*4
    load_end = base+count*0x66F
    if index_count > 500 or load_end > len(b):
        raise ValueError(f"Unsupported TLK {path}")
    records = []
    for i in range(count):
        o = base+i*0x66F
        r = b[o:o+0x66F]
        if u32(r, 0x13) != i+1:
            raise ValueError(f"TLK ID mismatch {path}:{i+1}")
        records.append(dict(id=i+1, offset=o, kind=r[0], style=r[1], region_byte_raw=r[7],
                            speaker=u32(r, 0xF),
                            condition_type=u32(r, 0x17), condition_index=u32(r, 0x1B), condition_bit=u32(r, 0x1F),
                            mutation_type=u32(r, 0x23), mutation_index=u32(r, 0x27), mutation_bit=u32(r, 0x2B),
                            if_true=u32(r, 0x2F), next=u32(r, 0x33),
                            text_raw=r[0x37:0x137].split(b"\0")[0].decode("gbk", "replace"), raw_hex=r.hex()))
    return dict(path=relative(path), sha256=sha(b), bytes=len(b), index_count=index_count,
                index_nonzero=[dict(slot=i, offset=0x1A+i*4, record=u32(b, 0x1A+i*4))
                               for i in range(index_count) if u32(b, 0x1A+i*4)],
                record_count=count, record_base=base, record_bytes=0x66F, native_loader_end=load_end,
                trailing_bytes=len(b)-load_end, trailing_sha256=sha(b[load_end:]), records=records,
                authority="Retained native TLK record layout; resource fields do not by themselves prove command behavior")


def anm_record(path):
    b = path.read_bytes()
    count = u32(b, 2)
    expected = 0x43+count*0x4A
    if b[:2] != b"\x03\x00" or expected != len(b):
        return dict(path=relative(path), sha256=sha(b), bytes=len(b), filenames=strings(b),
                    status="partition unavailable")
    records = []
    for i in range(count):
        o = 0x43+i*0x4A
        r = b[o:o+0x4A]
        records.append(dict(index=i, offset=o, opcode_raw=r[0],
                            dwords_plus1_raw=[u32(r, 1+n*4) for n in range(8)],
                            byte_21_raw=r[0x21], map_index_candidate=u32(r, 0x22),
                            filenames=strings(r), raw_hex=r.hex()))
    return dict(path=relative(path), sha256=sha(b), bytes=len(b), count=count,
                header_hex=b[:0x43].hex(), record_base=0x43, record_bytes=0x4A, records=records,
                authority="Structural partition candidate: shipped length matches header count and fixed record size",
                limitations=["ANM opcode meanings are not inferred by this extractor", "Resource linkage is static; execution is unobserved"])


def main():
    selected = ["m00000", "m17010", "m17011", "m17012", "m17014", "m17016", "m17020", "m17026", "m17029", "m17030", "m17030-1", "m17030-2",
                "m70010", "m70020", "m70030", "m70040", "m70050", "m70060"]
    catalog = [map_record(p) for p in sorted((ROOT/"Map").glob("*.dat"))]
    maps, tlks, anms, stgs = [], [], [], []
    source_hashes = {}
    for name in selected:
        p = ROOT/"Map"/(name+".dat")
        if p.exists():
            rec = map_record(p, detailed=True)
            maps.append(rec)
            source_hashes[relative(p)] = rec["sha256"]
        p = ROOT/"Map"/(name+".TLK")
        if p.exists():
            rec = tlk_record(p)
            tlks.append(rec)
            source_hashes[relative(p)] = rec["sha256"]
        p = ROOT/"Map"/(name+".STG")
        if p.exists():
            b = p.read_bytes()
            stgs.append(dict(path=relative(p), sha256=sha(b), bytes=len(b), filenames=strings(b), raw_hex=b.hex(),
                             authority="Raw STG bytes; encounter selection, multiplicity, placement and CHR variant need native corroboration"))
            source_hashes[relative(p)] = sha(b)
    for p in sorted((ROOT/"Animate").glob("m170*.anm")):
        rec = anm_record(p)
        anms.append(rec)
        source_hashes[relative(p)] = rec["sha256"]
    exe = (ROOT/"GAME.exe").read_bytes()
    source_hashes["GAME.exe"] = sha(exe)
    findings = [
        dict(id="F1", status="resource-observed", claim="Six distinct v6 DATs carry the exact localized name 白木森林",
             paths=[f"Map/m700{i}0.dat" for i in range(1, 7)], caveat="Name alone does not choose the world-menu entry"),
        dict(id="F2", status="resource-observed", claim="M17010.TLK record46 is referenced by an ANM record rather than the ordinary TLK next/true edges",
             sources=[dict(path="Map/m17010.TLK", record=46, offset=76141),
                      dict(path="Animate/m17010-1.anm", record_index=4, offset=363, opcode_raw=14, argument_plus5=46)],
             caveat="Native opcode0x0E confirmation is required before executing this reference"),
        dict(id="F3", status="resource-observed", claim="M17010 descriptor10 links to record48; descriptor31 links to record49 under the recovered state2 descriptor field",
             sources=[dict(path="Map/m17010.dat", offset=816772, id=10, field_26_raw=48),
                      dict(path="Map/m17010.dat", offset=818158, id=31, field_26_raw=49)],
             caveat="Descriptor state2 execution and gating require the retained native branch"),
        dict(id="F4", status="resource-observed", claim="Forest STGs share stage13.scn and three 20-byte DGP filename slots 011/012/013",
             sources=[dict(path="Map/m70010.STG", offset=9, filename="stage13.scn"),
                      dict(path="Map/m70010.STG", offset=409, filename="011.dgp"),
                      dict(path="Map/m70010.STG", offset=429, filename="012.dgp"),
                      dict(path="Map/m70010.STG", offset=449, filename="013.dgp")],
             caveat="STG references do not establish encounter probability, enemy quantity or concrete CHR variants"),
        dict(id="F5", status="inference", claim="The 26496-byte post-NPC map remainder fits a 144x92 RGB565 thumbnail",
             caveat="Byte density and size support the candidate; native map-save/preview use remains to be confirmed"),
        dict(id="F6", status="resource-observed", claim="The initial departure condition refers to flag48 bit1, written by the equipment preparation dialogue in M17026",
             sources=[dict(path="Map/m17010.TLK", record=48, offset=79435, condition_type=0, condition_index=48, condition_bit=1, if_true=41),
                      dict(path="Map/m17026.dat", offset=0x92, map_flag_index=48),
                      dict(path="Map/m17026.TLK", record=1, offset=2026, condition_index=51, condition_bit=1, if_true=4, next=3),
                      dict(path="Map/m17026.TLK", record=8, offset=13555, mutation_type=0, mutation_index=0, mutation_bit=1)],
             caveat="Equipment mutation types1/5 and entry/ANM execution still need their native handlers; this is not a fabricated new-game seed"),
        dict(id="F7", status="resource-observed", claim="M17029 initial automatic TLK entry25 refers to an ANM dialogue that sets flag51 bit1 and announces Kai joining",
             sources=[dict(path="Map/m17029.dat", offset=0x92, map_flag_index=51),
                      dict(path="Map/m17029.TLK", offset=0x1A+499*4, index_slot=499, record=25),
                      dict(path="Map/m17029.TLK", record=24, offset=39907, mutation_type=0, mutation_index=0, mutation_bit=1),
                      dict(path="Map/m17029.TLK", record=26, offset=43201, text="凯加入队伍中！"),
                      dict(path="Animate/m17029-1.anm", record_index=26, offset=1991, opcode_raw=14, argument_plus5=24)],
             caveat="The join announcement alone does not reconstruct the ANM actor/team mutation; original execution remains unobserved"),
    ]
    unchanged = all(sha((ROOT/p).read_bytes()) == digest for p, digest in source_hashes.items())
    if not unchanged:
        raise ValueError("Read-only source digest changed")
    report = dict(schema="seventh-seal-route-resource-evidence", version=1,
                  source_unchanged=unchanged, source_hashes=source_hashes,
                  map_catalog=catalog, selected_maps=maps, selected_tlks=tlks,
                  fire_valley_anms=anms, selected_stgs=stgs, findings=findings,
                  search_boundary="All Map/*.dat labels/headers; detailed DAT/TLK/STG for 18 listed candidates; Animate/m170*.anm",
                  unknowns=["Exact new-game trigger and initial flag state", "All ANM opcode behavior and timing",
                            "Forest encounter random trigger and enemy initializer", "M00000 purpose: it is not assumed to be the Locate menu"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(dict(catalog=len(catalog), maps=len(maps), tlks=len(tlks), anms=len(anms), stgs=len(stgs), source_unchanged=True)))


if __name__ == "__main__":
    main()
