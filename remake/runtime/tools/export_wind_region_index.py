"""Index Wind Territory city, island, mountain and the source coastal handoff."""
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_fire_valley_index import RUNTIME, main

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main(region_label="风领地", region_id="wind-region",
         additional_labels=("力城", "劲风岛", "圣山", "东大陆海岸"),
         output=RUNTIME / "web/data/library/wind_region.json",
         report_output=RUNTIME / "evidence/wind_region_20261031/source_index.json")
