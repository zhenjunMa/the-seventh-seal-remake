"""Boundary checks for the CHR parser using bounded real samples.

These check real source EOF, candidate index coverage, and rejecting damaged
file boundaries. Temporary damaged inputs stay inside remake; originals are
only read. No battle formula is asserted by this resource test.
"""
from pathlib import Path
import json
import struct
import tempfile
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime/tools"))

from source.combat_resources import CHR, CHRError, PROJECT, ROOT, SAMPLES, association_probe, chr_name_inventory


def main() -> None:
    cases = []
    expected_names = {"001": "英格妮", "002": "凯", "011": "角鹰", "012": "雪泥怪",
                      "013": "森林狩猎者", "050": "森林狩猎者", "079": "角鹰",
                      "080": "森林狩猎者", "081": "森林狩猎者"}
    for key in SAMPLES:
        path = ROOT / "Fight_Role" / (key + ".CHR")
        role = CHR(path)
        assert role.name == expected_names[key]
        assert role.parsed_end == len(role.data)
        probe = association_probe(role, path.with_suffix(".dgp"))
        assert probe["type_zero_records"] == probe["indices_in_bounds"]
        assert probe["native_action_index_verified"] is True
        assert len(probe["native_action_index_evidence"]["evidence_ids"]) == 2
        assert probe["palette_branch"] == (key != "012")
        cases.append({"name": f"{key}: real sample EOF, explicit name, bounded candidate indices", "pass": True})
    names = chr_name_inventory()
    checks = {c["requested_name"]: c for c in names["enemy_name_checks"]}
    assert checks["狩猎者"]["exact_variants_checked"] == ["狩猎者", "狩獵者"]
    assert checks["狩猎者"]["exact_matches"] == []
    assert {r["chr_source"] for r in checks["狩猎者"]["related_full_name_matches"]} == {
        "Fight_Role/013.CHR", "Fight_Role/050.CHR", "Fight_Role/080.CHR", "Fight_Role/081.CHR"}
    assert checks["角鹰"]["exact_variants_checked"] == ["角鹰", "角鷹"]
    assert {r["chr_source"] for r in checks["角鹰"]["exact_matches"]} == {"Fight_Role/011.CHR", "Fight_Role/079.CHR"}
    assert [r["chr_source"] for r in checks["雪泥怪"]["exact_matches"]] == ["Fight_Role/012.CHR"]
    assert names["former_noncombat_map_object_probe"]["recommended_battle_sample"] is False
    cases.append({"name": "Whitewood enemy literal/variant name matches, hunter full-name distinction, city map-object exclusion", "pass": True})
    original = (ROOT / "Fight_Role/012.CHR").read_bytes()
    damaged = {"truncated_version": original[:3], "truncated_header": original[:100],
               "truncated_final_action": original[:-1], "trailing_byte": original + b"\0"}
    wrong_version = bytearray(original)
    struct.pack_into("<I", wrong_version, 0, 7)
    damaged["unsupported_version"] = bytes(wrong_version)
    excess_skills = bytearray(original)
    struct.pack_into("<I", excess_skills, 8, 0xFFFFFFFF)
    damaged["excess_skill_count"] = bytes(excess_skills)
    excess_actions = bytearray(original)
    struct.pack_into("<I", excess_actions, 8 + 0x30B + 0x15, 0xFFFFFFFF)
    damaged["excess_action_count"] = bytes(excess_actions)
    optional_tail = bytearray(original)
    struct.pack_into("<I", optional_tail, 8 + 0x1CE, 1)
    damaged["unsupported_optional_tail"] = bytes(optional_tail)
    (PROJECT / "evidence").mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="chr_boundary_", dir=PROJECT / "evidence") as directory:
        for label, data in damaged.items():
            path = Path(directory) / (label + ".CHR")
            path.write_bytes(data)
            try:
                CHR(path)
            except CHRError:
                cases.append({"name": label, "pass": True})
            else:
                raise AssertionError(f"Damaged sample was accepted: {label}")
    from source.combat_resources import write_json
    result = {"cases": cases, "passed": len(cases), "failed": 0,
              "limits": ["Static resource parser checks only; no gameplay parity assertion."]}
    write_json(PROJECT / "evidence/source/combat_resources_checks_20261011.json", result)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
