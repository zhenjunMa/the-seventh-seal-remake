import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'remake/runtime/tools'))
from source.dgp import DGP,normalize_v8_action


class PrologueExportTests(unittest.TestCase):
    def test_legacy_wait_action_uses_native_expansion(self):
        source=(ROOT/'SYSTEM/MessageWait1.dgp').read_bytes()
        normalized=normalize_v8_action(source[0x43:0x43+0x90])
        self.assertEqual(len(normalized),0xac)
        self.assertEqual(int.from_bytes(normalized[1:5],'little'),120)
        d=DGP(ROOT/'SYSTEM/MessageWait1.dgp')
        self.assertEqual((d.width,d.height,d.frame_count),(31,29,7))
        self.assertEqual(d.actions[0]['frames_per_direction'],7)
        self.assertEqual(d.actions[0]['first_frame'],0)
        for i in range(7):self.assertEqual(d.decode(i).size,(31,29))

    def test_export_hashes_match_readonly_sources_and_caption_assets(self):
        p=ROOT/'remake/runtime/evidence/prologue_routes_20261020/export.json'
        report=json.loads(p.read_text(encoding='utf-8'))
        for path,digest in {**report['source_hashes'],**report['output_hashes']}.items():
            self.assertEqual(hashlib.sha256((ROOT/path).read_bytes()).hexdigest(),digest,path)


if __name__=='__main__':unittest.main()
