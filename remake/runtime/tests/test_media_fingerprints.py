"""来源准入、显式放行和基准维护的隔离行为检查。"""
from pathlib import Path
from types import SimpleNamespace
import contextlib
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from media_definitions import OriginalFiles
from media_fingerprints import SourceFingerprints, write_reference
import export_media


class FingerprintTests(unittest.TestCase):
    def test_build_entrypoint_help_runs_in_isolated_python(self):
        entry = Path(__file__).resolve().parents[1] / 'tools/build_runtime.py'
        result = subprocess.run([sys.executable, '-I', '-X', 'utf8', '-B', str(entry), '--help'],
                                capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('--ignore-fingerprint', result.stdout)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / 'original'
        self.runtime = Path(self.directory.name) / 'runtime'
        self.reference = self.runtime / 'tools/media_inputs.json'
        self.put('Game.exe', b'program')
        self.put('M70010.DGP', b'background')
        self.put('ROLE/001.dgp', b'actor')
        self.put('sound/test.wav', b'audio')
        self.put('Map/001.dat', b'map')
        write_reference(OriginalFiles(self.root), self.reference)

    def put(self, name, raw):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        return path

    def inventory(self):
        return SourceFingerprints(OriginalFiles(self.root), self.reference)

    def test_case_and_background_layout_aliases_ignore_player_files(self):
        (self.root / 'M70010.DGP').rename(self.root / 'Map/m70010.dgp')
        (self.root / 'sound').rename(self.root / 'SOUND')
        for name in ['Game.SAV', 'SaveGame19.Dat', '.DS_Store', 'SOUND/._test.wav', 'SOUND/INSTALL.LOG']:
            self.put(name, b'local state')
        inventory = self.inventory()
        self.assertEqual(inventory.check(), [])
        self.assertTrue(inventory.report['matched'])
        self.assertEqual(len(inventory.files), 5)

    def test_missing_changed_and_extra_fail_by_default_and_are_recorded_when_ignored(self):
        self.put('sound/test.wav', b'different recording')
        (self.root / 'Map/001.dat').unlink()
        self.put('ROLE/mod.dgp', b'extra asset')
        inventory = self.inventory()
        self.assertTrue(inventory.check())
        self.assertEqual(list(inventory.report['changed']), ['sound/test.wav'])
        self.assertEqual(inventory.report['missing'], ['map/001.dat'])
        self.assertEqual(inventory.report['extra'], ['role/mod.dgp'])
        self.assertEqual(inventory.check(ignore=True), [])
        self.assertTrue(inventory.report['ignored'])
        self.assertFalse(inventory.report['matched'])

    def test_write_reference_is_explicit_idempotent_and_does_not_construct_an_exporter(self):
        before = self.reference.read_bytes()
        write_reference(OriginalFiles(self.root), self.reference)
        self.assertEqual(self.reference.read_bytes(), before)
        self.put('sound/test.wav', b'trusted new recording')
        with patch.object(export_media, 'RUNTIME', self.runtime), patch.object(export_media, 'MediaBuilder', side_effect=AssertionError('must not export')):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(export_media.main(['--original-dir', str(self.root), '--write-reference']), 0)
        self.assertFalse((self.runtime / 'web').exists())
        self.assertFalse((self.runtime / '.cache').exists())
        self.assertEqual(self.inventory().check(), [])
        self.assertNotEqual(self.reference.read_bytes(), before)

    def test_reference_integrity_and_during_build_source_changes_cannot_be_ignored(self):
        inventory = self.inventory()
        self.assertEqual(inventory.check(ignore=True), [])
        self.put('ROLE/001.dgp', b'changed during export')
        with self.assertRaisesRegex(ValueError, '构建期间'):
            inventory.verify_unchanged()
        self.reference.unlink()
        with self.assertRaisesRegex(ValueError, '缺少原版指纹基准'):
            self.inventory().check(ignore=True)

    def builder(self):
        plan = SimpleNamespace(required={'/assets/demo.png'},
            recipes={'/assets/demo.png': dict(kind='dgp', source='ROLE/001.dgp')},
            inputs={'ROLE/001.dgp': hashlib.sha256(b'actor').hexdigest()},
            expected={'/assets/demo.png': hashlib.sha256(b'cached PNG').hexdigest()}, missing_recipes=lambda: [])
        with patch.object(export_media, 'MediaDefinitions', return_value=plan):
            return export_media.MediaBuilder(self.runtime, self.root, images_only=True, ignore_fingerprint=True)

    def test_ignore_does_not_allow_missing_required_input(self):
        (self.root / 'ROLE/001.dgp').unlink()
        builder = self.builder()
        self.assertTrue(any('原版缺少文件' in problem for problem in builder.preflight()))
        self.assertIn('ROLE/001.dgp', builder.missing)

    def test_changed_source_cannot_hide_behind_existing_png_or_deduplicated_alias(self):
        from PIL import Image
        self.put('ROLE/001.dgp', b'changed graphic')
        builder = self.builder()
        self.assertEqual(builder.preflight(), [])
        path = builder.local('/assets/demo.png')
        path.parent.mkdir(parents=True)
        path.write_bytes(b'cached PNG')
        builder.state = {}
        builder.recipe_version = 'test'
        builder.aliases[builder.plan.expected['/assets/demo.png']] = path
        builder.decode = lambda row: Image.new('RGBA', (1, 1), (1, 2, 3, 255))
        with self.assertRaisesRegex(ValueError, '素材与固定描述不一致'):
            builder.build_one('/assets/demo.png')
        self.assertEqual(path.read_bytes(), b'cached PNG')

    def test_direct_pages_need_no_loose_png_and_repair_only_missing_output(self):
        from PIL import Image
        from image_atlas import build_image_catalog
        image = Image.new('RGBA', (16, 12), (17, 31, 47, 255))
        stream = io.BytesIO()
        image.save(stream, format='PNG')
        builder = self.builder()
        builder.plan.required = {'/assets/a/demo.png', '/assets/b/demo.png'}
        builder.plan.recipes = {name: dict(kind='dgp', source='ROLE/001.dgp') for name in builder.plan.required}
        builder.plan.expected = {name: hashlib.sha256(stream.getvalue()).hexdigest() for name in builder.plan.required}
        builder.plan.documents = {'data/battle_packs.json': dict(pages=[], images={})}
        builder.cache.mkdir(parents=True)
        self.assertEqual(builder.preflight(), [])
        builder.state = {}
        builder.recipe_version = 'test'
        with patch.object(builder, 'decode', side_effect=lambda row: image.copy()) as decode:
            catalog = build_image_catalog(builder)
            self.assertEqual(decode.call_count, 2)
        self.assertEqual(len(catalog['pages']), 1)
        for name in builder.plan.required:
            self.assertFalse(builder.local(name).exists())
        page = builder.local(catalog['pages'][0]['path'])
        with Image.open(page) as decoded:
            self.assertEqual(decoded.crop((2, 2, 18, 14)).tobytes(), image.tobytes())
        with patch.object(builder, 'decode', side_effect=AssertionError('valid pages must be reused')):
            self.assertEqual(build_image_catalog(builder), catalog)
        page.write_bytes(b'damaged')
        with patch.object(builder, 'decode', side_effect=lambda row: image.copy()) as decode:
            self.assertEqual(build_image_catalog(builder), catalog)
            self.assertEqual(decode.call_count, 1)


if __name__ == '__main__':
    unittest.main()
