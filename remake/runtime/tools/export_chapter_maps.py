"""Export registered rectangular maps and source-bound physical transitions.

Maps owned by an established opening/route exporter keep their existing files.
New maps use the chapter exporter by default. Compact 0x2B descriptors use the
retained 0x4A5F00 loader's byte-to-DWORD expansion, never a guessed offset.
"""
from __future__ import annotations

from collections import defaultdict
import json
from pathlib import Path
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / "tools"))
import export_maps
from route_export_maps import RouteMapBackground
from route_extract_resources import map_record, tlk_record
from source.dgp import DGP, DGPError
from source.map_objects import MapObjects
from map_npc_fields import initial_npc_visibility
from PIL import Image
from content_registration import role_ids as registered_role_ids, map_ids, map_exports

LOADER = "ev_18893b05019e3c8a7fc6989b91972feddeb54b0118896397c96cacc974e60f1a"
ENTRY = export_maps.EVIDENCE["entry_assembly"]
OBJECT_TICK = "ev_7ff7092a0522a10920b1c81430af56c62cb116c3d66a5af86a35ecb5e9498a5c"


def physical_edges(ids, backgrounds, registered):
    """Only native state0 DAT exits into admitted maps; never infer TLK routes."""
    targets = {f'{ident.lower()}.dat': ident for ident in registered}
    return [(origin, descriptor['id'], targets[descriptor['filename_raw'].lower()])
            for origin in ids for descriptor in transition_descriptors(backgrounds[origin])[0]
            if descriptor['state_raw'] == 0 and descriptor['filename_raw'].lower() in targets]


def u32(b, offset):
    return struct.unpack_from("<I", b, offset)[0]


def transition_descriptors(bg):
    b = bg.data
    record_bytes = 0x42 if u32(b, 0x18) == 1 else 0x2B
    start = bg.grid_end + 32 * 0x2A
    cells = defaultdict(list)
    for y in range(bg.height):
        for x in range(bg.width):
            ident = u32(b, 0x172 + (y * bg.width + x) * 64 + 0x38)
            if ident:
                if not 1 <= ident <= 32:
                    raise DGPError("Chapter descriptor index is outside the native table")
                cells[ident].append(dict(x=x, y=y))
    descriptors, triggers = [], []
    for ident, positions in sorted(cells.items()):
        offset = start + (ident - 1) * record_bytes
        raw = b[offset:offset + record_bytes]
        if len(raw) != record_bytes:
            raise DGPError("Truncated chapter transition table")
        compact = record_bytes == 0x2B
        descriptor = dict(id=ident, offset=offset, bytes=record_bytes, state_raw=raw[0],
                          filename_raw=raw[0x11:0x26].split(b"\0")[0].decode("ascii", "strict"),
                          field_26_raw=raw[0x26] if compact else u32(raw, 0x26),
                          field_2a_raw=raw[0x27] if compact else u32(raw, 0x2A),
                          field_2e_raw=raw[0x28] if compact else u32(raw, 0x2E),
                          compact_source_offsets=[0x26, 0x27, 0x28] if compact else None,
                          field_expansion_evidence=LOADER if compact else None,
                          cells=positions, path_gate=raw[0] == 0 and raw[0x11] != 0,
                          descriptor_hex=raw.hex())
        descriptors.append(descriptor)
        triggers.extend({**pos, "id": ident, "state_raw": raw[0],
                         "path_gate": descriptor["path_gate"], "descriptor_hex": raw.hex()}
                        for pos in positions)
    return descriptors, triggers


