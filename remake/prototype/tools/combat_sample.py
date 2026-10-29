"""Prepare role-state references and a user-reported combat-sample plan.

This does not load the game, modify a save, or assert a reproducible battle.
It reuses the runtime source parsers and records unresolved runtime steps.
Historical saves and analysis evidence remain separate, read-only inputs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
HISTORICAL_INPUTS = ROOT / "save_analysis_20261010"
TOOLS = ROOT / "remake/runtime/tools"
sys.path.insert(0, str(TOOLS))
from source.save_format import complete_layout, inventory  # noqa: E402
from source.inspect_equipment import describe_equipment  # noqa: E402

SAVES = (
    ("verified_level12_SaveGame0.Dat", "verified_level12_results.json", "source_sha256"),
    ("verified_ultimate_weapons_SaveGame0.Dat", "verified_ultimate_weapons_results.json", "active_sha256"),
)
NATIVE_EVIDENCE = {
    "header": "ev_eaaad0c04cbf044c873c7d22e0c4b5dc0a2f72f4411a81cd08012d06069a8517",
    "map_objects_write": "ev_eca76746ed72c81b59899e4de6ec817963d2125cadce51e7d78b2d59c75ae0b8",
    "map_objects_read": "ev_0f06d08a166a0c4675f1cd07686802fb06fedcd66474a3b033f7c614b14f1027",
}


def fingerprint(path: Path) -> dict:
    data = path.read_bytes()
    return {"path": path.relative_to(ROOT).as_posix(), "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest()}


def u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def cstring(data: bytes, start: int, length: int, encoding: str) -> dict:
    raw = data[start:start + length].split(b"\0", 1)[0]
    try:
        value = raw.decode(encoding, errors="strict")
    except UnicodeDecodeError:
        value = None
    return {"offset": start, "offset_hex": hex(start), "raw_hex": raw.hex(),
            "encoding": encoding, "value": value}


def object_observation(data: bytes, offset: int, dynamic_index: int) -> dict:
    raw = data[offset:offset + 0x4C5]
    resource = cstring(data, offset, 20, "ascii")
    if resource["value"] is not None and not resource["value"].isdigit():
        resource["value"] = None
    return {
        "dynamic_index": dynamic_index,
        "npc_index": dynamic_index - 10 if dynamic_index >= 10 else None,
        "record_offset": offset, "record_offset_hex": hex(offset),
        "record_length": len(raw), "record_sha256": hashlib.sha256(raw).hexdigest(),
        "resource_text_candidate": resource,
        "label_cp950": cstring(data, offset + 20, 20, "cp950"),
        "raw_u32_fields": {hex(field): {"offset": offset + field,
                                           "value": u32(data, offset + field)}
                           for field in (0x28, 0x30, 0x34, 0x6F, 0x73)},
        "status": "serialized_map_object_only; not_ordinary_combat_evidence",
    }


def describe_candidate(filename: str, report_name: str, digest_key: str) -> dict:
    path = HISTORICAL_INPUTS / filename
    data = path.read_bytes()
    report = json.loads((HISTORICAL_INPUTS / report_name).read_text(encoding="utf-8-sig"))
    digest = hashlib.sha256(data).hexdigest()
    if digest != report[digest_key]:
        raise ValueError(f"Previously verified snapshot digest changed: {filename}")
    layout = complete_layout(data)
    section = next(s for s in layout["sections"] if s["section"] == "map_objects")
    map_start = section["offset"]
    count_offset = map_start + 4 + 10 * 0x4C5
    npc_count = u32(data, count_offset)
    dynamic_start = count_offset + 4
    objects = [object_observation(data, dynamic_start + i * 0x4C5, i)
               for i in range(10 + npc_count)]
    actors = [{k: v for k, v in actor.items() if k != "skills"}
              for actor in layout["characters"] if actor["state_byte"] != 0]
    equipment = describe_equipment(path)
    equipment_observations = []
    for role in equipment["roles"]:
        if not role["state_byte"]:
            continue
        groups = []
        for group in role["groups"]:
            entries = []
            for entry in group["entries"]:
                item = {k: v for k, v in entry.items() if k != "raw_instance_hex"}
                item["raw_instance_sha256"] = hashlib.sha256(
                    bytes.fromhex(entry["raw_instance_hex"])).hexdigest()
                entries.append(item)
            groups.append({"group_index": group["group_index"], "entries": entries})
        equipment_observations.append({"role_index": role["role_index"],
                                       "name": role["name"], "groups": groups})
    return {
        "path": path.relative_to(ROOT).as_posix(), "sha256": digest,
        "size": len(data), "status": "role_state_reference_only; city_save_excluded_from_ordinary_combat_sample",
        "allowed_use": "Digest-bound character, equipment and inventory reference only.",
        "combat_exclusion": {"evidence_type": "user_reported",
                             "claim": "运炎河右岸 is a city and does not trigger ordinary encounters; encounters occur as movement-triggered hidden battles."},
        "prior_verification_report": (HISTORICAL_INPUTS / report_name).relative_to(ROOT).as_posix(),
        "prior_verification_digest_matches": True,
        "prior_user_verification_scope": (
            "level12 and YanLuo menu/use" if "level12" in filename
            else "ultimate weapons, seven slots, combo arrangement/use"),
        "complete_layout_reaches_eof": layout["reaches_eof"],
        "map_header": {
            "resource": cstring(data, 0x39, 20, "ascii"),
            "display_label": cstring(data, 0x4D, 20, "cp936"),
            "raw_globals": {hex(o): u32(data, o) for o in (0x61, 0x65, 0x69)},
            "native_header_evidence": NATIVE_EVIDENCE["header"],
        },
        "actors_with_nonzero_state_byte": actors,
        "actor_semantics_limit": "Stored character fields are not a proven effective battle-stat calculation.",
        "equipment": equipment_observations,
        "inventory": inventory(data),
        "serialized_map_objects": {
            "section_offset": map_start, "leader_raw_u32": u32(data, map_start),
            "fixed_template_count": 10, "npc_count": npc_count,
            "dynamic_object_count": 10 + npc_count,
            "dynamic_start": dynamic_start,
            "player_object_observation": objects[0], "npc_observations": objects[10:],
            "loader_limit": "0x4B2960 restores selected pre-load resource/event fields and recomputes fields; stored objects are not a complete runtime state.",
            "native_evidence": [NATIVE_EVIDENCE["map_objects_write"],
                                NATIVE_EVIDENCE["map_objects_read"]],
        },
        "enemy_candidates": [],
        "enemy_candidate_limit": "City map labels, including 獨腳蝠鳥 / resource text186, are map-object observations only and are excluded from the ordinary battle sample.",
    }


def build_report() -> dict:
    inputs = [ROOT / "GAME.exe", ROOT / "SYSTEM" / "Object.ITM",
              TOOLS / "source/save_format.py", TOOLS / "source/read_inventory.py",
              TOOLS / "source/inspect_equipment.py", HISTORICAL_INPUTS / "rea_format_evidence.json",
              HISTORICAL_INPUTS / "SaveGame0.full_parsed.json"]
    for filename, report_name, _ in SAVES:
        inputs.extend([HISTORICAL_INPUTS / filename, HISTORICAL_INPUTS / report_name])
    # Bounded shallow header inspection: no full-disk search or game loading.
    header_paths = sorted(HISTORICAL_INPUTS.glob("*.Dat"))
    header_paths.extend(p for p in (ROOT / "SaveGame0.Dat", ROOT / "SaveGame1.Dat") if p.is_file())
    inputs.extend(header_paths)
    inputs = list(dict.fromkeys(inputs))
    before = [fingerprint(p) for p in inputs]
    native = json.loads((HISTORICAL_INPUTS / "rea_format_evidence.json").read_text(encoding="utf-8-sig"))
    if before[0]["sha256"] != native["artifact"]["sha256"]:
        raise ValueError("GAME.exe no longer matches reused native evidence.")
    cached = json.loads((HISTORICAL_INPUTS / "SaveGame0.full_parsed.json").read_text(encoding="utf-8-sig"))
    candidates = [describe_candidate(*entry) for entry in SAVES]
    headers = []
    for path in header_paths:
        data = path.read_bytes()
        headers.append({"path": path.relative_to(ROOT).as_posix(),
                        "map_resource": cstring(data, 0x39, 20, "ascii"),
                        "map_label": cstring(data, 0x4D, 20, "cp936"),
                        "evidence_type": "serialized_header_bytes_only"})
    forest_headers = [h for h in headers if h["map_label"]["value"] == "白木森林"]
    after = [fingerprint(p) for p in inputs]
    if before != after:
        raise RuntimeError("An input changed while preparing candidates; no report written.")
    return {
        "format": "seventh-seal.combat-sample-candidates.v2", "assessment_date": "2026-10-11",
        "status": "partially_prepared; no_fixed_runtime_attack_sample",
        "scope": "Read-only historical-save inspection. No game execution, save load/install, save write, or new REA session.",
        "inputs_before": before, "inputs_after": after, "all_inputs_unchanged": True,
        "reused_sources": {
            "parser": "remake/runtime/tools/source/save_format.py",
            "equipment_parser": "remake/runtime/tools/source/inspect_equipment.py",
            "native_serialization": "save_analysis_20261010/rea_format_evidence.json",
            "cached_layout": {"path": "save_analysis_20261010/SaveGame0.full_parsed.json",
                              "reported_size": cached["length"],
                              "reported_map_npc_count": next(s["map_npc_count"] for s in cached["layout"]["sections"] if s["section"] == "map_objects"),
                              "limit": "Historical parsed layout is reused for context; it is not current active-save evidence."},
        },
        "candidates": candidates,
        "candidate_scope": "The two city snapshots are role-state references, not encounter candidates.",
        "user_reported_combat_context": {
            "evidence_type": "user_reported", "source": "current_conversation_user_correction",
            "claims": [
                "Ordinary battles are hidden encounters triggered while moving.",
                "运炎河右岸 is a city without ordinary encounters.",
                "白木森林 is an initial battle map; possible enemies include 狩猎者, 角鹰 and 雪泥怪.",
                "Enemies and attacks/skills have upper, middle and lower positions. Some enemies occupy middle+upper; a lower-targeting skill can miss them.",
            ],
            "limit": "These reports guide sample selection. This script has neither native encounter-table evidence nor original-game runtime observations for them.",
        },
        "bounded_save_header_search": {
            "boundary": "save_analysis_20261010/*.Dat plus active SaveGame0.Dat and SaveGame1.Dat; shallow inspection only",
            "inspected_count": len(headers), "headers": headers,
            "whitewood_forest_header_matches": forest_headers,
            "limit": "An absent match means only that these inspected header labels do not contain 白木森林; other saves, localized labels and route-to-map behavior are not covered.",
        },
        "recommended_first_candidate": {
            "path": None, "status": "user_reported_plan; forest_snapshot_and_attack_not_fixed",
            "map_name": "白木森林", "map_name_evidence_type": "user_reported",
            "map_resource_id": None, "encounter_trigger": "movement_hidden_encounter",
            "encounter_trigger_evidence_type": "user_reported",
            "possible_enemy_names": ["狩猎者", "角鹰", "雪泥怪"],
            "possible_enemy_names_evidence_type": "user_reported",
            "preferred_enemy": "雪泥怪", "preferred_enemy_status": "recommended_selection; not_observed",
            "attacker": "英格妮", "attacker_status": "recommended_selection; forest_actor_state_unverified",
            "snapshot_sha256": None, "start_coordinates": None, "movement_input_sequence": None,
            "enemy_distribution": None, "enemy_battle_id": None, "enemy_chr": None,
            "enemy_initial_hp": None, "enemy_occupied_positions": None,
            "attack_or_skill_name": None, "attack_target_positions": None,
            "position_field_offsets_and_encoding": None, "random_state": None,
            "reason": "Select one 雪泥怪 encounter in the user-reported initial map 白木森林, then fix the actual snapshot, movement route, encounter composition and a matching attack position. This is a proposed sample, not a recorded battle.",
        },
        "runtime_observations_needed": [
            {"id": "R1", "question": "Fix a 白木森林 snapshot, its SHA-256, map resource ID, actor/equipment/status fields and initial position; confirm that the same snapshot can be loaded repeatedly.", "status": "unobserved"},
            {"id": "R2", "question": "Record the exact movement route/inputs to a hidden encounter, its enemy distribution and observed composition; prefer one 雪泥怪 if available. Do repeated identical routes produce the same enemy group?", "status": "unobserved"},
            {"id": "R3", "question": "Does that encounter contain one enemy? Record enemy battle ID/CHR resource, initial HP, position, level and defense.", "status": "unobserved"},
            {"id": "R4", "question": "Which input executes a single ordinary attack, and how are combo slots, statuses and the other actor held constant?", "status": "unobserved"},
            {"id": "R5", "question": "Record one nonlethal attack: initial/remaining HP, damage text, hit/miss, action frames and hit timestamp.", "status": "unobserved"},
            {"id": "R6", "question": "Reload identical conditions and repeat at least three times; record variations and locate or bound RNG-state behavior.", "status": "unobserved"},
            {"id": "R7", "question": "Record a lethal attack, battle end and map return; confirm map position, HP and object/flag state afterward.", "status": "unobserved"},
            {"id": "R8", "question": "Record the target's occupied positions and the chosen ordinary attack or skill's upper/middle/lower target positions, skill name and underlying fields. Establish a matching-position sample before testing damage.", "status": "unobserved"},
            {"id": "R9", "question": "Under the same actor, target and status conditions, compare a matching-position attack with a mismatching-position attack; record miss text and unchanged HP for each repeat, and identify the position rejection branch independently of probabilistic hit checks.", "status": "unobserved"},
            {"id": "R10", "question": "Repeat a matching-position attack to investigate any probabilistic miss separately. A displayed miss alone does not identify position mismatch or RNG failure; retain an unknown reason unless branch/runtime evidence establishes it.", "status": "unobserved"},
        ],
        "conclusions": [
            {"type": "observation", "claim": "Both verified historical snapshots match their prior SHA-256 reports, parse to EOF, and contain M01060.DAT plus 运炎河右岸 in their headers."},
            {"type": "observation", "claim": "Both contain the same nonzero actor state fields: 英格妮 level12 HP960/960 MP72/72 attack60/60 defense44/44; 凯 level10 HP900/900 MP0/40 attack60/60 defense45/45."},
            {"type": "observation", "claim": "Each snapshot contains three serialized map records whose CP950 label is 獨腳蝠鳥 and resource text is 186, at dynamic indices20/21/22."},
            {"type": "user_reported", "claim": "运炎河右岸 is a city without ordinary encounters; 白木森林 uses movement-triggered hidden encounters with possible 狩猎者, 角鹰 and 雪泥怪."},
            {"type": "correction", "claim": "The former 獨腳蝠鳥 / map-object186 battle recommendation is withdrawn. Those city records remain serialization observations only."},
            {"type": "user_reported", "claim": "Attack/skill position compatibility matters: an enemy occupying middle+upper can be missed by a lower-targeting skill. Field encoding and native branching are not established here."},
            {"type": "unknown", "claim": "Enemy initial HP/defense, actual encounter composition, ordinary-attack input, RNG behavior, damage and repeatable load-to-attack steps remain unobserved."},
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path,
                        default=ROOT / "remake" / "prototype" / "evidence" / "combat_sample_20261011.json")
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to((ROOT / "remake").resolve()):
        parser.error("Output must remain inside remake; original inputs are read-only.")
    report = build_report()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "all_inputs_unchanged": report["all_inputs_unchanged"],
                      "candidate_count": len(report["candidates"]),
                      "enemy_candidate_counts": [len(c["enemy_candidates"]) for c in report["candidates"]],
                      "status": report["status"]}, ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
