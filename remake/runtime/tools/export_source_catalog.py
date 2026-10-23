"""Export every shipped CHR role/skill as lossless, indexed source definitions.

Source catalogs do not admit content into runtime_content or enable handlers.
Original inputs are read only. Export is deterministic and --check is read only.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import json
from pathlib import Path
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / "tools"))
from source.catalog_chr import CatalogCHR, sha
from source.combat_resources import GAME_SHA256, HEADER_BYTES, SKILL_BYTES

NATIVE_PATH = RUNTIME / "evidence/source_library_20261023/native.json"
ROLE_OUTPUT = RUNTIME / "web/data/library/roles.json"
SKILL_OUTPUT = RUNTIME / "web/data/library/skills.json"
REPORT_OUTPUT = RUNTIME / "evidence/source_library_20261023/source_export.json"

HEADER_FIELDS = {
    "level": 0x24, "experience": 0x28, "next_level_experience": 0x2C,
    "hp_current": 0x30, "hp_maximum": 0x34, "mp_current": 0x38,
    "mp_maximum": 0x3C, "attack_current": 0x40, "attack_base": 0x44,
    "defense_current": 0x48, "defense_base": 0x4C,
    "speed_current": 0x58, "speed_base": 0x5C,
    "growth_row": 0x60, "experience_remaining": 0x64,
}


def read_json(path):
    return json.loads(path.read_text("utf-8"))


def rel(path):
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def exe_bytes_at_va(executable, address, count):
    """Map a retained 32-bit PE VA to actual on-disk bytes, without executing it."""
    pe = struct.unpack_from("<I", executable, 0x3C)[0]
    if executable[pe:pe + 4] != b"PE\0\0":
        raise ValueError("GAME.exe has no PE signature")
    sections = struct.unpack_from("<H", executable, pe + 6)[0]
    optional_size = struct.unpack_from("<H", executable, pe + 20)[0]
    optional = pe + 24
    if struct.unpack_from("<H", executable, optional)[0] != 0x10B:
        raise ValueError("Expected PE32 GAME.exe")
    base = struct.unpack_from("<I", executable, optional + 28)[0]
    rva = address - base
    for index in range(sections):
        at = optional + optional_size + index * 40
        virtual_size, virtual_address, raw_size, raw_at = struct.unpack_from("<4I", executable, at + 8)
        if virtual_address <= rva and rva + count <= virtual_address + min(virtual_size, raw_size):
            offset = raw_at + rva - virtual_address
            raw = executable[offset:offset + count]
            if len(raw) == count:
                return offset, raw
    raise ValueError("Retained native table VA is outside disk-backed PE data")


def native_sources():
    paths = [ROOT / "GAME.exe", ROOT / "SYSTEM/Object.ITM", NATIVE_PATH,
             RUNTIME / "evidence/opening_native.json", RUNTIME / "web/data/opening_seed.json"]
    hashes = {rel(path): sha(path.read_bytes()) for path in paths}
    if hashes["GAME.exe"] != GAME_SHA256:
        raise ValueError("GAME.exe differs from retained native evidence")
    native = read_json(NATIVE_PATH)
    records = native["records"]
    proof = {}
    for name, address in [("chr_layout", "0x4fed00"), ("player_slots", "0x4fdd00"),
                          ("optional_tail", "0x4ff480")]:
        record = next(row for row in records if row["operation"] == "procedure_pseudo_code"
                      and row["parameters"]["procedure"].lower() == address)
        if record["subject"]["digest"]["sha256"] != GAME_SHA256:
            raise ValueError(f"Native evidence binary drift: {address}")
        proof[name] = {"path": rel(NATIVE_PATH), "procedure": address,
                       "evidence_id": record["evidence_id"], "kind": "native-static"}
    record = next(row for row in records if row["operation"] == "read_bytes"
                  and row["parameters"].get("address") == "0x679c78")
    result = record["normalized_result"]
    if record["subject"]["digest"]["sha256"] != GAME_SHA256 or not result["complete"]:
        raise ValueError("Incomplete or mismatched growth table evidence")
    table = bytes.fromhex(result["bytes_hex"])
    if len(table) != 1040 or result["returned_bytes"] != len(table):
        raise ValueError("Expected two 100-DWORD experience tables and six ten-DWORD growth rows")
    table_offset, source_table = exe_bytes_at_va((ROOT / "GAME.exe").read_bytes(), 0x679C78, len(table))
    if source_table != table:
        raise ValueError("Retained growth bytes differ from actual GAME.exe")
    proof["growth_table"] = {"path": rel(NATIVE_PATH), "evidence_id": record["evidence_id"],
                             "address": "0x679c78", "file_offset": table_offset,
                             "bytes": len(table), "sha256": sha(table), "kind": "native-static"}
    seed = read_json(RUNTIME / "web/data/opening_seed.json")["source"]
    if seed["kind"] != "native-new-game" or seed["sha256"] != GAME_SHA256:
        raise ValueError("Opening seed is not the retained native new-game source")
    for path, expected in seed["source_hashes"].items():
        actual = sha((ROOT / path).read_bytes())
        if actual != expected:
            raise ValueError(f"Opening seed input drift: {path}")
        hashes[path] = actual
    bundle = seed["native_bundle"]
    if bundle["path"] != rel(RUNTIME / "evidence/opening_native.json") or bundle["sha256"] != hashes[bundle["path"]]:
        raise ValueError("Opening initializer evidence drift")
    proof["initial_equipment"] = seed["native_evidence"]["equipment_initialize"]
    proof["initial_item_instance"] = seed["native_evidence"]["item_initialize"]
    return hashes, proof, seed, table


def source_skill(role, skill):
    fixed = bytes.fromhex(skill["fixed_raw_hex"])
    get = lambda at: struct.unpack_from("<i", fixed, at)[0]
    raw_type_flags = struct.unpack_from("<I", fixed, 0x32)[0]
    range_at = lambda low, high: {"minimum": get(low), "maximum_exclusive": get(high)}
    defaults = {"mp_cost": max(0, -get(0x14F)),
                "physical_multiplier_percent": range_at(0xCB, 0xCF),
                "element_power": [get(0x105 + i * 4) for i in range(6)],
                "defense_bonus": range_at(0xD3, 0xD7), "term4_bonus": range_at(0xE3, 0xE7),
                "hp_term_bonus": get(0xAB), "hp_max_term_bonus": get(0xAF),
                "preparation_delay_raw": get(0x2E)}
    ident = f"{role.path.stem}_{skill['index']}"
    return {"id": ident, "actor_id": role.path.stem, "role_id": role.path.stem,
            "index": skill["index"], "original_skill_index": skill["index"],
            "original_source_id": fixed[0], "original_id_raw": fixed[0],
            "name": skill["name_cp936"], "name_raw_hex": skill["name_raw_hex"],
            "fixed_raw_hex": fixed.hex(), "fixed_bytes": SKILL_BYTES,
            "record_sha256": sha(fixed), "memory_stride_bytes": 0x421,
            "source_record_offset": skill["offset"], "action_record_count": len(skill["actions"]),
            "actions_offset": skill["actions_offset"], "end_offset": skill["end_offset"],
            "source": {"path": rel(role.path), "sha256": role.sha256,
                       "fixed_record_offset": skill["offset"], "fixed_bytes": SKILL_BYTES},
            "learned_raw": fixed[0x23], "combination_code_raw": fixed[0x19],
            "target_side_raw": fixed[0x25], "type_raw": raw_type_flags & 15,
            "type_flags_u32_0x32": raw_type_flags, "mp_delta_raw": get(0x14F),
            "mp_cost": defaults["mp_cost"], "charge_i32_0x2e": get(0x2E),
            "skill_level_raw": fixed[0x2D], "required_role_level_raw": get(0x143),
            "skill_experience_raw": get(0x2FB), "required_skill_experience_raw": get(0x2F7),
            "class_raw": skill["actions"][0]["class_raw"] if skill["actions"] else None,
            "action_mask_raw": skill["actions"][0]["action_mask_raw"] if skill["actions"] else None,
            "source_defaults": defaults, "actions": skill["actions"],
            "classification": {"source_type_raw": raw_type_flags & 15,
                               "has_menu_type": bool(raw_type_flags & 15),
                               "learned_in_definition": bool(fixed[0x23]),
                               "runtime_handler_status": "not-assessed"}}


def build_catalogs():
    hashes, proof, seed, table = native_sources()
    source_paths = sorted((ROOT / "Fight_Role").rglob("*"), key=lambda p: rel(p).casefold())
    source_paths = [path for path in source_paths if path.is_file() and path.suffix.lower() == ".chr"]
    if not source_paths:
        raise ValueError("No Fight_Role/**/*.CHR inputs")
    roles, skills, companion_ids, seen_ids = {}, {}, [], set()
    for path in source_paths:
        role = CatalogCHR(path)
        ident = path.stem
        if ident.casefold() in seen_ids:
            raise ValueError(f"Duplicate canonical role stem: {rel(path)}")
        seen_ids.add(ident.casefold())
        if role.reconstruct() != role.data:
            raise ValueError(f"Lossless CHR reconstruction failed: {rel(path)}")
        hashes[rel(path)] = role.sha256
        slot = int(ident) - 1 if ident.isdecimal() and len(ident) == 3 and 1 <= int(ident) <= 10 and path.parent == ROOT / "Fight_Role" else None
        if slot is not None:
            companion_ids.append(ident)
        rows = [source_skill(role, skill) for skill in role.skills]
        skills.update((row["id"], row) for row in rows)
        by_type, by_id = defaultdict(list), defaultdict(list)
        for row in rows:
            by_type[str(row["type_raw"])].append(row["id"])
            by_id[str(row["original_source_id"])].append(row["id"])
        get = lambda at: struct.unpack_from("<i", role.header, at)[0]
        fields = {name: {"value": get(offset), "header_relative_offset": offset,
                         "file_offset": 8 + offset, "bytes": 4}
                  for name, offset in HEADER_FIELDS.items()}
        value = {"id": ident, "name": role.name, "name_raw_hex": role.name_raw.hex(),
                 "source": {"path": rel(path), "sha256": role.sha256, "bytes": len(role.data),
                            "header_offset": 8, "header_bytes": HEADER_BYTES},
                 "prefix_raw_hex": role.data[:8].hex(), "version_raw": role.version,
                 "reserved_raw": role.reserved_raw, "header_raw_hex": role.header.hex(),
                 "header_sha256": sha(role.header), "definition_fields": fields,
                 "classification": {"kind": "companion" if slot is not None else "source-role",
                                    "native_player_slot": slot, "role_kind_raw": role.header[0x18],
                                    "side_raw": role.header[0x19], "authority": proof["player_slots"],
                                    "runtime_handler_status": "not-assessed"},
                 "skill_count": role.skill_count, "skill_ids": [row["id"] for row in rows],
                 "learned_indices": [row["index"] for row in rows if row["learned_raw"]],
                 "classification_indices": {"source_type_raw": dict(by_type), "original_source_id": dict(by_id)},
                 "post_role_record_count_raw": role.post_role_record_count_raw,
                 "post_role_record_count_file_offset": 8 + 0x1CE,
                 "optional_records_offset": role.optional_records_offset,
                 "optional_records": role.optional_records,
                 "parsed_end": role.parsed_end, "eof_verified": role.parsed_end == len(role.data)}
        if slot is not None:
            initial = seed["role_definitions"].get(ident)
            if initial is None or initial["sha256"] != role.sha256 or initial["header_raw_hex"] != role.header.hex():
                raise ValueError(f"Companion initialization source mismatch: {ident}")
            stored = initial["stored"]
            for name, offset in [("level", 0x24), ("experience", 0x28),
                                 ("next_level_experience", 0x2C), ("experience_remaining", 0x64)]:
                if stored[name] != get(offset):
                    raise ValueError(f"Companion stored {name} mismatch: {ident}")
            for name, offset, upper in [("hp", 0x30, "maximum"), ("mp", 0x38, "maximum"),
                                        ("attack", 0x40, "base"), ("defense", 0x48, "base"),
                                        ("attribute_0x58_0x5c", 0x58, "base")]:
                if stored[name] != {"current": get(offset), upper: get(offset + 4)}:
                    raise ValueError(f"Companion stored {name} mismatch: {ident}")
            equipment = [row for row in seed["initial_equipment"] if row["role_id"] == ident]
            if not equipment:
                raise ValueError(f"Companion initial equipment source missing: {ident}")
            itm = (ROOT / "SYSTEM/Object.ITM").read_bytes()
            for entry in equipment:
                source = entry["definition_source"]
                raw = itm[source["record_offset"]:source["record_offset"] + source["record_bytes"]]
                if sha(raw) != source["sha256"] or sha(bytes.fromhex(entry["source_raw_hex"])) != entry["instance_sha256"]:
                    raise ValueError(f"Initial equipment source mismatch: {ident}")
            growth_index = get(0x60)
            if not 0 <= growth_index < 6:
                raise ValueError(f"Companion growth row is outside recovered table: {ident}")
            growth_at = 800 + growth_index * 40
            value["initial_state"] = {"authority": "native-new-game-source-definition",
                                      "seed_path": rel(RUNTIME / "web/data/opening_seed.json"),
                                      "seed_role_pointer": f"/source/role_definitions/{ident}",
                                      "stored": initial["stored"], "equipment": equipment,
                                      "active_in_opening_party": initial["active_in_opening_party"]}
            value["growth"] = {"row_index_raw": growth_index, "selector_file_offset": 8 + 0x60,
                               "table_row": list(struct.unpack_from("<10i", table, growth_at)),
                               "raw_hex": table[growth_at:growth_at + 40].hex(),
                               "source": {"path": "GAME.exe", "sha256": GAME_SHA256,
                                          "address": hex(0x679C78 + growth_at),
                                          "file_offset": proof["growth_table"]["file_offset"] + growth_at,
                                          "bytes": 40, "evidence_id": proof["growth_table"]["evidence_id"]}}
        roles[ident] = value
    if any(sha((ROOT / path).read_bytes()) != expected for path, expected in hashes.items()):
        raise ValueError("Read-only source changed during export")
    coverage = {"scope": "All files with case-insensitive .CHR suffix recursively under Fight_Role",
                "role_count": len(roles), "companion_count": len(companion_ids),
                "skill_count": len(skills), "action_count": sum(row["action_record_count"] for row in skills.values()),
                "optional_record_count": sum(len(row["optional_records"]) for row in roles.values()),
                "eof_verified_roles": len(roles), "lossless_reconstruction_verified_roles": len(roles),
                "source_bytes_unchanged": True, "failures": []}
    limits = ["Static source definitions; catalog membership does not enable a runtime handler or join/acquisition event.",
              "Names may repeat or be empty. Stable identity is role filename stem plus zero-based source skill index; fixed byte0 is separate.",
              "Non-companion resources retain raw role-kind and side bytes; no faction is invented.",
              "CHR stored defaults are not current saved state or derived equipment statistics.",
              "All fixed records, actions and optional tails are preserved; uninterpreted fields remain raw.",
              "Original game execution was not observed."]
    common = {"version": 1, "source_hashes": dict(sorted(hashes.items())), "provenance": proof,
              "coverage": coverage, "limits": limits}
    role_doc = {"schema": "seventh-seal-source-roles", **common, "companion_ids": companion_ids,
                "native_player_slot_capacity": 10, "roles": roles}
    skill_doc = {"schema": "seventh-seal-source-skills", **common, "skills": skills,
                 "raw_semantics": {"fixed_record_bytes": SKILL_BYTES, "memory_stride_bytes": 0x421,
                                   "action_record_bytes": 0xB0, "optional_tail_record_bytes": 0x66F,
                                   "source_defaults": "Numeric projections of preserved source fields, compatible with sourceSkillParameters; not an execution declaration.",
                                   "mp_cost": "Existing adapter projection max(0,-signed DWORD at fixed+0x14F); positive source values retain branch-dependent semantics in mp_delta_raw.",
                                   "ranges": "minimum / maximum_exclusive preserve signed source pairs, including fields not admitted by runtime configuration.",
                                   "type_raw": "Low four source flag bits; zero/nonzero menu distinction only, not proof that a handler is implemented.",
                                   "preparation_delay_raw": "Signed source preparation amount at fixed+0x2E, not milliseconds.",
                                   "action_fields": "Raw field projections. Type-specific command sequencing and target behavior require their native handlers."}}
    return role_doc, skill_doc


def export(check=False):
    roles, skills = build_catalogs()
    outputs = {ROLE_OUTPUT: encoded(roles), SKILL_OUTPUT: encoded(skills)}
    report = {"schema": "seventh-seal-source-catalog-export", "version": 1,
              "coverage": roles["coverage"], "source_hashes": roles["source_hashes"],
              "output_hashes": {rel(path): sha(raw) for path, raw in outputs.items()},
              "provenance": roles["provenance"], "original_game_execution_observed": False}
    outputs[REPORT_OUTPUT] = encoded(report)
    for path, raw in outputs.items():
        if not path.resolve().is_relative_to(RUNTIME.resolve()):
            raise ValueError("Catalog outputs must remain under remake/runtime")
        if check:
            if not path.exists() or path.read_bytes() != raw:
                raise ValueError(f"Catalog is missing or stale: {rel(path)}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
    print(json.dumps({"passed": True, "check": check, **roles["coverage"]}, ensure_ascii=True))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify current catalogs without writing")
    export(parser.parse_args().check)
