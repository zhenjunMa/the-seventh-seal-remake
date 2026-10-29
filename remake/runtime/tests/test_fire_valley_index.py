"""Source identity, revisit variants and cross-map plot dependency coverage."""
from pathlib import Path
import json
import struct
import sys
import tempfile
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / "tools"))
import export_fire_valley_index as index


class SourceProjectionTests(unittest.TestCase):
    def test_source_inventory_is_deterministic_case_insensitive_and_registration_free(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ["Map/z.TLK", "Map/a.dat", "Map/B.DAT", "Map/ignored.txt", "Animate/c.ANM", "Animate/ignored.bik"]:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"source")
            self.assertEqual(index.source_files(root), ("Animate/c.ANM", "Map/B.DAT", "Map/a.dat", "Map/z.TLK"))
            self.assertEqual(index.source_files(root / "missing"), ())

    def test_build_target_has_no_content_dependencies_and_tracks_all_original_inputs(self):
        import build_runtime as build
        step = build.STEPS["fire-valley-index"]
        self.assertEqual(build.plan(["fire-valley-index"]), ["fire-valley-index"])
        self.assertEqual(step.sources, index.source_files())
        self.assertNotIn("data/runtime_content.json", step.inputs)
        self.assertIn("data/library/fire_valley.json", step.outputs)
        self.assertIn("../evidence/fire_valley_20261024/source_index.json", step.outputs)

    def test_ember_city_is_an_independent_registered_source_target(self):
        import build_runtime as build
        step = build.STEPS['ember-city-index']
        self.assertEqual(build.plan(['ember-city-index']), ['ember-city-index'])
        self.assertEqual(step.tool, 'export_ember_city_index.py')
        self.assertEqual(step.sources, index.source_files())
        self.assertNotIn('data/runtime_content.json', step.inputs)
        self.assertIn('data/library/ember_city.json', step.outputs)
        self.assertIn('../evidence/ember_city_20261028/source_index.json', step.outputs)

    def test_choice_targets_include_all_native_slots_even_empty_label(self):
        raw = bytearray(0x66F)
        raw[0x537:0x53A] = b"yes"
        struct.pack_into("<I", raw, 0x537 + 100, 7)
        # Empty-label nonzero slots remain visible instead of disappearing.
        struct.pack_into("<I", raw, 0x537 + 104 + 100, 9)
        record = {"kind": 0, "style": 1, "raw_hex": raw.hex(), "offset": 123}
        choices = index.choice_records(record)
        self.assertEqual([(r["index"], r["text"], r["target_record"]) for r in choices],
                         [(0, "yes", 7), (1, "", 9)])
        self.assertEqual(choices[0]["source_offset"], 123 + 0x537)

    def test_only_known_flag_kinds_are_projected_and_signed_clear_is_preserved(self):
        record = {"id": 4, "condition_type": 0, "condition_index": 0, "condition_bit": 3,
                  "mutation_type": 0, "mutation_index": 0, "mutation_bit": 0xFFFFFFFE}
        refs = index.record_flag_refs(record, "M99999", 471)
        self.assertEqual([(r["operation"], r["index"], r["bit"]) for r in refs],
                         [("read", 471, 3), ("clear", 471, 2)])
        record.update(condition_type=10, mutation_type=14)
        self.assertEqual(index.record_flag_refs(record, "M99999", 471), [])

    def test_reachability_handles_cycles_and_preserves_missing_targets_for_audit(self):
        records = [{"id": 1, "branch_targets": [2]}, {"id": 2, "branch_targets": [1, 3, 99]},
                   {"id": 3, "branch_targets": []}, {"id": 4, "branch_targets": []}]
        self.assertEqual(index.reachable_records(records, 1), [1, 2, 3])
        self.assertEqual(index.reachable_records(records, 99), [])

    def test_map_prefix_alone_never_admits_an_unlinked_candidate(self):
        def detail(ident, target=None):
            records = []
            if target:
                raw = bytearray(0x42)
                raw[0x11:0x11 + len(target)] = target.encode("ascii")
                records = [{"id": 1, "offset": 100, "raw_hex": raw.hex()}]
            return {"id": ident, "path": f"Map/{ident}.dat", "sha256": "0" * 64,
                    "bytes": 200, "trigger_cells": {},
                    "fixed_sections": [{}, {"record_bytes": 0x42, "nonzero_records": records}]}
        catalog = {"M17010": {"name": "火之谷入口"}, "M17011": {"name": "住处"},
                   "M17099": {"name": "另一地点"}}
        details = {"M17010": detail("M17010", "m17011.dat"),
                   "M17011": detail("M17011"), "M17099": detail("M17099")}
        members, evidence = index.discover_maps(catalog, details)
        self.assertEqual(members, ["M17010", "M17011"])
        self.assertEqual(evidence["M17011"][0]["kind"], "source-DAT-link")


