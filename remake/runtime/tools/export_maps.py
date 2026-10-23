"""Read-only export of the first two real maps for the formal runtime.

Pixel, terrain and initial-object rules reuse the retained native evidence of
the prototype. A map transition is exposed only when the retained executing
branch explains its target and entry placement; strings alone are insufficient.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import struct
import sys

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
SOURCE_TOOLS = RUNTIME / "tools"
sys.path.insert(0, str(SOURCE_TOOLS))
from source.dgp import DGP, DGPError, u32
from source.map_data import MapBackground
from source.map_objects import MapObjects
from PIL import Image

GAME_SHA = "fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18"
EVIDENCE = {
    "map_loader": "ev_86fb8504826b15ccbea2b3911eaa302ef3f5cbeba7d1b233df62109a9ff38681",
    "background_draw": "ev_2f7d67b0c8598838be7ac99150b959c5012222fdac93464caaf6732031f0b6e7",
    "background_resource_loader": "ev_7c353572e07610a7b7e99f989466929dd711a469b13e61acb2597b40ff70e8d4",
    "transition_path_gate": "ev_1ccb72823e262e4317968f322fcebaf8bd8724a31c215f127d8a68ac77c7b2b2",
    "transition_execute": "ev_49e75a99b3e63a3ad909ec9b83d16fcc3fe4046568391ae2a399a2b2cdd69d54",
    "transition_load": "ev_8564dce0fc083a81e920321518d1d32841a39c673640260fae4417f4fdb5f00b",
    "entry_scan": "ev_32d96560f0087a383b5eaf8ff9646886dba64a9de41cf598f1089ad8ca65d16e",
    "entry_assembly": "ev_64381418fb6ce9006b56967c5a24b40e3f64ea74ee5e6d4aa7a4f245416548d0",
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def source_path(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def web_url(path: Path) -> str:
    return "/" + path.relative_to(RUNTIME / "web").as_posix()


def background_names(bg: MapBackground) -> list[str]:
    # 0x4A0FA0: DWORD header+0x96, names header+0x9A + index*20.
    count = u32(bg.data, 0x96)
    if not 1 <= count <= 8:
        raise DGPError("Background resource count outside the fixed filename table")
    names = [bg.data[0x9A + i * 20:0x9A + (i + 1) * 20].split(b"\0")[0].decode("ascii", "strict")
             for i in range(count)]
    if any(not value.lower().endswith(".dgp") or "/" in value or "\\" in value for value in names):
        raise DGPError("Background name is not an ordinary game-root DGP filename")
    return names


def compose_background(bg: MapBackground, resources: list[DGP]):
    # The retained 0x4A3770 rectangular branch obtains frame from cell+0,
    # resource index from cell+4 and draws at 32-pixel / 2-cell strides.
    if any(dgp.width != 32 or dgp.height != 32 for dgp in resources):
        raise DGPError("Background resource differs from the confirmed 32-pixel draw stride")
    image = Image.new("RGBA", (bg.width * 16, bg.height * 16))
    cache = {}
    used = set()
    empty = 0
    for y in range(0, bg.height, bg.step):
        for x in range(0, bg.width, bg.step):
            frame, resource = bg.cells[y * bg.width + x]
            if frame == 999999:
                empty += 1
                continue
            if not 0 <= resource < len(resources):
                raise DGPError(f"Background resource {resource} outside the native filename table")
            if not 0 <= frame < resources[resource].frame_count:
                raise DGPError(f"Background frame {frame} outside resource {resource}")
            key = (resource, frame)
            if key not in cache:
                cache[key] = resources[resource].decode(frame)
            image.paste(cache[key], (x * 16, y * 16))
            used.add(key)
    return image, dict(referenced_frames=len(used), empty_blocks=empty,
                       columns=bg.width // 2, rows=bg.height // 2,
                       resource_count=len(resources), animation_frame=0,
                       assembly="DAT even-cell frame/resource -> indexed header DGP; 0x4A3770 rectangular branch")


def retain_transition_evidence() -> None:
    bundle_path = RUNTIME / "evidence/npc_native_20261011.json"
    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    wanted = {EVIDENCE[key] for key in ("transition_execute", "transition_load", "entry_scan", "entry_assembly")}
    records = [record for record in bundle.get("records", []) if record.get("evidence_id") in wanted]
    if {record.get("evidence_id") for record in records} != wanted:
        raise DGPError("Retained native transition execution/entry evidence is incomplete")
    for record in records:
        if record.get("subject", {}).get("digest", {}).get("sha256") != GAME_SHA:
            raise DGPError("Transition evidence belongs to another original executable")
    write_json(RUNTIME / "evidence/map_native_20261011.json",
               dict(target_sha256=GAME_SHA, authority="Retained native static evidence, not original runtime observation",
                    records=records, limitations=["Decompiler mis-types the byte direction as bool; full assembly governs directions.",
                    "Original transition fires after a discrete movement step. Continuous keyboard movement is a runtime policy."]))


def enable_verified_exits(maps: list[dict]) -> None:
    by_id = {record["id"]: record for record in maps}
    if set(by_id) != {"M01010", "M01030"}:
        return
    # These two exits are the first-slice scope. Other actual map exits remain
    # blocked because their target maps are outside this exported pair.
    pairs = [("M01010", 2, "M01030"), ("M01030", 3, "M01010")]
    for origin, ident, destination in pairs:
        record, target = by_id[origin], by_id[destination]
        descriptor = next(d for d in record["unresolved_triggers"] if d["id"] == ident)
        if descriptor["state_raw"] != 0 or descriptor["filename_raw"].lower() != destination.lower() + ".dat":
            raise DGPError("Reviewed exit descriptor changed")
        b = (ROOT / target["source"]["path"]).read_bytes()
        w, h = struct.unpack_from("<II", b, 0x146)
        entry_id = descriptor["field_26_raw"]
        # 0x4A5110 scans row-major and stops as soon as four cells are found.
        scanned = [(x, y) for y in range(h) for x in range(w)
                   if b[0x172 + (y * w + x) * 64 + 0x21] == entry_id][:4]
        if len(scanned) != 4:
            raise DGPError("The reviewed entry no longer has four cells; do not use the native missing-entry fallback")
        placements = list(scanned)
        code = descriptor["field_2a_raw"]
        # cmp+jcc in retained assembly settles both order and the byte enum.
        if code in (4, 8):
            placements.sort(key=lambda value: -value[0])
            direction, order = int(code == 8), "x descending, stable ties"
        elif code in (3, 7):
            placements.sort(key=lambda value: value[0])
            direction, order = 4 + int(code == 7), "x ascending, stable ties"
        elif code in (2, 6):
            placements.sort(key=lambda value: -value[1])
            direction, order = 6 + int(code == 6), "y descending, stable ties"
        else:
            raise DGPError("Entry ordering code is outside this reviewed transition subset")
        x, y = placements[0]
        if target["movement"]["terrain_rows"][y][x] != "0" or any(
                t["path_gate"] and (t["x"], t["y"]) == (x, y) for t in target["movement"]["triggers"]):
            raise DGPError("Native entry is blocked; never substitute another coordinate")
        record["exits"].append(dict(id=ident, state="ready", cells=descriptor["cells"], target_map=destination,
                                   entry=dict(x=x * 16, y=y * 16, direction=direction,
                                              cell_x=x, cell_y=y, native_x=x << 3, native_y=y << 3),
                                   conditions=[],
                                   native_global_guards=dict(DAT_04EDD404=0, DAT_04B49F0C=0,
                                                             DAT_02B906CC=0, DAT_05020CEC=0),
                                   source=dict(path=record["source"]["path"], sha256=record["source"]["sha256"],
                                               descriptor_offset=descriptor["offset"], descriptor_hex=descriptor["descriptor_hex"],
                                               target_path=target["source"]["path"], target_sha256=target["source"]["sha256"],
                                               target_entry_marker=entry_id, entry_sort_code=code,
                                               entry_scan_cells=[dict(x=a, y=c) for a, c in scanned],
                                               entry_sorted_cells=[dict(x=a, y=c) for a, c in placements],
                                               entry_sort=order, coordinate_rule="first sorted cell << header+0x142; native coordinate × 2 to world pixels; no center offset",
                                               native_evidence={key: EVIDENCE[key] for key in ("transition_execute", "transition_load", "entry_scan", "entry_assembly")}),
                                   execution="At exploration movement completion, enter the true exit cell and load the target at its native entry marker. Clear held input during scene loading.",
                                   limitations=["Continuous keyboard speed/delta is runtime policy; original discrete movement timing remains unobserved.",
                                                "Native guard symbols are retained without guessing every subsystem's meaning; runtime permits exits only during exploration."]))
        record["unresolved_triggers"] = [d for d in record["unresolved_triggers"] if d["id"] != ident]
    by_id["M01010"]["probes"] = [dict(name="下方道路", x=330, y=1500, direction=7),
                                      dict(name="前往焰坛连回道 · 向右", x=1208, y=1288, direction=1,
                                           purpose="Development relocation at an open approach cell, not the original map entry")]
    by_id["M01030"]["probes"] = [dict(name="返回升焰高冕 · 向上", x=1048, y=56, direction=3,
                                      purpose="Development relocation at an open approach cell, not the original map entry")]


def transition_descriptors(map_data: MapBackground) -> tuple[list[dict], list[dict]]:
    b = map_data.data
    if u32(b, 0x18) != 1:
        raise DGPError("Formal map slice supports explicit 0x42-byte transition records only")
    start = map_data.grid_end + 32 * 0x2A
    if start + 32 * 0x42 > len(b):
        raise DGPError("Truncated transition descriptor table")
    cells = defaultdict(list)
    for y in range(map_data.height):
        for x in range(map_data.width):
            cell_offset = 0x172 + (y * map_data.width + x) * 64
            ident = u32(b, cell_offset + 0x38)
            if ident:
                if not 1 <= ident <= 32:
                    raise DGPError(f"Transition index {ident} is outside the native table")
                cells[ident].append(dict(x=x, y=y))
    descriptors, triggers = [], []
    for ident, positions in sorted(cells.items()):
        offset = start + (ident - 1) * 0x42
        raw = b[offset:offset + 0x42]
        # +0x11 is the native path-gate input. Until the execution branch is
        # available, retaining these fields does not establish a map change.
        filename = raw[0x11:0x26].split(b"\0")[0].decode("ascii", "strict")
        descriptor = dict(id=ident, offset=offset, bytes=0x42,
                          state_raw=raw[0], filename_raw=filename,
                          field_26_raw=u32(raw, 0x26), field_2a_raw=u32(raw, 0x2A),
                          field_2e_raw=u32(raw, 0x2E), cells=positions,
                          path_gate=raw[0] == 0 and raw[0x11] != 0,
                          descriptor_hex=raw.hex())
        descriptors.append(descriptor)
        for pos in positions:
            triggers.append({**pos, "id": ident, "state_raw": raw[0],
                             "path_gate": descriptor["path_gate"],
                             "descriptor_hex": raw.hex()})
    return descriptors, triggers


def export_map(map_id: str, parsed: dict, output_files: dict) -> dict:
    slug = map_id.lower()
    dat_path = ROOT / "Map" / (slug + ".dat")
    bg = MapBackground(dat_path)
    if bg.data[0x88] != 1 or bg.data[0x142] != 3 or bg.data[0x143] != 0 or bg.step != 2:
        raise DGPError("Map differs from the established rectangular projection/coordinate branch")
    bg_paths = [ROOT / name for name in background_names(bg)]
    background_dgps = [parsed[source_path(path)] for path in bg_paths]
    image, assembly = compose_background(bg, background_dgps)
    target = RUNTIME / "web/assets/maps" / slug
    target.mkdir(parents=True, exist_ok=True)
    background_png = target / "background.png"
    image.save(background_png)
    output_files[web_url(background_png)] = sha(background_png)

    rows = []
    for y in range(bg.height):
        row = []
        for x in range(bg.width):
            flag = bg.data[0x172 + (y * bg.width + x) * 64 + 0x20]
            if flag not in (0, 1):
                raise DGPError(f"Unsupported terrain flag {flag} at {map_id}:{x},{y}")
            row.append(str(flag))
        rows.append("".join(row))
    descriptors, triggers = transition_descriptors(bg)
    table = MapObjects(dat_path)
    resources = {Path(key).name.lower(): value for key, value in parsed.items()
                 if key.lower().startswith(f"mapm/{slug}/")}
    graphics = table.prepare_graphics(resources)
    objects = []
    saved = set()
    for graphic in graphics:
        dgp = resources[graphic["resource_filename"].lower()]
        object_png = target / "objects" / f'{Path(graphic["source"]).stem}_frame_{graphic["frame"]:03d}.png'
        if object_png not in saved:
            object_png.parent.mkdir(parents=True, exist_ok=True)
            dgp.decode(graphic["frame"]).save(object_png)
            output_files[web_url(object_png)] = sha(object_png)
            saved.add(object_png)
        objects.append({**graphic, "image": web_url(object_png),
                        "image_sha256": output_files[web_url(object_png)]})
    movement = dict(schema="seventh-seal-map-movement", version=1, map=map_id,
                    source=source_path(dat_path), source_sha256=sha(dat_path),
                    width=bg.width, height=bg.height, cell_size=16,
                    native_coordinate_shift=3, native_to_pixel_scale=2, native_step_shift=bg.data[0x144],
                    terrain_rows=rows, triggers=triggers,
                    terrain_rule="cell byte +0x20 == 0 permits terrain entry",
                    transition_rule="0x4A80E0: +0x38 reference, descriptor[0]==0 and descriptor[0x11]!=0 is path-gated",
                    policy="Unimplemented native transition gates block. Runtime enables only separately verified exits.",
                    role_occupancy_rule="+0x14 is runtime role index + 1, not static terrain",
                    object_lookup_rule="+0x2B is runtime object index + 1, not a second collision mask")
    # GBK is observed in this localized DAT's name bytes. Preserve those bytes
    # alongside display text; the name never selects a resource or transition.
    name_bytes = bg.data[0x1C:0x7C].split(b"\0")[0]
    result = dict(schema="seventh-seal-runtime-map", version=1, id=map_id,
                  name=name_bytes.decode("gbk", "strict"), name_bytes_hex=name_bytes.hex(),
                  width=image.width, height=image.height,
                  background=dict(image=web_url(background_png), width=image.width, height=image.height,
                                  sources=[dict(path=source_path(path), sha256=dgp.sha256)
                                           for path, dgp in zip(bg_paths, background_dgps)],
                                  image_sha256=output_files[web_url(background_png)], assembly=assembly),
                  movement=movement, objects=objects, exits=[],
                  unresolved_triggers=descriptors,
                  role_layer_preview=2,
                  role_layer_note="Runtime render policy; native role +0xF3 initial value remains unverified",
                  source=dict(path=source_path(dat_path), sha256=sha(dat_path), bytes=len(bg.data),
                              object_table_start=table.object_start, object_table_end=table.object_end,
                              unknown_tail_bytes=len(bg.data) - table.object_end,
                              native_evidence=EVIDENCE, object_native_evidence=table.metadata()["evidence"]),
                  limitations=["Static resource/code evidence; original-game entry/transition timing is not observed.",
                               "Background uses its initial animation frame; background animation is not advanced.",
                               "Initial static objects; script changes and object animation are not reconstructed.",
                               "Role depth and continuous keyboard movement are runtime policies."])
    if map_id == "M01010":
        result["start_preview"] = dict(x=330, y=1500, source="retained prototype placement; runtime starting policy")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--maps", nargs="+", default=["M01010", "M01030"])
    args = parser.parse_args()
    ids = [value.upper() for value in args.maps]
    if any(value not in {"M01010", "M01030"} for value in ids):
        parser.error("Only the reviewed M01010 / M01030 first slice is supported")
    sources = {"GAME.exe"}
    for map_id in ids:
        slug = map_id.lower()
        bg = MapBackground(ROOT / "Map" / (slug + ".dat"))
        sources.add(f"Map/{slug}.dat")
        sources.update(background_names(bg))
        sources.update(source_path(p) for p in (ROOT / "mapm" / slug).glob("*.dgp"))
    sources = sorted(sources)
    before = {source: sha(ROOT / source) for source in sources}
    if before["GAME.exe"] != GAME_SHA:
        raise DGPError("GAME.exe changed: revalidate the retained native evidence before export")
    parsed = {source: DGP(ROOT / source) for source in sources if source.lower().endswith(".dgp")}
    retain_transition_evidence()
    outputs = {}
    maps = [export_map(map_id, parsed, outputs) for map_id in ids]
    enable_verified_exits(maps)
    for record in maps:
        out = RUNTIME / "web/data/maps" / (record["id"].lower() + ".json")
        write_json(out, record)
        outputs[web_url(out)] = sha(out)
    after = {source: sha(ROOT / source) for source in sources}
    if before != after:
        raise DGPError("Original input changed during map export")
    report = dict(created_utc=datetime.now(timezone.utc).isoformat(), schema="seventh-seal-runtime-map-export",
                  version=1, input_hashes=before, input_hashes_after=after,
                  source_bytes_unchanged=before == after, output_hashes=outputs,
                  maps=[dict(id=r["id"], width=r["width"], height=r["height"],
                             grid_cells=r["movement"]["width"] * r["movement"]["height"],
                             terrain_counts=dict(Counter("".join(r["movement"]["terrain_rows"]))),
                             objects=len(r["objects"]), exits=len(r["exits"]),
                             pending_descriptors=len(r["unresolved_triggers"])) for r in maps],
                  evidence=EVIDENCE,
                  limitations=["Unresolved transition records remain blocked; field values are not guessed.",
                               "Map asset export alone does not demonstrate original runtime behavior."])
    write_json(RUNTIME / "evidence/map_export_20261011.json", report)
    write_json(RUNTIME / "web/data/map_index.json", dict(schema="seventh-seal-runtime-map-index", version=1,
               maps=[dict(id=r["id"], name=r["name"], path=f'/data/maps/{r["id"].lower()}.json') for r in maps]))
    print(json.dumps({"source_bytes_unchanged": report["source_bytes_unchanged"], "maps": report["maps"],
                      "outputs": len(outputs)}, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
