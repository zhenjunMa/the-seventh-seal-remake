"""Index the sealed ruins, six trials and their complete final animation map."""
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_fire_valley_index import RUNTIME, main

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main(region_label="封印遗迹", region_id="seal-region",
         additional_labels=("炼狱之路", "回旋之风", "迷恋之渊", "绝灭之地", "审判之光", "沈寂之梦"),
         script_map_sources=(("M72065", "m72065", 9),),
         output=RUNTIME / "web/data/library/seal_region.json",
         report_output=RUNTIME / "evidence/seal_region_20261104/source_index.json")
