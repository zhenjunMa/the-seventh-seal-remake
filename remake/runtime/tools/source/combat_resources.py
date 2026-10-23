"""Read-only CHR v8 parser and bounded CHR/DGP association probe.

Layout authority: GAME.exe 0x4FED00, retained in
save_analysis_20261010/rea_format_evidence.json. Runtime role header fields
follow the existing save parser; resource-definition values are not live state.
The native loader derives CHR from the DGP filename; player state may instead
come from a loaded save. An action's +1 integer is a DGP index when the
retained 0x510D20/0x50E980 evidence matches this binary. No action is named
by its number; runtime skill selection remains unobserved.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import struct
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

PROJECT = Path(__file__).resolve().parents[2]
ROOT = PROJECT.parents[1]
GAME_SHA256 = "fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18"
ROLE_READ_EVIDENCE = "ev_ac1e58d9c4c3c45e5e22037e7532d393f5b5e77cd6ea9bd722b40a83145310a9"
CHR_LOAD_EVIDENCE = "ev_82c64bd2888077eec29db2720454278fccb714f72cf20ce7e2254b44d0f15820"
DGP_LOAD_EVIDENCE = "ev_c4916d77f3525da931f337c2d8b67b9c4d4c38f2b311e1b488a77a02052e560c"
ACTION_INDEX_EVIDENCE = ("ev_ad54dbda1ffc67d6ef6a0fcf1e6c3676f23727fe36df43ad0645128b44e9c7ee",
                        "ev_e684765a5b552708f4e35b7fa0516950d8ef5d9e5acc0b9e4ddb0f7e3ff1a5cf")
SAMPLES = ("001", "002", "011", "012", "013", "050", "079", "080", "081")
ENEMY_NAME_CHECKS = (
    {"requested_name": "狩猎者", "exact_variants": ("狩猎者", "狩獵者"),
     "related_full_names_checked": ("森林狩猎者", "森林狩獵者")},
    {"requested_name": "角鹰", "exact_variants": ("角鹰", "角鷹"),
     "related_full_names_checked": ()},
    {"requested_name": "雪泥怪", "exact_variants": ("雪泥怪",),
     "related_full_names_checked": ()},
)
HEADER_BYTES = 0x30B
SKILL_BYTES = 0x41D
ACTION_BYTES = 0xB0
FILE_REFS = re.compile(rb"[A-Za-z0-9_.-]{1,32}\.(?:dgp|wav)", re.IGNORECASE)


class CHRError(ValueError):
    pass


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value) -> None:
    resolved = path.resolve()
    if not resolved.is_relative_to(PROJECT.resolve()):
        raise CHRError("Outputs must remain inside remake/runtime")
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


class CHR:
    """Parse a standalone v8 CHR stream with checked bounds and exact EOF."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.data = self.path.read_bytes()
        self.sha256 = hashlib.sha256(self.data).hexdigest()
        self.version = self.u32(0)
        if self.version != 8:
            raise CHRError(f"Unsupported CHR version {self.version}; only v8 is established")
        self.reserved_raw = self.u32(4)
        self.header_offset = 8
        self.header = self.take(self.header_offset, HEADER_BYTES)
        self.skill_count = self.u32(self.header_offset)
        if self.skill_count > (len(self.data) - 8 - HEADER_BYTES) // SKILL_BYTES:
            raise CHRError("Skill count cannot fit even the fixed records")
        self.name_raw = self.header[4:24].split(b"\0")[0]
        self.name = self.name_raw.decode("cp936", "strict")
        self.post_role_record_count_raw = self.u32(self.header_offset + 0x1CE)
        if self.post_role_record_count_raw:
            raise CHRError("CHR optional 0x66F post-role records are observed in 0x4FF480 but not implemented for this bounded sample parser")
        self.skills = []
        p = self.header_offset + HEADER_BYTES
        for i in range(self.skill_count):
            fixed = self.take(p, SKILL_BYTES)
            count = self.u32(p + 0x15)
            actions_offset = p + SKILL_BYTES
            if count > (len(self.data) - actions_offset) // ACTION_BYTES:
                raise CHRError(f"Skill {i}: action count {count} exceeds remaining file")
            name_raw = fixed[1:0x15].split(b"\0")[0]
            actions = []
            for action_index in range(count):
                q = actions_offset + action_index * ACTION_BYTES
                raw = self.take(q, ACTION_BYTES)
                actions.append({
                    "index": action_index,
                    "offset": q,
                    "bytes": ACTION_BYTES,
                    "type_raw": raw[0],
                    "u32_at_0x01_raw": self.u32(q + 1),
                    "u32_at_0x05_raw": self.u32(q + 5),
                    "u32_at_0x2a_raw": self.u32(q + 0x2A),
                    "u32_at_0x33_raw": self.u32(q + 0x33),
                    "u32_at_0x3b_raw": self.u32(q + 0x3B),
                    "u32_at_0x43_raw": self.u32(q + 0x43),
                    "file_reference_literals": [
                        {"action_relative_offset": m.start(), "file_offset": q + m.start(),
                         "raw_hex": m.group().hex(), "text_ascii": m.group().decode("ascii"),
                         "confidence": "literal-only; may be a partial string"}
                        for m in FILE_REFS.finditer(raw)
                    ],
                    "raw_hex": raw.hex(),
                })
            end = actions_offset + count * ACTION_BYTES
            self.skills.append({
                "index": i,
                "offset": p,
                "fixed_bytes": SKILL_BYTES,
                "id_raw": fixed[0],
                "name_cp936": name_raw.decode("cp936", "strict"),
                "name_raw_hex": name_raw.hex(),
                "type_flags_raw": self.u32(p + 0x32),
                "u32_at_0xcb_raw": self.u32(p + 0xCB),
                "u32_at_0xcf_raw": self.u32(p + 0xCF),
                "0xcb_0xcf_file_offsets": [p + 0xCB, p + 0xCF],
                "0xcb_0xcf_limit": "Candidate settlement inputs; semantics are not established by the resource bytes.",
                "action_record_count": count,
                "action_count_offset": p + 0x15,
                "actions_offset": actions_offset,
                "end_offset": end,
                "fixed_raw_hex": fixed.hex(),
                "actions": actions,
            })
            p = end
        if p != len(self.data):
            raise CHRError(f"Unconsumed trailing bytes: parsed {p}, actual {len(self.data)}")
        self.parsed_end = p

    def take(self, offset: int, size: int) -> bytes:
        if offset < 0 or size < 0 or offset + size > len(self.data):
            raise CHRError(f"Truncated block at 0x{offset:x}, need {size} bytes")
        return self.data[offset:offset + size]

    def u32(self, offset: int) -> int:
        return struct.unpack("<I", self.take(offset, 4))[0]

    def metadata(self) -> dict:
        offsets = {"level": 0x24, "hp_current": 0x30, "hp_maximum": 0x34,
                   "mp_current": 0x38, "mp_maximum": 0x3C,
                   "attack_current": 0x40, "attack_base": 0x44,
                   "defense_current": 0x48, "defense_base": 0x4C}
        return {
            "source": self.path.resolve().relative_to(ROOT.resolve()).as_posix(),
            "sha256": self.sha256, "bytes": len(self.data), "version": self.version,
            "reserved_raw": self.reserved_raw, "header_offset": self.header_offset,
            "header_bytes": HEADER_BYTES, "header_raw_hex": self.header.hex(),
            "name_cp936": self.name, "name_raw_hex": self.name_raw.hex(),
            "name_file_offset": self.header_offset + 4,
            "skill_count": self.skill_count,
            "post_role_record_count_raw": self.post_role_record_count_raw,
            "post_role_record_count_file_offset": self.header_offset + 0x1CE,
            "definition_fields": {
                k: {"header_relative_offset": off, "file_offset": self.header_offset + off,
                    "raw_u32": self.u32(self.header_offset + off)} for k, off in offsets.items()
            },
            "definition_field_limit": "Names follow the existing save parser; these are CHR resource defaults, not a captured fight state.",
            "skills": self.skills, "parsed_end": self.parsed_end, "eof_verified": True,
            "layout_evidence": {"path": "save_analysis_20261010/rea_format_evidence.json",
                                "procedure": "0x4FED00", "evidence_id": ROLE_READ_EVIDENCE},
        }


