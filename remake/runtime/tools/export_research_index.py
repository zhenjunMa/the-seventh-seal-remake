"""Index the original research ruins and their source-linked floor variants."""
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_fire_valley_index import RUNTIME, main

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main(region_label="研究所遗迹", region_id="research",
         output=RUNTIME / "web/data/library/research.json",
         report_output=RUNTIME / "evidence/guild_20261031/research_source_index.json")
