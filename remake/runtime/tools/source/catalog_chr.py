"""Lossless v8 CHR stream reader for the complete shipped role catalog.

The native 4FED00 reader consumes 0x30B header, then each 0x41D skill and
its 0xB0 actions. 4FDD00 / 4FF480 consume header+0x1CE * 0x66F opaque
records afterwards. See evidence/source_library_20261023/native.json.
No field in the opaque records is assigned gameplay semantics.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import struct

from .combat_resources import ACTION_BYTES, HEADER_BYTES, SKILL_BYTES, CHRError, FILE_REFS

OPTIONAL_BYTES = 0x66F


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


class CatalogCHR:
    """Every byte belongs to the prefix, header, fixed/action records or tail."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.data = self.path.read_bytes()
        self.sha256 = sha(self.data)
        self.version = self.u32(0)
        if self.version != 8:
            raise CHRError(f"Unsupported CHR version {self.version}: {self.path}")
        self.reserved_raw = self.u32(4)
        self.header = self.take(8, HEADER_BYTES)
        self.name_raw = self.header[4:24].split(b"\0", 1)[0]
        self.name = self.name_raw.decode("cp936", "strict")
        self.skill_count = self.u32(8)
        self.post_role_record_count_raw = self.u32(8 + 0x1CE)
        cursor = 8 + HEADER_BYTES
        if self.skill_count > (len(self.data) - cursor) // SKILL_BYTES:
            raise CHRError("Skill count cannot fit the remaining stream")
        self.skills = []
        for index in range(self.skill_count):
            fixed = self.take(cursor, SKILL_BYTES)
            count = self.u32(cursor + 0x15)
            actions_offset = cursor + SKILL_BYTES
            if count > (len(self.data) - actions_offset) // ACTION_BYTES:
                raise CHRError(f"Skill {index} action count exceeds the remaining stream")
            actions = []
            for action_index in range(count):
                offset = actions_offset + action_index * ACTION_BYTES
                raw = self.take(offset, ACTION_BYTES)
                actions.append({
                    "index": action_index, "offset": offset, "bytes": ACTION_BYTES,
                    "type_raw": raw[0], "u32_at_0x01_raw": self.u32(offset + 1),
                    "u32_at_0x05_raw": self.u32(offset + 5),
                    "u32_at_0x2a_raw": self.u32(offset + 0x2A),
                    "u32_at_0x33_raw": self.u32(offset + 0x33),
                    "u32_at_0x3b_raw": self.u32(offset + 0x3B),
                    "u32_at_0x43_raw": self.u32(offset + 0x43),
                    "movement_i32_raw_0x1e": struct.unpack_from("<i", raw, 0x1E)[0],
                    "class_raw": raw[0x24], "action_mask_raw": raw[0x78],
                    "reaction_mode_raw_0x77": raw[0x77],
                    "reaction_class_raw_0x62": raw[0x62],
                    "contact_u32_raw_0x49": self.u32(offset + 0x49),
                    "file_reference_literals": [
                        {"action_relative_offset": match.start(),
                         "file_offset": offset + match.start(),
                         "raw_hex": match.group().hex(),
                         "text_ascii": match.group().decode("ascii"),
                         "confidence": "literal-only; may be a partial string"}
                        for match in FILE_REFS.finditer(raw)],
                    "raw_hex": raw.hex(), "raw_sha256": sha(raw),
                })
            name_raw = fixed[1:0x15].split(b"\0", 1)[0]
            end = actions_offset + count * ACTION_BYTES
            self.skills.append({
                "index": index, "offset": cursor, "fixed_bytes": SKILL_BYTES,
                "id_raw": fixed[0], "name_cp936": name_raw.decode("cp936", "strict"),
                "name_raw_hex": name_raw.hex(), "fixed_raw_hex": fixed.hex(),
                "action_record_count": count, "action_count_offset": cursor + 0x15,
                "actions_offset": actions_offset, "end_offset": end, "actions": actions,
            })
            cursor = end
        self.optional_records_offset = cursor
        if self.post_role_record_count_raw > (len(self.data) - cursor) // OPTIONAL_BYTES:
            raise CHRError("Optional 0x66F post-role records exceed the remaining stream")
        self.optional_records = []
        for index in range(self.post_role_record_count_raw):
            raw = self.take(cursor, OPTIONAL_BYTES)
            self.optional_records.append({"index": index, "offset": cursor,
                                          "bytes": OPTIONAL_BYTES,
                                          "raw_hex": raw.hex(), "sha256": sha(raw)})
            cursor += OPTIONAL_BYTES
        if cursor != len(self.data):
            raise CHRError(f"Unconsumed CHR bytes: parsed {cursor}, actual {len(self.data)}")
        self.parsed_end = cursor

    def take(self, offset: int, size: int) -> bytes:
        if offset < 0 or size < 0 or offset + size > len(self.data):
            raise CHRError(f"Truncated CHR block at 0x{offset:x}, need {size}")
        return self.data[offset:offset + size]

    def u32(self, offset: int) -> int:
        return struct.unpack("<I", self.take(offset, 4))[0]

    def reconstruct(self) -> bytes:
        parts = [self.data[:8], self.header]
        for skill in self.skills:
            parts.append(bytes.fromhex(skill["fixed_raw_hex"]))
            parts.extend(bytes.fromhex(action["raw_hex"]) for action in skill["actions"])
        parts.extend(bytes.fromhex(record["raw_hex"]) for record in self.optional_records)
        return b"".join(parts)