@unittest.skipUnless((ROOT / "Map/m17010.dat").exists(), "Original Fire Valley source unavailable")
class ShippedFireValleyIndex(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = index.build_index()

    def test_current_artifact_is_deterministic_and_every_scan_is_read_only(self):
        self.assertEqual(index.OUTPUT.read_bytes(), index.encoded(self.data))
        report = index.coverage_report(self.data, index.encoded(self.data))
        self.assertEqual(index.REPORT_OUTPUT.read_bytes(), index.encoded(report))
        expected_records = {source_id for field in ["kind", "condition_type", "mutation_type"]
                            for value in self.data["capability_summary"][field].values() if value["unresolved"]
                            for source_id in value["source_ids"]}
        self.assertEqual(report["projection_gaps"]["tlk_distinct_record_count"], len(expected_records))
        self.assertEqual(self.data["coverage"]["parse_failures"], [])
        self.assertTrue(self.data["coverage"]["source_bytes_unchanged"])
        self.assertFalse(self.data["provenance"]["save_state_imported"])
        self.assertFalse(self.data["provenance"]["original_game_execution_observed"])

    def test_all_region_sources_are_indexed_independently_of_runtime_registration(self):
        expected = {path.stem.upper() for path in (ROOT / "Map").glob("m170*.dat")}
        self.assertEqual(set(self.data["maps"]), expected)
        self.assertEqual(self.data["coverage"]["maps"], 21)
        self.assertEqual(self.data["coverage"]["npc_instances"], 147)
        self.assertEqual(self.data["coverage"]["npc_instances_with_tlk_entry"], 63)
        self.assertEqual(self.data["coverage"]["npc_instances_without_tlk_entry"], 84)
        self.assertEqual(self.data["coverage"]["tlk_records"], 361)
        self.assertEqual(self.data["coverage"]["unlinked_candidates"], [])
        self.assertEqual(len(self.data["discovery"]["map_catalog"]), 601)
        registered = json.loads((RUNTIME / "web/data/runtime_content.json").read_text("utf-8"))["maps"]
        self.assertIn("M17013", self.data["maps"])
        # The test remains valid after admission expands to every indexed map.
        self.assertTrue(set(self.data["maps"]) >= {key for key in registered if key.startswith("M170")})

    def test_each_npc_dialogue_and_command_matches_its_exact_source_bytes(self):
        documents = [npc for m in self.data["maps"].values() for npc in m["npcs"]]
        documents += [r for m in self.data["maps"].values() for r in m["dialogue"]["records"]]
        documents += [c for p in self.data["programs"].values() for c in p["commands"]]
        source_bytes = {}
        all_ids = set()
        for row in documents:
            source = row["source"]
            path = source["path"]
            if path not in source_bytes:
                source_bytes[path] = (ROOT / path).read_bytes()
            raw = source_bytes[path]
            self.assertEqual(index.sha(raw), source["sha256"])
            self.assertEqual(bytes.fromhex(row["raw_hex"]), raw[source["offset"]:source["offset"] + source["bytes"]])
            self.assertNotIn(row["source_id"], all_ids)
            all_ids.add(row["source_id"])

    def test_revisit_variants_keep_distinct_slots_flags_and_source_identity(self):
        variants = [self.data["maps"][key] for key in ["M17030", "M17030-1", "M17030-2"]]
        self.assertEqual([m["map_flag_index"] for m in variants], [11, 471, 469])
        self.assertEqual([len(m["npcs"]) for m in variants], [18, 11, 49])
        self.assertEqual(len({m["source"]["sha256"] for m in variants}), 3)
        group = next(g for g in self.data["variant_groups"] if "M17030" in g["maps"])
        self.assertEqual(group["maps"], ["M17030", "M17030-1", "M17030-2"])
        self.assertIsNone(group["chronological_order"])

    def test_real_map_entry_and_later_npc_mutations_are_retained(self):
        entrance = self.data["maps"]["M17010"]
        self.assertEqual(entrance["map_entry_source"]["offset"], 0x13A)
        self.assertEqual(entrance["map_entry_record_raw"], 90)
        self.assertEqual(entrance["map_load_record_raw"], 69)
        self.assertEqual(entrance["map_load_source"]["offset"], 0x8A)
        self.assertEqual(self.data["maps"]["M17020"]["map_load_record_raw"], 10)
        self.assertEqual(self.data["maps"]["M17028"]["map_load_record_raw"], 22)
        self.assertIn("M17010:map-load", next(r for r in entrance["dialogue"]["records"] if r["id"] == 69)["potential_call_roots"])
        self.assertEqual(entrance["header_11e_raw"], 0)
        self.assertTrue(any(n["hidden_on_load_raw_2ac"] for n in entrance["npcs"]))
        self.assertTrue(any(n["animation_effect_sources"] for n in entrance["npcs"]))
        inherited = self.data["programs"]["m17010-6"]
        self.assertEqual(inherited["caller_entry_maps"], ["M17010"])
        self.assertTrue(inherited["referenced_by"])
        self.assertFalse(any(c["opcode_raw"] == 10 for c in inherited["commands"]))
        self.assertTrue(all(c["possible_map_contexts"] == ["M17010"] for c in inherited["commands"]))

    def test_absent_tlk_and_external_shared_flags_remain_explicit(self):
        absent = [ident for ident, m in self.data["maps"].items() if m["dialogue"]["status"] == "source-file-absent"]
        self.assertEqual(absent, ["M17016", "M17021", "M17022"])
        self.assertTrue(any(not ref["inside_region"] for ref in self.data["flags"]["471:1"]))
        self.assertIn("m01050-2", self.data["programs"])
        self.assertIn("resurrect", self.data["programs"])
        self.assertEqual(self.data["missing_animation_references"], [])

    def test_external_animation_callers_are_indexed_without_admitting_their_region(self):
        program = self.data["programs"]["m17010-3"]
        self.assertIn("M03039:TLK:13", program["referenced_by"])
        self.assertEqual(program["caller_entry_maps"], ["M03039", "M17020"])
        caller = next(row for row in program["external_callers"] if row["source_id"] == "M03039:TLK:13")
        self.assertEqual(caller["index_roots"], [{"index_slot": 11, "record_id": 7}, {"index_slot": 499, "record_id": 10}])
        raw = (ROOT / caller["source"]["path"]).read_bytes()
        self.assertEqual(bytes.fromhex(caller["raw_hex"]), raw[caller["source"]["offset"]:caller["source"]["offset"]+0x66F])
        self.assertNotIn("M03039", self.data["maps"])
        first = program["commands"][0]
        self.assertEqual(first["possible_map_contexts"], ["M03039", "M17020"])

    def test_physical_exit_graph_distinguishes_connections_from_actual_reachability(self):
        graph = self.data["physical_map_graph"]
        self.assertEqual(graph["physical_exit_count"], 44)
        self.assertEqual(len(graph["undirected_components"]), 1)
        self.assertEqual(len(graph["undirected_components"][0]), 21)
        self.assertEqual(graph["entry_unreachable_by_physical_exit"]["M17010"], ["M17030", "M17030-1", "M17030-2"])
        self.assertEqual(len(graph["directed_reachable_from"]["M17010"]), 18)
        entrance = self.data["maps"]["M17010"]
        self.assertTrue(any(root["kind"] == "source-grid-tlk" and root["record_id"] == 49 for root in entrance["entrypoints"]))
        self.assertFalse(self.data["capability_summary"]["kind"]["2"]["unresolved"])
        scope = self.data["provenance"]["tlk_projection_reference"]["kind2_scope"]
        self.assertIn("admitted current state2 trigger", scope)
        self.assertIn("does not admit all source records", scope)
        self.assertFalse(self.data["capability_summary"]["condition_type"]["10"]["unresolved"])

    def test_unsupported_source_fields_have_locations_and_call_roots(self):
        summary = self.data["capability_summary"]
        self.assertEqual(set(summary["condition_type"]), {"0", "1", "4", "10"})
        self.assertTrue({"9", "14", "16", "17"} <= set(summary["mutation_type"]))
        for kind in ["condition_type", "mutation_type", "kind"]:
            for value in summary[kind].values():
                self.assertEqual(value["count"], len(value["source_ids"]))
                self.assertIn("potential_call_roots", value["representative"])
        self.assertTrue({"20", "37", "60", "62", "63", "255"} <= set(summary["anm_opcode"]))


@unittest.skipUnless((ROOT / 'Map/m01020a.dat').exists(), 'Original Ember City source unavailable')
class ShippedEmberCityIndex(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import export_ember_city_index as ember
        cls.output, cls.report_output = ember.OUTPUT, ember.REPORT_OUTPUT
        cls.data = index.build_index(region_label='炎城', region_id='ember-city')

    def test_full_source_counts_and_formal_outputs_are_deterministic(self):
        raw = index.encoded(self.data)
        self.assertEqual(self.output.read_bytes(), raw)
        self.assertEqual(self.report_output.read_bytes(), index.encoded(index.coverage_report(self.data, raw, self.output)))
        coverage = self.data['coverage']
        self.assertEqual({key: coverage[key] for key in ['maps', 'npc_instances', 'map_objects', 'tlk_records', 'programs', 'anm_commands']},
                         dict(maps=28, npc_instances=195, map_objects=562, tlk_records=1008, programs=34, anm_commands=1660))
        self.assertEqual(coverage['parse_failures'], [])
        self.assertTrue(coverage['source_bytes_unchanged'])
        self.assertFalse(self.data['provenance']['original_game_execution_observed'])

    def test_alpha_map_absent_tlk_and_source_candidates_remain_explicit(self):
        self.assertIn('M01020A', self.data['maps'])
        self.assertEqual(self.data['maps']['M01020']['dialogue']['status'], 'source-file-absent')
        self.assertEqual(self.data['maps']['M01020']['dialogue']['records'], [])
        self.assertEqual(self.data['maps']['M01060']['map_entry_record_raw'], 0)
        self.assertEqual(self.data['maps']['M01060']['map_load_record_raw'], 0)
        self.assertTrue(index.query_index(self.data, text='小吉')['total_matches'])
        self.assertTrue(index.query_index(self.data, flag='4:12')['references'])
        self.assertTrue(any(d['target_map_id'] == 'M01020A' for d in self.data['maps']['M01030']['descriptors']))

    def test_all_city_npc_object_dialogue_and_animation_bytes_match_sources(self):
        documents = [row for table in self.data['maps'].values()
                     for rows in [table['npcs'], table['objects'], table['dialogue']['records']] for row in rows]
        documents += [row for program in self.data['programs'].values() for row in program['commands']]
        files = {}
        for row in documents:
            source = row['source']
            if source['path'] not in files:
                files[source['path']] = (ROOT / source['path']).read_bytes()
            raw = files[source['path']]
            self.assertEqual(index.sha(raw), source['sha256'])
            self.assertEqual(bytes.fromhex(row['raw_hex']), raw[source['offset']:source['offset'] + source['bytes']])


if __name__ == "__main__":
    unittest.main()
