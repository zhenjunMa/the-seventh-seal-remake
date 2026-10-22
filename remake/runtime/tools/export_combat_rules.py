"""Write the bounded combat rule contract with immutable source identities.

Reads only GAME.exe and the retained REA bundle. This is an evidence/contract
export, not an executable-game observation or an original-save writer.
"""
from pathlib import Path
import hashlib
import json
import re

RUNTIME = Path(__file__).resolve().parents[1]
GAME_ROOT = RUNTIME.parents[1]
GAME_HASH = "fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def export():
    source = GAME_ROOT / "GAME.exe"
    assert digest(source) == GAME_HASH, "The admitted GAME.exe identity changed"
    bundle = RUNTIME / "evidence/turn_rules_native_20261011.json"
    native = json.loads(bundle.read_text(encoding="utf-8"))
    module = RUNTIME / "web/core/combat_rules.mjs"
    module_text = module.read_text(encoding="utf-8")
    evidence_ids = re.findall(r"ev_[0-9a-f]{64}", module_text)
    retained = {record["evidence_id"] for record in native["records"]}
    assert set(evidence_ids) <= retained, "Module evidence references absent from bundle"
    address_lists = {}
    for name in ("RAW", "STATUS", "LINK"):
        body = re.search(r"const REQUIRED_" + name + r" = \[([^]]+)\]", module_text).group(1)
        address_lists[name.lower()] = [f"0x{int(value, 16):08x}" for value in re.findall(r"0x[0-9a-f]+", body)]
    report = {
        "schema": "seventh-seal-combat-rule-contract", "version": 1,
        "source": {"path": "GAME.exe", "sha256": GAME_HASH},
        "native_bundle": {"path": str(bundle.relative_to(GAME_ROOT)).replace("\\", "/"),
                          "sha256": digest(bundle), "records": len(native["records"])},
        "module": {"path": "core/combat_rules.mjs", "sha256": digest(module)},
        "functions": {"effective": "0x41C610", "elements": "0x41CFE0", "damage": "0x41D990",
                      "rng": "0x571060", "reaction_type_gate": "0x50B3E0", "hp_submit": "0x5005C0",
                      "selected_actor_settled_clear": "0x503BD8"},
        "evidence": evidence_ids, "required_native_tables": address_lists,
        "skill_fixed_source_bytes": 0x41D, "native_skill_stride_bytes": 0x421,
        "native_skill_extra_bytes": "Trailing action-array pointer; never fabricated by source exporter.",
        "resource_fields": {"0x0524a701": "current_raw_hp", "0x0524a705": "maximum_raw_hp",
                            "0x0524a709": "current_raw_mp", "0x0524a70d": "maximum_raw_mp"},
        "input_contract": [
            "attacker and target contain explicit source-exported raw/status/linked tables; omitted values reject.",
            "target.current_skill is the whole selected source skill, fixed_raw_hex plus proved mp_cost.",
            "Fresh battle status and globals are explicit controlled initialization, not captured original battle state.",
            "A dead linked actor may have negative raw HP; preserve DWORD bits in world state and decode signed for native arithmetic.",
            "Selected actor settled_raw is cleared at its own action start following 0x503BD8; target settlement result persists.",
        ],
        "rng": {"kind": "uint32-lcg", "multiplier": 214013, "increment": 2531011,
                "output": "(state >>> 16) & 32767", "seed_authority": "Controlled reconstruction input; original RNG state unknown."},
        "original_game_execution_observed": False,
        "coverage": ["Bounded direct damage: raw class gates, effective randomized inputs, hit comparison and bypass, "
                     "physical multiplier, element addition, minimum/deflection, guard reduction, HP submit."],
        "limits": [
            "This numeric port does not establish original action queue/charging timing, enemy AI or encounter composition.",
            "Effect-token damage, ailments, other skill execution types, counters, item actions, rewards and original save compatibility remain outside the contract.",
            "RNG call order is checked within the admitted numeric functions; random calls elsewhere in the original game are not simulated.",
            "Static instruction-text differential replay uses explicit record/display/clock/death hooks and is not execution of GAME.exe.",
        ],
    }
    output = RUNTIME / "web/data/combat_rules.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "source_unchanged": True,
                      "evidence_records": len(native["records"]), "module_evidence": len(set(evidence_ids))}))


if __name__ == "__main__":
    export()
