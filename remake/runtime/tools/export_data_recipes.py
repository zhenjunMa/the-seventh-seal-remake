"""维护：将核验过的生成数据转为结构配方，原版内容只保存文件范围引用。

不压缩或内嵌原版文件，不改变游戏数据、自定义参数、原版及历史证据。
首次构建使用 data_recipes.py，不需要本维护命令或开发台账。
"""
from bisect import bisect_right
from collections import Counter
from pathlib import Path
import argparse
import gzip
import json
import re
import struct

from data_recipes import RUNTIME, SCHEMA, OriginalBytes, authored, encoded, digest, document_bytes, atomic_write, player_save
from media_definitions import OriginalFiles, checksum, original

HEX = re.compile('[0-9a-f]{16,}')
CHINESE = re.compile('[\u3400-\u9fff]')
NATIVE_TEXT = {'text_raw', 'description', 'name_cp950', 'name_cp936'}
METADATA = {'.exe', '.dat', '.chr', '.itm', '.anm', '.tlk', '.mag', '.mnu', '.cap', '.stg', '.scn'}
RECORD_FILES = {176: ('.chr',), 1053: ('.chr',), 779: ('.chr',),
                1647: ('.tlk',), 74: ('.anm',), 957: ('.itm',),
                274: ('.dat',), 1221: ('.dat',)}


class SourceLocator:
    def __init__(self, directory):
        self.original = OriginalFiles(directory)
        self.found = {}
        self.sources = {}
        self.stats = Counter()
        self.blobs = {}
        self.source_cache = OriginalBytes(48)

    def read(self, name):
        return self.source_cache.get(self.original.path(name))

    def record(self, name, offset, raw, codec):
        name = name.replace('\\', '/').casefold()
        if name not in self.sources:
            self.sources[name] = checksum(self.original.path(name))
        self.stats['source_values'] += 1
        self.stats['source_bytes'] += len(raw)
        return ['source', name, offset, len(raw), codec, digest(raw)]

    def blob(self, text, extensions=None):
        key = (text, extensions)
        if key not in self.blobs:
            chunks, starts, names, lengths, source_offsets = [], [], [], [], []
            position = 0
            for name, path in sorted(self.original.files.items()):
                if player_save(name):
                    continue
                if path.suffix.casefold() not in METADATA:
                    continue
                if extensions and path.suffix.casefold() not in extensions:
                    continue
                if path.suffix.casefold() == '.exe' and name != 'game.exe':
                    continue
                if text and path.suffix.casefold() == '.mnu':
                    continue
                raw = path.read_bytes()
                ranges = [(0, len(raw))]
                if text and path.suffix.casefold() == '.dat':
                    ranges = [(0, min(len(raw), 0x172))]
                    if len(raw) >= 0x172 and struct.unpack_from('<I', raw, 0x14)[0] == 6:
                        width, height = struct.unpack_from('<II', raw, 0x146)
                        variant = struct.unpack_from('<I', raw, 0x18)[0]
                        objects = struct.unpack_from('<I', raw, 0x82)[0]
                        base = 0x172 + width * height * 64 + 32 * (0x2a + (0x42 if variant == 1 else 0x2b) + 0x1b + 0x110) + objects * 0x112
                        for i in range(raw[0x86]):
                            offset = base + i * 0x4c5 + 0x14
                            if offset + 20 <= len(raw):
                                ranges.append((offset, 20))
                for offset, length in ranges:
                    chunks.append(raw[offset:offset + length])
                    starts.append(position)
                    names.append(name)
                    lengths.append(length)
                    source_offsets.append(offset)
                    position += length
            self.blobs[key] = (b''.join(chunks), starts, names, lengths, source_offsets)
        return self.blobs[key]

    def find(self, raw, candidates, codec):
        if (raw, codec) in self.found:
            return self.found[(raw, codec)]
        preferred = RECORD_FILES.get(len(raw)) if codec == 'hex' else None
        # A manifest can mix CHR records with DGP provenance. Search record
        # files first rather than scanning large image payloads for every action.
        candidates = sorted(candidates, key=lambda name: bool(preferred and Path(name).suffix.casefold() not in preferred))
        for name in candidates:
            if player_save(name):
                continue
            if preferred and Path(name).suffix.casefold() not in preferred:
                continue
            if codec != 'hex' and Path(name).suffix.casefold() not in METADATA | {'.mnu'}:
                continue
            try:
                data = self.read(name)
                end = min(len(data), 1024 * 1024) if Path(name).suffix.casefold() == '.dgp' else len(data)
                offset = data.find(raw, 0, end)
            except FileNotFoundError:
                continue
            if offset >= 0:
                node = self.record(name, offset, raw, codec)
                self.found[(raw, codec)] = node
                return node
        for extensions in ([preferred, None] if preferred else [None]):
            blob, starts, names, lengths, source_offsets = self.blob(codec != 'hex', extensions)
            offset = blob.find(raw)
            while offset >= 0:
                index = bisect_right(starts, offset) - 1
                local = offset - starts[index]
                if local + len(raw) <= lengths[index]:
                    node = self.record(names[index], local + source_offsets[index], raw, codec)
                    self.found[(raw, codec)] = node
                    return node
                # No later start in this file can fit; skip its tail.
                offset = blob.find(raw, starts[index] + lengths[index])
        self.found[(raw, codec)] = None
        return None

    def string(self, value, key, candidates):
        if not value:
            return ['string', value]
        native_text = key in NATIVE_TEXT or ':TLK:' in key
        cache_key = (value, 'hex' if 'hex' in key else 'native-text' if native_text else 'text')
        if cache_key in self.found:
            return self.found[cache_key]
        if ('hex' in key or key == 'bytes') and HEX.fullmatch(value) and len(value) % 2 == 0:
            node = self.find(bytes.fromhex(value), candidates, 'hex')
            if node is not None:
                self.found[cache_key] = node
                return node
            self.stats['derived_hex_values'] += 1
            self.stats['derived_hex_bytes'] += len(value) // 2
        elif CHINESE.search(value) or native_text:
            for codec in ('gbk', 'cp950', 'utf-16le', 'utf-8'):
                try:
                    raw = value.encode(codec, 'strict')
                except UnicodeEncodeError:
                    continue
                if raw.decode(codec, 'strict') != value:
                    continue
                node = self.find(raw, candidates, codec)
                if node is not None:
                    self.found[cache_key] = node
                    return node
        node = ['string', value]
        self.found[cache_key] = node
        return node


