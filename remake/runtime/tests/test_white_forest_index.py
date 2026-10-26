"""Outer White Forest boundaries, source bytes and directed connectivity."""
from pathlib import Path
import json
import sys
import unittest

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / "tools"))
import export_fire_valley_index as index

MAPS = [f"M700{i}0" for i in range(1, 7)]


@unittest.skipUnless((ROOT / "Map/m70010.dat").is_file(), "Original forest unavailable")
class WhiteForestSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = index.build_index("白木森林", "white-forest", exact_label=True)

    def test_exact_labels_keep_inner_forest_outside_the_delivery(self):
        self.assertEqual(list(self.data["maps"]), MAPS)
        self.assertEqual(self.data["discovery"]["label_match"], "exact")
        self.assertIn("M70071", self.data["coverage"]["unlinked_candidates"])
        self.assertEqual(self.data["coverage"]["parse_failures"], [])
        self.assertEqual(self.data["coverage"]["npc_instances"], 6)
        self.assertEqual(self.data["coverage"]["tlk_records"], 38)
        self.assertEqual(self.data["coverage"]["map_objects"], 96)
        self.assertEqual(set(self.data["programs"]), {"m70010-1", "m70030-1"})

    def test_every_raw_object_and_dialogue_remains_bound_to_original_bytes(self):
        counts = {}
        for row in self.data["maps"].values():
            for record in [*row["objects"], *row["dialogue"]["records"]]:
                source = record["source"]
                raw = (ROOT / source["path"]).read_bytes()
                self.assertEqual(bytes.fromhex(record["raw_hex"]),
                                 raw[source["offset"]:source["offset"] + source["bytes"]])
            for record in row["objects"]:
                behavior = record["behavior_raw_cf"]
                counts[behavior] = counts.get(behavior, 0) + 1
        self.assertEqual(counts, {1: 83, 4: 13})

    def test_all_six_maps_are_reachable_in_both_directions(self):
        graph = self.data["physical_map_graph"]
        self.assertEqual(graph["physical_exit_count"], 10)
        for reachable in graph["directed_reachable_from"].values():
            self.assertEqual(reachable, MAPS)
        empty = next(d for d in self.data["maps"]["M70050"]["descriptors"] if d["id"] == 2)
        self.assertEqual(empty["cells"], [])
        self.assertEqual(self.data["maps"]["M70020"]["dialogue"]["status"], "source-file-absent")

    def test_external_writers_are_retained_without_admitting_external_maps(self):
        self.assertTrue(any(r["source_id"] == "M01031:TLK:14" for r in self.data["flags"]["7:1"]))
        self.assertTrue(any(r["source_id"] == "M01065:TLK:62" for r in self.data["flags"]["384:1"]))
        self.assertNotIn("M01031", self.data["maps"])
        self.assertFalse(self.data["provenance"]["original_game_execution_observed"])

    def test_current_index_and_target_have_their_own_identity(self):
        output = RUNTIME / "web/data/library/white_forest.json"
        self.assertEqual(output.read_bytes(), index.encoded(self.data))
        import build_runtime as build
        self.assertEqual(build.plan(["white-forest-index"]), ["white-forest-index"])
        self.assertIn("data/library/white_forest.json", build.STEPS["white-forest-index"].outputs)


if __name__ == "__main__":
    unittest.main()
