"""Read-only route resource export for M17010 and M70010.

The odd map height is accepted because the retained 0x4A3770 rectangular
background branch checks each tile origin against the real dimensions.
Native entry marker 1 and sort code 5 are retained separately from ordinary
four-marker exits. This tool does not register routes or invent TLK behavior.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / "tools"))
sys.path.insert(0, str(ROOT / "remake/prototype/tools"))
import export_maps
from dgp import DGP, DGPError, u32


class RouteMapBackground:
    """Same established v6 rectangular cells without a guessed even-size gate."""
    def __init__(self, path: Path):
        self.path = path
        self.data = path.read_bytes()
        b = self.data
        if len(b) < 0x172 or u32(b, 0x14) != 6 or not b[0x88]:
            raise DGPError("Route export requires the established rectangular v6 DAT")
        self.width = u32(b, 0x146)
        self.height = u32(b, 0x14A)
        self.step = 1 << b[0x145]
        if not self.width or not self.height or self.step != 2:
            raise DGPError("Route map differs from the native 2-cell tile stride")
        self.grid_end = 0x172 + self.width * self.height * 64
        if self.grid_end > len(b):
            raise DGPError("Truncated route map grid")
        self.cells = [struct.unpack_from("<ii", b, 0x172 + i * 64)
                      for i in range(self.width * self.height)]


def export():
    ids = ["M17010", "M70010"]
    source_names = {"GAME.exe"}
    for ident in ids:
        slug = ident.lower()
        bg = RouteMapBackground(ROOT / "Map" / f"{slug}.dat")
        source_names.add(f"Map/{slug}.dat")
        source_names.update(export_maps.background_names(bg))
        source_names.update(export_maps.source_path(p) for p in (ROOT / "mapm" / slug).glob("*.dgp"))
    before = {name: export_maps.sha(ROOT / name) for name in sorted(source_names)}
    if before["GAME.exe"] != export_maps.GAME_SHA:
        raise DGPError("Original executable differs from retained native evidence")
    parsed = {name: DGP(ROOT / name) for name in sorted(source_names) if name.lower().endswith(".dgp")}
    export_maps.MapBackground = RouteMapBackground
    outputs = {}
    maps = []
    for ident in ids:
        record = export_maps.export_map(ident, parsed, outputs)
        b = (ROOT / record["source"]["path"]).read_bytes()
        w, h = struct.unpack_from("<II", b, 0x146)
        entries = [dict(x=x, y=y, offset=0x172 + (y*w+x)*64)
                   for y in range(h) for x in range(w)
                   if b[0x172 + (y*w+x)*64 + 0x21] == 1]
        if len(entries) != 1:
            raise DGPError("Confirmed route marker 1 cardinality changed")
        entry = entries[0]
        if b[entry["offset"] + 0x20] != 0 or u32(b, entry["offset"] + 0x38) != 0:
            raise DGPError("Confirmed route entry is blocked")
        record["route_entry"] = dict(marker=1, sort_code=5,
                                    x=entry["x"]*16, y=entry["y"]*16, direction=2,
                                    cell_x=entry["x"], cell_y=entry["y"],
                                    source_offset=entry["offset"],
                                    authority="Retained native entry assembly; original execution remains unobserved",
                                    native_evidence="ev_64381418fb6ce9006b56967c5a24b40e3f64ea74ee5e6d4aa7a4f245416548d0")
        record["background"]["assembly"]["rows"] = (h + 1)//2
        record["background"]["assembly"]["columns"] = (w + 1)//2
        record["background"]["assembly"]["odd_size_policy"] = "Loop on tile origins within real dimensions; clip any pixels past image boundary"
        record["limitations"].append("Plot-related role relocation and ANM commands are not executed by this map asset export")
        maps.append(record)
    after = {name: export_maps.sha(ROOT / name) for name in sorted(source_names)}
    if before != after:
        raise DGPError("Read-only source hashes changed during export")
    report = dict(schema="seventh-seal-route-map-export", version=1,
                  maps=maps, output_files=outputs, source_hashes=before, source_unchanged=True,
                  native_bundle="remake/runtime/evidence/route_native_20261011.json")
    target = RUNTIME / "evidence/route_resources_maps_20261011.json"
    export_maps.write_json(target, report)
    print(json.dumps(dict(maps=[m["id"] for m in maps], outputs=len(outputs), source_unchanged=True)))


if __name__ == "__main__":
    export()
