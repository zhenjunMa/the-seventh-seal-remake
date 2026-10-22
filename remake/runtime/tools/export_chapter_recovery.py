"""Read-only source ledger for home rest, whole-party defeat and branch scope.

REA cannot decompile the mutation jump-table blocks; its complete byte read is
retained and checked against the original PE file. This exporter explicitly
labels the byte-level case2 interpretation rather than inventing pseudocode.
"""
from pathlib import Path
import hashlib
import json
import struct

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
GAME_SHA = "fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18"
REST_BYTES = "c745f800000000eb098b55f883c2018955f8837df80a7d5c0fbe0500c818058b4df869c9c50400008b148514a41f05837c0a2800743c8b45f869c0140300008b4df869c9140300008b90b5d85d058991b1d85d058b45f869c0140300008b4df869c9140300008b90bdd85d058991b9d85d05eb95e91f040000"

def digest(b):
    return hashlib.sha256(b).hexdigest()

def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def export():
    names = ["GAME.exe", "Map/m17026.dat", "Map/m17026.TLK", "Animate/m17026-1.anm",
             "Fight_Role/011.CHR", "Fight_Role/012.CHR", "Fight_Role/013.CHR", "Animate/GO02.bik"]
    originals = {name:(ROOT/name).read_bytes() for name in names}
    hashes = {name:digest(b) for name,b in originals.items()}
    assert hashes["GAME.exe"] == GAME_SHA
    b = originals["GAME.exe"]
    pe = struct.unpack_from("<I", b, 0x3C)[0]
    count = struct.unpack_from("<H", b, pe+6)[0]
    opt_bytes = struct.unpack_from("<H", b, pe+20)[0]
    image_base = struct.unpack_from("<I", b, pe+52)[0]
    sections = []
    for index in range(count):
        at = pe + 24 + opt_bytes + index*40
        _, rva, size, file_at = struct.unpack_from("<IIII", b, at+8)
        sections.append((rva,size,file_at))
    def file_offset(address):
        query = address-image_base
        return next(file_at+query-rva for rva,size,file_at in sections if rva<=query<rva+size)
    case_offset = file_offset(0x461861)
    assert b[case_offset:case_offset+121].hex() == REST_BYTES
    table_offset = file_offset(0x461D0D)
    assert struct.unpack_from("<I",b,table_offset+2*4)[0] == 0x461861
    native = json.loads((RUNTIME/"evidence/chapter_recovery_native_20261011.json").read_text(encoding="utf-8"))
    byte_record = next(row for row in native["records"] if row["operation"] == "read_bytes"
                       and row["parameters"]["address"] == "0x461861")
    assert byte_record["normalized_result"]["complete"]
    assert byte_record["normalized_result"]["bytes_hex"] == REST_BYTES
    story = json.loads((RUNTIME/"web/data/chapter_story.json").read_text(encoding="utf-8"))
    home = story["maps"]["M17026"]
    assert home["source"]["sha256"] == hashes["Map/m17026.TLK"]
    record = home["records"][9]
    raw = bytes.fromhex(record["raw_hex"])
    assert originals["Map/m17026.TLK"][record["offset"]:record["offset"]+0x66F] == raw
    choices = []
    for index in range(3):
        at = 0x537+index*104
        label = raw[at:at+100].split(b"\0")[0].decode("gbk")
        target = struct.unpack_from("<I",raw,at+100)[0]
        if label: choices.append(dict(index=index,text=label,record_id=target,source_offset=record["offset"]+at))
    assert [(row["text"],row["record_id"]) for row in choices] == [("休息。",12),("不用。",0)]
    enemy_tlk = {}
    for name in names:
        if name.endswith(".CHR"):
            # CHR file has an eight-byte preamble; +0x20A belongs to its header.
            enemy_tlk[name] = struct.unpack_from("<I",originals[name],8+0x20A)[0]
            assert enemy_tlk[name] == 0
    report = dict(schema="seventh-seal-chapter-recovery",version=1,source_hashes=hashes,
        source_unchanged=all((ROOT/name).read_bytes()==data for name,data in originals.items()),
        original_save_used=False,original_game_execution_observed=False,
        rest=dict(map_id="M17026",descriptor_id=2,entry_record_id=10,requires_explicit_interaction=True,
            cells=home["descriptors"][1]["cells"],choices=choices,accepted_chain=[10,12,11],
            confirmation_record_id=13,program="m17026-1",
            mutation=dict(type=2,jump_table_address="0x461d0d",target_address="0x461861",
                file_offset=case_offset,bytes_hex=REST_BYTES,byte_evidence=byte_record["evidence_id"],
                interpretation="Manually decoded bounded x86 case2: loop slots0..9; current-map actor+0x28 != 0; saved character stride0x314; +0x34 to +0x30 and +0x3C to +0x38; no inventory, money, flag, location writes.",
                limits="Ghidra default analysis leaves this block undecoded and the dispatcher decompiler fails; complete provider/source bytes are checked, not claimed to be decompiled pseudocode."),
            choice_native_evidence="ev_9779a32fae547e022645534daa03c7f09c274d93eda072163ee2c43a3c0aa81b"),
        defeat=dict(enemy_defeat_tlk_by_chr=enemy_tlk,mode="game-over",
            native_movie_path="Animate/GO02.bik",menu_call="0x419e90(0)",
            handlers=["0x4ffa30","0x430ed0","0x445f80","0x4307a0","0x419e90"],
            evidence=["ev_0c6a5805b7e804d34d6b28d3d290dbd99623994b1bc4a0ca231123501795516d",
                      "ev_cb0dced217462ac81aa764674b32ee36ff03b4902fa8c98200b53ed92f2a0285",
                      "ev_64adef34e4cb82d9c19035780fcca2b9a7991122da97b2b2a8ebb7745ea0c4ce",
                      "ev_2a05f4a1a3b5bae6560f396092aaa052b5dc7eea602d3c36ec48fa2c75b305f0"],
            unsupported="Nonzero enemy CHR+0x20A routes to an authored defeat TLK; future encounters must recover that TLK before enabling it.",
            observed_scope="Static normal-defeat dispatch; no original game-over execution observed.",
            post_battle_resource_note="Existing source 0x4FE0C0 sets KO actors to raw HP1 during exit copying; the ordinary all-party defeat still goes to the game-over menu, so this must not permit continued exploration."),
        branch_scope=[
            dict(id="first-departure",status="implemented",kind="required",scope="Kai invitation, equipment chest, tea supply, guarded departure and forest-return loop."),
            dict(id="home-rest",status="implemented",kind="required-for-continuous-play",scope="Explicit bed interaction; accept/decline; raw resources and atomic source ANM."),
            dict(id="village-dialogue",status="implemented",kind="optional",scope="Existing unconditional text and type0 flag branches; no new mainline prerequisite."),
            dict(id="M17020:10",status="deferred",kind="later-story",scope="Global flag12 bit1 invokes m17020-1; outside first forest loop."),
            dict(id="M17010:49,69,90",status="deferred",kind="later-story",scope="Flag16, flag12 and later current-map branches name additional ANMs; explicit unsupported animation errors retained."),
            dict(id="M17010:93..95",status="deferred",kind="later-story",scope="Aid skill72 mutation14 requires its native skill binding and preceding fire-crystal attack story; not needed for first departure."),
            dict(id="M17010:45",status="deferred",kind="optional",scope="Communication crystal native menu mutation4; not needed for first departure."),
        ],
        limitations=["Static source/native evidence only; original GAME.exe runtime not observed.",
                     "Exact original fade duration and Go02.bik/menu presentation are separate UI validation requirements.",
                     "Later story/skill/crystal branches are explicitly deferred; no full-game completion claim."])
    assert report["source_unchanged"]
    write(RUNTIME/"evidence/chapter_recovery_export_20261011.json",report)
    print(json.dumps(dict(source_unchanged=True,rest_choices=choices,enemy_defeat_tlk=enemy_tlk),ensure_ascii=False))

if __name__ == "__main__":
    export()