def npcs(detail):
    result = []
    for npc in detail["npc_table"]["records"]:
        raw = bytes.fromhex(npc["raw_hex"])
        result.append(dict(id=f"{detail['id']}-role-{npc['slot_zero_based']}",
                           slot_zero_based=npc["slot_zero_based"],
                           speaker_slot_one_based=npc["slot_zero_based"] + 1,
                           name=npc["name_cp950"], resource_id=f"{npc['resource_id']:03}",
                           x=npc["x_native"] * 2, y=npc["y_native"] * 2,
                           x_native=npc["x_native"], y_native=npc["y_native"],
                           direction=npc["direction"], direction_raw_45=npc["direction"],
                           **initial_npc_visibility(raw),
                           raw_field_41=u32(raw, 0x41), action_mode_raw_2f=raw[0x2F],
                           animation_index_raw_83=u32(raw, 0x83), frame_index_raw_7b=u32(raw, 0x7B),
                           actor_mode_raw_f0=raw[0xF0], behavior_raw_c5=raw[0xC5],
                           behavior_state_raw_f5=raw[0xF5], movement_direction_raw_2b1=raw[0x2B1],
                           blend_mode_raw_4bd=raw[0x4BD],
                           source=dict(path=detail["path"], sha256=detail["sha256"],
                                       offset=npc["offset"], bytes=0x4C5)))
    return result


def role_graphics(role_id, outputs):
    name = f"ROLE/{role_id}.dgp"
    dgp = DGP(ROOT / name)
    actions = []
    for action in dgp.actions:
        frames, dirs = action["frames_per_direction"], action["directions"]
        if frames <= 0 or dirs <= 0:
            raise DGPError("Chapter role has an empty action group")
        sheet = Image.new("RGBA", (dgp.width * frames, dgp.height * dirs))
        for direction in range(dirs):
            for frame in range(frames):
                sheet.paste(dgp.decode(action["first_frame"] + direction * frames + frame),
                            (frame * dgp.width, direction * dgp.height))
        target = RUNTIME / f"web/assets/chapter_roles/{role_id}/action_{action['index']:02}.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(target)
        outputs[export_maps.web_url(target)] = export_maps.sha(target)
        raw = dgp.raw_actions[action["index"]]
        uses_sequence = (raw[0x0D] & 0x0F) == 0
        count = u32(raw, 0x12) if uses_sequence else frames
        sequence = list(raw[0x16:0x72])
        indexes = sequence[:count] if uses_sequence else list(range(frames))
        if (uses_sequence and count > len(sequence)) or any(i >= frames for i in indexes):
            raise DGPError("Chapter role logical frame sequence exceeds physical frames")
        actions.append(dict(index=action["index"], sheet=export_maps.web_url(target),
                            sha256=outputs[export_maps.web_url(target)], frame_count=frames,
                            directions=dirs, first_frame=action["first_frame"],
                            interval_raw=action["interval_raw"], loop_raw=action["loop_raw"],
                            raw_hex=action["raw_hex"], sequence_length_raw=u32(raw, 0x12),
                            sequence_raw=sequence, uses_sequence=uses_sequence, logical_count=count,
                            logical_frames=[dict(logical_index=i, physical_frame=physical,
                                                 hold_interval_raw=action["interval_raw"])
                                            for i, physical in enumerate(indexes)],
                            sequence_rule="(raw+0x0D &0x0F)==0 selects byte+0x16+logical_index; otherwise logical_index. Add first_frame and direction*physical_frame_count.",
                            sequence_evidence=["ev_0ffb771246c6d16325580fe6f266e66f57fbb84cfe7a3be766ff48234043fbab"],
                            source_offset=0x43 + action["index"] * 0xAC))
    return dict(id=role_id, name=dgp.metadata()["name_cp950"],
                source=dict(path=name, sha256=dgp.sha256), frame_width=dgp.width,
                frame_height=dgp.height, anchor=dict(x=dgp.anchor_raw[0], y=dgp.anchor_raw[1]),
                actions=actions, limitation="DGP action indexes are zero-based; exact native blend/timing remains unobserved")


