import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from map_npc_fields import initial_npc_visibility


class NpcVisibilityExportTests(unittest.TestCase):
    def test_loader_hide_is_a_generic_nonzero_byte_rule(self):
        for hidden in (0, 1, 9):
            for on_load in (0, 1, 7):
                raw = bytearray(0x4C5)
                raw[0x97], raw[0x2AC] = hidden, on_load
                fields = initial_npc_visibility(raw)
                self.assertEqual(fields["hidden"], bool(hidden or on_load))
                self.assertEqual(fields["hidden_raw_97"], hidden)
                self.assertEqual(fields["hidden_on_load_raw_2ac"], on_load)

    def test_truncated_source_record_is_rejected(self):
        with self.assertRaises(ValueError):
            initial_npc_visibility(bytes(0x2AD))
