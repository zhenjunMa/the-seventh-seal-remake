"""Read-only structural checks derived from the native loader evidence.

This is an evidence probe, not an event interpreter or combat simulator.
"""
from pathlib import Path
import hashlib
import json
import struct

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "evidence" / "m01010_structural_probe.json"


def u32(data, offset):
    return struct.unpack_from("<I", data, offset)[0]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inspect():
    data = (ROOT / "Map" / "m01010.dat").read_bytes()
    assert u32(data, 0x14) == 6, "Native map loader requires format 6"
    scale = data[0x145]
    width = u32(data, 0x146) or (data[0x80] * 40 << scale)
    height = u32(data, 0x14A) or (data[0x81] * 40 << scale)
    grid_end = 0x172 + width * height * 0x40
    assert grid_end <= len(data)
    step = 1 << scale
    samples = []
    resource_ids = set()
    frame_ids = set()
    for y in range(0, height, step):
        for x in range(0, width, step):
            offset = 0x172 + (y * width + x) * 0x40
            frame = u32(data, offset)
            resource = u32(data, offset + 4)
            frame_ids.add(frame)
            resource_ids.add(resource)
            if len(samples) < 32:
                samples.append(dict(x=x, y=y, offset=offset,
                                    frame=frame, resource=resource))
    tlk = (ROOT / "Map" / "m01010.tlk").read_bytes()
    indexes, records = u32(tlk, 2), u32(tlk, 6)
    loader_end = 0x1A + indexes * 4 + records * 0x66F
    assert loader_end <= len(tlk)
    return {
        "authority": "local-resource-byte-observation",
        "map": {
            "path": "Map/m01010.dat", "sha256": sha(data),
            "bytes": len(data), "header_bytes": 0x172,
            "format": u32(data, 0x14), "grid_width": width,
            "grid_height": height, "cell_bytes": 0x40,
            "grid_end": grid_end, "scale": scale,
            "coordinate_shift": data[0x142],
            "projection_flag": data[0x88],
            "sample_step": step,
            "sample_count": ((width + step - 1) // step)
                            * ((height + step - 1) // step),
            "resource_ids": sorted(resource_ids),
            "frame_min": min(frame_ids), "frame_max": max(frame_ids),
            "samples": samples,
            "native_evidence": [
                "ev_86fb8504826b15ccbea2b3911eaa302ef3f5cbeba7d1b233df62109a9ff38681",
                "ev_2f7d67b0c8598838be7ac99150b959c5012222fdac93464caaf6732031f0b6e7"
            ]
        },
        "tlk": {
            "path": "Map/m01010.tlk", "sha256": sha(tlk),
            "bytes": len(tlk), "header_hex": tlk[:0x1A].hex(),
            "index_count": indexes, "record_count": records,
            "native_record_bytes": 0x66F,
            "native_loader_end": loader_end,
            "unexplained_tail_bytes": len(tlk) - loader_end,
            "first_indexes": [u32(tlk, 0x1A + i * 4)
                              for i in range(min(indexes, 20))],
            "status": "partial: native loader does not consume whole sample",
            "native_evidence": "ev_5e8b2970ad7fd9a51d0b4085cf684c21860c22ae04bec8712cdaf84c11e56eea"
        },
        "unknowns": [
            "TLK trailing payload and per-record semantics",
            "Event conditions, mutations, and scheduler",
            "Normal attack hit and damage settlement",
            "Native renderer span coordinate and anchor semantics"
        ]
    }


if __name__ == "__main__":
    result = inspect()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    print(json.dumps({"map_grid": [result["map"]["grid_width"],
                                   result["map"]["grid_height"]],
                      "samples": result["map"]["sample_count"],
                      "resources": result["map"]["resource_ids"],
                      "frame_range": [result["map"]["frame_min"],
                                      result["map"]["frame_max"]],
                      "tlk_tail": result["tlk"]["unexplained_tail_bytes"],
                      "output": str(OUT)}, ensure_ascii=False))
