"""Check chapter assets against exact retained source bytes and walking cells."""
from collections import deque
import hashlib
import json
from pathlib import Path
import sys
from PIL import Image

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / "web"


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify():
    manifest = load(WEB / "data/chapter_map_resources.json")
    export = load(RUNTIME / "evidence/chapter_map_export.json")
    assert all(digest(ROOT / path) == value for path, value in export["source_hashes"].items())
    assert all(digest(WEB / path.lstrip("/")) == value for path, value in export["output_hashes"].items())
    starts = {"M17020": (1092 // 16, 986 // 16), "M17029": (640 // 16, 592 // 16),
              "M17026": (272 // 16, 560 // 16), "M17010": (1088 // 16, 1008 // 16)}
    checks = []
    for ident, edges in manifest["exits_by_map"].items():
        data = load(WEB / f"data/maps/{ident.lower()}.json")
        rows = data["movement"]["terrain_rows"]
        enabled = {edge["id"] for edge in edges}
        blocked = {(t["x"], t["y"]) for t in data["movement"]["triggers"]
                   if t["path_gate"] and t["id"] not in enabled}
        queue, visited = deque([starts[ident]]), {starts[ident]}
        while queue:
            x, y = queue.popleft()
            for xx, yy in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if (0 <= yy < len(rows) and 0 <= xx < len(rows[0]) and rows[yy][xx] == "0"
                        and (xx, yy) not in blocked and (xx, yy) not in visited):
                    visited.add((xx, yy))
                    queue.append((xx, yy))
        for edge in edges:
            source = edge["source"]
            dat = (ROOT / source["path"]).read_bytes()
            at = source["descriptor_offset"]
            assert dat[at:at + source["descriptor_bytes"]].hex() == source["descriptor_hex"]
            assert any((cell["x"], cell["y"]) in visited for cell in edge["cells"])
            target = (ROOT / source["target_path"]).read_bytes()
            cell = source["entry_scan_cells"][0]
            assert target[cell["offset"] + 0x21] == source["target_entry_marker"]
            assert target[cell["offset"] + 0x20] == 0
            checks.append(dict(map_id=ident, descriptor=edge["id"], target=edge["target_map"],
                               exact_source_bytes=True, entry_marker_verified=True, walking_path_exists=True))
    for role in manifest["roles"].values():
        for action in role["actions"]:
            path = WEB / action["sheet"].lstrip("/")
            assert digest(path) == action["sha256"]
            with Image.open(path) as im:
                assert im.size == (role["frame_width"] * action["frame_count"],
                                   role["frame_height"] * action["directions"])
            assert all(0 <= f["physical_frame"] < action["frame_count"] for f in action["logical_frames"])
    for npcs in manifest["npcs_by_map"].values():
        for npc in npcs:
            assert (npc["x"], npc["y"]) == (npc["x_native"] * 2, npc["y_native"] * 2)
            assert npc["resource_id"] in manifest["roles"]
    for fields in manifest["map_entry_tlk_header_raw"].values():
        raw = (ROOT / fields["source"]["path"]).read_bytes()[fields["offset"]:fields["offset"] + 4]
        assert raw.hex() == fields["raw_hex"] and int.from_bytes(raw, "little") == fields["value"]
    boxes = []
    for ident, animations in manifest["object_animations"].items():
        for animation in animations:
            for frame in animation["frames"]:
                with Image.open(WEB / frame["image"].lstrip("/")) as im:
                    assert im.size == (animation["frame_width"], animation["frame_height"])
            with Image.open(WEB / animation["frames"][animation["completed_last_frame"]]["image"].lstrip("/")) as im:
                boxes.append(dict(map_id=ident, object_number=animation["object_number_one_based"],
                                  frames=len(animation["frames"]), completed_frame_transparent=im.getbbox() is None))
    report = dict(schema="seventh-seal-chapter-map-checks", version=1, source_hashes_match=True,
                  output_hashes_match=True, asset_hashes_and_dimensions_match=True,
                  six_physical_edges=checks, npc_count=sum(map(len, manifest["npcs_by_map"].values())),
                  role_resources=len(manifest["roles"]), object_animation_checks=boxes,
                  limits=["BFS proves passable grid connectivity, not original runtime execution",
                          "Continuous keyboard/collision policy remains runtime-specific"])
    (RUNTIME / "evidence/chapter_map_checks.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(dict(source_hashes_match=True, output_hashes_match=True,
                          six_physical_edges=len(checks), roles=report["role_resources"], boxes=boxes), ensure_ascii=False))


if __name__ == "__main__":
    verify()