def dgp_action_headers(path: Path) -> dict:
    """Bounded v9 action-table metadata; intentionally independent of pixels.

    header[19] marks an auxiliary indexed stream, separate from primary RGB565.
    This function does not decode either stream or claim full resource EOF.
    It reads only the layout-established header, actions, and geometry tables.
    """
    data = path.read_bytes()

    def take(offset, count):
        if offset < 0 or count < 0 or offset + count > len(data):
            raise CHRError(f"Truncated DGP metadata at 0x{offset:x}, need {count}")
        return data[offset:offset + count]

    header = take(0, 0x43)
    if header[0] != 9:
        raise CHRError(f"Unsupported DGP version {header[0]}")
    actions = []
    geometry_offset = 0x43 + header[2] * 0xAC
    geometry = take(geometry_offset, 0x2A)
    frame_count = struct.unpack_from("<I", geometry, 4)[0]
    for index in range(header[2]):
        offset = 0x43 + index * 0xAC
        raw = take(offset, 0xAC)
        actions.append({"index": index, "header_offset": offset,
                        "directions_raw": raw[0], "interval_raw": struct.unpack_from("<H", raw, 1)[0],
                        "loop_raw": raw[13], "frames_per_direction": raw[14],
                        "first_frame": struct.unpack_from("<I", raw, 0x72)[0],
                        "identifier_raw": struct.unpack_from("<I", raw, 0x7E)[0],
                        "raw_hex": raw.hex()})
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
            "actions": actions, "frame_count": frame_count,
            "frame_width": struct.unpack_from("<H", geometry, 0)[0],
            "frame_height": struct.unpack_from("<H", geometry, 2)[0],
            "palette_branch": bool(header[19]), "header_hex": header.hex(),
            "geometry_offset": geometry_offset, "geometry_hex": geometry.hex(),
            "metadata_end": geometry_offset + 0x2A,
            "pixel_decode_performed": False, "eof_verified": False}


