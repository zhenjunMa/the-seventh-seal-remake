"""Index every Floating City period, including source-scripted isolated maps."""
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_fire_valley_index import RUNTIME, main

OUTPUT = RUNTIME / "web/data/library/floating_city.json"
REPORT_OUTPUT = RUNTIME / "evidence/floating_city_20261030/source_index.json"
SCRIPT_MAP_SOURCES = (("M03021-3", "m03020-1", 125),
                      ("M03021-3", "m03021", 131))

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main(region_label="飘城", region_id="floating-city", output=OUTPUT,
         report_output=REPORT_OUTPUT, script_map_sources=SCRIPT_MAP_SOURCES)
