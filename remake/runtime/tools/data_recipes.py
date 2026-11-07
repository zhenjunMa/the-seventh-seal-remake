"""从原版字节与已核实的结构配方还原运行数据；不写入自定义配置。

配方节点只保存结构、共享常量及原文件的范围引用。生成的 JSON 保持既有
路径与字节格式，游戏和开发检查继续使用同一数据合同。
"""
from collections import OrderedDict
from pathlib import Path, PurePosixPath
import argparse
import gzip
import hashlib
import json
import mmap
import os
import re
import tempfile

from media_definitions import OriginalFiles, checksum

SCHEMA = 'seventh-seal-data-recipes'
RUNTIME = Path(__file__).resolve().parents[1]
AUTHORING = {'runtime_content.json', 'content_checklist.json', 'battle_result.json'}


def player_save(name):
    return bool(re.fullmatch(r'(?:savegame\d+\.dat|game\.sav)', PurePosixPath(name.replace('\\', '/')).name, re.I))


def authored(name):
    path = PurePosixPath(name)
    return name in AUTHORING or path.parts[0] in {'config', 'events', 'source'}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def document_bytes(value, formatting):
    options = dict(ensure_ascii=False, indent=formatting['indent'])
    if formatting['compact']:
        options['separators'] = (',', ':')
    text = json.dumps(value, **options) + ('\n' if formatting['newline'] else '')
    if formatting['crlf']:
        text = text.replace('\n', '\r\n')
    return text.encode('utf-8')


def atomic_write(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file() and path.read_bytes() == raw:
        return False
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(raw)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return True


class OriginalBytes:
    """Bounded read-only mappings; large DGP sources are never copied wholesale."""
    def __init__(self, capacity=32):
        self.capacity = capacity
        self.maps = OrderedDict()

    def get(self, path):
        if path in self.maps:
            self.maps.move_to_end(path)
            return self.maps[path]
        if not path.stat().st_size:
            return b''
        with path.open('rb') as stream:
            value = mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ)
        self.maps[path] = value
        if len(self.maps) > self.capacity:
            _, previous = self.maps.popitem(last=False)
            previous.close()
        return value

    def close(self):
        for value in self.maps.values():
            value.close()
        self.maps.clear()

    def __del__(self):
        self.close()


class DataRecipes:
    def __init__(self, runtime, original_dir):
        self.runtime = Path(runtime).resolve()
        self.directory = self.runtime / 'tools/data_recipes'
        self.original = OriginalFiles(original_dir)
        self.manifest = json.loads((self.directory / 'index.json').read_text('utf-8'))
        if self.manifest.get('schema') != SCHEMA or self.manifest.get('version') != 1:
            raise ValueError('运行数据配方版本无效')
        self.nodes = []
        compression = self.manifest.get('compression')
        if compression not in (None, 'gzip'):
            raise ValueError('运行数据配方压缩格式无效')
        for name, expected in self.manifest['pools'].items():
            if not name.isdigit():
                raise ValueError('运行数据配方分片名称无效')
            raw = (self.directory / (name + ('.json.gz' if compression else '.json'))).read_bytes()
            if digest(raw) != expected:
                raise ValueError('运行数据配方分片指纹不符：' + name)
            self.nodes.extend(json.loads(gzip.decompress(raw) if compression else raw))
        self.sources = self.manifest['sources']
        self.paths = {}
        self.values = {}
        self.source_cache = OriginalBytes()
        for name in self.manifest['documents']:
            self.output(name)

    def output(self, name):
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or path.suffix != '.json' or authored(name):
            raise ValueError('运行数据配方不得覆盖源码或自定义配置：' + name)
        target = (self.runtime / 'web/data' / name).resolve()
        if not target.is_relative_to((self.runtime / 'web/data').resolve()):
            raise ValueError('运行数据输出超出 data：' + name)
        return target

    def preflight(self):
        problems = []
        for name, expected in self.sources.items():
            if player_save(name):
                problems.append('运行数据配方不得依赖玩家存档：' + name)
                continue
            try:
                path = self.original.path(name)
                if checksum(path) != expected:
                    raise ValueError('原版内容与运行数据配方不一致：' + name)
                self.paths[name] = path
            except (ValueError, OSError) as error:
                problems.append(str(error))
        return problems

    def source_bytes(self, name):
        return self.source_cache.get(self.paths[name])

    def value(self, reference):
        if not isinstance(reference, list):
            return reference
        if len(reference) != 1 or type(reference[0]) is not int:
            raise ValueError('运行数据节点引用无效')
        index = reference[0]
        if index in self.values:
            return self.values[index]
        if not 0 <= index < len(self.nodes):
            raise ValueError('运行数据节点引用越界')
        node = self.nodes[index]
        kind = node[0]
        if kind == 'string':
            value = node[1]
        elif kind == 'source':
            _, name, offset, length, codec, expected = node
            if type(offset) is not int or type(length) is not int or offset < 0 or length < 0:
                raise ValueError('运行数据原版范围无效')
            raw = self.source_bytes(name)[offset:offset + length]
            if len(raw) != length or digest(raw) != expected:
                raise ValueError(f'运行数据原版范围不匹配：{name}+{offset}')
            value = raw.hex() if codec == 'hex' else raw.decode(codec, 'strict')
        elif kind in {'object', 'array'}:
            children = node[1]
            references = (v for _, v in children) if kind == 'object' else iter(children)
            if any(isinstance(v, list) and (len(v) != 1 or type(v[0]) is not int or not 0 <= v[0] < index)
                   for v in references):
                raise ValueError('运行数据节点必须只引用此前节点')
            value = ({key: self.value(child) for key, child in children} if kind == 'object'
                     else [self.value(child) for child in children])
        else:
            raise ValueError('运行数据节点类型无效：' + str(kind))
        self.values[index] = value
        return value

    def documents(self):
        for name, row in self.manifest['documents'].items():
            raw = document_bytes(self.value(row['root']), row['format'])
            if digest(raw) != row['sha256']:
                raise ValueError('重建后的运行数据与已核实定义不同：' + name)
            yield name, raw

    def build(self, *, run=False):
        problems = self.preflight()
        if problems:
            raise ValueError('；'.join(problems))
        # Complete validation precedes installation, including failures in the
        # last document. Staging never touches player saves or config/.
        stats = dict(files=len(self.manifest['documents']), bytes=0, written=0, reused=0)
        if not run:
            return dict(passed=True, run=False, **stats)
        cache = self.runtime / '.cache'
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='data-build-', dir=cache) as temporary:
            stage = Path(temporary)
            pending = []
            for name, raw in self.documents():
                stats['bytes'] += len(raw)
                target = self.output(name)
                if target.is_file() and checksum(target) == digest(raw):
                    stats['reused'] += 1
                    continue
                staged = stage / name
                staged.parent.mkdir(parents=True, exist_ok=True)
                staged.write_bytes(raw)
                pending.append((staged, target))
            # Source files can be replaced by another process during a build.
            if self.preflight():
                raise ValueError('重建期间原版文件发生变化，未安装运行数据')
            for staged, target in pending:
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(staged, target)
            stats['written'] = len(pending)
        return dict(passed=True, run=True, **stats)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original-dir', type=Path, required=True)
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args(argv)
    try:
        result = DataRecipes(RUNTIME, args.original_dir).build(run=args.run)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, '运行数据提取失败：' + str(error) + '\n')


if __name__ == '__main__':
    raise SystemExit(main())
