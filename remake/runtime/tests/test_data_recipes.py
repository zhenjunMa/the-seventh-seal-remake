"""首次数据提取的隔离重建、配置保留及失败不安装检查。"""
from pathlib import Path
import contextlib
import gzip
import io
import json
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from data_recipes import DataRecipes, digest
from export_data_recipes import export


class DataRebuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.original = self.root / 'original'
        self.runtime = self.root / 'runtime'
        self.data = self.runtime / 'web/data'
        self.source = self.original / 'System/Object.ITM'
        self.source.parent.mkdir(parents=True)
        self.native = b'\x00\x01' + '原版道具说明'.encode('gbk') + b'\0Original dialogue\0' + bytes(range(32))
        self.source.write_bytes(self.native)
        player = self.original / 'SaveGame0.Dat'
        instance = bytes((i * 7) % 256 for i in range(229))
        player.write_bytes(b'player-prefix' + instance + b'player-suffix')
        self.data.mkdir(parents=True)
        source = dict(path='SYSTEM/Object.ITM', sha256=digest(self.native))
        self.outputs = {}
        for name in ['items.json', 'story/maps/m17020.json']:
            value = dict(source=source, description='原版道具说明', text_raw='Original dialogue', raw_hex=self.native.hex(),
                         initialized_raw_hex=instance.hex())
            raw = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').replace('\n', '\r\n').encode()
            target = self.data / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            self.outputs[name] = raw
        self.configuration = self.data / 'config/skills.json'
        self.configuration.parent.mkdir()
        self.custom = b'{"entries":{"001_48":{"parameters":{"required_role_level":50}}}}'
        self.configuration.write_bytes(self.custom)
        with contextlib.redirect_stdout(io.StringIO()):
            export(self.runtime, self.original)
        player.unlink()  # A clean installation need not contain player saves.
        for name in self.outputs:
            (self.data / name).unlink()

    def test_clean_build_restores_exact_bytes_and_keeps_custom_changes(self):
        result = DataRecipes(self.runtime, self.original).build(run=False)
        self.assertFalse(result['run'])
        self.assertFalse((self.data / 'items.json').exists())
        self.assertFalse((self.runtime / '.cache').exists())
        result = DataRecipes(self.runtime, self.original).build(run=True)
        self.assertEqual(result['written'], 2)
        for name, raw in self.outputs.items():
            self.assertEqual((self.data / name).read_bytes(), raw)
        self.assertEqual(self.configuration.read_bytes(), self.custom)
        repeated = DataRecipes(self.runtime, self.original).build(run=True)
        self.assertEqual((repeated['written'], repeated['reused']), (0, 2))
        recipes = ''.join(gzip.decompress(p.read_bytes()).decode() for p in (self.runtime / 'tools/data_recipes').glob('*.json.gz'))
        self.assertNotIn('原版道具说明', recipes)
        self.assertNotIn('Original dialogue', recipes)
        self.assertNotIn(self.native.hex(), recipes)

    def test_late_document_failure_does_not_install_partial_output(self):
        reader = DataRecipes(self.runtime, self.original)
        reader.manifest['documents']['story/maps/m17020.json']['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, '重建后的运行数据'):
            reader.build(run=True)
        self.assertFalse((self.data / 'items.json').exists())
        self.assertEqual(self.configuration.read_bytes(), self.custom)

    def test_changed_original_and_forbidden_config_output_are_rejected(self):
        self.source.write_bytes(b'changed original')
        with self.assertRaisesRegex(ValueError, '原版内容'):
            DataRecipes(self.runtime, self.original).build(run=True)
        self.assertFalse((self.data / 'items.json').exists())
        manifest = self.runtime / 'tools/data_recipes/index.json'
        value = json.loads(manifest.read_text(encoding='utf-8'))
        self.source.write_bytes(self.native)
        value['sources']['SaveGame0.Dat'] = '0' * 64
        manifest.write_text(json.dumps(value), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '玩家存档'):
            DataRecipes(self.runtime, self.original).build(run=True)
        value['sources'].pop('SaveGame0.Dat')
        value['documents']['config/skills.json'] = value['documents']['items.json']
        manifest.write_text(json.dumps(value), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '自定义配置'):
            DataRecipes(self.runtime, self.original)
        self.assertEqual(self.configuration.read_bytes(), self.custom)


if __name__ == '__main__':
    unittest.main()
