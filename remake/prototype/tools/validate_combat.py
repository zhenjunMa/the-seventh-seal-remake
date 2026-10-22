"""Reproduce the first combat investigation without launching the game.

Generates only investigation evidence inside remake. Success means the
declared static/parser/subrule checks passed; it never means playable combat.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

PROJECT = Path(__file__).resolve().parents[1]
ROOT = PROJECT.parents[1]
EVIDENCE = PROJECT / "evidence"
GAME_SHA = "fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18"

CLAIMS = (
    ("resource_image_load", "0x4FDA70", "ev_c4916d77f3525da931f337c2d8b67b9c4d4c38f2b311e1b488a77a02052e560c"),
    ("chr_pair_and_saved_player_branch", "0x4FF480", "ev_82c64bd2888077eec29db2720454278fccb714f72cf20ce7e2254b44d0f15820"),
    ("selected_action_record", "0x5017B0", "ev_40f6a111851f05d4c90f3c1c68b4d9201d4b9c71c15dbaaf33a7b3e042166933"),
    ("selected_skill_record", "0x501930", "ev_dc019d336cb98549ccba8bab90528f5d4cb8a1d34fea55c99639941e188b6763"),
    ("effective_attribute_builder_partial", "0x41C610", "ev_1303a62e3e254cd7e702384a9dc7969f724a5a21d0d057b071f3f42bfb371a68"),
    ("damage_formula_assembly_partial", "0x41D990", "ev_2a07b703ffba4f257babff8aa568885165fed9b0aaff627398713aa8b09bc85d"),
    ("hp_commit_and_death_return", "0x5005C0", "ev_e76dc0fc2a37ba715b7005825ea4ce93f1523440769a6aa6549a0ac77569df72"),
    ("effective_hp_getter", "0x500350", "ev_635bf69f89b9158deec299cbb4f0e334664adeb56ef85dca7d95156113e301e8"),
    ("linked_hp_bonus_getter", "0x5003F0", "ev_6ee54dc6fe565f173e91b950485b3f7ad09dc8ebbe91d714b32509786be353a8"),
    ("death_state_handler", "0x4FFD40", "ev_24e24e3f56faadf09cf1593a03268c5fdc4cd1a2e5832781c0b6a2c9f6243092"),
    ("direct_action_settlement_caller", "0x50FA00", "ev_7199407875fd945ae708cfdfaabfd31e75f0148dd8b57f794f1095e39d526c30"),
    ("effect_token_settlement_caller", "0x506870", "ev_002884ef01c4e12ecd81ced44fe8ba3a55e7ec1a4eb6e9e7b360dfc3611c5eb1"),
    ("battle_actor_tick_partial", "0x51A4F0", "ev_e7ebc40b1eb0efaa9d96ff7f3e6fc290955d8807dff0dc831ad32c06ceb45a70"),
    ("map_reaction_not_damage_formula", "0x46F060", "ev_0b246554843c0ee34fa383603bdc8f046b907e002c4da05d29fa343011b6b423"),
)


def read(name):
    return json.loads((EVIDENCE / name).read_text(encoding="utf-8"))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    before = sha(ROOT / "GAME.exe")
    if before != GAME_SHA:
        raise ValueError("GAME.exe does not match the investigation")
    for script in ("combat_resources.py", "test_combat_resources.py",
                   "combat_sample.py", "test_combat_rules.py"):
        print(f"Running {script}", flush=True)
        subprocess.run([sys.executable, "-B", str(PROJECT / "tools" / script)],
                       cwd=ROOT, check=True)
    resources = read("combat_resources_20261011.json")
    parser_checks = read("combat_resources_checks_20261011.json")
    samples = read("combat_sample_20261011.json")
    rules = read("combat_rules_verification_20261011.json")
    if resources["failures"] or parser_checks["failed"] or not rules["passed"]:
        raise ValueError("A resource or finite-rule check failed")
    native_path = EVIDENCE / "combat_native_20261011.json"
    native = read(native_path.name)
    records = {r["evidence_id"]: r for r in native["records"]}
    claims = []
    for claim_id, function, evidence_id in CLAIMS:
        record = records[evidence_id]
        if record["subject"]["digest"]["sha256"] != GAME_SHA:
            raise ValueError(f"Evidence target mismatch: {claim_id}")
        claims.append({"claim_id": claim_id, "function": function,
                       "evidence_id": evidence_id, "operation": record["operation"],
                       "parameters": record["parameters"],
                       "authority": record["authority"], "scope": "static; no observed gameplay"})
    after = sha(ROOT / "GAME.exe")
    all_unchanged = (before == after == GAME_SHA and resources["source_bytes_unchanged"]
                     and samples["all_inputs_unchanged"] and rules["source_bytes_unchanged"])
    if not all_unchanged:
        raise ValueError("An investigation input changed")
    report = {
        "schema": "seventh-seal-combat-investigation", "version": 1,
        "assessment_date": "2026-10-11", "research_version": "0.1",
        "preview_version": "0.2", "checks_passed": True,
        "source_bytes_unchanged": all_unchanged, "game_sha256": after,
        "native_bundle": {"path": native_path.relative_to(ROOT).as_posix(),
                          "sha256": sha(native_path), "records": len(records)},
        "checks": {"chr_samples": len(resources["samples"]),
                   "historical_role_state_references": len(samples["candidates"]),
                   "chr_boundary_report": parser_checks,
                   "subrule_tests": rules["tests_run"],
                   "total_checks": parser_checks["passed"] + rules["tests_run"]},
        "evidence_index": claims,
        "user_reported_combat_context": samples["user_reported_combat_context"],
        "enemy_name_checks": resources["name_header_inventory"]["enemy_name_checks"],
        "recommended_candidate": samples["recommended_first_candidate"],
        "milestones": {
            "bounded_resource_parsing": "passed",
            "static_dgp_chr_pairing": "confirmed; selected runtime branch unobserved",
            "hp_commit_subrule": "implemented and checked against finite assembly contract",
            "pre_damage_raw_class_gate": "implemented; raw bits/classes only; upper/middle/lower semantic mapping unresolved",
            "damage_formula": "partial; effective inputs/state/element/RNG order still unresolved",
            "fixed_original_attack_sample": "pending original observation",
            "playable_attack_kill_return": "not implemented",
            "original_movement_comparison": "pending; unchanged from movement report"},
        "limits": ["All checks are static, original-byte, parser, or finite-port checks.",
                   "No original battle, damage result, or map-return was observed.",
                   "The city references are not ordinary encounter samples; user reports movement-triggered encounters in Whitewood Forest.",
                   "Whitewood Forest encounter variant selection, target/skill zone encoding and multi-zone targets are unresolved.",
                   "Primary RGB565 animation decoding is now separate from auxiliary indexed records; see combat_animation_verification_20261011.json for all-frame coverage. Auxiliary indexed effects remain unresolved.",
                   "Subrule arithmetic inputs are already-resolved native intermediates; raw CHR stats cannot be substituted."]}
    output = EVIDENCE / "combat_investigation_20261011.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(output), "checks_passed": True,
                      "source_bytes_unchanged": all_unchanged,
                      "playable_combat": False}, ensure_ascii=True))


if __name__ == "__main__":
    main()