def native_loading_evidence() -> dict:
    path = PROJECT / "evidence/source/combat_native_20261011.json"
    if not path.exists():
        return {"static_loading_rule_confirmed": False, "reason": "Retained native loading evidence unavailable"}
    data = path.read_bytes()
    bundle = json.loads(data.decode("utf-8"))
    wanted = {CHR_LOAD_EVIDENCE, DGP_LOAD_EVIDENCE}
    records = [r for r in bundle["records"] if r["evidence_id"] in wanted]
    confirmed = len(records) == 2
    return {"static_loading_rule_confirmed": confirmed,
            "source": "remake/runtime/evidence/source/combat_native_20261011.json",
            "snapshot_sha256": hashlib.sha256(data).hexdigest(),
            "evidence_ids": [r["evidence_id"] for r in records],
            "observations": [
                "0x4FF480 calls 0x4FDA70 with the supplied image filename, then copies that filename and changes its last three characters to CHR.",
                "Its disk branch opens the resulting file and calls 0x4FED00 to read the character definition.",
                "0x4FDA70 calls DGP loader 0x51FCC4 for the supplied filename or reuses an already-loaded matching image filename.",
            ] if confirmed else [],
            "saved_player_branch": {
                "observation": "When DAT_055DF750, parsed leading numeric ID in 1..10, and the corresponding loaded role state satisfy the branch, 0x4FF480 copies saved role data through 0x4FE7E0 instead of reopening the CHR definition.",
                "implication": "Player CHR defaults must not be substituted for current saved HP, equipment, learned skills, or other role state.",
                "runtime_selection_observed": False,
            } if confirmed else {},
            "optional_tail": "Disk loader can read header+0x1CE count * 0x66F records after 0x4FED00; supported bounded samples have count zero.",
            "limits": ["Static code only; selected runtime branch and the stored map object's battle filename remain unobserved.",
                       "The action +1 integer's use as a DGP index is not established by these loaders."]}


