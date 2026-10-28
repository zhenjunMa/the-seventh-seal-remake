"""Content-checked resource reuse and atomic, unchanged-preserving writes.

Cache records are local evidence, not runtime inputs. A hit checks the source /
recipe signature AND every recorded output; existence alone is never enough.
"""
from pathlib import Path
from contextlib import contextmanager
from collections import Counter
import ast
import atexit
import hashlib
import io
import json
import os
import re
from functools import lru_cache
from uuid import uuid4


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    return digest(Path(path).read_bytes())


def write_bytes(path, data):
    """Leave identical files (including their mtimes) alone; publish atomically."""
    path = Path(path)
    if path.is_file() and path.read_bytes() == data:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid4().hex + '.tmp')
    try:
        temporary.write_bytes(data)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def write_json(path, value, compact=False):
    path = Path(path)
    original = path.read_bytes() if path.is_file() else b''
    if original:
        try:
            if json.dumps(json.loads(original), sort_keys=True) == json.dumps(value, sort_keys=True):
                return False
        except (ValueError, UnicodeError, TypeError):
            pass
    options = {'separators': (',', ':')} if compact else {'indent': 2}
    text = json.dumps(value, ensure_ascii=False, **options) + '\n'
    if b'\r\n' in original:
        text = text.replace('\n', '\r\n')
    return write_bytes(path, text.encode('utf-8'))


def save_png(image, path):
    encoded = io.BytesIO()
    image.save(encoded, format='PNG')
    return write_bytes(path, encoded.getvalue())


def local_modules(entry, runtime):
    """Follow local Python imports and literal JS imports, including lazy ones.

    Data/recipe files and dynamically chosen scripts are explicitly declared by
    callers. Unrelated exporters and gameplay modules are never globbed in.
    """
    runtime, entry = Path(runtime).resolve(), Path(entry).resolve()
    pending, found = [entry], set()
    while pending:
        path = pending.pop()
        if path in found or not path.is_file():
            continue
        found.add(path)
        source = path.read_text(encoding='utf-8-sig')
        candidates = []
        if path.suffix == '.py':
            for node in ast.walk(ast.parse(source, filename=str(path))):
                if isinstance(node, ast.Import):
                    modules = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    prefix = (node.module + '.') if node.module else ''
                    modules = [node.module or '', *[prefix + alias.name for alias in node.names]]
                else:
                    continue
                for module in modules:
                    base = path.parent
                    if isinstance(node, ast.ImportFrom) and node.level:
                        for _ in range(node.level - 1):
                            base = base.parent
                        roots = [base]
                    else:
                        roots = [path.parent, runtime/'tools']
                    for root in roots:
                        target = root.joinpath(*module.split('.'))
                        candidates.extend([target.with_suffix('.py'), target/'__init__.py'])
                        # Changes to package initialization affect imported modules.
                        for parent in target.parents:
                            if parent == root or not parent.is_relative_to(root):
                                break
                            candidates.append(parent/'__init__.py')
            # Cross-language subprocess helpers (e.g. the content resolver)
            # are literal script names, not Python imports.
            for name in re.findall(r'''["']([A-Za-z0-9_./-]+\.(?:py|mjs|js))["']''', source):
                candidates.extend([path.parent/name, runtime/'tools'/name])
        elif path.suffix in ('.mjs', '.js'):
            names = re.findall(r'''(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.[^"']+)["']''', source)
            candidates.extend(path.parent/name for name in names)
        pending.extend(candidate.resolve() for candidate in candidates
                       if candidate.is_file() and candidate.resolve().is_relative_to(runtime))
    return found


@lru_cache(maxsize=512)
def _recipe_file(path, modified, size):
    return file_hash(path)


def recipe_hash(paths):
    values = {}
    for path in paths:
        path = Path(path).resolve()
        stat = path.stat()
        values[str(path)] = _recipe_file(path, stat.st_mtime_ns, stat.st_size)
    return digest(json.dumps(values, sort_keys=True).encode())


def cached_png(runtime, path, source, options, rules, render):
    path, runtime = Path(path).resolve(), Path(runtime).resolve()
    def produce():
        save_png(render(), path)
        return file_hash(path), [path]
    return resource(runtime, 'png/'+path.relative_to(runtime).as_posix(),
                    {'source': source, 'options': options}, rules, produce)


_decisions = []


def resource(runtime, key, inputs, rules, produce):
    """Produce (JSON value, output paths) only when this resource is stale."""
    runtime = Path(runtime).resolve()
    record_path = runtime/'evidence/resource_cache'/digest(key.encode())[:2]/(digest(key.encode()) + '.json')
    signature = digest(json.dumps({'inputs': inputs, 'rules': rules}, sort_keys=True).encode())
    previous = None
    if record_path.is_file():
        try:
            previous = json.loads(record_path.read_text('utf-8'))
            if (previous.get('version') != 1 or previous.get('key') != key
                    or 'value' not in previous or not isinstance(previous.get('outputs'), dict)):
                previous = None
        except (ValueError, OSError):
            pass
    reason = 'new-resource'
    if os.environ.get('SEVENTH_SEAL_FORCE_EXPORT') == '1':
        reason = 'forced'
    elif previous and previous.get('signature') == signature:
        outputs = previous.get('outputs', {})
        if all((runtime/name).resolve().is_relative_to(runtime) and (runtime/name).is_file()
               and file_hash(runtime/name) == sha for name, sha in outputs.items()):
            _decisions.append({'key': key, 'status': 'reused', 'reason': 'unchanged'})
            return previous['value']
        reason = 'missing-or-modified-output'
    elif previous:
        reason = 'source-or-recipe-changed'
    value, outputs = produce()
    checked = {}
    for path in outputs:
        path = Path(path).resolve()
        checked[path.relative_to(runtime).as_posix()] = file_hash(path)
    write_json(record_path, {'version': 1, 'key': key, 'signature': signature,
                            'inputs': inputs, 'rules': rules, 'outputs': checked, 'value': value})
    _decisions.append({'key': key, 'status': 'generated', 'reason': reason})
    return value


def report_resources():
    target = os.environ.get('SEVENTH_SEAL_RESOURCE_REPORT')
    if target:
        runtime = Path(__file__).resolve().parents[1]
        path = Path(target).resolve()
        if not path.is_relative_to((runtime/'evidence').resolve()):
            raise ValueError('Resource report must be inside runtime/evidence')
        write_json(path, {'counts': dict(Counter(row['status'] for row in _decisions)), 'resources': _decisions})


atexit.register(report_resources)


@contextmanager
def build_lock(evidence):
    """An OS lock is released even if a build is interrupted or killed."""
    path = Path(evidence)/'build.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as stream:
        if path.stat().st_size == 0:
            stream.write(b'\0'); stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError('Another runtime build is running; retry after it completes') from error
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)