def exit_record(origin, ident, destination, bg, detail):
    descriptor = next(d for d in transition_descriptors(bg[origin])[0] if d["id"] == ident)
    if descriptor["state_raw"] != 0 or descriptor["filename_raw"].lower() != destination.lower() + ".dat":
        raise DGPError("Reviewed chapter transition changed")
    marker, code = descriptor["field_26_raw"], descriptor["field_2a_raw"]
    scanned = detail[destination]["entry_markers"].get(marker, [])[:4]
    if not scanned:
        raise DGPError("No native entry marker; no substitute coordinate is permitted")
    placement = list(scanned)
    direction, order = 2, "row-major scan; first four; missing followers repeat last observed cell"
    if code in (2, 6):
        placement.sort(key=lambda c: -c["y"])
        direction, order = 6 + int(code == 6), "y descending; stable ties"
    elif code in (3, 7):
        placement.sort(key=lambda c: c["x"])
        direction, order = 4 + int(code == 7), "x ascending; stable ties"
    elif code in (4, 8):
        placement.sort(key=lambda c: -c["x"])
        direction, order = int(code == 8), "x descending; stable ties"
    elif code not in (0, 1, 5):
        raise DGPError("Chapter entry sort code not covered")
    cell = placement[0]
    b = bg[destination].data
    if b[cell["offset"] + 0x20] != 0 or u32(b, cell["offset"] + 0x38) != 0:
        raise DGPError("Exact chapter entry is terrain/transition blocked")
    return dict(id=ident, state="ready", cells=descriptor["cells"], target_map=destination,
                entry=dict(x=cell["x"] * 16, y=cell["y"] * 16, direction=direction,
                           cell_x=cell["x"], cell_y=cell["y"],
                           native_x=cell["x"] << 3, native_y=cell["y"] << 3),
                conditions=[], source=dict(path=detail[origin]["path"], sha256=detail[origin]["sha256"],
                  descriptor_offset=descriptor["offset"], descriptor_bytes=descriptor["bytes"],
                  descriptor_hex=descriptor["descriptor_hex"],
                  compact_field_expansion_evidence=descriptor["field_expansion_evidence"],
                  target_path=detail[destination]["path"], target_sha256=detail[destination]["sha256"],
                  target_entry_marker=marker, entry_sort_code=code,
                  entry_scan_cells=[dict(x=c["x"], y=c["y"], offset=c["offset"]) for c in scanned],
                  entry_sorted_cells=[dict(x=c["x"], y=c["y"]) for c in placement], entry_sort=order,
                  default_direction_assembly="0x4A5144: MOV byte ptr [EBP-0x28],0x2",
                  coordinate_rule="first native sorted marker cell <<3, then native coordinate x2; no center offset",
                  native_evidence={k: export_maps.EVIDENCE[k] for k in ("transition_execute", "transition_load", "entry_scan", "entry_assembly")}),
                execution="Native transition descriptor only; map-entry TLK/ANM and their once-only checks must complete separately.",
                limitations=["Static source/code evidence; original timing not observed", "Continuous keyboard movement is runtime policy"])


def retain_evidence():
    wanted = {LOADER, ENTRY, OBJECT_TICK, export_maps.EVIDENCE["transition_execute"], export_maps.EVIDENCE["transition_load"]}
    records = {}
    for path in (RUNTIME / "evidence/forest_ai_native_20261011.json", RUNTIME / "evidence/map_native_20261011.json",
                 RUNTIME / "evidence/chapter_native.json"):
        for record in json.loads(path.read_text(encoding="utf-8")).get("records", []):
            if record.get("evidence_id") in wanted:
                if record.get("subject", {}).get("digest", {}).get("sha256") != export_maps.GAME_SHA:
                    raise DGPError("Chapter evidence executable identity mismatch")
                records[record["evidence_id"]] = record
    if set(records) != wanted:
        raise DGPError("Chapter native evidence is incomplete")
    export_maps.write_json(RUNTIME / "evidence/chapter_map_native.json",
        dict(schema="seventh-seal-chapter-map-native", target_sha256=export_maps.GAME_SHA,
             authority="Retained native static analysis; not original runtime observation",
             records=list(records.values()), limitations=["No original executable was launched"]))


