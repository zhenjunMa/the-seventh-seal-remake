"""Export real combat DGP action atlases without changing original inputs.

Header[19] auxiliary indexed data is preserved by DGP but never used as a
guessed color/alpha source. Atlases contain the separately loaded main RGB565
rows. CHR names, skill bytes and static animation-index evidence are retained.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import struct
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from PIL import Image
from source.combat_resources import CHR, GAME_SHA256, ROOT, PROJECT
from source.dgp import DGP, DGPError, Reader, u16

SAMPLES = ("001", "002", "012")
WEB = PROJECT / "web"
ASSETS = WEB / "assets/combat_lab"
EVIDENCE = PROJECT / "evidence/source"
LOADER_ID = "ev_9abd5ba6645433c0752e35b69015a7f998c9c9b054862a5afdfadc7499e40962"
ROWS_ID = "ev_6482fb38218f9adb514e906dac54cdf6c3c4a3feb48e936b7968d60150842102"
ACTION_CALL_ASM_ID = "ev_ad54dbda1ffc67d6ef6a0fcf1e6c3676f23727fe36df43ad0645128b44e9c7ee"
ACTION_USE_ID = "ev_66f82c795bc2c5392a4af502e71da424a6f4e6b2c796a8bcc66a61f2d38eec29"
POSITION_WRITE_ASM_ID = "ev_e684765a5b552708f4e35b7fa0516950d8ef5d9e5acc0b9e4ddb0f7e3ff1a5cf"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value) -> None:
    path = path.resolve()
    if not path.is_relative_to(PROJECT.resolve()):
        raise DGPError("Export path must remain within remake/runtime")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def confirmed_animation_index() -> bool:
    path = EVIDENCE / "combat_animation_native_20261011.json"
    if not path.exists():
        return False
    records = {r["evidence_id"]: r for r in json.loads(path.read_text("utf-8"))["records"]}
    return all(key in records for key in (ACTION_CALL_ASM_ID, ACTION_USE_ID))


def secondary_status(dgp: DGP) -> dict:
    """Keep an invalid unused 555 stream distinct from valid main 565 pixels."""
    try:
        status = dgp.verify_secondary()
        status['independently_verified'] = status['present']
        return status
    except DGPError as error:
        status = dict(present=True, independently_verified=False, error=str(error),
                      rendered=False, comparison_uses_primary_layout=True,
                      structural_bytes=0, secondary_structural_nonzero_bytes=0,
                      structural_matching_bytes=0, primary_layout_pixels_compared=0,
                      conversion_mismatches=0)
        for frame in dgp.frames:
            primary = Reader(dgp.primary[frame.offset:frame.offset + frame.size])
            secondary = Reader(dgp.secondary[frame.offset:frame.offset + frame.size])

            def structure(size: int) -> bytes:
                original, other = primary.take(size), secondary.take(size)
                status['structural_bytes'] += size
                status['secondary_structural_nonzero_bytes'] += sum(b != 0 for b in other)
                status['structural_matching_bytes'] += sum(a == b for a, b in zip(original, other))
                return original

            for _ in range(dgp.height):
                count = u16(structure(2), 0)
                if count != 0xFFFF:
                    for _ in range(count):
                        size = u16(structure(4), 2)
                        rgb565, rgb555 = primary.take(size * 2), secondary.take(size * 2)
                        for (value,), (other,) in zip(struct.iter_unpack('<H', rgb565),
                                                     struct.iter_unpack('<H', rgb555), strict=True):
                            expected = (((value & 0xFFE0) >> 1) & 0xFFE0) | (value & 31)
                            status['primary_layout_pixels_compared'] += 1
                            status['conversion_mismatches'] += expected != other
            if primary.pos != len(primary.data) or secondary.pos != len(secondary.data):
                raise DGPError('Secondary diagnostic does not cover declared frame bytes')
        status['limit'] = ('Comparison reads the unused second block at primary-layout positions. '
                           'It does not establish an independently decodable native RGB555 stream.')
        return status


def export_role(key: str, action_index_confirmed: bool) -> tuple[dict, dict]:
    source = ROOT / "Fight_Role" / (key + ".dgp")
    character_source = source.with_suffix(".CHR")
    dgp, role = DGP(source), CHR(character_source)
    expected = 0
    for action in dgp.actions:
        count = action["directions"] * action["frames_per_direction"]
        if count <= 0 or action["first_frame"] != expected:
            raise DGPError(f"{key}: action {action['index']} does not continue an exact frame partition")
        expected += count
    if expected != dgp.frame_count:
        raise DGPError(f"{key}: action partition does not cover every real frame")

    opaque_pixels = 0
    for frame in range(dgp.frame_count):
        for y, spans in dgp.rows(frame):
            end = 0
            for x, count, raw in spans:
                if x < end or x + count > dgp.width:
                    raise DGPError(f"{key}: frame {frame} row {y} has an invalid span")
                end = x + count
                opaque_pixels += count
    secondary_check = secondary_status(dgp)
    target = ASSETS / key
    target.mkdir(parents=True, exist_ok=True)
    actions, frame_hashes, sheet_checks = [], [], []
    for action in dgp.actions:
        n, directions = action["frames_per_direction"], action["directions"]
        sheet = Image.new("RGBA", (dgp.width * n, dgp.height * directions))
        for direction in range(directions):
            for column in range(n):
                frame = action["first_frame"] + direction * n + column
                image = dgp.decode(frame)
                frame_hashes.append({"frame": frame, "rgba_sha256": sha256(image.tobytes())})
                sheet.paste(image, (column * dgp.width, direction * dgp.height))
        output = target / f"action_{action['index']:02d}.png"
        expected_rgba = sha256(sheet.tobytes())
        sheet.save(output)
        with Image.open(output) as stored:
            if stored.size != sheet.size or sha256(stored.convert("RGBA").tobytes()) != expected_rgba:
                raise DGPError(f"{key}: PNG round trip differs for action {action['index']}")
        atlas = {k: action[k] for k in ("index", "directions", "directions_raw", "frames_per_direction",
                                       "first_frame", "interval_raw", "loop_raw", "identifier_raw")}
        atlas.update(sheet=output.relative_to(WEB).as_posix(),
                     sheet_width=sheet.width, sheet_height=sheet.height,
                     sheet_sha256=sha256(output.read_bytes()), sheet_rgba_sha256=expected_rgba,
                     frame_layout="columns=frames_per_direction; rows=directions")
        actions.append(atlas)
        sheet_checks.append({"action": action["index"], "pixels": sheet.width * sheet.height,
                             "png_roundtrip_equal": True})

    skills = []
    for skill in role.skills:
        fixed = bytes.fromhex(skill["fixed_raw_hex"])
        skill_actions = []
        for action in skill["actions"]:
            raw = bytes.fromhex(action["raw_hex"])
            index = struct.unpack_from("<I", raw, 1)[0]
            entry = {"index": action["index"], "type_raw": raw[0],
                     "dgp_action_index": index if raw[0] == 0 else None,
                     "u32_at_0x01_raw": index,
                     "dgp_action_index_confirmed": bool(raw[0] == 0 and action_index_confirmed),
                     "dgp_action_index_in_bounds": index < len(dgp.actions) if raw[0] == 0 else None,
                     "raw_reject_mask": raw[0x78], "target_class_raw": raw[0x24],
                     "target_class_raw_limit": "0x50E9F1 copies this byte to DAT_0524A633; upper/middle/lower labels are not mapped.",
                     "source_offset": action["offset"], "source_bytes": len(raw),
                     "raw_sha256": sha256(raw)}
            if raw[0] == 0 and index >= len(dgp.actions):
                raise DGPError(f"{key}: skill {skill['index']} action {action['index']} exceeds DGP action table")
            skill_actions.append(entry)
        skills.append({"index": skill["index"], "id_raw": skill["id_raw"],
                       "name": skill["name_cp936"], "gate_raw": fixed[0x3A],
                       "gate_source_offset": skill["offset"] + 0x3A,
                       "source_offset": skill["offset"], "type_flags_raw": skill["type_flags_raw"],
                       "actions": skill_actions})
    record = {"id": key, "name": role.name, "source": source.relative_to(ROOT).as_posix(),
              "sha256": dgp.sha256, "chr_source": character_source.relative_to(ROOT).as_posix(),
              "chr_sha256": role.sha256, "frame_width": dgp.width, "frame_height": dgp.height,
              "frame_count": dgp.frame_count,
              "pixel_format": "primary RGB565 sparse rows",
              "native_action_index_verified": action_index_confirmed,
              "secondary_stream_validation": secondary_check,
              "anchor": {"x": dgp.anchor_raw[0], "y": dgp.anchor_raw[1],
                         "source": "DGP extra_header+0x10/+0x14 raw values", "native_use_verified": False},
              "actions": actions, "skills": skills, "definition_fields": role.metadata()["definition_fields"],
              "source_hashes": {source.relative_to(ROOT).as_posix(): dgp.sha256,
                                character_source.relative_to(ROOT).as_posix(): role.sha256}}
    check = {"id": key, "source": record["source"], "sha256": dgp.sha256,
             "frames": dgp.frame_count, "actions": len(actions), "all_rows_checked": True,
             "decoded_frames": len(frame_hashes), "frame_rgba_hashes": frame_hashes,
             "opaque_pixels": opaque_pixels, "eof_verified": True,
             "secondary": secondary_check, "sheets": sheet_checks,
             "indexed_auxiliary_records": len(dgp.indexed_auxiliary),
             "indexed_auxiliary_active_records": sum(bool(r["active_raw"]) for r in dgp.indexed_auxiliary),
             "indexed_auxiliary_bytes_preserved": sum(b["bytes"] for b in dgp.optional_blocks
                                                     if b["kind"] in ("palette", "indexed_pixels")),
             "indexed_auxiliary_rendering_performed": False}
    meta = dgp.metadata()
    meta["source"] = record["source"]
    write_json(EVIDENCE / f"combat_animation_{key}_20261011.json", meta)
    return record, check


def main() -> int:
    start = time.monotonic()
    inputs = [ROOT / "GAME.exe"] + [ROOT / "Fight_Role" / (key + suffix)
                                     for key in SAMPLES for suffix in (".dgp", ".CHR")]
    before = {p.relative_to(ROOT).as_posix(): sha256(p.read_bytes()) for p in inputs}
    if before["GAME.exe"] != GAME_SHA256:
        raise DGPError("Binary identity differs from retained native evidence")
    original_manifest = WEB / "data/source/manifest.json"
    old_manifest_hash = sha256(original_manifest.read_bytes()) if original_manifest.exists() else None
    index_confirmed = confirmed_animation_index()
    manifest = {"schema": "seventh-seal-combat-lab", "version": 1,
                "native_action_index_verified": index_confirmed,
                "created_utc": datetime.now(timezone.utc).isoformat(), "roles": [], "errors": [],
                "source_hashes": before, "evidence": [
                    {"path": "remake/assessment/native_resource_evidence.json", "ids": [LOADER_ID, ROWS_ID]},
                    {"path": "remake/runtime/evidence/source/combat_animation_native_20261011.json",
                     "ids": [ACTION_CALL_ASM_ID, ACTION_USE_ID, POSITION_WRITE_ASM_ID]}],
                "limits": [
                    "Every atlas contains real main RGB565 sparse-row pixels; auxiliary indexed palettes are retained without guessing their effect rendering.",
                    "002's unused second RGB555 block has zero row/span headers and cannot be decoded independently. Its pixel words match conversion only when read using the main 565 layout. No 555 runtime rendering is asserted.",
                    "Action indices are exported without naming their game semantics. DGP timing/loop fields remain raw.",
                    "Atlases expose every physical DGP frame in table order. Native DGP+0x16 sequence tables and CHR+0x26/+0x2A frame ranges are not reproduced by a full-row preview.",
                    "CHR type 0 action+1 is statically confirmed as a DGP action-table index; nonzero action types are not implemented as effects.",
                    "Atlas playback does not reproduce the native skill scheduler, hit-frame timing, sound, camera, or complete battle rules.",
                    "Anchor x/y preserve original extra-header values; the native draw use remains unverified.",
                    "Target classification byte and rejection masks are exported as raw values; upper/middle/lower mapping is unconfirmed. Event field +0x6A is not named as a hit frame.",
                    "CHR player attributes are resource defaults; a loaded player may use saved role state through the native loader's other branch.",
                    "No original-game combat runtime comparison is asserted by this export."]}
    verification = {"created_utc": manifest["created_utc"], "source_hashes": before,
                    "schema": "seventh-seal-combat-animation-verification", "version": 1, "checks": []}
    for key in SAMPLES:
        try:
            role, check = export_role(key, index_confirmed)
            manifest["roles"].append(role)
            verification["checks"].append(check)
            print(f"PASS {key}: {check['frames']} real frames; {check['actions']} action PNGs; {check['opaque_pixels']} opaque pixels", flush=True)
        except (DGPError, OSError, ValueError) as exc:
            manifest["errors"].append({"id": key, "error": str(exc), "role_omitted": True})
            print(f"FAIL {key}: {exc}", flush=True)
    after = {p.relative_to(ROOT).as_posix(): sha256(p.read_bytes()) for p in inputs}
    unchanged = before == after
    legacy_unchanged = old_manifest_hash == (sha256(original_manifest.read_bytes()) if original_manifest.exists() else None)
    manifest["source_bytes_unchanged"] = unchanged
    verification.update(source_bytes_unchanged=unchanged, changed_inputs=[p for p in before if before[p] != after[p]],
                        legacy_manifest_unchanged=legacy_unchanged, errors=manifest["errors"],
                        decoded_frames=sum(c["decoded_frames"] for c in verification["checks"]),
                        exported_actions=sum(c["actions"] for c in verification["checks"]),
                        elapsed_seconds=round(time.monotonic() - start, 2))
    write_json(WEB / "data/source/combat_manifest.json", manifest)
    write_json(EVIDENCE / "combat_animation_verification_20261011.json", verification)
    print(json.dumps({k: verification[k] for k in ("decoded_frames", "exported_actions", "source_bytes_unchanged", "legacy_manifest_unchanged", "elapsed_seconds")}), flush=True)
    return 0 if unchanged and legacy_unchanged and len(manifest["roles"]) == len(SAMPLES) and not manifest["errors"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
