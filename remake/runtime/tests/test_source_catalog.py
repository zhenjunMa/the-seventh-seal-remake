"""Lossless source coverage, native-table binding and runtime-reader compatibility."""
from pathlib import Path
import json
import struct
import subprocess
import sys
import tempfile
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / "tools"))
from export_source_catalog import build_catalogs, encoded, ROLE_OUTPUT, SKILL_OUTPUT
from source.catalog_chr import CatalogCHR, OPTIONAL_BYTES, sha
from source.combat_resources import CHRError, HEADER_BYTES, SKILL_BYTES, ACTION_BYTES


class StreamBoundaries(unittest.TestCase):
    def read_stream(self, raw):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "fixture.CHR"
            path.write_bytes(raw)
            return CatalogCHR(path)

    @staticmethod
    def stream(optional_count=1):
        prefix = struct.pack("<II", 8, 123)
        header = bytearray(HEADER_BYTES)
        header[4:8] = b"role"
        struct.pack_into("<I", header, 0, 1)
        struct.pack_into("<I", header, 0x1CE, optional_count)
        skill = bytearray(SKILL_BYTES)
        skill[1:6] = b"skill"
        struct.pack_into("<I", skill, 0x15, 1)
        action = bytes((i * 7) & 255 for i in range(ACTION_BYTES))
        optional = bytes((i * 11) & 255 for i in range(OPTIONAL_BYTES)) * optional_count
        return prefix + header + skill + action + optional

    def test_optional_records_follow_all_skills_and_actions_and_round_trip(self):
        raw = self.stream(2)
        role = self.read_stream(raw)
        self.assertEqual(role.skills[0]["offset"], 8 + HEADER_BYTES)
        tail_at = 8 + HEADER_BYTES + SKILL_BYTES + ACTION_BYTES
        self.assertEqual([row["offset"] for row in role.optional_records],
                         [tail_at, tail_at + OPTIONAL_BYTES])
        self.assertEqual(role.parsed_end, len(raw))
        self.assertEqual(role.reconstruct(), raw)

    def test_truncated_header_fixed_action_and_optional_records_fail(self):
        raw = self.stream()
        for end in [3, 7, 8 + HEADER_BYTES - 1, 8 + HEADER_BYTES + SKILL_BYTES - 1,
                    8 + HEADER_BYTES + SKILL_BYTES + ACTION_BYTES - 1, len(raw) - 1]:
            with self.subTest(end=end), self.assertRaises(CHRError):
                self.read_stream(raw[:end])

    def test_unclaimed_tail_bad_version_and_impossible_counts_fail(self):
        raw = self.stream()
        bad_version = struct.pack("<I", 7) + raw[4:]
        bad_skill_count = bytearray(raw)
        struct.pack_into("<I", bad_skill_count, 8, 0xFFFFFFFF)
        bad_action_count = bytearray(raw)
        struct.pack_into("<I", bad_action_count, 8 + HEADER_BYTES + 0x15, 0xFFFFFFFF)
        bad_optional_count = bytearray(raw)
        struct.pack_into("<I", bad_optional_count, 8 + 0x1CE, 0xFFFFFFFF)
        for bad in [raw + b"x", bad_version, bad_skill_count, bad_action_count, bad_optional_count]:
            with self.subTest(size=len(bad)), self.assertRaises(CHRError):
                self.read_stream(bad)


