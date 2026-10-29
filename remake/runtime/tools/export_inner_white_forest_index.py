"""Index Inner White Forest, Phantom Forest and every Sealed Forest variant."""
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_fire_valley_index import RUNTIME, main

OUTPUT = RUNTIME / "web/data/library/inner_white_forest.json"
REPORT_OUTPUT = RUNTIME / "evidence/inner_white_forest_20261029/source_index.json"

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main(region_label="封印之森", region_id="inner-white-forest",
         output=OUTPUT, report_output=REPORT_OUTPUT)
