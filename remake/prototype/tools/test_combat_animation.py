"""Check every exported real battle frame and main/auxiliary separation.

PNG sheet grid placement and all RGBA bytes are compared with per-frame
export digests, source sparse opacity counts, and unchanged original hashes.
These are asset checks, not original-game combat timing equivalence.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime/tools"))
from PIL import Image
from source.combat_resources import ROOT, PROJECT
from source.dgp import DGP
from export_combat_lab import SAMPLES, ACTION_CALL_ASM_ID, ACTION_USE_ID


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def main():
    web = PROJECT / "web"
    manifest = json.loads((web / "data/source/combat_manifest.json").read_text("utf-8"))
    export = json.loads((PROJECT / "evidence/source/combat_animation_verification_20261011.json").read_text("utf-8"))
    assert manifest["schema"] == "seventh-seal-combat-lab" and manifest["version"] == 1
    assert [r["id"] for r in manifest["roles"]] == list(SAMPLES)
    assert not manifest["errors"] and manifest["source_bytes_unchanged"]
    assert manifest["native_action_index_verified"]
    ids = {r["evidence_id"] for r in json.loads((PROJECT / "evidence/source/combat_animation_native_20261011.json").read_text("utf-8"))["records"]}
    assert ACTION_CALL_ASM_ID in ids and ACTION_USE_ID in ids
    checks = {c["id"]: c for c in export["checks"]}
    verified_frames = 0
    cases = []
    for role in manifest["roles"]:
        key = role["id"]
        source = DGP(ROOT / role["source"])
        expected = {r["frame"]: r["rgba_sha256"] for r in checks[key]["frame_rgba_hashes"]}
        found = set()
        opaque = 0
        for action in role["actions"]:
            path = (web / action["sheet"]).resolve()
            assert path.is_relative_to((web / "assets/combat_lab").resolve())
            assert sha256(path.read_bytes()) == action["sheet_sha256"]
            with Image.open(path) as atlas:
                image = atlas.convert("RGBA")
                assert image.size == (role["frame_width"] * action["frames_per_direction"], role["frame_height"] * action["directions"])
                assert sha256(image.tobytes()) == action["sheet_rgba_sha256"]
                for direction in range(action["directions"]):
                    for column in range(action["frames_per_direction"]):
                        frame = action["first_frame"] + direction * action["frames_per_direction"] + column
                        assert frame not in found
                        found.add(frame)
                        x, y = column * source.width, direction * source.height
                        crop = image.crop((x, y, x + source.width, y + source.height))
                        assert sha256(crop.tobytes()) == expected[frame]
                        # Every sparse source span creates one opaque PNG pixel;
                        # holes remain transparent even when the palette exists.
                        source_opaque = 0
                        expected_rgba = bytearray(source.width * source.height * 4)
                        for row, spans in source.rows(frame):
                            for x, count, raw in spans:
                                source_opaque += count
                                for offset, (value,) in enumerate(struct.iter_unpack('<H', raw)):
                                    red, green, blue = value // 2048, (value // 32) % 64, value % 32
                                    position = (row * source.width + x + offset) * 4
                                    expected_rgba[position:position + 4] = bytes((red * 8 + red // 4,
                                                                               green * 4 + green // 16,
                                                                               blue * 8 + blue // 4, 255))
                        assert crop.tobytes() == bytes(expected_rgba)
                        alpha = crop.getchannel("A").histogram()
                        assert alpha[255] == source_opaque and sum(alpha[1:255]) == 0
                        opaque += source_opaque
                        verified_frames += 1
        assert found == set(range(source.frame_count))
        assert opaque == checks[key]["opaque_pixels"]
        assert checks[key]["secondary"]["present"] == (key == "002")
        assert role["native_action_index_verified"]
        if key == "002":
            secondary = checks[key]["secondary"]
            assert not secondary["independently_verified"]
            assert secondary["secondary_structural_nonzero_bytes"] == 0
            assert secondary["primary_layout_pixels_compared"] == opaque
            assert secondary["conversion_mismatches"] == 0
        for skill in role["skills"]:
            for action in skill["actions"]:
                if action["type_raw"] == 0:
                    assert action["dgp_action_index_confirmed"] and action["dgp_action_index_in_bounds"]
                else:
                    assert action["dgp_action_index"] is None and not action["dgp_action_index_confirmed"]
        cases.append({"id": key, "frames": len(found), "opaque_pixels": opaque,
                      "png_rgba_and_grid_equal": True, "all_source_spans_checked": True})
    unchanged = all(sha256((ROOT / p).read_bytes()) == h for p, h in manifest["source_hashes"].items())
    assert unchanged
    result = {"checks": cases, "verified_frames": verified_frames, "source_bytes_unchanged": unchanged,
              "passed": True, "limits": ["Auxiliary indexed effects and original-game timing were not rendered or compared."]}
    (PROJECT / "evidence/source/combat_animation_checks_20261011.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
