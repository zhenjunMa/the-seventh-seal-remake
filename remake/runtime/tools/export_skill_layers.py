"""Export the bounded Yantu actor layers, with an independent source-byte audit.

Original GAME/CHR/DGP files are read only. The production decoders are reused;
the audit below independently locates and decodes sparse rows from file bytes.
This is a same-source-frame inspection export, not an original battle replay.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import struct
import sys

RUNTIME = Path(__file__).resolve().parents[1]
REMAKE = RUNTIME.parent
ROOT = REMAKE.parent
sys.path.insert(0, str(RUNTIME / 'tools'))

from incremental import save_png
from PIL import Image, ImageDraw
from source.combat_resources import CHR, GAME_SHA256
from source.dgp import DGP, DGPError
from export_combat_presentation import indexed_contribution, native_frame_sequence

WEB = RUNTIME / "web"
SOURCE_WEB = WEB / 'data/source'
ASSETS = WEB / "assets/skills/yantu"
EVIDENCE = RUNTIME / "evidence"
DGP_SHA256 = "df86e4089870c720beee6c8fb216ee1f85156b061c69433a6ce767ce9dee6b49"
CHR_SHA256 = "37ce92ab57622d2cce022b4a9b8add9b29789f89d82bc369ea7352f38ca75c0a"
NATIVE = {
    "loader": "ev_9abd5ba6645433c0752e35b69015a7f998c9c9b054862a5afdfadc7499e40962",
    "indexed_draw": "ev_0c237df7043928c88bbdebd562f666aa4b7f4201a779c0a793b1483939fd71d2",
    "pixel_format": "ev_a6647ea0bc3a48a670332ca03d6a4e02d7b145a407b5a5ad2dcfa4ed39b122d1",
    "integrated_scaled_additive": "ev_c2389f434b39dc55444e72ee2ab400b3277d3cf3149032728acf29ffa53dd76e",
    "frame_range": "ev_e684765a5b552708f4e35b7fa0516950d8ef5d9e5acc0b9e4ddb0f7e3ff1a5cf",
    "frame_range_pseudo": "ev_66f82c795bc2c5392a4af502e71da424a6f4e6b2c796a8bcc66a61f2d38eec29",
}


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def output_json(path: Path, value: dict) -> None:
    if not path.resolve().is_relative_to(RUNTIME.resolve()):
        raise DGPError("All outputs must remain inside remake/runtime")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", "utf-8")


class SourceAudit:
    """Independent parser: no DGP/Reader/rows helpers or decoder metadata."""

    def __init__(self, data: bytes):
        self.data = data
        if len(data) < 0x43 or data[0] != 9:
            raise DGPError("Audit requires bounded DGP v9 input")
        action_start = 0x43
        geometry = action_start + data[2] * 0xAC
        self.width, self.height, self.count = struct.unpack_from("<HHI", data, geometry)
        self.anchor = list(struct.unpack_from("<III", data, geometry + 0x2A + 0x10))
        self.payload, self.payload_bytes = struct.unpack_from("<II", data, geometry + 0x20)
        self.actions = [data[action_start + n * 0xAC:action_start + (n + 1) * 0xAC]
                        for n in range(data[2])]
        extra = geometry + 0x2A
        frame_start = extra + 0x30 + data[geometry + 13] * 18
        self.frames = [struct.unpack_from("<5I", data, frame_start + n * 20)
                       for n in range(self.count)]
        position = frame_start + self.count * 20

        def take(size: int) -> int:
            nonlocal position
            if size < 0 or position + size > len(data):
                raise DGPError("Audit optional record leaves input")
            start = position
            position += size
            return start

        volume = struct.unpack_from("<III", data, extra)
        if all(volume):
            take(volume[0] * volume[1] * volume[2])
        if data[5]:
            take(self.width * self.height * self.count)
        if data[6]:
            for _ in range(self.count):
                size = struct.unpack_from("<I", data, take(4))[0]
                take(size * 8)
        self.shadows = []
        if data[geometry + 41]:
            for _ in range(self.count):
                size = struct.unpack_from("<I", data, take(4))[0]
                self.shadows.append((take(size), size))
        self.indexed = []
        if data[19]:
            for frame in range(self.count):
                begin = take(1)
                entry = {"frame": frame, "record_offset": begin, "active_raw": data[begin]}
                if entry["active_raw"]:
                    size_offset = take(4)
                    size = struct.unpack_from("<I", data, size_offset)[0]
                    palette_offset = take(768)
                    pixels_offset = take(size)
                    entry.update(size_field_offset=size_offset, palette_offset=palette_offset,
                                 indexed_pixels_offset=pixels_offset, indexed_pixels_bytes=size)
                entry["end_offset"] = position
                self.indexed.append(entry)
        if position != self.payload:
            raise DGPError("Audit optional records disagree with declared payload start")
        running = 0
        for frame in self.frames:
            if frame[3] != running:
                raise DGPError("Audit physical frame offsets are not contiguous")
            running += frame[4]
        if running != self.payload_bytes:
            raise DGPError("Audit frame sizes disagree with declared payload size")
        expected_end = self.payload + self.payload_bytes * (1 if data[21] else 2)
        if expected_end != len(data):
            raise DGPError("Audit EOF mismatch")

    def sparse(self, frame: int, indexed: bool) -> tuple[bytes, dict]:
        """Decode file offsets with explicit LE reads and coverage-bit audit."""
        if not 0 <= frame < self.count:
            raise DGPError('Audit frame index leaves source frame table')
        record = self.indexed[frame] if indexed and self.indexed else None
        active = not indexed or bool(record and record["active_raw"])
        if indexed and active:
            begin = record["indexed_pixels_offset"]
            size = record["indexed_pixels_bytes"]
            palette = self.data[record["palette_offset"]:record["palette_offset"] + 768]
        elif not indexed:
            begin = self.payload + self.frames[frame][3]
            size = self.frames[frame][4]
        else:
            return bytes(self.width * self.height * 4), {
                "active": False, "covered_pixels": 0, "transparent_pixels": self.width * self.height,
                "span_count": 0, "rows": self.height, "bounds": None, "pixel_probes": [],
            }
        end, position = begin + size, begin
        rgba = bytearray(self.width * self.height * 4)
        bounds = [self.width, self.height, 0, 0]
        occupied = spans = zeros = last_index = 0
        probes = []

        def word() -> int:
            nonlocal position
            if position + 2 > end:
                raise DGPError("Audit row word leaves source block")
            value = self.data[position] | (self.data[position + 1] << 8)
            position += 2
            return value

        y = 0
        visible_end = None
        retained_spans = retained_pixels = 0
        # Main16-bit drawing is bounded by native geometry height52AE7F;
        # complete extra source rows are independently audited and retained.
        # Indexed rows keep their already established exact-height contract.
        while y < self.height or (not indexed and position < end):
            if y >= 8192:
                raise DGPError('Audit stored row count exceeds bound')
            count = word()
            if count != 0xFFFF:
                if count > self.width:
                    raise DGPError("Audit excessive span count")
                previous_end = 0
                for _ in range(count):
                    x, length = word(), word()
                    if x < previous_end or x + length > self.width:
                        raise DGPError("Audit absolute span overlaps/leaves width")
                    previous_end = x + length
                    visible = y < self.height
                    if visible:
                        spans += 1
                        if length:
                            bounds = [min(bounds[0], x), min(bounds[1], y),
                                      max(bounds[2], x + length), max(bounds[3], y + 1)]
                    else:
                        retained_spans += 1
                        retained_pixels += length
                    for dx in range(length):
                        source_offset = position
                        if indexed:
                            if position >= end:
                                raise DGPError("Audit palette index leaves block")
                            value = self.data[position]
                            position += 1
                            p = value * 3
                            color = (palette[p] // 8 * 8, palette[p + 1] // 4 * 4,
                                     palette[p + 2] // 8 * 8, 255)
                            zeros += value == 0
                            last_index += value == 255
                        else:
                            value = word()
                            r, g, b = value // 2048, (value // 32) % 64, value % 32
                            color = (r * 8 + r // 4, g * 4 + g // 16, b * 8 + b // 4, 255)
                        if not visible:
                            continue
                        q = (y * self.width + x + dx) * 4
                        if rgba[q + 3]:
                            raise DGPError("Audit duplicate occupied pixel")
                        rgba[q:q + 4] = bytes(color)
                        occupied += 1
                        if dx == 0 and (len(probes) < 2 or y in (self.height // 2, self.height - 1)):
                            probes.append(dict(x=x, y=y, source_offset=source_offset,
                                               raw_value=value, rgba=list(color)))
            y += 1
            if y == self.height:
                visible_end = position
        if position != end:
            raise DGPError("Audit sparse rows did not consume exact source span")
        transparent = sum(rgba[q] == 0 for q in range(3, len(rgba), 4))
        if transparent + occupied != self.width * self.height:
            raise DGPError("Audit coverage/holes count mismatch")
        return bytes(rgba), dict(active=active, source_offset=begin, source_bytes=size,
                                 source_span_sha256=sha(self.data[begin:end]),
                                 rgba_sha256=sha(rgba), covered_pixels=occupied,
                                 transparent_pixels=transparent, span_count=spans,
                                 rows=self.height, stored_rows=y,
                                 retained_rows=y - self.height, retained_offset=visible_end,
                                 retained_bytes=end - visible_end,
                                 retained_sha256=sha(self.data[visible_end:end]),
                                 retained_span_count=retained_spans, retained_covered_pixels=retained_pixels,
                                 bounds=bounds if occupied else None,
                                 index_zero_pixels=zeros if indexed else None,
                                 index_255_pixels=last_index if indexed else None,
                                 pixel_probes=probes)

    def shadow(self, frame: int) -> tuple[bytes, dict]:
        """Independent colorless geometry[41] spans; native destination /2.

        The PNG alpha128 is the existing 8-bit presentation approximation. It
        must be drawn before the primary copy and intrinsic additive passes.
        """
        if not 0 <= frame < self.count:
            raise DGPError('Audit shadow frame leaves source frame table')
        rgba = bytearray(self.width * self.height * 4)
        covered = spans = 0
        bounds = [self.width, self.height, 0, 0]
        source = {}
        if self.shadows:
            begin, size = self.shadows[frame]
            end, position = begin + size, begin

            def word():
                nonlocal position
                if position + 2 > end:
                    raise DGPError('Audit shadow word leaves source block')
                value = self.data[position] | self.data[position + 1] << 8
                position += 2
                return value

            for y in range(self.height):
                count = word()
                if count == 0xffff:
                    continue
                if count > self.width:
                    raise DGPError('Audit excessive shadow span count')
                previous_end = 0
                for _ in range(count):
                    x, length = word(), word()
                    if x < previous_end or x + length > self.width:
                        raise DGPError('Audit shadow span overlaps/leaves width')
                    previous_end = x + length
                    spans += 1
                    if length:
                        bounds = [min(bounds[0], x), min(bounds[1], y),
                                  max(bounds[2], x + length), max(bounds[3], y + 1)]
                    start = (y * self.width + x) * 4
                    rgba[start:start + length * 4] = bytes((0, 0, 0, 128)) * length
                    covered += length
            if position != end:
                raise DGPError('Audit shadow rows did not consume exact source span')
            source = dict(source_offset=begin, source_bytes=size,
                          source_span_sha256=sha(self.data[begin:end]))
        return bytes(rgba), dict(active=bool(covered), covered_pixels=covered,
            transparent_pixels=self.width * self.height - covered, span_count=spans,
            bounds=bounds if covered else None, rows=self.height, rgba_sha256=sha(rgba), **source)


def save_layer(image: Image.Image, path: Path, audit_rgba: bytes, check: dict, *, web=None) -> dict:
    if image.tobytes() != audit_rgba:
        raise DGPError(f"Independent source span decode disagrees: {path.name}")
    save_png(image, path)
    with Image.open(path) as loaded:
        if loaded.convert("RGBA").tobytes() != audit_rgba:
            raise DGPError(f"Stored PNG disagrees with independent input bytes: {path.name}")
    return dict(path=path.relative_to(WEB if web is None else web).as_posix(), sha256=sha(path.read_bytes()),
                rgba_sha256=sha(audit_rgba), bounds=check["bounds"],
                covered_pixels=check["covered_pixels"], transparent_pixels=check["transparent_pixels"])


def compose_fixture(main: bytes, intrinsic: bytes, width: int, height: int) -> Image.Image:
    """Quantized RGB565 saturating composition on a fixed dark fixture surface."""
    target = bytearray(width * height * 4)
    for q in range(0, len(target), 4):
        rgb = main[q:q + 3] if main[q + 3] else bytes((16, 24, 32))
        r, g, b = rgb[0] >> 3, rgb[1] >> 2, rgb[2] >> 3
        if intrinsic[q + 3]:
            r = min(31, r + (intrinsic[q] >> 3))
            g = min(63, g + (intrinsic[q + 1] >> 2))
            b = min(31, b + (intrinsic[q + 2] >> 3))
        target[q:q + 4] = bytes((r * 8 + r // 4, g * 4 + g // 16, b * 8 + b // 4, 255))
    return Image.frombytes("RGBA", (width, height), target)


def main() -> None:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)
    inputs = [ROOT / "GAME.exe", ROOT / "Fight_Role/001.CHR", ROOT / "Fight_Role/001.dgp"]
    before = {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in inputs}
    if before != {"GAME.exe": GAME_SHA256, "Fight_Role/001.CHR": CHR_SHA256,
                  "Fight_Role/001.dgp": DGP_SHA256}:
        raise DGPError("Input identity differs from retained native evidence")
    existing_paths = [SOURCE_WEB / "combat_manifest.json", SOURCE_WEB / "combat_presentation.json",
                      RUNTIME / "evidence/source/skill_intrinsic_layer_gap_20261011.json"]
    existing_before = {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in existing_paths}
    bundle_paths = [RUNTIME / "evidence/source/combat_presentation_native_20261011.json",
                    RUNTIME / "evidence/source/combat_presentation_indexed_native_20261011.json"]
    records = {record["evidence_id"]: record for path in bundle_paths
               for record in json.loads(path.read_text("utf-8"))["records"]}
    if missing := set(NATIVE.values()) - records.keys():
        raise DGPError(f"Missing retained evidence: {sorted(missing)}")
    if any(records[e]["subject"]["digest"]["sha256"] != GAME_SHA256 for e in NATIVE.values()):
        raise DGPError("Retained native evidence identity mismatch")
    role, dgp = CHR(inputs[1]), DGP(inputs[2])
    audit = SourceAudit(inputs[2].read_bytes())
    if (audit.width, audit.height, audit.count, audit.anchor) != (
            dgp.width, dgp.height, dgp.frame_count, dgp.anchor_raw):
        raise DGPError("Independent layout disagrees with production metadata")
    skill = role.skills[22]
    if skill["name_cp936"] != "炎剑．燕突" or skill["id_raw"] != 26:
        raise DGPError("CHR bounded skill identity mismatch")
    frames, checks, segments, active_preview = [], [], [], []
    retained_sequence = json.loads(existing_paths[1].read_text("utf-8"))["skills"][0]["sequence"]
    for record in skill["actions"]:
        raw = bytes.fromhex(record["raw_hex"])
        if raw[0] != 0:
            continue
        if role.data[record["offset"]:record["offset"] + 0xB0] != raw:
            raise DGPError("CHR action bytes disagree with retained file span")
        group = struct.unpack_from("<I", raw, 1)[0]
        action = dgp.actions[group]
        independent_action = audit.actions[group]
        if (max(1, independent_action[0]), independent_action[14],
                struct.unpack_from("<I", independent_action, 0x72)[0]) != (
                action["directions"], action["frames_per_direction"], action["first_frame"]):
            raise DGPError("Independent action table disagrees with exported source-frame selection")
        if action["directions"] != 1:
            raise DGPError("Bounded export requires the established single source direction")
        start, end = struct.unpack_from("<II", raw, 0x26)
        logical = native_frame_sequence(dgp.raw_actions[group], start, end, raw[0x1D])
        # Independently compare CHR bounds against the retained native manifest.
        old = retained_sequence[len(segments)]
        if old["action_index"] != group or old["frame_sequence"] != logical:
            raise DGPError("Retained CHR sequence differs from current source fields")
        segment = dict(index=len(segments), chr_record_index=record["index"], action_index=group,
                       chr_source_offset=record["offset"], chr_raw_sha256=sha(raw),
                       source_frame_start=action["first_frame"], frame_sequence=logical,
                       native_frame_range=dict(start=start, end_exclusive=end, reverse_raw=raw[0x1D]),
                       interval_raw=action["interval_raw"], timing_verified=False,
                       direction=0, frame_indices=[])
        for action_frame in logical:
            source_frame = action["first_frame"] + action_frame
            main_image = dgp.decode(source_frame)
            layer_image, layer_stats = indexed_contribution(dgp, source_frame)
            main_rgba, main_check = audit.sparse(source_frame, False)
            intrinsic_rgba, intrinsic_check = audit.sparse(source_frame, True)
            if intrinsic_check["bounds"] != layer_stats["bounds"]:
                raise DGPError("Independent indexed bounds differ")
            key = f"frame_{source_frame:04d}"
            main_asset = save_layer(main_image, ASSETS / f"{key}_main.png", main_rgba, main_check)
            main_asset.update(blend="source-over", pixel_format="sparse RGB565 expanded to RGB8")
            layer_asset = save_layer(layer_image, ASSETS / f"{key}_intrinsic.png", intrinsic_rgba, intrinsic_check)
            layer_asset.update(blend="additive-rgb565", active=bool(audit.indexed[source_frame]["active_raw"]),
                               alpha_semantics="Sparse coverage only; covered palette index 0/255 are retained",
                               rgb_semantics="Palette truncated: R/B & 0xF8, G & 0xFC; saturating native channel addition")
            entry = dict(sequence_index=len(frames), segment_index=segment["index"], action_index=group,
                         action_frame=action_frame, direction=0, source_frame=source_frame,
                         main=main_asset, intrinsic=layer_asset,
                         intrinsic_record=audit.indexed[source_frame],
                         main_source_span={k: main_check[k] for k in ("source_offset", "source_bytes", "source_span_sha256")})
            segment["frame_indices"].append(entry["sequence_index"])
            frames.append(entry)
            checks.append(dict(sequence_index=entry["sequence_index"], source_frame=source_frame,
                               main=main_check, intrinsic=intrinsic_check,
                               independent_source_png_comparison_passed=True))
            if layer_asset["active"]:
                active_preview.append((source_frame, main_image, layer_image,
                                       compose_fixture(main_rgba, intrinsic_rgba, dgp.width, dgp.height)))
        segments.append(segment)
    if [s["action_index"] for s in segments] != [7, 11, 8, 28, 9, 12, 10] or len(frames) != 32:
        raise DGPError("Unexpected bounded Yantu sequence")
    gap = json.loads(existing_paths[2].read_text("utf-8"))
    probe = next(a for a in gap["actions"] if a["action_index"] == 28)
    current_probe = next(f for f in frames if f["source_frame"] == probe["probe_source_frame"])
    if current_probe["intrinsic"]["rgba_sha256"] != probe["probe"]["rgba_sha256"]:
        raise DGPError("Historical representative source-frame contribution differs")
    after = {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in inputs}
    existing_after = {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in existing_paths}
    if before != after or existing_before != existing_after:
        raise DGPError("Original inputs or prototype manifests changed during export")
    limits = [
        "Only role001 CHR skill22/id26 Yantu, single existing source direction, seven segments/32 source frames.",
        "Main/intrinsic images share the complete DGP raster; use identical origin/scale and no additional mirror.",
        "Anchor x/y are DGP extra_header+0x10/+0x14 raw values; their native battle-world usage remains unverified.",
        "Inspection composition draws main then same-frame intrinsic additive contribution. This export does not claim the original battle draw branch or runtime layer order is fully recovered.",
        "Retained 0x52868a scaled additive routine reads the same physical frame for main and indexed records and processes main rows before auxiliary rows. Its use by this specific battle sample has not been observed.",
        "Intrinsic validity follows source active_raw and sparse per-frame spans; no independent effect queue/lifetime is invented for this actor-internal layer.",
        "interval_raw and CHR segment order are preserved; combined animation timing, movement trajectory, camera and original skill replay remain unverified.",
        "Canvas lighter is approximate. Exact RGB565 inspection first quantizes destination R/B to5 bits and G to6, adds contribution, saturates and expands for display.",
        "Generic dust/target effects, damage/hit/MP settlement and sounds are outside this bounded layer export.",
    ]
    manifest = dict(schema="seventh-seal-skill-layers", version=1, id="yantu", name=skill["name_cp936"],
                    role_id="001", chr_skill_index=22, skill_id_raw=26, source_hashes=before,
                    frame_width=dgp.width, frame_height=dgp.height,
                    anchor=dict(x=dgp.anchor_raw[0], y=dgp.anchor_raw[1], z_raw=dgp.anchor_raw[2],
                                source="DGP extra_header+0x10/+0x14 raw values", native_use_verified=False),
                    source_orientation=dict(direction=0, mirror=False,
                                            basis="retained prototype battle_facing_correction_20261011.json visual check"),
                    composition=dict(order=["main", "intrinsic"], coordinate_space="complete same-source-frame DGP raster",
                                     relative_origin=[0, 0], native_battle_draw_order_verified=False,
                                     inspection_order="main source-over then RGB565 saturating indexed contribution"),
                    timing=dict(original_timing_verified=False, interval_field="DGP action+0x01 raw DWORD"),
                    segments=segments, frames=frames, evidence=dict(references=NATIVE,
                        bundles=[p.relative_to(ROOT).as_posix() for p in bundle_paths],
                        retained_gap=existing_paths[2].relative_to(ROOT).as_posix()), limits=limits)
    output_json(WEB / "data/yantu_layers.json", manifest)
    preview = Image.new("RGB", (3 * 270, len(active_preview) * 246), (24, 28, 34))
    draw = ImageDraw.Draw(preview)
    for row, (source_frame, *images) in enumerate(active_preview):
        for column, image in enumerate(images):
            tile = Image.new("RGBA", (dgp.width, dgp.height), (16, 24, 32, 255))
            tile.alpha_composite(image)
            preview.paste(tile.convert("RGB").resize((270, 220), Image.Resampling.NEAREST),
                          (column * 270, row * 246 + 24))
            draw.text((column * 270 + 8, row * 246 + 5),
                      f"source {source_frame}: {['main', 'intrinsic', 'RGB565 fixture'][column]}", fill="white")
    preview_path = EVIDENCE / "yantu_layers_contact_sheet_20261011.png"
    save_png(preview, preview_path)
    verification = dict(schema="seventh-seal-skill-layer-verification", version=1,
                        method="Independent file-layout and sparse-row decoder, source bytes compared to both production RGBA and stored PNG; no DGP helpers used by audit",
                        source_hashes_before=before, source_hashes_after=after, original_inputs_unchanged=True,
                        prototype_hashes_before=existing_before, prototype_hashes_after=existing_after,
                        prototype_manifests_and_historical_gap_unchanged=True,
                        exported_main_frames=len(frames), exported_intrinsic_frames=len(frames),
                        active_intrinsic_source_frames=[f[0] for f in active_preview],
                        covered_main_pixels=sum(c["main"]["covered_pixels"] for c in checks),
                        covered_intrinsic_pixels=sum(c["intrinsic"]["covered_pixels"] for c in checks),
                        historical_probe_frame338_matched=True,
                        source_sparse_holes_and_covered_indices_verified=True,
                        manifest_sha256=sha((WEB / "data/yantu_layers.json").read_bytes()),
                        contact_sheet=dict(path=preview_path.relative_to(RUNTIME).as_posix(), sha256=sha(preview_path.read_bytes()),
                                           background_fixture_rgb8=[16, 24, 32], native_runtime_capture=False),
                        frames=checks, limits=limits)
    output_json(EVIDENCE / "yantu_layers_verification_20261011.json", verification)
    print(json.dumps(dict(main_frames=len(frames), active_intrinsic_frames=len(active_preview),
                         covered_intrinsic_pixels=verification["covered_intrinsic_pixels"],
                         independent_source_png_comparison_passed=True, original_inputs_unchanged=True)))


if __name__ == "__main__":
    main()
