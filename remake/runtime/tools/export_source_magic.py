"""Preserve the complete shipped SYSTEM/System.MAG table without runtime rewrites.

REA 0x49BB10 reads an 0x12-byte header and count@+2 * 0x21E records.
Its in-memory assignment record[0]=record[0x4E]; record[0x4E]=1 must not
alter the disk evidence. Stable catalog identity is the zero-based record
index: native source DWORD IDs are not unique in the shipped table.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / "tools"))
from source.combat_resources import GAME_SHA256

SOURCE_PATH = ROOT / "SYSTEM/System.MAG"
NATIVE_PATH = RUNTIME / "evidence/source_library_20261023/magic_native.json"
OUTPUT = RUNTIME / "web/data/library/magic.json"
REPORT_OUTPUT = RUNTIME / "evidence/source_library_20261023/magic_export.json"
HEADER_BYTES = 0x12
RECORD_BYTES = 0x21E


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def rel(path):
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def parse_magic(raw):
    if len(raw) < HEADER_BYTES:
        raise ValueError("Truncated MAG header")
    version = struct.unpack_from("<H", raw)[0]
    count = struct.unpack_from("<I", raw, 2)[0]
    if version != 4:
        raise ValueError(f"Unsupported MAG version: {version}")
    expected_end = HEADER_BYTES + count * RECORD_BYTES
    if expected_end != len(raw):
        raise ValueError(f"MAG count/EOF mismatch: count {count}, expected {expected_end}, actual {len(raw)}")
    rows = []
    for index in range(count):
        offset = HEADER_BYTES + index * RECORD_BYTES
        record = raw[offset:offset + RECORD_BYTES]
        name_raw = record[4:24].split(b"\0", 1)[0]
        token_raw = record[24:44].split(b"\0", 1)[0]
        rows.append({"id": index, "record_index": index,
                     "original_source_id": struct.unpack_from("<I", record)[0],
                     "name": name_raw.decode("cp936", "strict"),
                     "name_raw_hex": name_raw.hex(), "name_field_raw_hex": record[4:24].hex(),
                     "effect_token_raw": token_raw.decode("ascii", "strict"),
                     "effect_token_field_raw_hex": record[24:44].hex(),
                     "u32_at_0x4e_raw": struct.unpack_from("<I", record, 0x4E)[0],
                     "raw_hex": record.hex(),
                     "source": {"path": "SYSTEM/System.MAG", "sha256": sha(raw),
                                "record_index": index, "record_offset": offset,
                                "record_bytes": RECORD_BYTES, "record_sha256": sha(record)},
                     "classification": {"source_kind": "system-magic", "runtime_handler_status": "not-assessed"}})
    if raw[:HEADER_BYTES] + b"".join(bytes.fromhex(row["raw_hex"]) for row in rows) != raw:
        raise ValueError("MAG lossless reconstruction failed")
    return version, count, rows


def build_catalog():
    sources = {path: path.read_bytes() for path in [SOURCE_PATH, ROOT / "GAME.exe", NATIVE_PATH]}
    hashes = {rel(path): sha(raw) for path, raw in sources.items()}
    if hashes["GAME.exe"] != GAME_SHA256:
        raise ValueError("GAME.exe differs from retained MAG evidence")
    bundle = json.loads(sources[NATIVE_PATH].decode("utf-8"))
    record = next(row for row in bundle["records"]
                  if row["operation"] == "procedure_pseudo_code"
                  and row["parameters"].get("procedure", "").lower() == "0x49bb10")
    if record["subject"]["digest"]["sha256"] != GAME_SHA256:
        raise ValueError("MAG native loader evidence binary drift")
    raw = sources[SOURCE_PATH]
    version, count, rows = parse_magic(raw)
    by_source_id, by_name, by_token = defaultdict(list), defaultdict(list), defaultdict(list)
    for row in rows:
        by_source_id[str(row["original_source_id"])].append(row["record_index"])
        by_name[row["name"]].append(row["record_index"])
        by_token[row["effect_token_raw"]].append(row["record_index"])
    duplicates = {key: values for key, values in by_source_id.items() if len(values) > 1}
    if any(path.read_bytes() != original for path, original in sources.items()):
        raise ValueError("Read-only MAG inputs changed during export")
    return {"schema": "seventh-seal-source-magic", "version": 1,
            "source": {"path": "SYSTEM/System.MAG", "sha256": hashes["SYSTEM/System.MAG"], "bytes": len(raw)},
            "version_raw": version, "record_count_raw": count,
            "count_file_offset": 2, "header_bytes": HEADER_BYTES, "record_bytes": RECORD_BYTES,
            "header_raw_hex": raw[:HEADER_BYTES].hex(), "header_sha256": sha(raw[:HEADER_BYTES]),
            "magic": {str(row["record_index"]): row for row in rows},
            "indexes": {"by_source_id": dict(by_source_id), "by_name": dict(by_name),
                        "by_effect_token_raw": dict(by_token)},
            "source_hashes": hashes,
            "coverage": {"scope": "Complete SYSTEM/System.MAG v4 header and every fixed record",
                         "record_count": count, "parsed_end": len(raw), "eof_verified": True,
                         "lossless_reconstruction_verified": True, "source_bytes_unchanged": True,
                         "duplicate_source_ids": duplicates, "failures": []},
            "provenance": {"loader": {"path": rel(NATIVE_PATH), "procedure": "0x49bb10",
                                      "evidence_id": record["evidence_id"], "kind": "native-static"},
                           "runtime_rewrite": {"source_field_offset": 0x4E, "destination_field_offset": 0,
                                               "source_field_replaced_with": 1,
                                               "preserved_disk_record": True}},
            "limits": ["Catalog identity is the original zero-based record index, not the non-unique source DWORD at +0.",
                       "The shipped source ID 28 occurs in two distinct records; both are retained without renumbering their source ID.",
                       "Header bytes, full records and NUL-terminated fields retain all original padding and stale bytes.",
                       "Native loader overwrites DWORD+0 from DWORD+0x4E and sets DWORD+0x4E to 1 in memory; exported source bytes are not rewritten.",
                       "Names and effect tokens are literal fields. Effect execution, availability and whether this is legacy data remain unestablished.",
                       "Catalog membership does not enable runtime skills or acquisition events. Original game execution was not observed."]}


def export(check=False):
    catalog = build_catalog()
    output = encoded(catalog)
    report = {"schema": "seventh-seal-source-magic-export", "version": 1,
              "coverage": catalog["coverage"], "source_hashes": catalog["source_hashes"],
              "output_hashes": {rel(OUTPUT): sha(output)}, "provenance": catalog["provenance"],
              "original_game_execution_observed": False}
    for path, raw in [(OUTPUT, output), (REPORT_OUTPUT, encoded(report))]:
        if not path.resolve().is_relative_to(RUNTIME.resolve()):
            raise ValueError("MAG outputs must remain in remake/runtime")
        if check:
            if not path.exists() or path.read_bytes() != raw:
                raise ValueError(f"MAG output is missing or stale: {rel(path)}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
    print(json.dumps({"passed": True, "check": check, **catalog["coverage"]}, ensure_ascii=True))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify current MAG outputs without writing")
    export(parser.parse_args().check)
