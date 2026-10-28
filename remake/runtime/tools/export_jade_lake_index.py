"""Index every Jade Lake source variant; research-institute ruins stay separate."""
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_fire_valley_index import RUNTIME, main

OUTPUT = RUNTIME / "web/data/library/jade_lake.json"
REPORT_OUTPUT = RUNTIME / "evidence/jade_lake_20261028/source_index.json"

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main(region_label="翠碧湖", region_id="jade-lake",
         output=OUTPUT, report_output=REPORT_OUTPUT)
