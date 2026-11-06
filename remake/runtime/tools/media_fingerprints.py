"""原版素材输入基准；不改变固定规则和历史来源记录。"""
from pathlib import PurePosixPath
import json
import re

from media_definitions import OriginalFiles, checksum


DIRECTORIES = ('animate', 'anilink', 'fight_bk', 'fight_role', 'font', 'map',
               'mapm', 'picture', 'role', 'sound', 'system')
IGNORED_NAMES = {'.ds_store', 'thumbs.db', 'desktop.ini'}
SCOPE = dict(directories=list(DIRECTORIES), root_files=['game.exe', '*.dgp'],
             ignored=['系统杂项和资源叉', '*.sav', 'SaveGame<number>.Dat', '*.log', '*.tmp'],
             aliases={'<root>/*.dgp': 'map/*.dgp'}, case_sensitive=False)


def source_key(name):
    if not isinstance(name, str) or re.match(r'^[A-Za-z]:', name):
        raise ValueError('无效的原版指纹路径：' + str(name))
    path = PurePosixPath(name.replace('\\', '/').casefold())
    if path.is_absolute() or '..' in path.parts or not path.parts:
        raise ValueError('无效的原版指纹路径：' + name)
    if len(path.parts) == 1 and path.suffix == '.dgp':
        return 'map/' + path.name
    return path.as_posix()


def input_files(original):
    files = {}
    for name, path in sorted(original.files.items()):
        parts = PurePosixPath(name).parts
        if any(part in IGNORED_NAMES or part == '__macosx' or part.startswith('._') for part in parts):
            continue
        if path.suffix.casefold() in {'.sav', '.log', '.tmp'} or re.fullmatch(r'savegame\d+\.dat', parts[-1]):
            continue
        if not (parts[0] in DIRECTORIES or (len(parts) == 1 and
                (name == 'game.exe' or path.suffix.casefold() == '.dgp'))):
            continue
        key = source_key(name)
        if key in files and checksum(files[key]) != checksum(path):
            raise ValueError('原版存在内容不同的同名背景：' + key)
        # Match OriginalFiles.path(): an explicit Map/ file wins over the root alias.
        if key not in files or parts[0] == 'map':
            files[key] = path
    return files


class SourceFingerprints:
    def __init__(self, original, reference):
        self.original = original
        self.reference = reference
        self.paths = input_files(original)
        self.digests = {}
        self.files = {name: self.file_hash(path) for name, path in self.paths.items()}

    def file_hash(self, path):
        if path not in self.digests:
            self.digests[path] = checksum(path)
        return self.digests[path]

    def check(self, *, ignore=False):
        try:
            raw = self.reference.read_bytes()
        except FileNotFoundError as error:
            raise ValueError('缺少原版指纹基准：'+str(self.reference)+'；维护者可用 --write-reference 从可信完整安装生成') from error
        data = json.loads(raw)
        if (not isinstance(data, dict) or data.get('schema') != 'seventh-seal-original-inputs' or data.get('version') != 1
                or data.get('scope') != SCOPE or not isinstance(data.get('files'), dict)):
            raise ValueError('原版指纹基准格式或核验范围不匹配：'+str(self.reference))
        self.expected = {}
        for name, value in data['files'].items():
            key = source_key(name)
            if key in self.expected or not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value):
                raise ValueError('原版指纹基准条目无效：'+name)
            self.expected[key] = value
        if 'game.exe' not in self.expected:
            raise ValueError('原版指纹基准缺少 GAME.exe')
        missing = sorted(self.expected.keys() - self.files.keys())
        extra = sorted(self.files.keys() - self.expected.keys())
        changed = {name: dict(reference_sha256=self.expected[name], actual_sha256=self.files[name])
                   for name in sorted(self.expected.keys() & self.files.keys())
                   if self.expected[name] != self.files[name]}
        from hashlib import sha256
        self.report = dict(reference='tools/'+self.reference.name, reference_sha256=sha256(raw).hexdigest(),
                           compared=len(self.files), matched=not (missing or changed or extra),
                           ignored=ignore, missing=missing, changed=changed, extra=extra)
        problems = []
        if not ignore:
            for label, names in [('缺少基准文件', missing), ('内容与基准不同', list(changed)), ('多出素材文件', extra)]:
                if names:
                    problems.append(f'{label} {len(names)} 个：'+ '、'.join(names[:8])+(' …' if len(names)>8 else ''))
            if problems:
                problems.append('原版目录与已验证基准不一致；确认使用此来源可加 --ignore-fingerprint，导出结果仍须通过校验')
        return problems

    def verify_unchanged(self):
        current = SourceFingerprints(OriginalFiles(self.original.root), self.reference)
        if current.files != self.files:
            raise ValueError('构建期间原版素材文件集合或内容发生变化')
        for path, expected in self.digests.items():
            if current.file_hash(path) != expected:
                raise ValueError('构建期间原版文件发生变化：'+str(path))
        if checksum(self.reference) != self.report['reference_sha256']:
            raise ValueError('构建期间原版指纹基准发生变化')


def write_reference(original, destination):
    # This maintenance entry uses only the standard library and never exports media.
    original.path('GAME.exe')
    inventory = SourceFingerprints(original, destination)
    from incremental import write_json
    data = dict(schema='seventh-seal-original-inputs', version=1,
                description='已验证安装的原版文件基准；用 --write-reference 维护，固定规则及历史来源指纹保持原值。',
                scope=SCOPE, files=dict(sorted(inventory.files.items())))
    write_json(destination, data)
    return dict(reference=str(destination), files=len(data['files']), sha256=checksum(destination))
