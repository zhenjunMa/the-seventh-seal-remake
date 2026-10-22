"""Independent raw-DAT and exported-pixel checks for the formal map slice."""
from __future__ import annotations
from collections import Counter
import hashlib
import json
from pathlib import Path
import struct
import sys

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(ROOT / "remake/prototype/tools"))
from dgp import DGP
from PIL import Image


def u32(b, offset):
    return struct.unpack_from("<I", b, offset)[0]


def i32(b, offset):
    return struct.unpack_from("<i", b, offset)[0]


def output_path(url):
    assert url.startswith("/") and ".." not in url.split("/")
    return RUNTIME / "web" / url.lstrip("/")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_map(record):
    b = (ROOT / record["source"]["path"]).read_bytes()
    w, h = struct.unpack_from("<II", b, 0x146)
    m = record["movement"]
    assert (w, h) == (m["width"], m["height"])
    assert (w * 16, h * 16) == (record["width"], record["height"])
    gate_start = 0x172 + w * h * 64 + 32 * 42
    triggers = {(t["x"], t["y"]): t for t in m["triggers"]}
    assert len(triggers) == len(m["triggers"])
    for y in range(h):
        for x in range(w):
            off = 0x172 + (y * w + x) * 64
            assert int(m["terrain_rows"][y][x]) == b[off + 0x20]
            ident = u32(b, off + 0x38)
            assert bool(ident) == ((x, y) in triggers)
            if ident:
                trigger = triggers[x, y]
                raw = b[gate_start + (ident - 1) * 66:gate_start + ident * 66]
                assert trigger["id"] == ident
                assert trigger["descriptor_hex"] == raw.hex()
                assert trigger["path_gate"] == (raw[0] == 0 and bool(raw[0x11]))
    background = Image.open(output_path(record["background"]["image"])).convert("RGBA")
    assert background.size == (w * 16, h * 16)
    count = u32(b, 0x96)
    resource_names = [b[0x9A + i * 20:0x9A + (i + 1) * 20].split(b"\0")[0].decode("ascii")
                      for i in range(count)]
    bg_resources = [DGP(ROOT / value) for value in resource_names]
    decoded = {}
    tile_count = 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            frame, resource = struct.unpack_from("<ii", b, 0x172 + (y * w + x) * 64)
            crop = background.crop((x * 16, y * 16, x * 16 + 32, y * 16 + 32)).tobytes()
            if frame == 999999:
                assert not any(crop)
            else:
                if (resource, frame) not in decoded:
                    decoded[resource, frame] = bg_resources[resource].decode(frame).tobytes()
                assert crop == decoded[resource, frame]
            tile_count += 1
    object_count = u32(b, 0x82)
    assert object_count == len(record["objects"])
    object_start = gate_start + 32 * 66 + 32 * 27 + 32 * 272
    raw_objects = [b[object_start + i * 274:object_start + (i + 1) * 274] for i in range(object_count)]
    for item, raw in zip(record["objects"], raw_objects):
        dgp = DGP(ROOT / item["source"])
        frame = i32(raw, 0x3C)
        assert item["frame"] == frame
        assert item["resource_filename"] == f'{i32(raw, 0x1E):03d}.DGP'
        assert item["x_native"] == i32(raw, 0x26)
        assert item["y_native"] == i32(raw, 0x2A)
        assert item["x_world"] == i32(raw, 0x26) * 2
        assert item["y_world"] == i32(raw, 0x2A) * 2
        assert item["draw_x"] == item["x_world"] - i32(dgp.extra_header, 16)
        assert item["draw_y"] == item["y_world"] - i32(dgp.extra_header, 20)
        assert item["width_cells"] == u32(dgp.extra_header, 4)
        assert item["height_cells"] == u32(dgp.extra_header, 8)
        assert item["layer"] == raw[0xCE]
        assert item["sort_y"] == item["y_world"] + (item["width_cells"] + item["height_cells"]) * 16
        png = Image.open(output_path(item["image"])).convert("RGBA")
        assert png.size == (dgp.width, dgp.height)
        assert png.tobytes() == dgp.decode(frame).tobytes()
    for exit_record in record["exits"]:
        assert exit_record["state"] == "ready"
        descriptor = next(t for t in m["triggers"] if t["id"] == exit_record["id"])
        raw = bytes.fromhex(descriptor["descriptor_hex"])
        assert raw[0] == 0
        assert raw[0x11:0x26].split(b"\0")[0].decode("ascii").lower() == exit_record["target_map"].lower() + ".dat"
        target = json.loads((RUNTIME / "web/data/maps" / (exit_record["target_map"].lower() + ".json")).read_text(encoding="utf-8"))
        target_bytes = (ROOT / target["source"]["path"]).read_bytes()
        tw, th = struct.unpack_from("<II", target_bytes, 0x146)
        ident = u32(raw, 0x26)
        positions = [(x, y) for y in range(th) for x in range(tw)
                     if target_bytes[0x172 + (y * tw + x) * 64 + 0x21] == ident][:4]
        assert len(positions) > 0
        direction_code = u32(raw, 0x2A)
        if direction_code in (4, 8):
            positions.sort(key=lambda p: -p[0])
            assert exit_record["entry"]["direction"] == int(direction_code == 8)
        elif direction_code in (3, 7):
            positions.sort(key=lambda p: p[0])
            assert exit_record["entry"]["direction"] == 4 + int(direction_code == 7)
        elif direction_code in (2, 6):
            positions.sort(key=lambda p: -p[1])
            assert exit_record["entry"]["direction"] == 6 + int(direction_code == 6)
        assert (exit_record["entry"]["x"], exit_record["entry"]["y"]) == (positions[0][0] * 16, positions[0][1] * 16)
        assert all(triggers[p["x"], p["y"]]["id"] == exit_record["id"] for p in exit_record["cells"])
        assert target["movement"]["terrain_rows"][positions[0][1]][positions[0][0]] == "0"
        assert not any(t["path_gate"] and (t["x"], t["y"]) == positions[0] for t in target["movement"]["triggers"])
    for p in record.get("probes", []):
        x, y = int(p["x"] // 16), int(p["y"] // 16)
        assert m["terrain_rows"][y][x] == "0"
        assert (x, y) not in triggers or not triggers[x, y]["path_gate"]
    return dict(id=record["id"], terrain_cells=w * h, trigger_references=len(triggers),
                background_tiles=tile_count, distinct_background_frames=len(decoded),
                object_pixel_and_anchor_checks=object_count, exits=len(record["exits"]),
                probes=len(record.get("probes", [])))


def main():
    report = json.loads((RUNTIME / "evidence/map_export_20261011.json").read_text(encoding="utf-8"))
    for source, expected in report["input_hashes"].items():
        assert digest(ROOT / source) == expected
    for output, expected in report["output_hashes"].items():
        assert digest(output_path(output)) == expected
    checks = []
    for item in report["maps"]:
        path = RUNTIME / "web/data/maps" / (item["id"].lower() + ".json")
        checks.append(verify_map(json.loads(path.read_text(encoding="utf-8"))))
    result = dict(schema="seventh-seal-runtime-map-verification", version=1, success=True,
                  source_hash_checks=len(report["input_hashes"]), output_hash_checks=len(report["output_hashes"]),
                  checks=checks,
                  scope="Raw DAT fields, all background tiles, all initial object pixels/anchors, verified entries; no original runtime comparison")
    out = RUNTIME / "evidence/map_verification_20261011.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