def native_action_index_evidence() -> dict:
    path = PROJECT / "evidence/source/combat_animation_native_20261011.json"
    if not path.exists():
        return {"confirmed": False, "evidence_ids": []}
    bundle = json.loads(path.read_text(encoding="utf-8"))
    records = [r for r in bundle["records"] if r["evidence_id"] in ACTION_INDEX_EVIDENCE]
    confirmed = len(records) == 2 and all(r["subject"]["digest"]["sha256"] == GAME_SHA256 for r in records)
    return {"confirmed": confirmed, "source": path.relative_to(ROOT).as_posix(),
            "evidence_ids": [r["evidence_id"] for r in records],
            "scope": "Static type0 current-action +1 DWORD -> 0x50E980 DGP action table; command scheduling remains unresolved"}


def association_probe(chr_data: CHR, dgp_path: Path, loading_evidence=None) -> dict:
    dgp = dgp_action_headers(dgp_path)
    action_evidence = native_action_index_evidence()
    dgp_actions = dgp["actions"]
    matches, unequal, rows = 0, 0, []
    for skill in chr_data.skills:
        for action in skill["actions"]:
            if action["type_raw"] != 0:
                continue
            index = action["u32_at_0x01_raw"]
            row = {"skill_index": skill["index"], "skill_id_raw": skill["id_raw"],
                   "action_index": action["index"], "field_file_offset": action["offset"] + 1,
                   "candidate_dgp_index": index, "index_in_bounds": index < len(dgp_actions)}
            if index < len(dgp_actions):
                dgp_action = dgp_actions[index]
                row.update({"dgp_action_header_offset": 0x43 + index * 0xAC,
                            "dgp_identifier_raw": dgp_action["identifier_raw"],
                            "dgp_first_frame": dgp_action["first_frame"],
                            "dgp_frames_per_direction": dgp_action["frames_per_direction"],
                            "dgp_interval_raw": dgp_action["interval_raw"],
                            "chr_u32_at_0x2a_raw": action["u32_at_0x2a_raw"]})
                same = dgp_action["frames_per_direction"] == action["u32_at_0x2a_raw"]
                row["0x2a_equals_dgp_frame_count"] = same
                matches += int(same)
                unequal += int(not same)
            rows.append(row)
    return {"candidate_source": dgp_path.resolve().relative_to(ROOT.resolve()).as_posix(),
            **{k: v for k, v in dgp.items() if k != "actions"},
            "action_count": len(dgp_actions),
            "dgp_actions": dgp_actions,
            "matching_rule": "Native disk loading derives CHR from the supplied DGP filename; type_raw=0 / u32@+1 is used as DGP action index when retained trace evidence matches.",
            "static_filename_pairing_verified": (loading_evidence or native_loading_evidence())["static_loading_rule_confirmed"],
            "native_action_index_verified": action_evidence["confirmed"],
            "native_action_index_evidence": action_evidence,
            "type_zero_records": len(rows), "indices_in_bounds": sum(r["index_in_bounds"] for r in rows),
            "frame_count_equalities": matches, "frame_count_inequalities": unequal,
            "records": rows,
            "limits": ["Actual skill/command selection, action sequencing, effects and hit timing remain unresolved.",
                       "u32@+0x2A differs from DGP frame count for some records; its playback meaning is unresolved.",
                       "DGP action identifiers, CHR skill IDs, and DGP action indices are distinct raw fields.",
                       "A named attack is not automatically the game's basic attack; command selection remains to be traced."]}