class ShippedCatalog(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.roles, cls.skills = build_catalogs()

    def test_current_artifacts_are_reproducible(self):
        self.assertEqual(ROLE_OUTPUT.read_bytes(), encoded(self.roles))
        self.assertEqual(SKILL_OUTPUT.read_bytes(), encoded(self.skills))

    def test_every_recursive_source_is_indexed_without_stem_normalization(self):
        paths = {path.relative_to(ROOT).as_posix(): path for path in (ROOT / "Fight_Role").rglob("*")
                 if path.is_file() and path.suffix.lower() == ".chr"}
        roles = self.roles["roles"]
        self.assertEqual(set(paths), {role["source"]["path"] for role in roles.values()})
        self.assertEqual(len(roles), len(paths))
        for role_id, role in roles.items():
            self.assertEqual(paths[role["source"]["path"]].stem, role_id)
        self.assertTrue({"031A", "031A1", "031A2", "031B", "031B1", "031B2", "031C", "E01", "eagle", "slime", "wolf"} <= set(roles))
        self.assertEqual(self.roles["companion_ids"], [f"{i:03d}" for i in range(1, 7)])
        self.assertEqual(self.roles["native_player_slot_capacity"], 10)

    def test_each_fixed_action_and_optional_byte_has_exact_source_offset(self):
        all_ids = set()
        for ident, role in self.roles["roles"].items():
            raw = (ROOT / role["source"]["path"]).read_bytes()
            chunks = [bytes.fromhex(role["prefix_raw_hex"]), bytes.fromhex(role["header_raw_hex"])]
            self.assertEqual(sha(raw), role["source"]["sha256"])
            self.assertTrue(role["eof_verified"])
            cursor = 8 + HEADER_BYTES
            self.assertEqual(role["skill_count"], len(role["skill_ids"]))
            for index, skill_id in enumerate(role["skill_ids"]):
                self.assertEqual(skill_id, f"{ident}_{index}")
                self.assertNotIn(skill_id, all_ids)
                all_ids.add(skill_id)
                skill = self.skills["skills"][skill_id]
                fixed = bytes.fromhex(skill["fixed_raw_hex"])
                self.assertEqual(skill["actor_id"], ident)
                self.assertEqual(skill["source"]["fixed_record_offset"], cursor)
                self.assertEqual(skill["original_skill_index"], index)
                self.assertEqual(skill["original_source_id"], raw[cursor])
                self.assertEqual(fixed, raw[cursor:cursor + SKILL_BYTES])
                chunks.append(fixed)
                cursor += SKILL_BYTES
                self.assertEqual(skill["action_record_count"], struct.unpack_from("<I", fixed, 0x15)[0])
                self.assertEqual(skill["action_record_count"], len(skill["actions"]))
                for action in skill["actions"]:
                    self.assertEqual(action["offset"], cursor)
                    block = bytes.fromhex(action["raw_hex"])
                    self.assertEqual(block, raw[cursor:cursor + ACTION_BYTES])
                    self.assertEqual(sha(block), action["raw_sha256"])
                    chunks.append(block)
                    cursor += ACTION_BYTES
                self.assertEqual(cursor, skill["end_offset"])
            self.assertEqual(cursor, role["optional_records_offset"])
            for record in role["optional_records"]:
                self.assertEqual(record["offset"], cursor)
                block = bytes.fromhex(record["raw_hex"])
                self.assertEqual(block, raw[cursor:cursor + OPTIONAL_BYTES])
                chunks.append(block)
                cursor += OPTIONAL_BYTES
            self.assertEqual(cursor, len(raw))
            self.assertEqual(b"".join(chunks), raw)
        self.assertEqual(all_ids, set(self.skills["skills"]))

    def test_companion_growth_equipment_and_raw_initial_values_are_source_bound(self):
        executable = (ROOT / "GAME.exe").read_bytes()
        items = (ROOT / "SYSTEM/Object.ITM").read_bytes()
        for ident in self.roles["companion_ids"]:
            role = self.roles["roles"][ident]
            self.assertEqual(role["classification"]["native_player_slot"], int(ident) - 1)
            growth = role["growth"]
            source = growth["source"]
            block = executable[source["file_offset"]:source["file_offset"] + source["bytes"]]
            self.assertEqual(bytes.fromhex(growth["raw_hex"]), block)
            self.assertEqual(growth["table_row"], list(struct.unpack("<10i", block)))
            for entry in role["initial_state"]["equipment"]:
                source = entry["definition_source"]
                block = items[source["record_offset"]:source["record_offset"] + source["record_bytes"]]
                self.assertEqual(sha(block), source["sha256"])
                self.assertEqual(entry["item_id"], struct.unpack_from("<I", block)[0])
        self.assertEqual(sum(role["initial_state"]["active_in_opening_party"] for role in self.roles["roles"].values() if "initial_state" in role), 1)

    def test_every_skill_is_compatible_with_existing_numeric_source_reader(self):
        script = """
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {sourceSkillParameters} from './web/core/skill_config.mjs';
const data=JSON.parse(fs.readFileSync('./web/data/library/skills.json','utf8'));
for(const [id,skill] of Object.entries(data.skills)){
  const {preparation_delay_raw,...parameters}=skill.source_defaults;
  assert.deepEqual(sourceSkillParameters(skill),parameters,id);
  assert.equal(skill.id,id);
}
"""
        subprocess.run(["node", "--input-type=module", "-e", script], cwd=RUNTIME,
                       check=True, capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()
