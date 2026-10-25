"""Native DAT resource bases, shared maps, and confined source lookup."""
from pathlib import Path
import sys
import tempfile
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
from source.map_objects import MapObjects, MapObjectError
from source.dgp import DGP


class MapObjectResourceTests(unittest.TestCase):
    def test_real_shared_bases_bind_exact_native_source_graphics(self):
        for ident, base, identifiers in (
                ('M17024', 'mapm/m01021_2', {26}),
                ('M17030-1', 'mapm/m17030', {3, 4, 5, 6}),
                ('M17030-2', 'mapm/m17030', {3, 4, 5, 6})):
            with self.subTest(map=ident):
                table = MapObjects(ROOT / f'Map/{ident.lower()}.dat')
                self.assertEqual(table.resource_relative_base(), base)
                paths = table.resource_paths(ROOT)
                self.assertEqual(set(paths), {f'{ident:03}.dgp' for ident in identifiers})
                self.assertTrue(all(path.parent == ROOT / base for path in paths.values()))
                resources = {name: DGP(path) for name, path in paths.items()}
                graphics = table.prepare_graphics(resources)
                self.assertEqual(len(graphics), table.object_count)
                for graphic in graphics:
                    self.assertTrue(graphic['source'].startswith(base + '/'))
                    self.assertEqual(graphic['resource_sha256'], resources[graphic['resource_filename'].lower()].sha256)

    def table(self, base, identifiers=(1,)):
        table = MapObjects.__new__(MapObjects)
        table.resource_base_raw = base
        table.objects = [dict(library_raw=0, resource_identifier_raw=identifier) for identifier in identifiers]
        return table

    def test_only_exact_referenced_basenames_are_selected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / 'mapm/shared'
            base.mkdir(parents=True)
            (base / '001.DGP').write_bytes(b'one')
            (base / '002.dgp').write_bytes(b'unreferenced')
            paths = self.table('.\\MAPM\\shared\\').resource_paths(root)
            self.assertEqual(set(paths), {'001.dgp'})
            self.assertEqual(paths['001.dgp'].read_bytes(), b'one')
            other = root / 'mapm/other'
            other.mkdir()
            (other / '003.dgp').write_bytes(b'wrong directory')
            with self.assertRaisesRegex(MapObjectError, 'Missing exact native object resource'):
                self.table('.\\MAPM\\shared\\', (3,)).resource_paths(root)

    def test_absolute_paths_traversal_and_non_native_basenames_are_rejected(self):
        invalid = ('../mapm/shared', '.\\MAPM\\..\\shared\\', '.\\MAPM\\shared\\..\\other\\',
                   'C:\\MAPM\\shared\\', '\\\\server\\mapm\\shared\\', '/mapm/shared', 'mapm/shared/extra', '')
        for base in invalid:
            with self.subTest(base=base), self.assertRaisesRegex(MapObjectError, 'confined native Mapm'):
                self.table(base).resource_relative_base()
        for identifier in (-1, 0, '../001', True):
            with self.subTest(identifier=identifier), self.assertRaises(MapObjectError):
                self.table('mapm/shared').resource_source(identifier)


if __name__ == '__main__':
    unittest.main()