class Compiler:
    def __init__(self, original_dir):
        self.locator = SourceLocator(original_dir)
        self.nodes = []
        self.interned = {}

    def intern(self, node):
        key = encoded(node)
        index = self.interned.get(key)
        if index is None:
            index = len(self.nodes)
            self.nodes.append(node)
            self.interned[key] = index
        return [index]

    def value(self, value, key='', candidates=()):
        if isinstance(value, str):
            return self.intern(self.locator.string(value, key, candidates))
        if isinstance(value, list):
            return self.intern(['array', [self.value(child, key, candidates) for child in value]])
        if isinstance(value, dict):
            paths = []
            for field in ('source', 'map_source', 'path'):
                item = value.get(field)
                if isinstance(item, dict):
                    item = item.get('path')
                if original(item):
                    paths.append(item)
            hashes = value.get('source_hashes')
            if isinstance(hashes, dict) and len(hashes) <= 32:
                paths.extend(name for name in hashes if original(name))
            candidates = tuple(dict.fromkeys([*paths, *candidates]))[:48]
            return self.intern(['object', [[name, self.value(child, name, candidates)] for name, child in value.items()]])
        return value


def formatting(raw, data):
    for indent in (2, None, 1, 4):
        for compact in (False, True):
            row = dict(indent=indent, compact=compact, crlf=b'\r\n' in raw, newline=raw.endswith(b'\n'))
            if document_bytes(data, row) == raw:
                return row
    raise ValueError('未识别的生成数据格式，未更改文件：请先确认其生产者')