def export():
    policies = map_exports()
    IDS = tuple(ident for ident, policy in policies.items() if policy['assets'] == 'chapter' or policy['story'])
    NEW_MAPS = map_ids('assets')
    detail = {ident: map_record(ROOT / f"Map/{ident.lower()}.dat", True) for ident in IDS}
    bg = {ident: RouteMapBackground(ROOT / detail[ident]["path"]) for ident in IDS}
    EDGES = physical_edges(IDS, bg, policies)
    for target in {target for _, _, target in EDGES} - set(detail):
        detail[target] = map_record(ROOT / f'Map/{target.lower()}.dat', True)
        bg[target] = RouteMapBackground(ROOT / detail[target]['path'])
    sources = {"GAME.exe"}
    sources.update(row['path'] for row in detail.values())
    opening = json.loads((RUNTIME / "web/data/opening_map_resources.json").read_text(encoding="utf-8"))
    role_ids = set(registered_role_ids('player'))
    for ident in IDS:
        sources.update((detail[ident]["path"], f"Map/{ident.lower()}.TLK"))
        role_ids.update(f"{npc['resource_id']:03}" for npc in detail[ident]["npc_table"]["records"])
    sources.update(f"ROLE/{ident}.dgp" for ident in role_ids)
    for ident in NEW_MAPS:
        sources.update(export_maps.background_names(bg[ident]))
        sources.update(export_maps.source_path(p) for p in (ROOT / "mapm" / ident.lower()).glob("*.dgp"))
    before = {name: export_maps.sha(ROOT / name) for name in sorted(sources)}
    if before["GAME.exe"] != export_maps.GAME_SHA:
        raise DGPError("Chapter executable differs from retained native evidence")
    retain_evidence()
    outputs = {}
    roles = {ident: opening["roles"][ident] for ident in sorted(role_ids) if ident in opening["roles"]}
    for ident in sorted(role_ids - set(roles)):
        roles[ident] = role_graphics(ident, outputs)
    parsed = {name: DGP(ROOT / name) for name in sorted(sources)
              if name.lower().endswith(".dgp") and not name.startswith("ROLE/")}
    export_maps.MapBackground = RouteMapBackground
    export_maps.transition_descriptors = transition_descriptors
    exits = defaultdict(list)
    for origin, ident, target in EDGES:
        exits[origin].append(exit_record(origin, ident, target, bg, detail))
    maps = []
    npc_tables = {ident: npcs(detail[ident]) for ident in IDS}
    for ident in NEW_MAPS:
        record = export_maps.export_map(ident, parsed, outputs)
        record["background"]["assembly"]["rows"] = (detail[ident]["height_cells"] + 1) // 2
        record["background"]["assembly"]["columns"] = (detail[ident]["width_cells"] + 1) // 2
        record["background"]["assembly"]["odd_size_policy"] = "Native tile-origin loops; clip beyond exact DAT dimensions"
        record["chapter_npcs"] = npc_tables[ident]
        record["opening_npcs"] = npc_tables[ident]
        record["map_flag_index"] = detail[ident]["flag_index"]
        record["exits"] = exits[ident]
        enabled = {e["id"] for e in exits[ident]}
        record["unresolved_triggers"] = [d for d in record["unresolved_triggers"] if d["id"] not in enabled]
        record["limitations"].append("NPC source defaults require chapter TLK/ANM changes; asset export executes no story")
        target = RUNTIME / f"web/data/maps/{ident.lower()}.json"
        export_maps.write_json(target, record)
        outputs[export_maps.web_url(target)] = export_maps.sha(target)
        maps.append(dict(id=ident, name=record["name"], path=f"/data/maps/{ident.lower()}.json"))
    global_slots = {}
    for ident in IDS:
        table = tlk_record(ROOT / f"Map/{ident.lower()}.TLK")
        slot = next((s for s in table["index_nonzero"] if s["slot"] == 499), None)
        if slot:
            global_slots[ident] = dict(record=slot["record"], index_slot=499,
                source=dict(path=table["path"], sha256=table["sha256"], offset=slot["offset"]),
                map_flag_index=detail[ident]["flag_index"],
                status="Resource-observed TLK slot499; it does not prove automatic map entry or object interaction semantics")
    trigger_regions = {}
    interactive_objects = {}
    object_animations = {}
    for ident in IDS:
        trigger_regions[ident] = [d for d in transition_descriptors(bg[ident])[0] if d["state_raw"] == 2]
        table = MapObjects(ROOT / detail[ident]["path"])
        interactive_objects[ident] = []
        for obj in table.objects:
            raw = bytes.fromhex(obj["raw_hex"])
            if raw[0xCF] < 2 and u32(raw, 0xF6) == 0:
                continue
            interactive_objects[ident].append(dict(object_index_zero_based=obj["index"],
                object_number_one_based=obj["index"] + 1, resource_id=f"{obj['resource_identifier_raw']:03}",
                x=obj["x_native"] * 2, y=obj["y_native"] * 2,
                behavior_raw_cf=raw[0xCF], state_raw_d0=raw[0xD0],
                field_f6_raw=u32(raw, 0xF6), field_fa_raw=u32(raw, 0xFA),
                source=dict(path=detail[ident]["path"], sha256=detail[ident]["sha256"],
                            offset=obj["offset"], bytes=0x112, raw_hex=obj["raw_hex"]),
                status="Raw interactive-object candidates; native selection/TLK/state timing must be corroborated"))
        if ident in NEW_MAPS:
            object_animations[ident] = []
            for obj in interactive_objects[ident]:
                name = f"mapm/{ident.lower()}/{obj['resource_id']}.dgp"
                dgp = parsed[name]
                frame_records = []
                for frame in range(dgp.frame_count):
                    target = RUNTIME / f"web/assets/chapter_objects/{ident.lower()}/{obj['resource_id']}/frame_{frame:03}.png"
                    target.parent.mkdir(parents=True, exist_ok=True)
                    dgp.decode(frame).save(target)
                    outputs[export_maps.web_url(target)] = export_maps.sha(target)
                    frame_records.append(dict(index=frame, image=export_maps.web_url(target),
                                              sha256=outputs[export_maps.web_url(target)]))
                object_animations[ident].append(dict(object_index_zero_based=obj["object_index_zero_based"],
                    object_number_one_based=obj["object_number_one_based"], resource_id=obj["resource_id"],
                    source=dict(path=name, sha256=dgp.sha256), frames=frame_records,
                    frame_width=dgp.width, frame_height=dgp.height, actions=dgp.actions,
                    completed_last_frame=dgp.frame_count - 1,
                    evidence=[OBJECT_TICK],
                    authority="Original DGP physical frames; retained 0x4137C0 proves CF3 state2 progresses to state3 at its final animation frame; exact clock phase remains unobserved"))
    manifest = dict(schema="seventh-seal-chapter-map-resources", version=1, maps=maps,
                    roles=roles, npcs_by_map=npc_tables, exits_by_map=dict(exits),
                    global_object_tlk=global_slots, trigger_regions=trigger_regions,
                    interactive_objects=interactive_objects, object_animations=object_animations,
                    map_entry_tlk_header_raw={ident:dict(offset=0x11E, bytes=4,
                        raw_hex=bg[ident].data[0x11E:0x122].hex(), value=u32(bg[ident].data, 0x11E),
                        source=dict(path=detail[ident]["path"], sha256=detail[ident]["sha256"])) for ident in IDS},
                    authority="Original DAT/TLK/DGP plus retained native static loading/entry rules",
                    limitations=["Only native state0 DAT edges into registered maps are provided; TLK/ANM routes stay separate", "No original execution observed",
                                 "Map entry and chapter mutation execution is a separate runtime responsibility"])
    target = RUNTIME / "web/data/chapter_map_resources.json"
    export_maps.write_json(target, manifest)
    outputs[export_maps.web_url(target)] = export_maps.sha(target)
    after = {name: export_maps.sha(ROOT / name) for name in sorted(sources)}
    if before != after:
        raise DGPError("Read-only chapter inputs changed")
    report = dict(schema="seventh-seal-chapter-map-export", version=1,
                  source_hashes=before, source_hashes_after=after, source_unchanged=True,
                  output_hashes=outputs, new_maps=maps,
                  reviewed_edges=[dict(map_id=o, descriptor=i, destination=t,
                                       entry=next(e["entry"] for e in exits[o] if e["id"] == i)) for o, i, t in EDGES],
                  native_bundle="remake/runtime/evidence/chapter_map_native.json",
                  limits=["Maps with assets=existing retain their owning exporter files", "No story commands executed", "No original execution observed"])
    export_maps.write_json(RUNTIME / "evidence/chapter_map_export.json", report)
    print(json.dumps(dict(source_unchanged=True, new_maps=NEW_MAPS, roles=list(roles),
                          edges=report["reviewed_edges"], outputs=len(outputs)), ensure_ascii=False))


if __name__ == "__main__":
    export()
