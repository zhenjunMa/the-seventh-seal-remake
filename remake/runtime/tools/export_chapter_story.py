"""Read-only source ledger for registered maps and ANM programs.

This exports raw TLK records, fixed ANM records and item definitions. It does
not initialize a world, interpret unverified mutations or use any save file.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / "tools"))
sys.path.insert(0, str(ROOT / "save_analysis_20261010"))
from route_extract_resources import anm_record, map_record, tlk_record
from native_item_init import VALUE_PAIRS
from source.combat_resources import CHR
from save_format import character_at_header

GAME_SHA = "fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18"
VM_EVIDENCE = "ev_b22e41c65651a4372b3b155d8d241a6094c01a46a948633a0db792af188533c1"
COMPACT_EVIDENCE = "ev_18893b05019e3c8a7fc6989b91972feddeb54b0118896397c96cacc974e60f1a"
TLK_EVIDENCE = "ev_e14d28c11ec31e5eebdf4c08a994a900102658650d8e5364d58b848cbd114ea7"
from content_registration import map_ids, program_ids, role_ids, definition, map_exports


def sha(data):
    return hashlib.sha256(data).hexdigest()


def u32(data, offset):
    return struct.unpack_from("<I", data, offset)[0]


def source(path, digest, offset=None, **fields):
    result = dict(path=path, sha256=digest, **fields)
    if offset is not None:
        result["offset"] = offset
    return result


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def program_map_context(commands, maps, ident):
    """Resolve control contexts from opcode10 and actual TLK/DAT callers only."""
    loads = []
    for command in commands:
        if command['opcode'] != 10:
            continue
        filename = command.get('filename', '')
        if command['u32_plus5'] != 0 or not re.fullmatch(r'M[0-9]{5}(?:-[0-9]+)?\.DAT', filename, re.IGNORECASE):
            raise ValueError(f'ANM {ident} has an unsupported opcode10 map reference: {filename}')
        map_id = filename[:-4].upper()
        if map_id not in maps:
            raise ValueError(f'ANM {ident} has an unregistered control map: {map_id}')
        loads.append(dict(map_id=map_id, command_index=command.get('index'), source=command.get('source')))
    callers, descriptors = [], []
    for map_id, table in maps.items():
        for record in table.get('records', []):
            if record['kind'] == 1 and record['text_raw'].lower() == ident.lower() + '.anm':
                callers.append(dict(map_id=map_id, record_id=record['id'], source=record.get('source')))
        for descriptor in table.get('descriptors', []):
            if descriptor['state_raw'] == 1 and descriptor['filename_raw'].lower() == ident.lower() + '.anm':
                descriptors.append(dict(map_id=map_id, descriptor_id=descriptor['id'], source=descriptor.get('source')))
    control_maps = list(dict.fromkeys(row['map_id'] for row in loads))
    caller_maps = list(dict.fromkeys(row['map_id'] for row in [*callers, *descriptors]))
    if not control_maps and len(caller_maps) != 1:
        raise ValueError(f'ANM {ident} without opcode10 requires one actual registered caller map; got {caller_maps}')
    return dict(control_map=loads[-1]['map_id'] if loads else caller_maps[0],
                control_maps=control_maps, caller_maps=caller_maps,
                maps=list(dict.fromkeys([*caller_maps, *control_maps])),
                context_sources=dict(map_commands=loads, caller_records=callers, caller_descriptors=descriptors))


def program_control_map(commands, maps, ident):
    """Compatibility accessor: the final loaded map, or unique no-load caller."""
    return program_map_context(commands, maps, ident)['control_map']


def export():
    MAP_IDS, ANM_IDS = map_ids('story-data'), program_ids()
    PLAYER_IDS = role_ids('player')
    names = ["GAME.exe", "SYSTEM/Object.ITM", *[f'Fight_Role/{ident}.CHR' for ident in PLAYER_IDS]]
    names += [f"Map/{ident.lower()}.dat" for ident in MAP_IDS]
    names += [f"Map/{ident.lower()}.TLK" for ident in MAP_IDS
              if (ROOT / f"Map/{ident.lower()}.TLK").is_file()]
    names += [f"Animate/{ident}.anm" for ident in ANM_IDS]
    original = {name: (ROOT / name).read_bytes() for name in names}
    hashes = {name: sha(data) for name, data in original.items()}
    assert hashes["GAME.exe"] == GAME_SHA
    maps = {}
    for ident in MAP_IDS:
        name = ident.lower()
        dat = map_record(ROOT / f"Map/{name}.dat", detailed=True)
        tlk_path = ROOT / f"Map/{name}.TLK"
        if not tlk_path.is_file() and map_exports()[ident]['story']:
            raise FileNotFoundError(f"Registered story map {ident} has no TLK source")
        tlk = tlk_record(tlk_path) if tlk_path.is_file() else dict(
            records=[], index_nonzero=[], index_count=0, record_base=None,
            record_bytes=0x66F, record_count=0, trailing_bytes=0, trailing_sha256=sha(b""))
        data = original[dat["path"]]
        for record in tlk["records"]:
            record["source"] = source(tlk["path"], tlk["sha256"], record["offset"],
                                       record_id=record["id"], record_bytes=0x66F)
            record["evidence"] = [TLK_EVIDENCE]
            # Preserve additional fields used by native event record writes.
            raw = bytes.fromhex(record["raw_hex"])
            record["byte_plus7_raw"] = raw[7]
            record["byte_plus8_raw"] = raw[8]
            record["condition_byte_raw_0b"] = raw[0x0B]
            record["header_bytes_2_to14_raw"] = raw[2:15].hex()
        descriptors = []
        table = dat["fixed_sections"][1]
        for entry in table["nonzero_records"]:
            raw = bytes.fromhex(entry["raw_hex"])
            compact = table["record_bytes"] == 0x2B
            assert compact or table["record_bytes"] == 0x42
            descriptor = dict(id=entry["id"], state_raw=raw[0],
                filename_raw=raw[0x11:0x26].split(b"\0")[0].decode("ascii", "strict"),
                field_26_raw=raw[0x26] if compact else u32(raw, 0x26),
                field_2a_raw=raw[0x27] if compact else u32(raw, 0x2A),
                field_2e_raw=raw[0x28] if compact else u32(raw, 0x2E),
                record_bytes=table["record_bytes"], raw_hex=raw.hex(),
                cells=[dict(x=cell["x"], y=cell["y"], offset=cell["offset"])
                       for cell in dat["trigger_cells"].get(str(entry["id"]),
                                  dat["trigger_cells"].get(entry["id"], []))],
                source=source(dat["path"], dat["sha256"], entry["offset"],
                              descriptor_id=entry["id"], bytes=table["record_bytes"]),
                evidence=[COMPACT_EVIDENCE],
                field_expansion=("Compact source bytes +0x26/+0x27/+0x28 become native DWORD +0x26/+0x2A/+0x2E"
                                 if compact else "Native 0x42-byte descriptor fields"))
            descriptors.append(descriptor)
        objects = []
        for index in range(dat["object_table"]["count"]):
            offset = dat["object_table"]["offset"] + index * 0x112
            raw = data[offset:offset + 0x112]
            objects.append(dict(index=index, slot_one_based=index + 1,
                raw_hex=raw.hex(), x_native=struct.unpack_from("<i", raw, 0x26)[0],
                y_native=struct.unpack_from("<i", raw, 0x2A)[0],
                resource_id_raw=u32(raw, 0x1E),
                event_record_index_raw_4c=u32(raw, 0x4C),
                event_region_raw_b6=u32(raw, 0xB6),
                interaction_record_raw_f6=u32(raw, 0xF6),
                object_type_raw_ce=raw[0xCE], behavior_raw_cf=raw[0xCF],
                source=source(dat["path"], dat["sha256"], offset, bytes=0x112)))
        maps[ident] = dict(id=ident, name=dat["name"], flag_index=dat["flag_index"],
            map_flag_index=dat["flag_index"],
            source=source(tlk["path"], tlk["sha256"], bytes=tlk["bytes"]) if tlk_path.is_file() else None,
            dialogue_status="parsed" if tlk_path.is_file() else "source-file-absent",
            map_source=source(dat["path"], dat["sha256"], bytes=dat["bytes"]),
            index_nonzero=tlk["index_nonzero"], index_count=tlk["index_count"],
            record_base=tlk["record_base"], record_bytes=tlk["record_bytes"],
            record_count=tlk["record_count"], records=tlk["records"],
            trailing_bytes=tlk["trailing_bytes"], trailing_sha256=tlk["trailing_sha256"],
            header_raw_hex=dat["header_hex"], compatibility_variant=u32(data, 0x18),
            descriptors=descriptors, objects=objects,
            npc_records=dat["npc_table"]["records"],
            entry_markers={str(marker): [dict(x=cell["x"],y=cell["y"],offset=cell["offset"])
                            for cell in cells] for marker,cells in dat["entry_markers"].items()},
            default_object_index_slot=499,
            default_object_record=next((slot["record"] for slot in tlk["index_nonzero"] if slot["slot"] == 499), 0),
            # 4A5F00 loads the header at 0504B1C8; 4A85A0 passes
            # 0504B302 to 4670C0, giving source offset 0x13A.
            header_entry_tlk_raw=u32(data, 0x13A),
            header_entry_tlk_source=source(dat["path"],dat["sha256"],0x13A,bytes=4),
            # 4A5F00 runs 466EC0 with header 0504B252 before returning;
            # this rebuilds phase-specific actors even when restoring a save.
            header_setup_tlk_raw=u32(data, 0x8A),
            header_setup_tlk_source=source(dat["path"],dat["sha256"],0x8A,bytes=4),
            evidence=[TLK_EVIDENCE, COMPACT_EVIDENCE],
            limitations=["Index slot499 is retained as the object default TLK entry; it must not be used as an automatic map-load event. Header +0x8A controls map setup; +0x13A controls map-entry TLK.",
                         "TLK record kind/mutation numbers are raw native values; dialogue text alone does not define their behavior."])
    programs = {}
    for ident in ANM_IDS:
        anm = anm_record(ROOT / f"Animate/{ident}.anm")
        assert anm.get("count") and len(anm["records"]) == anm["count"]
        commands = []
        for record in anm["records"]:
            raw = bytes.fromhex(record["raw_hex"])
            command = dict(index=record["index"], opcode=record["opcode_raw"], raw_hex=record["raw_hex"],
                source=source(anm["path"], anm["sha256"], record["offset"], record_index=record["index"]),
                map_index_raw=u32(raw, 34), evidence=[VM_EVIDENCE])
            command.update({f"u32_plus{at}": u32(raw, at) for at in [1,5,9,13,17,21,25]})
            command.update({f"byte_plus{at}": raw[at] for at in range(29,34)})
            if command["opcode"] in [10,60,62]:
                command["filename"] = raw[54:74].split(b"\0")[0].decode("ascii", "strict")
            commands.append(command)
        context = program_map_context(commands, maps, ident)
        programs[ident] = dict(schema="seventh-seal-chapter-anm", version=1, id=ident,
            source=source(anm["path"], anm["sha256"], bytes=anm["bytes"]),
            header_raw_hex=anm["header_hex"], commands=commands,
            required_opcodes=sorted({command["opcode"] for command in commands}),
            maps=context['maps'], dialogues={map_id: dict(source=maps[map_id]["source"],records=maps[map_id]["records"])
                                             for map_id in context['maps']},
            expected=dict(control_map=context['control_map'], control_maps=context['control_maps'],
                          caller_maps=context['caller_maps'], final_control_actor=0),
            context_sources=context['context_sources'],
            native_evidence=[VM_EVIDENCE],
            limitations=["Static source/native command export, not observed original execution.",
                         "Native movement speed0, actor party opcode36 and TLK mutation dispatch require their recovered handlers.",
                         "Browser visual timing and exact native blending are separate renderer limitations."])
    itm = original["SYSTEM/Object.ITM"]
    assert len(itm) == 0x61C + 416 * 0x3BF
    # Grant targets are source facts, not a second author-maintained item list.
    ITEM_IDS = sorted({r['mutation_bit'] for m in maps.values() for r in m['records']
                       if r['mutation_type'] == 5 and r['mutation_bit'] > 0})
    item_ids = set(ITEM_IDS)
    for ident, binding in definition()['maps'].items():
        if ident not in maps:
            continue  # A scoped export only admits grants from its selected maps.
        for selected in binding.get('objects', []):
            if selected['handler'] != 'keyed-chest':
                continue
            obj = next(row for row in maps[ident]['objects'] if row['index'] == selected['index'])
            raw = bytes.fromhex(obj['raw_hex'])
            if raw[0xCF] != 4 or u32(raw, 0xF6):
                raise ValueError(f'Not a native direct-reward CF4 chest: {ident}:{selected["index"]}')
            item_ids.update(u32(raw, at) for at in [0xF2, *range(0x54, 0x7C, 4)] if u32(raw, at))
    ITEM_IDS = sorted(item_ids)
    definitions = {}
    for ident in ITEM_IDS:
        if not 1 <= ident <= 416: raise ValueError(f'Invalid story item ID: {ident}')
        offset = 0x61C + (ident - 1) * 0x3BF
        raw = itm[offset:offset + 0x3BF]
        assert u32(raw, 0) == ident
        pairs = [dict(instance_offset=destination, definition_offset=at,
                      minimum=struct.unpack_from("<i",raw,at)[0],
                      maximum=struct.unpack_from("<i",raw,at+4)[0]) for destination,at in VALUE_PAIRS]
        definitions[str(ident)] = dict(id=ident, name=raw[4:28].split(b"\0")[0].decode("gbk", "strict"),
            raw_hex=raw.hex(), record_sha256=sha(raw), instance_byte9_raw=raw[0x176],
            type_raw_24=raw[0x24],allowed_role_mask_raw_13e=u32(raw,0x13E),
            initializer_value_pairs=pairs, deterministic_initializer_ranges=all(p["minimum"]==p["maximum"] for p in pairs),
            source=source("SYSTEM/Object.ITM", hashes["SYSTEM/Object.ITM"], offset,record_bytes=0x3BF,record_id=ident),
            native_evidence=["ev_059378b70e0c3d2d6a7d89406c901bd8453f733aa06817ae33106d860a16fa22"],
            limitations=["This is a definition record, not an initialized or awarded inventory instance."])
    role_definitions = {}
    for ident in PLAYER_IDS:
        c = CHR(ROOT / f'Fight_Role/{ident}.CHR')
        stored = character_at_header(c.data, 8)
        assert stored['end_offset'] == len(c.data)
        role_definitions[ident] = dict(id=ident, name=stored['name'], path=f'Fight_Role/{ident}.CHR',
            sha256=c.sha256, header_file_offset=8, header_raw_hex=c.header.hex(),
            stored={key: value for key, value in stored.items() if key not in ('skills', 'name')},
            skills=stored['skills'], source=source(f'Fight_Role/{ident}.CHR', c.sha256, 8, header_bytes=len(c.header)),
            limitations=['Source defaults only; existing party progress must remain intact.'])
    limits = ["All native findings are static; original GAME.exe runtime has not been observed by this exporter.",
              "No save state or historical flags are imported.",
              "Only registered ANMs are exported; unregistered TLK branches are not enabled by exporting their records.",
              "TLK trailing payload is hashed and retained by source identity but is not executed."]
    assert all((ROOT/name).read_bytes() == data for name,data in original.items())
    chapter = dict(schema="seventh-seal-chapter-story",version=1,id="registered-chapters",
        source_hashes=hashes,maps=maps,programs=programs,item_definitions=definitions,role_definitions=role_definitions,
        native_evidence=[VM_EVIDENCE,TLK_EVIDENCE,COMPACT_EVIDENCE],limitations=limits)
    output = RUNTIME / "web/data/chapter_story.json"
    write(output,chapter)
    report = dict(schema="seventh-seal-chapter-story-export",version=1,
        source_hashes=hashes,source_unchanged=True,original_save_used=False,original_game_execution_observed=False,
        output_path=output.relative_to(ROOT).as_posix(),output_sha256=sha(output.read_bytes()),
        map_record_counts={ident:group["record_count"] for ident,group in maps.items()},
        program_command_counts={ident:len(program["commands"]) for ident,program in programs.items()},
        item_definition_ids=ITEM_IDS,role_definition_ids=list(PLAYER_IDS),
        search_boundary=dict(maps=list(MAP_IDS), programs=list(ANM_IDS), items=ITEM_IDS),
        limitations=limits)
    write(RUNTIME / "evidence/chapter_story_export.json",report)
    print(json.dumps(dict(maps=report["map_record_counts"],programs=report["program_command_counts"],
                         items={key:value["name"] for key,value in definitions.items()},source_unchanged=True),ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    export()
