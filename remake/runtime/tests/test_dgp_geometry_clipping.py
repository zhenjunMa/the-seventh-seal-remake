"""Complete source-row retention versus the original geometry-bounded blit."""
from pathlib import Path
import base64
import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
from source.dgp import DGP, DGPError
from export_skill_layers import SourceAudit

SOURCE = ROOT / 'mapm/m01050/004.dgp'
SHA = '981a62435975c301c6d1c38858ed40b02288e4756df0630925a932e339efe781'


class DGPGeometryClipping(unittest.TestCase):
    def test_every_visible_pixel_equals_complete_original_blitter_and_the_independent_source_audit(self):
        original = SOURCE.read_bytes()
        self.assertEqual(hashlib.sha256(original).hexdigest(), SHA)
        dgp = DGP(SOURCE)
        audit = SourceAudit(original)
        with tempfile.TemporaryDirectory(prefix='dgp-geometry-', dir=RUNTIME / 'tests') as folder:
            output = Path(folder) / 'native_pixels.json'
            result = subprocess.run(['node', '--import', (RUNTIME / 'tests/preserve_history.mjs').as_uri(), '--test', 'tests/test_dgp_native_clipping.mjs'], cwd=RUNTIME,
                env=dict(os.environ, SEVENTH_SEAL_DGP_PIXEL_OUTPUT=str(output)),
                capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            native = json.loads(output.read_text('utf-8'))
        self.assertEqual((dgp.width, dgp.height, dgp.frame_count), (173, 175, 2))
        for index, frame in enumerate(native):
            expected = base64.b64decode(frame['rgba_base64'])
            actual = dgp.decode(index)
            independently, check = audit.sparse(index, False)
            self.assertEqual(actual.size, (173, 175))
            self.assertEqual(actual.tobytes(), expected)
            self.assertEqual(independently, expected)
            self.assertEqual(check['covered_pixels'], frame['occupied'])
            self.assertEqual(check['rgba_sha256'], frame['rgba_sha256'])
            self.assertEqual(check['stored_rows'], 200 if index == 0 else 175)
            self.assertEqual(check['retained_rows'], 25 if index == 0 else 0)
            self.assertEqual(check['retained_bytes'], 5576 if index == 0 else 0)
            self.assertEqual(frame['readEnd'], check['retained_offset'] - check['source_offset'])
        # Secondary verification includes all200 rows, not merely the visible
        # prefix: native RGB565->555 is exact even in the retained25 rows.
        self.assertEqual(dgp.verify_secondary()['checked_pixels'], 32364)
        tails = dgp.metadata()['sparse_row_tails']
        self.assertEqual([(row['frame'], row['stream'], row['stored_rows'], row['retained_bytes']) for row in tails],
                         [(0, 'primary', 200, 5576), (0, 'secondary', 200, 5576)])
        self.assertEqual(tails[0]['retained_sha256'], '76b2ba407d5140e6a813d3ac8dd3086aa1d3ae213dfa7d3772ba19bb1317c3a2')
        self.assertEqual(tails[1]['retained_sha256'], 'c3dd116919fa78cfaf9f834b728c4502857745e91108fa93e543c9888581391c')
        self.assertEqual(SOURCE.read_bytes(), original)

    def test_retained_rows_are_strict_source_records_not_ignored_trailing_bytes(self):
        original = SOURCE.read_bytes()
        dgp = DGP(SOURCE)
        tail = dgp.payload_start + 22460
        changes = []
        value = bytearray(original);struct.pack_into('<H', value, tail, 65534);changes.append(value)
        value = bytearray(original);struct.pack_into('<H', value, tail + 2, 173);changes.append(value)
        value = bytearray(original);struct.pack_into('<H', value, dgp.payload_start + 28036 - 2, 1);changes.append(value)
        for value in changes:
            with tempfile.TemporaryDirectory(prefix='dgp-corrupt-', dir=RUNTIME / 'tests') as folder:
                path = Path(folder) / 'modified-test-copy.dgp';path.write_bytes(value)
                with self.assertRaises(DGPError):
                    DGP(path).decode(0)
                with self.assertRaises(DGPError):
                    SourceAudit(bytes(value)).sparse(0, False)
        # A valid RLE tail with an incorrect secondary pixel still fails the
        # original exact565/555 contract, even though that pixel is clipped.
        value = bytearray(original)
        value[dgp.payload_start + dgp.payload_bytes + 22460 + 6] ^= 1
        with tempfile.TemporaryDirectory(prefix='dgp-secondary-', dir=RUNTIME / 'tests') as folder:
            path = Path(folder) / 'modified-test-copy.dgp';path.write_bytes(value)
            with self.assertRaises(DGPError):
                DGP(path).verify_secondary()
        with tempfile.TemporaryDirectory(prefix='dgp-eof-', dir=RUNTIME / 'tests') as folder:
            path = Path(folder) / 'modified-test-copy.dgp';path.write_bytes(original + b'\x00\x00')
            with self.assertRaisesRegex(DGPError, 'Unconsumed trailing bytes'):
                DGP(path)
        self.assertEqual(SOURCE.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
