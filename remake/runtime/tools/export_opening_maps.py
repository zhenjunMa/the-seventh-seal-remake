"""Export only the two maps and source roles used by Resurrect.ANM.

Original inputs remain read-only. This adds new map files and an independent
opening manifest; it does not alter the catalog or existing map index. Opcode
animation numbers are kept separate from zero-based DGP action indexes.
"""
from __future__ import annotations

import hashlib
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
from route_extract_resources import map_record
from source.dgp import DGP, DGPError
from map_npc_fields import initial_npc_visibility
from PIL import Image


def export():
    ids = ["M72061", "M17020"]
    sources = {"GAME.exe", "Animate/resurrect.anm", "ROLE/001.dgp"}
    detailed = {}
    for ident in ids:
        slug = ident.lower()
        dat_path = ROOT / "Map" / (slug + ".dat")
        bg = RouteMapBackground(dat_path)
        detailed[ident] = map_record(dat_path, detailed=True)
        sources.add(export_maps.source_path(dat_path))
        sources.update(export_maps.background_names(bg))
        sources.update(export_maps.source_path(p) for p in (ROOT / "mapm" / slug).glob("*.dgp"))
        for npc in detailed[ident]["npc_table"]["records"]:
            sources.add(f"ROLE/{npc['resource_id']:03}.dgp")
    before = {name: export_maps.sha(ROOT / name) for name in sorted(sources)}
    if before["GAME.exe"] != export_maps.GAME_SHA:
        raise DGPError("Opening source version differs from retained native evidence")
    parsed = {name: DGP(ROOT / name) for name in sorted(sources) if name.lower().endswith(".dgp")}
    export_maps.MapBackground = RouteMapBackground
    outputs = {}
    role_graphics = {}
    for name, dgp in parsed.items():
        if not name.startswith("ROLE/"):
            continue
        role_id = Path(name).stem
        actions = []
        # Export native frame partitions, without assigning ANM action semantics.
        for action in dgp.actions:
            frames, dirs = action["frames_per_direction"], action["directions"]
            if frames <= 0 or dirs <= 0:
                raise DGPError("Opening role has an unsupported empty action group")
            sheet = Image.new("RGBA", (dgp.width * frames, dgp.height * dirs))
            for direction in range(dirs):
                for frame in range(frames):
                    sheet.paste(dgp.decode(action["first_frame"] + direction * frames + frame),
                                (frame * dgp.width, direction * dgp.height))
            target = RUNTIME / f"web/assets/opening_roles/{role_id}/action_{action['index']:02}.png"
            target.parent.mkdir(parents=True, exist_ok=True)
            sheet.save(target)
            outputs[export_maps.web_url(target)] = export_maps.sha(target)
            raw_action = dgp.raw_actions[action["index"]]
            uses_sequence = (raw_action[0x0D] & 0x0F) == 0
            logical_count = struct.unpack_from("<I", raw_action, 0x12)[0] if uses_sequence else frames
            sequence_bytes = list(raw_action[0x16:0x72])
            logical_indexes = sequence_bytes[:logical_count] if uses_sequence else list(range(frames))
            if logical_count > len(sequence_bytes) or any(frame >= frames for frame in logical_indexes):
                raise DGPError("Opening role logical frame sequence is outside its physical frame group")
            actions.append(dict(index=action["index"], sheet=export_maps.web_url(target),
                                sha256=outputs[export_maps.web_url(target)],
                                frame_count=frames, directions=dirs,
                                first_frame=action["first_frame"], interval_raw=action["interval_raw"],
                                loop_raw=action["loop_raw"], raw_hex=action["raw_hex"],
                                sequence_length_raw=struct.unpack_from("<I", raw_action, 0x12)[0],
                                sequence_raw=sequence_bytes, uses_sequence=uses_sequence,
                                logical_count=logical_count,
                                logical_frames=[dict(logical_index=i, physical_frame=physical,
                                                     hold_interval_raw=action["interval_raw"])
                                                for i,physical in enumerate(logical_indexes)],
                                sequence_rule="(raw+0x0D &0x0F)==0 selects byte+0x16+logical_index; otherwise logical_index. Add first_frame and direction*physical_frame_count.",
                                sequence_evidence=["ev_0ffb771246c6d16325580fe6f266e66f57fbb84cfe7a3be766ff48234043fbab"],
                                source_offset=0x43+action["index"]*0xAC))
        role_graphics[role_id] = dict(id=role_id, name=dgp.metadata()["name_cp950"],
                                     source=dict(path=name, sha256=dgp.sha256),
                                     frame_width=dgp.width, frame_height=dgp.height,
                                     anchor=dict(x=dgp.anchor_raw[0], y=dgp.anchor_raw[1]), actions=actions,
                                     limitation="DGP action indexes are zero-based; ANM opcode48 action IDs require native mapping")
    maps = []
    for ident in ids:
        record = export_maps.export_map(ident, parsed, outputs)
        detail = detailed[ident]
        record["background"]["assembly"]["rows"] = (detail["height_cells"] + 1) // 2
        record["background"]["assembly"]["columns"] = (detail["width_cells"] + 1) // 2
        record["background"]["assembly"]["odd_size_policy"] = "Native tile-origin loops; pixels beyond real dimensions are clipped"
        record["opening_npcs"] = [dict(id=f"{ident}-role-{npc['slot_zero_based']}",
                                       slot_zero_based=npc["slot_zero_based"],
                                       speaker_slot_one_based=npc["slot_zero_based"] + 1,
                                       name=npc["name_cp950"], resource_id=f"{npc['resource_id']:03}",
                                       x=npc["x_native"] * 2, y=npc["y_native"] * 2,
                                       x_native=npc["x_native"], y_native=npc["y_native"],
                                       direction=npc["direction"], direction_raw_45=npc["direction"],
                                       **initial_npc_visibility(bytes.fromhex(npc["raw_hex"])),
                                       raw_field_41=struct.unpack_from("<I", bytes.fromhex(npc["raw_hex"]), 0x41)[0],
                                       action_mode_raw_2f=bytes.fromhex(npc["raw_hex"])[0x2F],
                                       animation_index_raw_83=struct.unpack_from("<I", bytes.fromhex(npc["raw_hex"]), 0x83)[0],
                                       frame_index_raw_7b=struct.unpack_from("<I", bytes.fromhex(npc["raw_hex"]), 0x7B)[0],
                                       actor_mode_raw_f0=bytes.fromhex(npc["raw_hex"])[0xF0],
                                       behavior_raw_c5=bytes.fromhex(npc["raw_hex"])[0xC5],
                                       behavior_state_raw_f5=bytes.fromhex(npc["raw_hex"])[0xF5],
                                       movement_direction_raw_2b1=bytes.fromhex(npc["raw_hex"])[0x2B1],
                                       blend_mode_raw_4bd=bytes.fromhex(npc["raw_hex"])[0x4BD],
                                       source=dict(path=detail["path"], sha256=detail["sha256"],
                                                   offset=npc["offset"], bytes=0x4C5))
                                   for npc in detail["npc_table"]["records"]]
        record["map_flag_index"] = detail["flag_index"]
        record["limitations"].append("Opening NPC positions are raw map defaults; Resurrect.ANM relocates and changes actors before control is returned")
        target = RUNTIME / f"web/data/maps/{ident.lower()}.json"
        export_maps.write_json(target, record)
        outputs[export_maps.web_url(target)] = export_maps.sha(target)
        maps.append(record)
    manifest = dict(schema="seventh-seal-opening-map-resources", version=1,
                    maps=[dict(id=m["id"], name=m["name"], path=f"/data/maps/{m['id'].lower()}.json") for m in maps],
                    roles=role_graphics,
                    authority="Source map/DGP data plus retained native rectangular rendering rules; not original runtime observation")
    target = RUNTIME / "web/data/opening_map_resources.json"
    export_maps.write_json(target, manifest)
    outputs[export_maps.web_url(target)] = export_maps.sha(target)
    after = {name: export_maps.sha(ROOT / name) for name in sorted(sources)}
    if before != after:
        raise DGPError("Read-only opening inputs changed during export")
    report = dict(schema="seventh-seal-opening-map-export", version=1,
                  source_hashes=before, source_hashes_after=after, source_unchanged=True,
                  output_hashes=outputs,
                  maps=[dict(id=m["id"], name=m["name"], width=m["width"], height=m["height"],
                             npcs=len(m["opening_npcs"]), objects=len(m["objects"]),
                             pending_descriptors=len(m["unresolved_triggers"])) for m in maps],
                  native_evidence=export_maps.EVIDENCE,
                  limits=["No catalog/map-index mutation", "No ANM opcode execution", "No original game runtime observation"])
    export_maps.write_json(RUNTIME / "evidence/opening_map_export_20261011.json", report)
    print(json.dumps(dict(source_unchanged=True, maps=report["maps"], role_resources=list(role_graphics),
                          outputs=len(outputs)), ensure_ascii=False))


if __name__ == "__main__":
    export()
