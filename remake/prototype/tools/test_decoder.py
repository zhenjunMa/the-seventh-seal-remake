"""Decoder integrity tests: sparse transparency, corrupt lengths, indices and input immutability."""
from pathlib import Path
import hashlib
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dgp import DGP, DGPError
from map_data import MapBackground

PROJECT = Path(__file__).resolve().parents[1]
ROOT = PROJECT.parents[1]


def sparse_sample():
    header = bytearray(67)
    header[0] = 9
    header[21] = 1
    geometry = bytearray(42)
    struct.pack_into('<HHI', geometry, 0, 3, 2, 1)
    geometry[13] = 1
    # Black is an opaque pixel. Missing spans, not a guessed color key, produce transparency.
    payload = struct.pack('<HHHHHHH', 2, 0, 1, 0, 2, 1, 0xffff) + b'\xff\xff'
    start = 67 + 42 + 48 + 18 + 20
    struct.pack_into('<II', geometry, 32, start, len(payload))
    page = struct.pack('<BBIIII', 1, 1, 3, 2, 3, 2)
    frame = struct.pack('<IIIII', 0, 0, 0, 0, len(payload))
    return bytes(header + geometry) + bytes(48) + page + frame + payload


def auxiliary_sample(active=True):
    data = bytearray(sparse_sample())
    data[19] = 1
    # Deliberately unrelated palette/index bytes. The native loader stores
    # these before the independently loaded main 16-bit rows.
    auxiliary = b'\1' + struct.pack('<I', 3) + bytes([0xAB]) * 0x300 + b'\7\11\15' if active else b'\0'
    struct.pack_into('<I', data, 67 + 32, 195 + len(auxiliary))
    return bytes(data[:195]) + auxiliary + bytes(data[195:])


class IntegrityTests(unittest.TestCase):
    def decode_bytes(self, data):
        with tempfile.TemporaryDirectory(dir=PROJECT) as directory:
            path = Path(directory) / 'sample.dgp'
            path.write_bytes(data)
            return DGP(path)

    def test_sparse_opaque_black_and_white(self):
        decoder = self.decode_bytes(sparse_sample())
        image = decoder.decode(0)
        self.assertEqual(image.getpixel((0, 0)), (0, 0, 0, 255))
        self.assertEqual(image.getpixel((1, 0)), (0, 0, 0, 0))
        self.assertEqual(image.getpixel((2, 0)), (255, 255, 255, 255))
        self.assertTrue(all(image.getpixel((x, 1))[3] == 0 for x in range(3)))

    def test_truncated_payload_rejected(self):
        with self.assertRaisesRegex(DGPError, 'Truncated'):
            self.decode_bytes(sparse_sample()[:-1])

    def test_indexed_auxiliary_does_not_replace_primary_pixels(self):
        for active in (False, True):
            decoder = self.decode_bytes(auxiliary_sample(active))
            self.assertEqual(decoder.decode(0).tobytes(), self.decode_bytes(sparse_sample()).decode(0).tobytes())
            self.assertEqual(decoder.indexed_auxiliary[0]['active_raw'], int(active))
            if active:
                self.assertEqual(decoder.indexed_auxiliary[0]['indexed_pixels_bytes'], 3)

    def test_corrupt_indexed_auxiliary_length_rejected(self):
        data = bytearray(auxiliary_sample())
        struct.pack_into('<I', data, 196, 0xFFFFFFFF)
        with self.assertRaisesRegex(DGPError, 'Truncated'):
            self.decode_bytes(data)

    def test_auxiliary_primary_boundary_mismatch_rejected(self):
        data = bytearray(auxiliary_sample())
        struct.pack_into('<I', data, 67 + 32, 195)
        with self.assertRaisesRegex(DGPError, 'Payload boundary mismatch'):
            self.decode_bytes(data)

    def test_extra_bytes_rejected(self):
        with self.assertRaisesRegex(DGPError, 'trailing'):
            self.decode_bytes(sparse_sample() + b'\0')

    def test_unknown_version_rejected(self):
        data = bytearray(sparse_sample()); data[0] = 8
        with self.assertRaisesRegex(DGPError, 'Unsupported DGP version'):
            self.decode_bytes(data)

    def test_bad_frame_payload_offset_rejected(self):
        data = bytearray(sparse_sample()); struct.pack_into('<I', data, 67 + 42 + 48 + 18 + 12, 1)
        with self.assertRaisesRegex(DGPError, 'offset mismatch'):
            self.decode_bytes(data)

    def test_out_of_bounds_span_rejected(self):
        data = bytearray(sparse_sample()); struct.pack_into('<H', data, 195 + 2, 3)
        with self.assertRaisesRegex(DGPError, 'outside width'):
            self.decode_bytes(data).decode(0)

    def test_invalid_map_reference_rejected(self):
        mapping = MapBackground(ROOT / 'Map/m01010.dat')
        mapping.cells[0] = (2160, 0)
        with self.assertRaisesRegex(DGPError, 'Invalid background frame'):
            mapping.compose(DGP(ROOT / 'm01010.dgp'))

    def test_real_map_uses_native_indices(self):
        mapping = MapBackground(ROOT / 'Map/m01010.dat')
        source = DGP(ROOT / 'm01010.dgp')
        before = hashlib.sha256(source.path.read_bytes()).hexdigest()
        image, report = mapping.compose(source)
        self.assertEqual(image.size, (1280, 1728))
        self.assertEqual(report['referenced_frames'], 2160)
        self.assertEqual(mapping.cells[2 * 80][0], 31)
        self.assertNotEqual(mapping.cells[2 * 80][0], 40)  # Linear assembly is demonstrably wrong.
        self.assertEqual(image.crop((0, 32, 32, 64)).tobytes(), source.decode(31).tobytes())
        self.assertEqual(hashlib.sha256(source.path.read_bytes()).hexdigest(), before)

    def test_native_dual_stream_conversion(self):
        dgp = DGP(ROOT / 'ROLE/001.dgp')
        check = dgp.verify_secondary()
        self.assertEqual(check['checked_pixels'], 2465506)
        self.assertEqual(sum(a['directions'] * a['frames_per_direction'] for a in dgp.actions), 1608)


if __name__ == '__main__':
    unittest.main(verbosity=2)
