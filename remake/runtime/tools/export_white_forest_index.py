"""Index the six outer White Forest maps; Inner White Forest stays separate."""
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_fire_valley_index import RUNTIME, main

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main(region_label="白木森林", region_id="white-forest", exact_label=True,
         output=RUNTIME / "web/data/library/white_forest.json",
         report_output=RUNTIME / "evidence/white_forest_20261026/source_index.json")
