"""Index all Ember City source variants without admitting runtime content."""
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_fire_valley_index import RUNTIME, main

OUTPUT = RUNTIME / "web/data/library/ember_city.json"
REPORT_OUTPUT = RUNTIME / "evidence/ember_city_20261028/source_index.json"

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main(region_label="炎城", region_id="ember-city",
         output=OUTPUT, report_output=REPORT_OUTPUT)
