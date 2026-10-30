"""Index Fire Valley source content without admitting maps or running scripts.

Map names nominate seeds. Their source DAT links establish region membership
within the nominated source family; filename prefix alone never admits a map.
Uninterpreted records, map variants and external dependencies remain visible.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / "tools"))
from route_extract_resources import anm_record, map_record, tlk_record, strings
from map_npc_fields import initial_npc_visibility

OUTPUT = RUNTIME / "web/data/library/fire_valley.json"
REPORT_OUTPUT = RUNTIME / "evidence/fire_valley_20261024/source_index.json"
REGION_LABEL = "火之谷"
SUPPORTED_TLK_KINDS = {0, 1, 2, 5}
SUPPORTED_CONDITIONS = {0, 1, 4, 10}
SUPPORTED_MUTATIONS = {0, 1, 2, 4, 5, 9, 10, 11, 14, 16, 17}
ENTRY_EVIDENCE = ["ev_18893b05019e3c8a7fc6989b91972feddeb54b0118896397c96cacc974e60f1a",
                  "ev_8564dce0fc083a81e920321518d1d32841a39c673640260fae4417f4fdb5f00b"]


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def u32(raw, offset):
    return struct.unpack_from("<I", raw, offset)[0]


def signed(value):
    return value if value < 0x80000000 else value - 0x100000000


def provenance(parsed, offset=None, size=None):
    result = {key: parsed[key] for key in ["path", "sha256"]}
    if offset is not None:
        result["offset"] = offset
    result["bytes"] = size if size is not None else parsed["bytes"]
    return result


def descriptors(parsed):
    table = parsed["fixed_sections"][1]
    result = []
    for entry in table["nonzero_records"]:
        raw = bytes.fromhex(entry["raw_hex"])
        compact = table["record_bytes"] == 0x2B
        filename = raw[0x11:0x26].split(b"\0")[0].decode("ascii", "replace")
        result.append({"id": entry["id"], "source_id": f"{parsed['id']}:DAT:descriptor:{entry['id']}",
                       "state_raw": raw[0], "filename_raw": filename,
                       "target_map_id": Path(filename).stem.upper() if filename.lower().endswith(".dat") else None,
                       "field_26_raw": raw[0x26] if compact else u32(raw, 0x26),
                       "field_2a_raw": raw[0x27] if compact else u32(raw, 0x2A),
                       "field_2e_raw": raw[0x28] if compact else u32(raw, 0x2E),
                       "raw_hex": raw.hex(), "record_bytes": len(raw),
                       "cells": [{"x": c["x"], "y": c["y"], "offset": c["offset"]}
                                 for c in parsed["trigger_cells"].get(entry["id"], [])],
                       "source": provenance(parsed, entry["offset"], len(raw))})
    return result


def discover_maps(catalog, details, region_label=REGION_LABEL, exact_label=False):
    """Return content/link-supported members and the exact admission reason."""
    seeds = {ident for ident, row in catalog.items()
             if (row.get("name") == region_label if exact_label else region_label in row.get("name", ""))}
    selected = set(seeds)
    edges = [(ident, d["target_map_id"], d["source_id"])
             for ident, row in details.items() for d in descriptors(row) if d["target_map_id"]]
    evidence = {ident: [{"kind": "source-map-label", "label": catalog[ident]["name"]}]
                for ident in sorted(seeds)}
    changed = True
    while changed:
        changed = False
        for origin, target, source_id in edges:
            if origin in selected and target in details and target not in selected:
                selected.add(target)
                evidence[target] = [{"kind": "source-DAT-link", "source_id": source_id, "related_map": origin}]
                changed = True
            elif target in selected and origin not in selected:
                selected.add(origin)
                evidence[origin] = [{"kind": "source-DAT-link", "source_id": source_id, "related_map": target}]
                changed = True
    return sorted(selected), evidence


def choice_records(record):
    if record["kind"] != 0 or record["style"] != 1:
        return []
    raw = bytes.fromhex(record["raw_hex"])
    return [{"index": index, "text": raw[at:at + 100].split(b"\0")[0].decode("gbk", "replace"),
             "target_record": u32(raw, at + 100), "source_offset": record["offset"] + at}
            for index in range(3) for at in [0x537 + index * 104]
            if any(raw[at:at + 104])]


def record_flag_refs(record, map_id, map_flag):
    refs = []
    source_id = f"{map_id}:TLK:{record['id']}"
    if record["condition_type"] == 0 and record["condition_bit"]:
        refs.append({"operation": "read", "index": record["condition_index"] or map_flag,
                     "bit": record["condition_bit"], "source_id": source_id})
    bit = signed(record["mutation_bit"])
    if record["mutation_type"] == 0 and bit:
        refs.append({"operation": "set" if bit > 0 else "clear", "index": record["mutation_index"] or map_flag,
                     "bit": abs(bit), "source_id": source_id})
    for ref in refs:
        ref["valid_runtime_range"] = 0 <= ref["index"] < 2000 and 1 <= ref["bit"] <= 32
    return refs


def dialogue_records(parsed, map_id, map_flag):
    result = []
    for record in parsed["records"]:
        choices = choice_records(record)
        raw = bytes.fromhex(record["raw_hex"])
        row = {**record, "source_id": f"{map_id}:TLK:{record['id']}",
               "condition_byte_raw_0b": raw[0x0B],
               "source": provenance(parsed, record["offset"], parsed["record_bytes"]),
               "choices": choices, "flag_refs": record_flag_refs(record, map_id, map_flag),
               "branch_targets": sorted({target for target in [record["if_true"], record["next"],
                                            *[choice["target_record"] for choice in choices]] if target})}
        if record["kind"] == 1:
            row["animation_reference"] = record["text_raw"].removesuffix(".anm").removesuffix(".ANM").lower()
        result.append(row)
    return result


def reachable_records(records, entry):
    by_id = {record["id"]: record for record in records}
    seen, pending = set(), [entry]
    while pending:
        ident = pending.pop()
        if ident in seen or ident not in by_id:
            continue
        seen.add(ident)
        pending.extend(by_id[ident]["branch_targets"])
    return sorted(seen)


def physical_map_graph(maps, region_label=REGION_LABEL):
    edges = [{"origin": ident, "destination": descriptor["target_map_id"],
              "descriptor_id": descriptor["id"], "source_id": descriptor["source_id"],
              "cell_count": len(descriptor["cells"]), "source": descriptor["source"]}
             for ident, row in maps.items() for descriptor in row["descriptors"]
             if descriptor["state_raw"] == 0 and descriptor["cells"] and descriptor["target_map_id"]]
    adjacent = {ident: set() for ident in maps}
    undirected = {ident: set() for ident in maps}
    for edge in edges:
        origin, target = edge["origin"], edge["destination"]
        if target in maps:
            adjacent[origin].add(target)
            undirected[origin].add(target)
            undirected[target].add(origin)
    def visit(graph, origin):
        seen, pending = set(), [origin]
        while pending:
            ident = pending.pop()
            if ident in seen:
                continue
            seen.add(ident)
            pending.extend(graph[ident] - seen)
        return sorted(seen)
    reachable = {ident: visit(adjacent, ident) for ident in maps}
    components, remaining = [], set(maps)
    while remaining:
        component = visit(undirected, min(remaining))
        components.append(component)
        remaining.difference_update(component)
    entries = [ident for ident, row in maps.items() if row["name"] == region_label + "入口"]
    return {"physical_exit_count": len(edges), "edges": edges, "undirected_components": components,
            "directed_reachable_from": reachable,
            "source_label_entry_maps": entries,
            "entry_unreachable_by_physical_exit": {ident: sorted(set(maps) - set(reachable[ident])) for ident in entries},
            "limits": "DAT state0 exits with grid cells only. Scripted TLK/ANM transfers and world-map routes are separate; undirected connection does not prove reachability."}


def source_program(parsed, supported, entry_maps=()):
    ident = Path(parsed["path"]).stem.lower()
    commands, current_map = [], None
    for record in parsed.get("records", []):
        raw = bytes.fromhex(record["raw_hex"])
        command = {**record, "source_id": f"{ident}:ANM:{record['index']}",
                   "source": provenance(parsed, record["offset"], parsed["record_bytes"]),
                   "runtime_declares_opcode": record["opcode_raw"] in supported,
                   "map_index_raw": u32(raw, 34)}
        command.update({f"u32_plus{offset}": u32(raw, offset) for offset in [1, 5, 9, 13, 17, 21, 25]})
        command.update({f"byte_plus{offset}": raw[offset] for offset in range(29, 34)})
        if record["opcode_raw"] == 10:
            filename = raw[54:74].split(b"\0")[0].decode("ascii", "replace")
            command["filename_raw"] = filename
            if filename.lower().endswith(".dat"):
                current_map = Path(filename).stem.upper()
        command["sequential_map_context"] = current_map
        command["possible_map_contexts"] = [current_map] if current_map else sorted(entry_maps)
        if record["opcode_raw"] in [33, 35, 48, 49]:
            command["actor_slot_raw"] = command["u32_plus5"]
            command["actor_effect"] = {33: "move", 35: "hide" if command["u32_plus1"] else "place",
                                       48: "animate", 49: "blend-and-reveal"}[record["opcode_raw"]]
        commands.append(command)
    return {"id": ident, "source": provenance(parsed), "structural_status": parsed.get("status", "partitioned"),
            "header_raw_hex": parsed.get("header_hex"), "commands": commands,
            "caller_entry_maps": sorted(entry_maps),
            "filename_references": [{**item, "offset": item["offset"]} for item in strings((ROOT / parsed["path"]).read_bytes())],
            "required_opcodes": sorted({c["opcode_raw"] for c in commands}),
            "not_declared_runtime_opcodes": sorted({c["opcode_raw"] for c in commands if not c["runtime_declares_opcode"]})}


def source_files(root=ROOT):
    """Deterministic original-input inventory, including unregistered sources."""
    return tuple(sorted(path.relative_to(root).as_posix()
                        for directory, suffixes in [("Map", {".dat", ".tlk"}), ("Animate", {".anm"})]
                        for path in (root / directory).glob("*")
                        if path.is_file() and path.suffix.lower() in suffixes))


def build_index(region_label=REGION_LABEL, region_id="fire-valley", exact_label=False,
                script_map_sources=()):
    catalog, hashes, failures = {}, {}, []
    paths = sorted(path for path in (ROOT / "Map").iterdir() if path.suffix.lower() == ".dat")
    for path in paths:
        try:
            row = map_record(path)
            catalog[path.stem.upper()] = row
            hashes[row["path"]] = row["sha256"]
        except (ValueError, struct.error) as error:
            raw = path.read_bytes()
            key = path.relative_to(ROOT).as_posix()
            hashes[key] = sha(raw)
            failures.append({"path": key, "error": str(error)})
    seeds = [ident for ident, row in catalog.items()
             if (row.get("name") == region_label if exact_label else region_label in row.get("name", ""))]
    if not seeds:
        raise ValueError(f"No source map label nominates {region_label}")
    # Prefix is only a bounded candidate search. Every admitted member requires
    # a matching source label or a DAT edge to an established member.
    families = {ident[:4] for ident in seeds}
    details = {}
    for ident, row in catalog.items():
        if ident in seeds or ident[:4] in families:
            try:
                parsed = map_record(ROOT / row["path"], detailed=True)
                if "unsupported" in parsed:
                    raise ValueError(parsed["unsupported"])
                details[ident] = parsed
            except (ValueError, struct.error) as error:
                failures.append({"path": row["path"], "error": str(error)})
    members, evidence = discover_maps(catalog, details, region_label, exact_label)
    all_programs = {}
    for path in sorted(path for path in (ROOT / "Animate").iterdir() if path.suffix.lower() == ".anm"):
        key = path.relative_to(ROOT).as_posix()
        hashes[key] = sha(path.read_bytes())
        try:
            all_programs[path.stem.lower()] = anm_record(path)
        except (ValueError, struct.error) as error:
            failures.append({"path": key, "error": str(error)})
    # A source script can establish an isolated map identity without a DAT
    # edge. These explicit source bindings never imply runtime admission.
    for map_id, program_id, command_index in script_map_sources:
        parsed = all_programs[program_id]
        command = next(row for row in parsed["records"] if row["index"] == command_index)
        raw = bytes.fromhex(command["raw_hex"])
        filename = raw[54:74].split(b"\0")[0].decode("ascii", "strict")
        if command["opcode_raw"] != 10 or filename.lower() != map_id.lower() + ".dat" or map_id not in details:
            raise ValueError(f"Script map source binding changed: {program_id}:{command_index} -> {map_id}")
        evidence.setdefault(map_id, []).append({"kind": "source-ANM-map-load",
            "source_id": f"{program_id}:ANM:{command_index}", "filename_raw": filename,
            "source": provenance(parsed, command["offset"], parsed["record_bytes"])})
        if map_id not in members:
            members.append(map_id)
    members.sort()
    animation_code = RUNTIME / "web/core/chapter_animation.mjs"
    compiler_code = RUNTIME / "web/core/story_flow_compiler.mjs"
    match = re.search(r"const OPCODES\s*=\s*new Set\(\[([\d,\s]+)\]\)", animation_code.read_text("utf-8"))
    if not match:
        raise ValueError("Cannot locate chapter animation declared opcode contract")
    supported = {int(value) for value in match[1].split(",") if value.strip()}

    # Scan all TLKs for incoming flag references and animation dependencies.
    # External TLK records are summarized only when they share an indexed flag.
    tlks = {}
    for path in sorted(path for path in (ROOT / "Map").iterdir() if path.suffix.lower() == ".tlk"):
        key = path.relative_to(ROOT).as_posix()
        hashes[key] = sha(path.read_bytes())
        try:
            tlks[path.stem.upper()] = tlk_record(path)
        except (ValueError, struct.error) as error:
            failures.append({"path": key, "error": str(error)})
    maps, region_flags, animation_refs = {}, set(), defaultdict(list)
    for ident in members:
        parsed, tlk = details[ident], tlks.get(ident)
        records = dialogue_records(tlk, ident, parsed["flag_index"]) if tlk else []
        index_slots = {entry["slot"]: entry for entry in tlk["index_nonzero"]} if tlk else {}
        npcs = []
        for npc in parsed["npc_table"]["records"]:
            raw = bytes.fromhex(npc["raw_hex"])
            slot = npc["slot_zero_based"]
            npcs.append({**npc, "id": f"{ident}:NPC:{slot}", "source_id": f"{ident}:DAT:NPC:{slot}",
                         "speaker_slot_one_based": slot + 1, "name": npc["name_cp950"],
                         "x_runtime": npc["x_native"] * 2, "y_runtime": npc["y_native"] * 2,
                         **initial_npc_visibility(raw),
                         "action_mode_raw_2f": raw[0x2F], "behavior_raw_c5": raw[0xC5],
                         "dialogue_index_entry": index_slots.get(slot),
                         "spoken_record_ids": [r["id"] for r in records if r["speaker"] == slot + 1],
                         "source": provenance(parsed, npc["offset"], parsed["npc_table"]["record_bytes"])})
        links = descriptors(parsed)
        for d in links:
            if d["filename_raw"].lower().endswith(".anm"):
                animation_refs[Path(d["filename_raw"]).stem.lower()].append(d["source_id"])
        for record in records:
            for ref in record["flag_refs"]:
                region_flags.add((ref["index"], ref["bit"]))
            if "animation_reference" in record:
                animation_refs[record["animation_reference"]].append(record["source_id"])
        header = bytes.fromhex(parsed["header_hex"])
        raw_dat = (ROOT / parsed["path"]).read_bytes()
        object_table = parsed["object_table"]
        objects = []
        for index in range(object_table["count"]):
            offset = object_table["offset"] + index * object_table["record_bytes"]
            raw = raw_dat[offset:offset + object_table["record_bytes"]]
            if len(raw) != 0x112:
                raise ValueError(f"Truncated regional object {ident}:{index}")
            objects.append({"index": index, "source_id": f"{ident}:DAT:object:{index}",
                            "resource_id_raw": u32(raw, 0x1E), "behavior_raw_cf": raw[0xCF],
                            "state_raw_d0": raw[0xD0], "interaction_record_raw_f6": u32(raw, 0xF6),
                            "raw_hex": raw.hex(), "source": provenance(parsed, offset, len(raw))})
        maps[ident] = {"id": ident, "name": parsed["name"], "membership_evidence": evidence[ident],
                       "source": provenance(parsed), "map_flag_index": parsed["flag_index"],
                       "width_cells": parsed["width_cells"], "height_cells": parsed["height_cells"],
                       "background_resources": parsed["background_resources"], "header_raw_hex": parsed["header_hex"],
                       "filename_references": strings((ROOT / parsed["path"]).read_bytes()),
                       "map_entry_record_raw": u32(header, 0x13A),
                       "map_entry_source": provenance(parsed, 0x13A, 4),
                       "map_entry_evidence": ENTRY_EVIDENCE,
                       "map_load_record_raw": u32(header, 0x8A),
                       "map_load_source": provenance(parsed, 0x8A, 4),
                       "map_load_evidence": [ENTRY_EVIDENCE[0]],
                       "header_11e_raw": u32(header, 0x11E), "npcs": npcs, "descriptors": links,
                       "objects": objects,
                       "dialogue": {"status": "parsed" if tlk else "source-file-absent",
                                    "source": provenance(tlk) if tlk else None,
                                    "index_nonzero": tlk["index_nonzero"] if tlk else [], "records": records,
                                    "trailing_bytes": tlk["trailing_bytes"] if tlk else None,
                                    "trailing_sha256": tlk["trailing_sha256"] if tlk else None},
                       "unresolved": {"condition_types": sorted({r["condition_type"] for r in records} - SUPPORTED_CONDITIONS),
                                      "mutation_types": sorted({r["mutation_type"] for r in records} - SUPPORTED_MUTATIONS),
                                      "record_kinds": sorted({r["kind"] for r in records} - SUPPORTED_TLK_KINDS),
                                      "branch_targets": sorted({t for r in records for t in r["branch_targets"]
                                                                if t > len(records)}),
                                      "map_targets": sorted({d["target_map_id"] for d in links
                                                             if d["target_map_id"] and d["target_map_id"] not in catalog})}}
        maps[ident]["entrypoints"] = [{"id": f"{ident}:TLK-index:{slot}", "kind": "npc" if any(n["slot_zero_based"] == slot for n in npcs) else "tlk-index-source",
                                       "index_slot": slot, "record_id": value["record"],
                                       "source": provenance(tlk, value["offset"], 4)}
                                      for slot, value in sorted(index_slots.items())]
        if maps[ident]["map_entry_record_raw"]:
            maps[ident]["entrypoints"].append({"id": f"{ident}:map-entry", "kind": "map-entry",
                                               "record_id": maps[ident]["map_entry_record_raw"],
                                               "source": maps[ident]["map_entry_source"]})
        if maps[ident]["map_load_record_raw"]:
            maps[ident]["entrypoints"].append({"id": f"{ident}:map-load", "kind": "map-load",
                                               "record_id": maps[ident]["map_load_record_raw"],
                                               "source": maps[ident]["map_load_source"]})
        maps[ident]["entrypoints"].extend({"id": descriptor["source_id"], "kind": "source-grid-tlk",
                                           "record_id": descriptor["field_26_raw"], "source": descriptor["source"]}
                                          for descriptor in links if descriptor["state_raw"] == 2
                                          and descriptor["cells"] and descriptor["field_26_raw"] > 0)

    selected_programs = {}
    for ident, parsed in all_programs.items():
        refs = strings((ROOT / parsed["path"]).read_bytes())
        linked = sorted({Path(r["text"]).stem.upper() for r in refs
                         if r["text"].lower().endswith(".dat") and Path(r["text"]).stem.upper() in maps})
        if ident in animation_refs or linked:
            selected_programs[ident] = (parsed, linked)
    # A regional filename can be invoked by a different region.  Selection is
    # bounded by actual regional dependencies; incoming callers never expand
    # region membership or imply that their maps are runtime-ready.
    external_callers = defaultdict(list)
    for map_id, table in tlks.items():
        if map_id in maps:
            continue
        projected = None
        for record in table["records"]:
            name = record["text_raw"].lower()
            ident = name[:-4] if record["kind"] == 1 and name.endswith(".anm") else None
            if ident not in selected_programs:
                continue
            source_id = f"{map_id}:TLK:{record['id']}"
            animation_refs[ident].append(source_id)
            if projected is None:
                projected = dialogue_records(table, map_id, catalog.get(map_id, {}).get("flag_index", 0))
            roots = [{"index_slot": row["slot"], "record_id": row["record"]}
                     for row in table["index_nonzero"]
                     if record["id"] in reachable_records(projected, row["record"])]
            external_callers[ident].append({"source_id": source_id, "map_id": map_id, "kind": "tlk-animation",
                "record_id": record["id"], "source": provenance(table, record["offset"], table["record_bytes"]),
                "index_roots": roots, "raw_hex": record["raw_hex"]})
    for map_id, row in catalog.items():
        if map_id in maps or "unsupported" in row:
            continue
        raw = (ROOT / row["path"]).read_bytes()
        if not any(ref["text"].lower().endswith(".anm")
                   and ref["text"][:-4].lower() in selected_programs for ref in strings(raw)):
            continue
        try:
            parsed = map_record(ROOT / row["path"], detailed=True)
            for descriptor in descriptors(parsed):
                name = descriptor["filename_raw"].lower()
                ident = name[:-4] if descriptor["state_raw"] == 1 and name.endswith(".anm") else None
                if ident in selected_programs:
                    animation_refs[ident].append(descriptor["source_id"])
                    external_callers[ident].append({"source_id": descriptor["source_id"], "map_id": map_id,
                        "kind": "dat-animation", "source": descriptor["source"], "cells": descriptor["cells"]})
        except (ValueError, struct.error) as error:
            failures.append({"path": row["path"], "error": str(error)})
    programs = {}
    for ident, (parsed, linked) in selected_programs.items():
        entry_maps = {source_id.split(":")[0] for source_id in animation_refs.get(ident, [])}
        programs[ident] = {**source_program(parsed, supported, entry_maps), "region_map_references": linked,
                           "referenced_by": sorted(set(animation_refs.get(ident, []))),
                           "external_callers": external_callers[ident]}
    for program in programs.values():
        for command in program["commands"]:
            if command["opcode_raw"] == 14:
                for map_id in command["possible_map_contexts"]:
                    if map_id in maps:
                        maps[map_id]["entrypoints"].append({"id": command["source_id"], "kind": "anm-tlk-call",
                                                           "record_id": command["u32_plus5"], "source": command["source"]})
    for map_id, row in maps.items():
        records = row["dialogue"]["records"]
        for entrypoint in row["entrypoints"]:
            entrypoint["reachable_record_ids"] = reachable_records(records, entrypoint["record_id"])
        for record in records:
            record["potential_call_roots"] = [entry["id"] for entry in row["entrypoints"]
                                               if record["id"] in entry["reachable_record_ids"]]
        row["unresolved_record_counts"] = {
            "condition_types": dict(sorted(Counter(str(r["condition_type"]) for r in records if r["condition_type"] not in SUPPORTED_CONDITIONS).items())),
            "mutation_types": dict(sorted(Counter(str(r["mutation_type"]) for r in records if r["mutation_type"] not in SUPPORTED_MUTATIONS).items())),
            "record_kinds": dict(sorted(Counter(str(r["kind"]) for r in records if r["kind"] not in SUPPORTED_TLK_KINDS).items()))}
        for npc in row["npcs"]:
            npc["dialogue_reachable_record_ids"] = reachable_records(records, npc["dialogue_index_entry"]["record"]) if npc["dialogue_index_entry"] else []
            npc["animation_effect_sources"] = [
                {"source_id": command["source_id"], "effect": command["actor_effect"],
                 "map_context_is_caller_inference": command["sequential_map_context"] is None}
                for program in programs.values() for command in program["commands"]
                if command.get("actor_slot_raw") == npc["slot_zero_based"]
                and map_id in command["possible_map_contexts"]]
    flag_index = defaultdict(list)
    for ident, table in tlks.items():
        if ident not in catalog or "flag_index" not in catalog[ident]:
            continue
        for record in table["records"]:
            for ref in record_flag_refs(record, ident, catalog[ident]["flag_index"]):
                if (ref["index"], ref["bit"]) in region_flags:
                    flag_index[f"{ref['index']}:{ref['bit']}"].append({**ref, "map_id": ident,
                        "inside_region": ident in maps, "source": provenance(table, record["offset"], table["record_bytes"])})
    variants = defaultdict(list)
    for ident, row in maps.items():
        variants[(tuple(row["background_resources"]), row["width_cells"], row["height_cells"])].append(ident)
    variant_groups = [{"maps": sorted(ids), "relation": "shared-source-background-and-dimensions",
                       "chronological_order": None} for ids in variants.values() if len(ids) > 1]
    capabilities = {}
    all_records = [record for row in maps.values() for record in row["dialogue"]["records"]]
    for field, known in [("kind", SUPPORTED_TLK_KINDS), ("condition_type", SUPPORTED_CONDITIONS), ("mutation_type", SUPPORTED_MUTATIONS)]:
        capabilities[field] = {str(value): {"count": sum(r[field] == value for r in all_records), "unresolved": value not in known,
                                          "source_ids": [r["source_id"] for r in all_records if r[field] == value],
                                          "representative": next({"source_id": r["source_id"], "potential_call_roots": r["potential_call_roots"]}
                                                                 for r in all_records if r[field] == value)}
                               for value in sorted({r[field] for r in all_records})}
    all_commands = [command for program in programs.values() for command in program["commands"]]
    capabilities["anm_opcode"] = {str(value): {"count": sum(c["opcode_raw"] == value for c in all_commands), "unresolved": value not in supported,
                                              "source_ids": [c["source_id"] for c in all_commands if c["opcode_raw"] == value]}
                                   for value in sorted({c["opcode_raw"] for c in all_commands})}
    graph = physical_map_graph(maps, region_label)
    if any(sha((ROOT / path).read_bytes()) != digest for path, digest in hashes.items()):
        raise ValueError("Read-only source changed during indexing")
    return {"schema": "seventh-seal-source-region-index", "version": 1, "id": region_id,
            "source_hashes": dict(sorted(hashes.items())),
            "provenance": {"parser_paths": ["remake/runtime/tools/route_extract_resources.py", "remake/runtime/tools/map_npc_fields.py"],
                           "extractor": {"path": Path(__file__).relative_to(ROOT).as_posix(), "sha256": sha(Path(__file__).read_bytes())},
                           "map_entry_evidence": ENTRY_EVIDENCE,
                           "original_game_execution_observed": False, "save_state_imported": False,
                           "capability_reference": {"path": animation_code.relative_to(ROOT).as_posix(),
                                                    "sha256": sha(animation_code.read_bytes()),
                                                    "declared_anm_opcodes": sorted(supported)},
                           "tlk_projection_reference": {"path": compiler_code.relative_to(ROOT).as_posix(),
                                                        "sha256": sha(compiler_code.read_bytes()),
                                                        "known_kinds": sorted(SUPPORTED_TLK_KINDS),
                                                        "known_conditions": sorted(SUPPORTED_CONDITIONS),
                                                        "known_mutations": sorted(SUPPORTED_MUTATIONS),
                                                        "authority": "Exporter projections of existing source adapter; unresolved fields remain raw.",
                                                        "kind2_scope": "Handler accepts a registered destination, literal DAT filename, entry marker 1..255 and an admitted current state2 trigger with source sort code 0..8. Handler availability does not admit all source records or paths."}},
            "coverage": {"map_headers_scanned": len(paths), "tlk_files_scanned": len(tlks),
                         "anm_files_scanned": len(all_programs), "maps": len(maps), "npc_instances": sum(len(m["npcs"]) for m in maps.values()),
                         "map_objects": sum(len(m["objects"]) for m in maps.values()),
                         "npc_instances_with_tlk_entry": sum(npc["dialogue_index_entry"] is not None for m in maps.values() for npc in m["npcs"]),
                         "npc_instances_without_tlk_entry": sum(npc["dialogue_index_entry"] is None for m in maps.values() for npc in m["npcs"]),
                         "maps_with_tlk": sum(m["dialogue"]["status"] == "parsed" for m in maps.values()),
                         "tlk_records": sum(len(m["dialogue"]["records"]) for m in maps.values()),
                         "programs": len(programs), "anm_commands": sum(len(p["commands"]) for p in programs.values()),
                         "physical_exits": graph["physical_exit_count"],
                         "shared_flags": len(flag_index), "source_bytes_unchanged": True,
                         "unlinked_candidates": sorted(set(details) - set(members)), "parse_failures": failures},
            "discovery": {"region_label": region_label, "label_seed_maps": sorted(seeds),
                          "label_match": "exact" if exact_label else "contains",
                          "candidate_filename_families": sorted(families),
                          "rule": "Source-label seeds plus undirected DAT descriptor links within candidate families. Prefix nominates candidates only."
                                  + (" Explicit opcode10 source bindings include isolated scripted maps." if script_map_sources else ""),
                          "map_catalog": {ident: row for ident, row in sorted(catalog.items())}},
            "maps": maps, "variant_groups": variant_groups, "programs": programs, "capability_summary": capabilities,
            "physical_map_graph": graph,
            "missing_animation_references": sorted(set(animation_refs) - set(all_programs)),
            "flags": dict(sorted(flag_index.items(), key=lambda pair: tuple(map(int, pair[0].split(":"))))),
            "limits": ["Source index membership does not register or enable runtime content.",
                       "NPC identity is map plus source slot. Names or graphics never merge people.",
                       "DAT positions/visibility are load defaults. ANM commands preserve later place/hide/move/reveal changes.",
                       "Variants remain separate map IDs and flag indices; shared assets do not establish temporal order.",
                       "Sequential ANM map context is a static aid. Map-index raw fields and unknown modes are retained; runtime feasibility is not inferred.",
                       "Potential call roots are structural reachability including every branch, not proof that a world state can reach that branch.",
                       "DAT+0x8A loader TLK and +0x13A arrival TLK are separate source roots; neither is replaced by TLK slot499.",
                       "Known flag projections include only TLK condition0/mutation0. Other condition/mutation semantics and external systems may add dependencies.",
                       "Missing TLK files are explicit source absence, not fabricated empty dialogue.",
                       "DAT descriptors retain literal targets, including unresolved truncated-looking names; no guessed route alias is applied.",
                       "All TLKs and ANMs are scanned for cross-region evidence. External DATs naming a selected regional ANM are decoded for incoming animation calls; arbitrary incoming map edges are not exhaustively decoded.",
                       "External animation callers retain source records and structural index roots. They do not register external maps, prove phase reachability or invent an entry checkpoint.",
                       "Runtime opcode declaration is not proof that every command mode, resource or story phase is supported.",
                       "No phase names, chronology, completion flags or world initial state are invented."]}


def query_index(data, text=None, map_id=None, flag=None, limit=50):
    if flag:
        return {"flag": flag, "references": data["flags"].get(flag, [])[:limit]}
    matches = []
    for ident, row in data["maps"].items():
        if map_id and ident != map_id.upper():
            continue
        if not text or text.casefold() in f"{ident} {row['name']}".casefold():
            matches.append({"kind": "map", "id": ident, "name": row["name"], "npc_count": len(row["npcs"]),
                            "dialogue_status": row["dialogue"]["status"], "unresolved": row["unresolved"]})
        for npc in row["npcs"]:
            if not text or text.casefold() in f"{npc['id']} {npc['name']}".casefold():
                matches.append({"kind": "npc", "id": npc["id"], "name": npc["name"],
                                "position": [npc["x_native"], npc["y_native"]], "hidden_on_load": npc["hidden"],
                                "dialogue_index_entry": npc["dialogue_index_entry"]})
        for record in row["dialogue"]["records"]:
            if text and text.casefold() in f"{record['source_id']} {record['text_raw']}".casefold():
                matches.append({"kind": "dialogue", "id": record["source_id"], "text": record["text_raw"],
                                "branch_targets": record["branch_targets"], "flag_refs": record["flag_refs"]})
    return {"total_matches": len(matches), "limit": limit, "matches": matches[:limit]}


def coverage_report(data, index_bytes, output=OUTPUT):
    unsupported_records = sorted({source_id for field in ["kind", "condition_type", "mutation_type"]
                                  for value in data["capability_summary"][field].values() if value["unresolved"]
                                  for source_id in value["source_ids"]})
    unsupported_commands = sorted({source_id for value in data["capability_summary"]["anm_opcode"].values()
                                   if value["unresolved"] for source_id in value["source_ids"]})
    return {"schema": "seventh-seal-source-region-coverage", "version": 1, "id": data["id"],
            "scope": "Static source index; runtime registration, branch execution and full playability are not certified.",
            "index": {"path": output.relative_to(ROOT).as_posix(), "sha256": sha(index_bytes)},
            "source_inventory_sha256": sha(encoded(data["source_hashes"])),
            "coverage": data["coverage"], "variant_groups": data["variant_groups"],
            "physical_map_graph": {key: data["physical_map_graph"][key] for key in ["physical_exit_count", "undirected_components", "source_label_entry_maps", "entry_unreachable_by_physical_exit", "limits"]},
            "maps": [{"id": ident, "name": row["name"], "map_flag_index": row["map_flag_index"],
                      "npc_instances": len(row["npcs"]),
                      "npc_dialogue_entries": sum(npc["dialogue_index_entry"] is not None for npc in row["npcs"]),
                      "tlk_status": row["dialogue"]["status"], "tlk_records": len(row["dialogue"]["records"]),
                      "load_record_8a": row["map_load_record_raw"], "arrival_record_13a": row["map_entry_record_raw"],
                      "unresolved_record_counts": row["unresolved_record_counts"]}
                     for ident, row in data["maps"].items()],
            "projection_gaps": {
                "tlk_distinct_record_count": len(unsupported_records), "tlk_source_ids": unsupported_records,
                "tlk_by_field": {field: {key: {"count": value["count"], "source_ids": value["source_ids"]}
                                         for key, value in data["capability_summary"][field].items() if value["unresolved"]}
                                 for field in ["kind", "condition_type", "mutation_type"]},
                "anm_distinct_command_count": len(unsupported_commands), "anm_source_ids": unsupported_commands,
                "anm_by_opcode": {key: {"count": value["count"], "source_ids": value["source_ids"]}
                                  for key, value in data["capability_summary"]["anm_opcode"].items() if value["unresolved"]},
                "meaning": "TLK gaps are fields not interpreted by this index projection; ANM gaps are opcodes absent from the referenced runtime declaration. Supported modes/resources still need independent checks."},
            "provenance": data["provenance"], "limits": data["limits"]}


def main(region_label=REGION_LABEL, region_id="fire-valley", exact_label=False,
         output=OUTPUT, report_output=REPORT_OUTPUT, script_map_sources=()):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify deterministic output without writing")
    parser.add_argument("--query", help="Search existing index for map, NPC or dialogue text")
    parser.add_argument("--map", dest="map_id", help="Filter existing-index query by exact source map ID")
    parser.add_argument("--flag", help="Query exact index:bit flag references from existing index")
    parser.add_argument("--limit", type=int, default=50)
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be positive")
    if args.query is not None or args.map_id or args.flag:
        print(json.dumps(query_index(json.loads(output.read_text("utf-8")), args.query, args.map_id, args.flag, args.limit), ensure_ascii=False))
        return
    data = build_index(region_label, region_id, exact_label, script_map_sources)
    raw = encoded(data)
    outputs = {output: raw, report_output: encoded(coverage_report(data, raw, output))}
    for path, value in outputs.items():
        if args.check:
            if not path.exists() or path.read_bytes() != value:
                raise ValueError(f"Source index output is missing or stale: {path.relative_to(ROOT)}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value)
    print(json.dumps({"passed": True, "check": args.check, **data["coverage"]}, ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