def chr_name_inventory() -> dict:
    """Only top-level CHR headers, no claim to parse every complete file."""
    records, failures = [], []
    for path in sorted((ROOT / "Fight_Role").glob("*.CHR")):
        with path.open("rb") as source:
            raw = source.read(32)
        if len(raw) != 32:
            failures.append({"source": path.relative_to(ROOT).as_posix(), "error": "short 32-byte header"})
            continue
        name_raw = raw[12:32].split(b"\0")[0]
        try:
            name = name_raw.decode("cp936", "strict")
        except UnicodeDecodeError as exc:
            failures.append({"source": path.relative_to(ROOT).as_posix(), "error": str(exc)})
            continue
        records.append({"source": path.relative_to(ROOT).as_posix(), "file_bytes": path.stat().st_size,
                        "header_bytes_read": 32, "header_sha256": hashlib.sha256(raw).hexdigest(),
                        "version_raw": struct.unpack_from("<I", raw, 0)[0],
                        "name_file_offset": 12, "name_cp936": name, "name_raw_hex": name_raw.hex(),
                        "complete_file_parsed": False})
    checks = []
    for query in ENEMY_NAME_CHECKS:
        exact = [r for r in records if r["name_cp936"] in query["exact_variants"]]
        full = [r for r in records if r["name_cp936"] in query["related_full_names_checked"]]

        def mapping(record):
            chr_path = ROOT / record["source"]
            dgp_path = chr_path.with_suffix(".dgp")
            return {"chr_source": record["source"], "dgp_source": dgp_path.relative_to(ROOT).as_posix(),
                    "dgp_exists": dgp_path.exists(), "original_name_cp936": record["name_cp936"],
                    "original_name_raw_hex": record["name_raw_hex"], "name_file_offset": 12,
                    "mapping_authority": "CHR name bytes plus static 0x4FF480 filename derivation",
                    "chosen_in_whitewood_encounter_verified": False}

        checks.append({"requested_name": query["requested_name"],
                       "exact_variants_checked": list(query["exact_variants"]),
                       "exact_matches": [mapping(r) for r in exact],
                       "related_full_names_checked": list(query["related_full_names_checked"]),
                       "related_full_name_matches": [mapping(r) for r in full],
                       "literal_name_limit": "The requested short name has no exact match; the explicitly checked full resource name is shown separately." if full and not exact else None})
    former = [r for r in records if r["name_cp936"] in ("独脚蝠鸟", "獨腳蝠鳥")]
    return {"scope": "Top-level Fight_Role/*.CHR only; first 32 bytes per file; no recursion, no other formats.",
            "records": records, "failures": failures,
            "examined_headers": len(records), "enemy_name_checks": checks,
            "former_noncombat_map_object_probe": {
                "name": "独脚蝠鸟", "variants_checked": ["独脚蝠鸟", "獨腳蝠鳥"],
                "matches": [r["source"] for r in former],
                "role_in_this_report": "Noncombat city map object only; battle-resource mapping remains unresolved.",
                "recommended_battle_sample": False,
            },
            "limits": ["A zero literal name match does not establish that a game character lacks resources.",
                       "Repeated CHR names do not identify which variant an encounter loads.",
                       "Whitewood encounter selection and upper/middle/lower position fields are not established by this name scan."]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=PROJECT / "evidence/source/combat_resources_20261011.json")
    args = parser.parse_args()
    inputs = [ROOT / "GAME.exe", ROOT / "save_analysis_20261010/rea_format_evidence.json"]
    inputs += [ROOT / "Fight_Role" / (key + suffix) for key in SAMPLES for suffix in (".CHR", ".dgp")]
    before = {p.relative_to(ROOT).as_posix(): digest(p) for p in inputs}
    if before["GAME.exe"] != GAME_SHA256:
        raise CHRError("GAME.exe digest differs from retained evidence")
    report = {"created_utc": datetime.now(timezone.utc).isoformat(),
              "scope": "Two player resources plus seven literal-name-matched enemy resources: Fight_Role/001, 002, 011, 012, 013, 050, 079, 080, 081; static bytes only.",
              "input_hashes": before, "samples": [], "failures": [],
              "confirmed": ["v8 CHR fixed/nested boundaries follow retained 0x4FED00 reads.",
                            "The header carries its own CP936 character name; names are not inferred from resource numbers."],
              "unknowns": ["Selected runtime skill and resource branch are unobserved; retained native trace confirms type0 action +1 as DGP index.",
                           "Auxiliary indexed records remain uninterpreted. Primary RGB565 can be decoded independently; this metadata-only entry does not establish per-resource pixel validity. See combat_animation_verification_20261011.json for tested frames.",
                           "Which duplicate-named enemy variant Whitewood Forest selects is unresolved.",
                           "Enemy/skill upper-middle-lower position fields and positional miss rules are not inferred from raw fields.",
                           "The sample set does not establish all CHR versions or the complete battle resource catalog.",
                           "Animation command meanings, hit points in animation, and end/loop behavior remain unresolved.",
                           "No original-game runtime sample or HP transition was captured by this tool."]}
    report["encounter_context"] = {
        "authority": "user-confirmed correction; not observed by this static tool",
        "trigger": "野外移动触发暗雷", "initial_battle_area": "白木森林",
        "city_excluded_from_encounter_sample": "运炎河右岸",
        "possible_enemy_names": ["狩猎者", "角鹰", "雪泥怪"],
        "position_description": "敌人和技能占上/中/下方位；有的怪占中上，攻击下方的技能可能miss。",
        "position_field_mapping_verified": False, "runtime_encounter_observed": False,
    }
    loading_evidence = native_loading_evidence()
    report["native_loading_evidence"] = loading_evidence
    for key in SAMPLES:
        path = ROOT / "Fight_Role" / (key + ".CHR")
        try:
            role = CHR(path)
            record = role.metadata()
            record["dgp_candidate"] = association_probe(role, path.with_suffix(".dgp"), loading_evidence)
            report["samples"].append(record)
        except (OSError, ValueError) as exc:
            report["failures"].append({"source": path.relative_to(ROOT).as_posix(), "error": str(exc)})
    after = {p.relative_to(ROOT).as_posix(): digest(p) for p in inputs}
    report["name_header_inventory"] = chr_name_inventory()
    report["parse_capabilities"] = {
        "chr": "Standalone v8 0x30B role header, 0x41D fixed skill records and 0xB0 nested action records; exact EOF; nonzero optional 0x66F tail count rejected explicitly.",
        "dgp": "v9 header/action table/geometry metadata only; no pixel decoder was run by this tool.",
        "samples": [{"chr_source": r["source"], "original_name_cp936": r["name_cp936"],
                     "chr_eof_verified": r["eof_verified"], "skill_count": r["skill_count"],
                     "dgp_source": r["dgp_candidate"]["candidate_source"],
                     "palette_branch": r["dgp_candidate"]["palette_branch"],
                     "pixel_decode_performed": False,
                     "existing_decoder_support": "primary RGB565 decoding independent of auxiliary indexed records; all-frame checks are in the animation report" if r["dgp_candidate"]["palette_branch"] else "direct-color branch; 012 was decoded by the prior prototype export"}
                    for r in report["samples"]],
    }
    report["source_bytes_unchanged"] = before == after
    report["changed_inputs"] = [p for p in before if before[p] != after[p]]
    write_json(args.output, report)
    print(json.dumps({"samples": len(report["samples"]), "failures": report["failures"],
                      "unchanged": report["source_bytes_unchanged"], "output": str(args.output)}, ensure_ascii=True))
    return 0 if len(report["samples"]) == len(SAMPLES) and before == after and not report["failures"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