def write_recipes(runtime, nodes, manifest):
    directory = Path(runtime) / 'tools/data_recipes'
    previous = []
    if (directory / 'index.json').is_file():
        old = json.loads((directory / 'index.json').read_text())
        previous = [directory / (name + ('.json.gz' if old.get('compression') else '.json')) for name in old['pools']]
    pools = {}
    for start in range(0, len(nodes), 8192):
        name = f'{start // 8192:04}'
        raw = gzip.compress(encoded(nodes[start:start + 8192]) + b'\n', compresslevel=9, mtime=0)
        atomic_write(directory / (name + '.json.gz'), raw)
        pools[name] = digest(raw)
    manifest = {**manifest, 'compression': 'gzip', 'pools': pools}
    atomic_write(directory / 'index.json', json.dumps(manifest, ensure_ascii=False, indent=2).encode() + b'\n')
    retained = {directory / (name + '.json.gz') for name in pools}
    for path in previous:
        if path not in retained:
            path.unlink(missing_ok=True)
    return sum(path.stat().st_size for path in retained) + (directory / 'index.json').stat().st_size


def repack(runtime, original_dir):
    from data_recipes import DataRecipes
    reader = DataRecipes(runtime, original_dir)
    problems = reader.preflight()
    if problems:
        raise ValueError('；'.join(problems))
    locator = SourceLocator(original_dir)
    locator.sources.update({name: value for name, value in reader.sources.items() if not player_save(name)})
    native = set()
    for node in reader.nodes:
        if node[0] == 'object':
            native.update(value[0] for key, value in node[1]
                          if isinstance(value, list) and (key in NATIVE_TEXT or ':TLK:' in key))
    updated = 0
    for index, node in enumerate(reader.nodes):
        if node[0] == 'string' and (CHINESE.search(node[1]) or index in native):
            candidate = locator.string(node[1], 'text_raw' if index in native else 'text', ())
            if candidate[0] == 'source':
                reader.nodes[index] = candidate
                updated += 1
    manifest = {**reader.manifest, 'sources': dict(sorted(locator.sources.items()))}
    size = write_recipes(runtime, reader.nodes, manifest)
    print(json.dumps(dict(files=len(manifest['documents']), recipe_bytes=size, additional_source_texts=updated), ensure_ascii=False, indent=2))


def export(runtime, original_dir):
    runtime = Path(runtime)
    compiler = Compiler(original_dir)
    documents = {}
    files = sorted((runtime / 'web/data').rglob('*.json'))
    for index, path in enumerate(files):
        name = path.relative_to(runtime / 'web/data').as_posix()
        if authored(name):
            continue
        raw = path.read_bytes()
        data = json.loads(raw)
        if index % 50 == 0 or len(raw) > 1024 * 1024:
            print(f'编译 {index}/{len(files)}：{name}', flush=True)
        documents[name] = dict(root=compiler.value(data), format=formatting(raw, data), sha256=digest(raw), bytes=len(raw))
        if index % 50 == 0:
            print(f'数据配方 {index}/{len(files)}：{name}；共享节点 {len(compiler.nodes)}', flush=True)
    manifest = dict(schema=SCHEMA, version=1,
        notes='共享结构节点按拓扑顺序保存；[编号]引用节点，其他标量为常量。source节点为原文件范围，string为重制定义，object/array保留既有字段与顺序。不得手工改配方；重新核验导出后使用export_data_recipes.py维护。',
        sources=dict(sorted(compiler.locator.sources.items())), documents=documents)
    size = write_recipes(runtime, compiler.nodes, manifest)
    print(json.dumps(dict(files=len(documents), original_bytes=sum(v['bytes'] for v in documents.values()),
        recipe_bytes=size,
        shared_nodes=len(compiler.nodes), **compiler.locator.stats), ensure_ascii=False, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original-dir', type=Path, required=True)
    parser.add_argument('--repack', action='store_true', help='仅更新已有配方的文本范围引用及压缩分片，不读取生成表')
    args = parser.parse_args()
    (repack if args.repack else export)(RUNTIME, args.original_dir)


if __name__ == '__main__':
    main()
