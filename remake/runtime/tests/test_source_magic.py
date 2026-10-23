"""System.MAG full-source coverage and non-unique source-ID preservation."""
import json
from pathlib import Path
import struct
import sys
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME / "tools"))
from export_source_magic import (parse_magic, build_catalog, encoded, OUTPUT,
                                 SOURCE_PATH, HEADER_BYTES, RECORD_BYTES, sha)


class MagicBoundaries(unittest.TestCase):
    @staticmethod
    def fixture(count=2):
        header = bytearray(HEADER_BYTES)
        struct.pack_into("<HI", header, 0, 4, count)
        records = []
        for index in range(count):
            record = bytearray(RECORD_BYTES)
            struct.pack_into("<I", record, 0, 28)
            record[4:8] = b"name"
            record[24:31] = b"001.dgp"
            struct.pack_into("<I", record, 0x4E, 77 + index)
            record[-1] = 255
            records.append(bytes(record))
        return bytes(header) + b"".join(records)

    def test_duplicate_source_id_never_overwrites_records_or_runtime_raw_fields(self):
        raw = self.fixture()
        version, count, rows = parse_magic(raw)
        self.assertEqual((version, count), (4, 2))
        self.assertEqual([row["id"] for row in rows], [0, 1])
        self.assertEqual([row["original_source_id"] for row in rows], [28, 28])
        self.assertEqual([row["u32_at_0x4e_raw"] for row in rows], [77, 78])
        self.assertEqual(raw[:HEADER_BYTES] + b"".join(bytes.fromhex(row["raw_hex"]) for row in rows), raw)

    def test_truncation_extra_tail_count_drift_and_unestablished_version_rejected(self):
        raw = self.fixture()
        too_many = bytearray(raw)
        struct.pack_into("<I", too_many, 2, 0xFFFFFFFF)
        wrong_version = bytearray(raw)
        struct.pack_into("<H", wrong_version, 0, 3)
        for invalid in [raw[:1], raw[:HEADER_BYTES - 1], raw[:-1], raw + b"x", too_many, wrong_version]:
            with self.subTest(size=len(invalid)), self.assertRaises(ValueError):
                parse_magic(invalid)


class ShippedMagic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = build_catalog()

    def test_every_record_index_and_source_byte_is_preserved_and_reproducible(self):
        source = SOURCE_PATH.read_bytes()
        self.assertEqual(self.catalog["record_count_raw"], 41)
        self.assertEqual(list(self.catalog["magic"]), [str(i) for i in range(41)])
        chunks = [bytes.fromhex(self.catalog["header_raw_hex"])]
        for index, row in enumerate(self.catalog["magic"].values()):
            at = HEADER_BYTES + index * RECORD_BYTES
            raw = source[at:at + RECORD_BYTES]
            self.assertEqual(row["id"], index)
            self.assertEqual(row["source"]["record_offset"], at)
            self.assertEqual(row["source"]["record_index"], index)
            self.assertEqual(row["source"]["record_sha256"], sha(raw))
            self.assertEqual(row["source"]["sha256"], sha(source))
            self.assertEqual(row["raw_hex"], raw.hex())
            self.assertEqual(row["effect_token_field_raw_hex"], raw[24:44].hex())
            self.assertEqual(row["name_field_raw_hex"], raw[4:24].hex())
            chunks.append(bytes.fromhex(row["raw_hex"]))
        self.assertEqual(b"".join(chunks), source)
        self.assertEqual(OUTPUT.read_bytes(), encoded(self.catalog))
        self.assertTrue(self.catalog["coverage"]["eof_verified"])

    def test_native_source_id_28_has_two_distinct_records_and_no_invented_id_29(self):
        self.assertEqual(self.catalog["indexes"]["by_source_id"]["28"], [27, 28])
        self.assertNotIn("29", self.catalog["indexes"]["by_source_id"])
        self.assertEqual(self.catalog["coverage"]["duplicate_source_ids"], {"28": [27, 28]})
        left, right = self.catalog["magic"]["27"], self.catalog["magic"]["28"]
        self.assertEqual([left["original_source_id"], right["original_source_id"]], [28, 28])
        self.assertNotEqual(left["name"], right["name"])
        self.assertNotEqual(left["raw_hex"], right["raw_hex"])


if __name__ == "__main__":
    unittest.main()
