"""Regress the source header offset using the shipped late-return entry."""
import contextlib
import io
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME / "tools"))
import export_chapter_story as exporter


class NativeMapEntryTests(unittest.TestCase):
    def export_maps_in_memory(self, ids):
        outputs = {}
        with patch.object(exporter, "map_ids", return_value=ids), \
                patch.object(exporter, "program_ids", return_value=[]), \
                patch.object(exporter, "role_ids", return_value=[]), \
                patch.object(exporter, "write", side_effect=lambda path, value: outputs.update({path.name: value})), \
                contextlib.redirect_stdout(io.StringIO()):
            exporter.export()
        return outputs["chapter_story.json"]["maps"]

    def test_fire_valley_return_entry_uses_native_header_address(self):
        raw = (exporter.ROOT / "Map/m17010.dat").read_bytes()
        # 4A5F00 reads at 0504B1C8; 4A85A0 passes 0504B302 to 4670C0.
        offset = 0x0504B302 - 0x0504B1C8
        self.assertEqual(offset, 0x13A)
        self.assertEqual(struct.unpack_from("<I", raw, 0x11E)[0], 0)
        self.assertEqual(struct.unpack_from("<I", raw, offset)[0], 90)

        table = self.export_maps_in_memory(["M17010"])["M17010"]
        self.assertEqual(table["header_entry_tlk_raw"], 90)
        self.assertEqual(table["header_entry_tlk_source"]["offset"], offset)
        self.assertEqual(table["header_entry_tlk_source"]["sha256"], table["map_source"]["sha256"])
        entry = next(row for row in table["records"] if row["id"] == 90)
        self.assertEqual((entry["condition_index"], entry["condition_bit"], entry["if_true"]), (12, 1, 96))
        # Slot499 is an object fallback, not this visit-dependent entry.
        self.assertEqual(table["default_object_record"], 41)

    def test_map_setup_is_distinct_from_arrival_and_object_fallback(self):
        maps = self.export_maps_in_memory(["M17010", "M17020", "M17028"])
        # The map loader 4A5F00 calls 466EC0 at header0504B252, before
        # the ordinary arrival caller invokes the separate +0x13A entry.
        offset = 0x0504B252 - 0x0504B1C8
        self.assertEqual(offset, 0x8A)
        for ident, setup_record in [("M17010", 69), ("M17020", 10), ("M17028", 22)]:
            with self.subTest(map=ident):
                table = maps[ident]
                raw = (exporter.ROOT / table["map_source"]["path"]).read_bytes()
                self.assertEqual(struct.unpack_from("<I", raw, offset)[0], setup_record)
                self.assertEqual(table["header_setup_tlk_raw"], setup_record)
                self.assertEqual(table["header_setup_tlk_source"]["offset"], offset)
                self.assertEqual(table["header_setup_tlk_source"]["sha256"], table["map_source"]["sha256"])
        self.assertEqual(maps["M17010"]["header_entry_tlk_raw"], 90)
        self.assertEqual(maps["M17020"]["header_entry_tlk_raw"], 0)
        self.assertEqual(maps["M17028"]["header_entry_tlk_raw"], 0)
        setup = next(row for row in maps["M17010"]["records"] if row["id"] == 69)
        self.assertEqual((setup["condition_index"], setup["condition_bit"], setup["if_true"]), (12, 1, 70))


if __name__ == "__main__":
    unittest.main()
