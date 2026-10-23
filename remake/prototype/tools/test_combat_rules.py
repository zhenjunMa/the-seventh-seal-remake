"""Checks for recovered subrules, with retained assembly and binary anchors.

These establish the finite port contract and source identity, not original
gameplay equivalence. No original program or save is executed or modified.
"""
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from combat_rules import (HpGate, HpState, commit_known_damage, idiv, i32,
                          physical_component, raw_action_class_rejected, raw_roll_passes,
                          threshold_from_terms)

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "remake/prototype/evidence/combat_rules_verification_20261011.json"
GAME_SHA = "fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18"
ASM_EVIDENCE = "ev_e76dc0fc2a37ba715b7005825ea4ce93f1523440769a6aa6549a0ac77569df72"
FORMULA_ASM = "ev_2a07b703ffba4f257babff8aa568885165fed9b0aaff627398713aa8b09bc85d"


def original_bytes_at_va(data, address, count):
    """Map a PE32 initialized-file range; never read process memory."""
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise ValueError("Expected PE")
    sections = struct.unpack_from("<H", data, pe + 6)[0]
    optional_size = struct.unpack_from("<H", data, pe + 20)[0]
    optional = pe + 24
    if struct.unpack_from("<H", data, optional)[0] != 0x10B:
        raise ValueError("Expected PE32")
    rva = address - struct.unpack_from("<I", data, optional + 28)[0]
    for i in range(sections):
        entry = optional + optional_size + i * 40
        va, raw_size, raw_offset = struct.unpack_from("<III", data, entry + 12)
        if va <= rva and rva + count <= va + raw_size:
            offset = raw_offset + rva - va
            return offset, data[offset:offset + count]
    raise ValueError("Address range not initialized in source file")


