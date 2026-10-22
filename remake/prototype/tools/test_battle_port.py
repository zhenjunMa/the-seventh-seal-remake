"""Compare the browser's finite contracts with the retained Python/native port.

This checks JavaScript translation at signed boundaries and gate combinations;
it does not establish complete original gameplay equivalence.
"""
from dataclasses import asdict
from itertools import product
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from combat_rules import HpGate, HpState, commit_known_damage, raw_action_class_rejected, raw_roll_passes

PROJECT = Path(__file__).resolve().parents[1]
ROOT = PROJECT.parents[1]


def hp_case(target, damage, attacker=2, gates=None):
    gates = gates or HpGate()
    result = commit_known_damage(target, damage, attacker, gates)
    result["target"] = asdict(result["target"])
    return {"kind": "hp", "args": [asdict(target), damage, attacker, asdict(gates)], "expected": result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="D:/game/youchenghuanjianlu/toolchain/node/node.exe")
    args = parser.parse_args()
    cases = []
    for hp, bonus, side, link, damage in product(
            (-0x80000000, -1, 0, 1, 100, 0x7FFFFFFF),
            (-50, 0, 50, 0x7FFFFFFF), (0, 1), (0, 1), (0, 1, 50, 100, 0x7FFFFFFF)):
        cases.append(hp_case(HpState(hp, side, link, bonus, 27), damage))
    for state, side, gate in product((0, 3, 4, 255), (0, 1),
            (HpGate(), HpGate(1), HpGate(0, 1), HpGate(0, 0, 1))):
        cases.append(hp_case(HpState(100, side, 1, 50, 27, state), 120, -1, gate))
    for mask, classification, skill_gate, token in product(
            (0, 1, 2, 3, 4, 5, 6, 7, 248, 255), (0, 1, 2, 3, 4, 255), (0, 1), (0, 1)):
        values = [mask, classification, skill_gate, token]
        cases.append({"kind": "class", "args": values, "expected": raw_action_class_rejected(*values)})
    for roll, threshold in product(range(100), (0, 20, 100)):
        cases.append({"kind": "roll", "args": [roll, threshold], "expected": raw_roll_passes(roll, threshold)})
    module = PROJECT / "web/battle_rules.mjs"
    before = hashlib.sha256((ROOT / "GAME.exe").read_bytes()).hexdigest()
    js = """import fs from 'node:fs';
const rules = await import(process.argv[1]);
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
const funcs = {hp: rules.commitKnownDamage, class: rules.rawActionClassRejected, roll: rules.rawRollPasses};
process.stdout.write(JSON.stringify(cases.map(c => funcs[c.kind](...c.args))));"""
    completed = subprocess.run([args.node, "--input-type=module", "-e", js, module.as_uri()],
        input=json.dumps(cases), text=True, capture_output=True, check=True, cwd=ROOT)
    actual = json.loads(completed.stdout)
    failures = [{"index": i, "kind": case["kind"], "args": case["args"],
                 "expected": case["expected"], "actual": result}
                for i, (case, result) in enumerate(zip(cases, actual, strict=True))
                if case["expected"] != result]
    after = hashlib.sha256((ROOT / "GAME.exe").read_bytes()).hexdigest()
    report = {"schema": "seventh-seal-battle-finite-port-check", "version": 1,
        "cases": len(cases), "case_counts": {kind: sum(c["kind"] == kind for c in cases)
            for kind in ("hp", "class", "roll")}, "passed": not failures,
        "failures": failures, "game_sha256": after, "source_bytes_unchanged": before == after,
        "javascript_source_sha256": hashlib.sha256(module.read_bytes()).hexdigest(),
        "python_source_sha256": hashlib.sha256((PROJECT / "tools/combat_rules.py").read_bytes()).hexdigest(),
        "scope": "Finite JavaScript/Python translation contract, not complete original gameplay or zone semantic mapping"}
    output = PROJECT / "evidence/battle_port_verification_20261011.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("cases", "case_counts", "passed", "source_bytes_unchanged")}))
    raise SystemExit(0 if report["passed"] and report["source_bytes_unchanged"] else 1)


if __name__ == "__main__":
    main()