class CombatRuleChecks(unittest.TestCase):
    def test_source_and_assembly_anchors(self):
        data = (ROOT / "GAME.exe").read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), GAME_SHA)
        bundle = json.loads((ROOT / "remake/runtime/evidence/source/combat_native_20261011.json").read_text(encoding="utf-8"))
        records = {r["evidence_id"]: r for r in bundle["records"]}
        hp = records[ASM_EVIDENCE]
        self.assertEqual(hp["subject"]["digest"]["sha256"], GAME_SHA)
        assembly = hp["normalized_result"]
        self.assertIn("0x500642: JL 0x00500673", assembly)
        self.assertIn("0x5006d9: MOV EAX, 0x1", assembly)
        self.assertIn("0x41e050: CDQ", records[FORMULA_ASM]["normalized_result"])
        # Independent original-file opcodes: signed overkill branch, raw HP
        # subtraction, return 1 on death, signed division and divisor, and
        # the three raw class bits used before RNG/damage computation.
        for address, expected in ((0x500642, "7c2f"), (0x500653, "2b4510"),
                                  (0x5006D9, "b801000000"),
                                  (0x41E050, "99"), (0x41E051, "b9e7030000"),
                                  (0x41DA58, "83e101"), (0x41DAA6, "83e002"),
                                  (0x41DAF1, "83e204")):
            _, original = original_bytes_at_va(data, address, len(bytes.fromhex(expected)))
            self.assertEqual(original.hex(), expected)

    def test_nonlethal(self):
        original = HpState(100)
        result = commit_known_damage(original, 30, 0)
        self.assertEqual((result["effective_hp"], result["native_return"]), (70, 0))
        self.assertEqual(original.raw_hp, 100)
        self.assertEqual(result["events"], [])

    def test_exact_lethal_preserves_status_hp_field(self):
        result = commit_known_damage(HpState(100, status_hp_raw=27), 100, 0)
        self.assertEqual(result["target"].status_hp_raw, 27)
        self.assertEqual((result["effective_hp"], result["native_return"], result["target"].state_raw), (0, 1, 4))

    def test_overkill_resets_status_hp_field(self):
        result = commit_known_damage(HpState(100, status_hp_raw=27), 101)
        self.assertEqual((result["target"].raw_hp, result["target"].status_hp_raw), (0, 0))
        self.assertEqual(result["native_return"], 1)

    def test_linked_bonus_can_leave_negative_raw_hp(self):
        result = commit_known_damage(HpState(100, 1, 1, 50), 120)
        self.assertEqual((result["target"].raw_hp, result["effective_hp"]), (-20, 30))
        self.assertEqual(result["native_return"], 0)

    def test_linked_bonus_overkill_and_equal_have_distinct_fields(self):
        original = HpState(100, 1, 1, 50, 27)
        equal = commit_known_damage(original, 150)
        over = commit_known_damage(original, 151)
        self.assertEqual((equal["target"].raw_hp, over["target"].raw_hp), (-50, -50))
        self.assertEqual((equal["target"].status_hp_raw, over["target"].status_hp_raw), (27, 0))

    def test_bonus_requires_both_native_fields(self):
        for target in (HpState(100, 0, 1, 50), HpState(100, 1, 0, 50)):
            self.assertEqual(commit_known_damage(target, 120)["target"].raw_hp, 0)

    def test_all_damage_gates_leave_state_unchanged(self):
        target = HpState(100, 1, 1, 50)
        for gate in (HpGate(global_00679c6c=1), HpGate(global_055ee004=1), HpGate(global_055edfec=1)):
            result = commit_known_damage(target, 150, gate=gate)
            self.assertEqual(result["target"], target)
            self.assertFalse(result["applied"])
        self.assertTrue(commit_known_damage(HpState(100), 10, gate=HpGate(global_055edfec=1))["applied"])
        for state in (4, 5, 255):
            self.assertFalse(commit_known_damage(HpState(100, state_raw=state), 10)["applied"])

    def test_environmental_death_has_no_attacker_byte_write(self):
        environment = commit_known_damage(HpState(5), 6, -1)
        self.assertEqual([e["kind"] for e in environment["events"]], ["death-handler"])
        actor = commit_known_damage(HpState(5), 6, 3)
        self.assertEqual(actor["events"][0]["index"], 3)

    def test_signed_arithmetic_and_zero_defense(self):
        self.assertEqual(idiv(-500, 999), 0)
        self.assertEqual(idiv(-1000, 999), -1)
        self.assertEqual(i32(0xFFFFFFFF), -1)
        self.assertEqual(physical_component(48, 24, 100), 132)
        self.assertEqual(physical_component(1, 1, 100), 0)
        self.assertEqual(physical_component(48, 0, 100), physical_component(48, 1, 100))
        self.assertEqual(physical_component(48, 24, 50), 66)

    def test_inclusive_roll_and_override(self):
        self.assertEqual(threshold_from_terms(200, 0), 100)
        self.assertEqual(threshold_from_terms(0, 0), 20)
        self.assertEqual(threshold_from_terms(200, 100), 0)
        self.assertTrue(raw_roll_passes(20, 20))
        self.assertFalse(raw_roll_passes(21, 20))
        self.assertTrue(raw_roll_passes(0, 0))

    def test_raw_action_class_gate_all_three_bits(self):
        # Enumerate bytes/classes without assigning gameplay zone names.
        rejected_classes = {0: set(), 1: {1}, 2: {2}, 3: {1, 2},
                            4: {3}, 5: {1, 3}, 6: {2, 3}, 7: {1, 2, 3}}
        for mask, rejected in rejected_classes.items():
            for target_class in (0, 1, 2, 3, 4, 255):
                self.assertEqual(raw_action_class_rejected(mask, target_class),
                                 target_class in rejected)
        self.assertFalse(raw_action_class_rejected(0xF8, 1))

    def test_raw_action_gate_target_skill_and_token_branches(self):
        self.assertTrue(raw_action_class_rejected(0, 0, target_skill_gate_raw=1))
        self.assertFalse(raw_action_class_rejected(7, 1, 1, effect_token_raw=1))
        self.assertFalse(raw_action_class_rejected(0, 1))

    def test_raw_action_gate_contract_rejects_invalid_fields(self):
        for args in ((256, 1), (0, -1), (0, 1, True), (0, 1, 0, -1)):
            with self.assertRaises(ValueError):
                raw_action_class_rejected(*args)

    def test_api_contract_rejects_invalid_values(self):
        for damage in (-1, True, 0x80000000):
            with self.assertRaises(ValueError):
                commit_known_damage(HpState(100), damage)
        with self.assertRaises(ValueError):
            commit_known_damage(HpState(100, state_raw=256), 1)
        with self.assertRaises(ValueError):
            raw_roll_passes(100, 20)


if __name__ == "__main__":
    before = hashlib.sha256((ROOT / "GAME.exe").read_bytes()).hexdigest()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(CombatRuleChecks)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    after = hashlib.sha256((ROOT / "GAME.exe").read_bytes()).hexdigest()
    report = {"schema": "seventh-seal-combat-subrule-verification", "version": 1,
              "tests_run": result.testsRun, "passed": result.wasSuccessful(),
              "failures": len(result.failures), "errors": len(result.errors),
              "game_sha256": after, "source_bytes_unchanged": before == after == GAME_SHA,
              "assembly_evidence": [ASM_EVIDENCE, FORMULA_ASM],
              "scope": "Finite native subrule port, original-file opcode anchors; no original gameplay observation",
              "example": {"input": asdict(HpState(100, 1, 1, 50)), "damage": 120,
                          "result": {k: asdict(v) if isinstance(v, HpState) else v
                                     for k, v in commit_known_damage(HpState(100, 1, 1, 50), 120).items()}},
              "remaining": ["Effective attribute construction", "Ordinary attack action selection",
                            "Raw action/target class mapping to upper/middle/lower and multi-zone targets",
                            "Complete damage/element/state branching", "RNG call order and state",
                            "Original attack/kill/return comparison"]}
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    raise SystemExit(0 if result.wasSuccessful() and report["source_bytes_unchanged"] else 1)
