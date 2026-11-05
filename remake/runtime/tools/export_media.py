"""从原版安装目录和仓库固定定义生成游戏素材。

仅生成媒体与素材清单，保留规则、剧情、调参和历史证据。
内置位图字库直接复制，不依赖 Windows 字体生成器。
"""
from collections import defaultdict
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
import argparse
import hashlib
import io
import importlib.util
import json
import os
import shutil
import struct
import subprocess
import sys
from uuid import uuid4

from media_definitions import MediaDefinitions, OriginalFiles, checksum, url

RUNTIME = Path(__file__).resolve().parents[1]


def digest(value):
    return hashlib.sha256(value).hexdigest()


class MediaBuilder:
    def __init__(self, runtime, original_dir, *, force=False, images_only=False):
        self.runtime = Path(runtime)
        self.web = self.runtime / 'web'
        self.original = OriginalFiles(original_dir)
        self.plan = MediaDefinitions(self.runtime)
        self.force = force
        self.images_only = images_only
        self.cache = self.runtime / '.cache/media'
        self.state_path = self.cache / 'state.json'
        self.source_hashes = {}
        self.source_paths = {}
        self.missing = {}
        self.variants = {}
        self.outputs = {}
        self.aliases = {}
        self.active = set()
        self.stats = dict(exported=0, reused=0, deduplicated=0, atlas_pages=0)
        self.ffmpeg = shutil.which('ffmpeg')
        self.ffprobe = shutil.which('ffprobe')

    def local(self, name):
        path = (self.web / name.lstrip('/')).resolve()
        if not path.is_relative_to((self.web / 'assets').resolve()):
            raise ValueError('素材输出超出 assets：' + name)
        if path == (self.web / 'assets').resolve():
            raise ValueError('素材输出必须是文件：' + name)
        return path

    def selected(self):
        return sorted(name for name in self.plan.required if not self.images_only or name.endswith('.png'))

    def preflight(self):
        problems = []
        for name, module in [('Pillow', 'PIL'), *([] if self.images_only else [('NumPy', 'numpy')])]:
            if importlib.util.find_spec(module) is None:
                problems.append('缺少 Python 依赖：'+name+'；请安装 runtime/requirements.txt')
        unknown = self.plan.missing_recipes()
        if unknown:
            problems.extend('缺少素材提取配方：' + name for name in unknown)
        names = {'GAME.exe'}
        for name in self.selected():
            row = self.plan.recipes.get(name, {})
            if row.get('source'):
                names.add(row['source'])
            names.update(row.get('backgrounds', []))
        expected = {key.casefold(): value for key, value in self.plan.inputs.items()}
        compatibility = json.loads((Path(__file__).parent / 'media_compatibility.json').read_text('utf-8'))['sources']
        for name in sorted(names):
            try:
                path = self.original.path(name)
            except FileNotFoundError:
                # A supported alternative location must match the retained
                # content digest. Similar names are never substituted.
                wanted = expected.get(name.casefold())
                candidates = [p for p in self.original.files.values() if p.name.casefold() == Path(name).name.casefold()]
                matches = [p for p in candidates if wanted and checksum(p) == wanted]
                if len(matches) == 1:
                    path = matches[0]
                else:
                    self.missing[name] = '原版目录未提供该文件'
                    continue
            actual = checksum(path)
            wanted = expected.get(name.casefold())
            if wanted and actual != wanted:
                admitted = compatibility.get(name.casefold(), {})
                if name.lower().endswith('.wav') or (admitted.get('definition_sha256') == wanted and actual in admitted.get('accepted_sha256', [])):
                    self.variants[name] = dict(definition_sha256=wanted, actual_sha256=actual)
                else:
                    problems.append('原版资源版本不匹配：' + name)
            self.source_paths[name] = path
            self.source_hashes[name] = actual
        for name, row in self.plan.recipes.items():
            if name not in self.selected_set:
                continue
            if row['kind'] == 'builtin':
                path = self.runtime / 'builtin' / row['file']
                if not path.is_file() or checksum(path) != self.plan.expected.get(name):
                    problems.append('内置字库缺失或指纹不符：' + str(path))
        problems.extend('原版缺少文件：' + name for name in self.missing)
        if not self.images_only:
            for name, tool in [('ffmpeg', self.ffmpeg), ('ffprobe', self.ffprobe), ('node', shutil.which('node'))]:
                if not tool:
                    problems.append('缺少外部工具：' + name)
        return problems

    @property
    def selected_set(self):
        if not hasattr(self, '_selected_set'):
            self._selected_set = set(self.selected())
        return self._selected_set

    def source(self, name):
        return self.source_paths[name]

    @lru_cache(maxsize=3)
    def dgp(self, source):
        from source.dgp import DGP
        return DGP(self.source(source))

    @lru_cache(maxsize=48)
    def frame(self, source, index, channel):
        from PIL import Image, ImageChops, ImageOps
        graphics = self.dgp(source)
        if index >= graphics.frame_count:
            return Image.new('RGBA', (graphics.width, graphics.height))
        if channel == 'main':
            return graphics.decode(index)
        if channel == 'shadow':
            return (graphics.decode_shadow(index) if graphics.shadow_blobs
                    else Image.new('RGBA', (graphics.width, graphics.height)))
        if channel == 'intrinsic':
            from export_combat_presentation import indexed_contribution
            return (indexed_contribution(graphics, index)[0] if graphics.indexed_auxiliary
                    else Image.new('RGBA', (graphics.width, graphics.height)))
        block = next(row for row in graphics.optional_blocks if row['kind'] == 'per_frame_mask')
        offset = block['offset'] + graphics.width * graphics.height * index
        mask = Image.frombytes('L', (graphics.width, graphics.height), graphics.data[offset:offset+graphics.width*graphics.height])
        if channel == 'mask':
            return mask
        if channel == 'inverse-mask':
            image = graphics.decode(index)
            image.putalpha(ImageChops.multiply(image.getchannel('A'), ImageOps.invert(mask)))
            return image
        raise ValueError('未知 DGP 图层：' + channel)

    def sheet(self, row):
        from PIL import Image
        graphics = self.dgp(row['source'])
        crop = row.get('crop')
        width, height = (crop['width'], crop['height']) if crop else (graphics.width, graphics.height)
        image = Image.new('RGBA', (width * row['count'], height * row['directions']))
        for direction in range(row['directions']):
            for frame in range(row['count']):
                physical = row['first'] + direction * row['count'] + frame
                cell = self.frame(row['source'], physical, row['channel'])
                if crop:
                    cell = cell.crop((crop['x'], crop['y'], crop['x']+width, crop['y']+height))
                image.paste(cell, (frame * width, direction * height))
        return image

    def mnu_image(self, row):
        from PIL import Image, ImageChops, ImageOps
        from export_operation_menu import decode_rows
        raw = self.source(row['source']).read_bytes()
        offset = row['offset']
        width, height, size, mask_size, alpha_size = struct.unpack_from('<5I', raw, offset)
        start = offset + 20
        mask = raw[start+size*2:start+size*2+mask_size]
        alpha = raw[start+size*2+mask_size:start+size*2+mask_size+alpha_size]
        if row['channel'] in ('mask', 'alpha'):
            return Image.frombytes('L', (width, height), mask if row['channel'] == 'mask' else alpha)
        image = decode_rows(raw[start:start+size], width, height)[0]
        if row['channel'] == 'render' and alpha:
            image.putalpha(ImageChops.multiply(image.getchannel('A'), ImageOps.invert(Image.frombytes('L', image.size, alpha))))
        return image

    @lru_cache(maxsize=4)
    def menu_offsets(self, source):
        raw = self.source(source).read_bytes()
        count, width, height = (struct.unpack_from('<I', raw, offset)[0] for offset in (52, 78, 82))
        cursor = 1138 + 473 * count + width * height
        result = []
        while cursor < len(raw):
            frames = struct.unpack_from('<I', raw, cursor+20)[0]
            cursor += 61
            for _ in range(frames):
                result.append(cursor)
                _, _, size, mask, alpha = struct.unpack_from('<5I', raw, cursor)
                cursor += 20 + size * 2 + mask + alpha
        if cursor != len(raw):
            raise ValueError('MNU 图片边界错误：' + source)
        return result

    @lru_cache(maxsize=2)
    def pak(self, source):
        from PIL import Image
        from export_startup_menu import sprite
        raw = self.source(source).read_bytes()
        key = Path(source).stem.lower()
        if key == 'menuback':
            count = struct.unpack_from('<I', raw, 1)[0]
            result = []
            for index in range(count):
                offset, size = struct.unpack_from('<II', raw, 5+index*72)
                with Image.open(io.BytesIO(raw[offset:offset+size])) as opened:
                    result.append(opened.convert('RGBA'))
            return result
        single = key in ('menulbk', 'menulbx')
        if single:
            size = struct.unpack_from('<I', raw)[0]
            count, offsets, start = 1, [0], 4
        else:
            count, size = struct.unpack_from('<II', raw)
            offsets = list(struct.unpack_from('<' + str(count) + 'I', raw, 8))
            start = 8 + count * 4
        palette = start + size
        blend = palette + count * 512
        result = []
        for index, offset in enumerate(offsets):
            end = offsets[index+1] if index+1 < count else size
            result.append(sprite(raw[start+offset:start+end], raw[palette+index*512:palette+(index+1)*512],
                                 raw[blend+index*1024:blend+(index+1)*1024])[0])
        return result

    def image(self, name):
        from PIL import Image
        self.build_one(url(name))
        opened = Image.open(self.local(url(name)))
        opened.load()
        if opened.mode == 'RGBA':
            return opened
        converted = opened.convert('RGBA')
        opened.close()
        return converted

    @lru_cache(maxsize=1)
    def atlas_image(self, name):
        return self.image(name)

    def stage(self, row):
        from PIL import Image, ImageChops
        composition = row['composition']
        layers = {layer['id']: layer for layer in row['layers']}
        preview = Image.new('RGBA', (640, 480), 'black')
        for part in ('sky', 'ground'):
            placement = composition[part]
            frames = layers[placement['layer_id']]['frames']
            frame = frames[placement.get('initial_frame', placement.get('frame', 0))]
            image = self.image(frame['path'])
            x, y, w, h = placement['source_rect']
            preview.alpha_composite(image.crop((x, y, x+w, y+h)), tuple(placement['destination_rect'][:2]))
        for placement in sorted(composition.get('scene_objects', []), key=lambda value: (value.get('sort_category', 0), value.get('sort_y', 0))):
            frame = layers[placement['layer_id']]['frames'][placement['frame']]
            image = self.image(frame['path'])
            at = tuple(placement['destination_rect'][:2])
            if row['legacy']:
                preview.paste(image, at, image)
            else:
                preview.alpha_composite(image, at)
                if frame.get('intrinsic'):
                    light = Image.new('RGBA', preview.size)
                    light.alpha_composite(self.image(frame['intrinsic']['path']), at)
                    preview = ImageChops.add(preview, light)
        return preview

    def decode(self, row):
        from PIL import Image
        kind = row['kind']
        if kind == 'dgp':
            return self.frame(row['source'], row['frame'], row['channel'])
        if kind == 'sheet':
            return self.sheet(row)
        if kind == 'shadow-grid':
            x, y, w, h = row['rect']
            image = Image.new('RGBA', (row['columns']*w, ((row['count']+row['columns']-1)//row['columns'])*h))
            for frame in range(row['count']):
                image.paste(self.frame(row['source'], frame, 'shadow').crop((x, y, x+w, y+h)),
                            ((frame % row['columns'])*w, (frame // row['columns'])*h))
            return image
        if kind == 'mnu-index':
            return self.mnu_image(dict(row, offset=self.menu_offsets(row['source'])[row['index']], channel='render'))
        if kind == 'mnu-image':
            return self.mnu_image(row)
        if kind == 'plane':
            raw = self.source(row['source']).read_bytes()
            plane = raw[row['offset']:row['offset']+row['width']*row['height']]
            if row.get('raw_sha256') and digest(plane) != row['raw_sha256']:
                raise ValueError('菜单感应平面与固定描述不一致：'+row['source'])
            return Image.frombytes('L', (row['width'], row['height']), plane)
        if kind == 'pak':
            return self.pak(row['source'])[row['frame']]
        if kind == 'map':
            from route_export_maps import RouteMapBackground
            from export_maps import compose_background
            background = RouteMapBackground(self.source(row['source']))
            return compose_background(background, [self.dgp(name) for name in row['backgrounds']])[0]
        if kind == 'crop':
            return self.image(row['image']).crop(tuple(row['rect']))
        if kind == 'compose':
            image = self.image(row['base'])
            for name, x, y in row['overlays']:
                image.alpha_composite(self.image(name), (x, y))
            return image.crop(tuple(row['crop'])) if row['crop'] else image
        if kind == 'stage':
            return self.stage(row)
        raise ValueError('未知素材配方：' + kind)

    def run(self, args):
        result = subprocess.run(args, capture_output=True)
        if result.returncode:
            raise RuntimeError(result.stderr.decode('utf-8', 'replace')[-4000:])
        return result.stdout

    def transcode(self, name, row, path):
        from incremental import write_bytes
        source = self.source(row['source'])
        print('转换媒体：'+row['source'], flush=True)
        if row['kind'] == 'audio' and path.suffix == '.mp3':
            raw = source.read_bytes()
            if not (raw.startswith(b'ID3') or raw[:1] == b'\xff'):
                raise ValueError('预期 MPEG 音频：' + row['source'])
            write_bytes(path, raw)
            return
        temporary = path.with_name(path.stem + '.' + uuid4().hex + path.suffix)
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            if row['kind'] == 'audio':
                self.run([self.ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', str(source), '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', str(temporary)])
                def pcm(file):
                    return self.run([self.ffmpeg, '-v', 'error', '-nostdin', '-i', str(file), '-map', '0:a:0', '-f', 'md5', '-'])
                if pcm(source) != pcm(temporary):
                    raise ValueError('音频转码改变了 PCM：' + row['source'])
            else:
                info = json.loads(self.run([self.ffprobe, '-v', 'error', '-show_streams', '-of', 'json', str(source)]))
                audio = any(stream['codec_type'] == 'audio' for stream in info['streams'])
                args = [self.ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', str(source), '-map', '0:v:0', '-c:v', 'libx264',
                        '-preset', 'slow', '-crf', '12', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough']
                args += ['-map', '0:a:0', '-af', 'volume='+str(row['encode_gain']), '-c:a', 'aac', '-b:a', '384k'] if audio else ['-an']
                self.run([*args, '-movflags', '+faststart', str(temporary)])
                from export_story_media import verify_video
                verify_video(self.ffmpeg, self.ffprobe, source, temporary, playback_gain=1/row['encode_gain'])
            write_bytes(path, temporary.read_bytes())
        finally:
            temporary.unlink(missing_ok=True)

    @lru_cache(maxsize=None)
    def resource_signature(self, name):
        row = self.plan.recipes[name]
        sources = [row['source']] if row.get('source') else []
        sources.extend(row.get('backgrounds', []))
        dependencies = []
        if row['kind'] == 'crop':
            dependencies.append(row['image'])
        elif row['kind'] == 'compose':
            dependencies.extend([row['base'], *[entry[0] for entry in row['overlays']]])
        elif row['kind'] == 'stage':
            for layer in row['layers']:
                for frame in layer['frames']:
                    dependencies.append(frame['path'])
                    if frame.get('intrinsic'):
                        dependencies.append(frame['intrinsic']['path'])
        inputs = {source: self.source_hashes.get(source) for source in sources}
        inputs.update({url(child): self.resource_signature(url(child)) for child in dependencies})
        return digest(json.dumps([self.recipe_version, row, inputs], sort_keys=True).encode())

    def build_one(self, name):
        from incremental import write_bytes
        if name in self.outputs:
            return
        if name in self.active:
            raise ValueError('素材配方存在循环：' + name)
        row = self.plan.recipes[name]
        if row.get('source') in self.missing:
            return
        path = self.local(name)
        signature = self.resource_signature(name)
        previous = self.state.get(name)
        expected = self.plan.expected.get(name) if row['kind'] not in ('audio', 'video') else None
        if not self.force and expected and path.is_file() and checksum(path) == expected:
            self.outputs[name] = expected
            self.aliases[expected] = path
            self.state[name] = dict(signature=signature, sha256=expected)
            self.stats['reused'] += 1
            return
        if not self.force and previous and previous['signature'] == signature and path.is_file() and checksum(path) == previous['sha256']:
            self.outputs[name] = previous['sha256']
            self.aliases[previous['sha256']] = path
            self.stats['reused'] += 1
            return
        if expected and expected in self.aliases:
            write_bytes(path, self.aliases[expected].read_bytes())
            actual = expected
            self.stats['deduplicated'] += 1
        else:
            self.active.add(name)
            try:
                if row['kind'] == 'builtin':
                    raw = (self.runtime / 'builtin' / row['file']).read_bytes()
                    write_bytes(path, raw)
                elif row['kind'] in ('audio', 'video'):
                    self.transcode(name, row, path)
                else:
                    image = self.decode(row)
                    stream = io.BytesIO()
                    image.save(stream, format='PNG')
                    raw = stream.getvalue()
                    if expected and digest(raw) != expected:
                        raise ValueError(f'素材与固定描述不一致：{name}，预期 {expected}，实际 {digest(raw)}')
                    write_bytes(path, raw)
                actual = checksum(path)
                self.stats['exported'] += 1
            finally:
                self.active.remove(name)
        self.outputs[name] = actual
        self.aliases[actual] = path
        self.state[name] = dict(signature=signature, sha256=actual)

    def battle_pages(self):
        from PIL import Image
        from incremental import write_bytes
        data = self.plan.documents['data/battle_packs.json']
        locations = defaultdict(dict)
        for name, image in data['images'].items():
            for region in image['regions']:
                locations[region[4]].setdefault(name, []).append(region)
        for index, page in enumerate(data['pages']):
            path = self.local(page['path'])
            if path.is_file() and checksum(path) == page['sha256'] and not self.force:
                self.outputs[page['path']] = page['sha256']
                continue
            atlas = Image.new('RGBA', (page['width'], page['height']))
            for name, regions in locations[index].items():
                image = self.atlas_image(name)
                for ox, oy, w, h, _, x, y in regions:
                    atlas.paste(image.crop((ox, oy, ox+w, oy+h)), (x, y))
            encoded = io.BytesIO()
            atlas.save(encoded, format='PNG', compress_level=6)
            raw = encoded.getvalue()
            if digest(raw) != page['sha256']:
                raise ValueError('战斗图集不能按固定坐标恢复：' + page['path'])
            write_bytes(path, raw)
            self.outputs[page['path']] = page['sha256']
            self.stats['atlas_pages'] += 1
            if (index+1) % 32 == 0:
                print(f'战斗图集 {index+1}/{len(data["pages"])}', flush=True)

    def build(self):
        import PIL
        from incremental import build_lock, local_modules, write_json
        from PIL import Image
        # Some frozen source sheets exceed Pillow's heuristic area limit. Their
        # dimensions and exact PNG digests are supplied by the fixed manifest.
        previous_limit = Image.MAX_IMAGE_PIXELS
        Image.MAX_IMAGE_PIXELS = None
        self.cache.mkdir(parents=True, exist_ok=True)
        self.state = json.loads(self.state_path.read_text('utf-8')) if self.state_path.is_file() else {}
        modules = local_modules(Path(__file__), self.runtime)
        encoders = {name: self.run([tool, '-version']).decode('utf-8', 'replace').splitlines()[0]
                    for name, tool in [('ffmpeg', self.ffmpeg), ('ffprobe', self.ffprobe)] if tool} if not self.images_only else {}
        self.recipe_version = digest(json.dumps([PIL.__version__, encoders,
            {str(p.relative_to(self.runtime)): checksum(p) for p in sorted(modules)}], sort_keys=True).encode())
        report = dict(schema='seventh-seal-media-build', version=1, scope='images' if self.images_only else 'game',
                      started_utc=datetime.now(timezone.utc).isoformat(), passed=False,
                      missing_original_files=sorted(self.missing), source_variants=self.variants, definitions_unchanged=False)
        directory = self.runtime / 'evidence/builds' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-media-'+uuid4().hex[:8])
        with build_lock(self.cache):
            try:
                selected = self.selected()
                # Group by original input to reuse source parsing and sparse
                # frame decoding across the different frozen presentation banks.
                selected.sort(key=lambda name: (self.plan.recipes[name].get('source', ''), name))
                for index, name in enumerate(selected):
                    self.build_one(name)
                    if (index+1) % 1024 == 0:
                        write_json(self.state_path, self.state, compact=True)
                        print(f'素材 {index+1}/{len(selected)} {self.stats}', flush=True)
                self.battle_pages()
                for name, expected in self.source_hashes.items():
                    if checksum(self.source(name)) != expected:
                        raise ValueError('构建期间原版文件发生变化：' + name)
                for name, expected in self.plan.definition_hashes.items():
                    if checksum(self.web / name) != expected:
                        raise ValueError('构建期间游戏定义发生变化：' + name)
                report.update(passed=True, definitions_unchanged=True, counts=self.stats,
                              files=len(self.outputs), missing_assets=sorted(name for name in self.selected() if name not in self.outputs),
                              report=str(directory / 'run.json'))
                manifest = dict(schema='seventh-seal-media-manifest', version=1, recipe=self.recipe_version,
                                scope=report['scope'], definitions=self.plan.definition_hashes,
                                sources=self.source_hashes, files=self.outputs,
                                source_variants=self.variants,
                                missing=report['missing_assets'], complete=not self.images_only and not report['missing_assets'])
                write_json(self.web / 'assets/media_manifest.json', manifest, compact=True)
                return report
            except BaseException as error:
                report['error'] = str(error)
                raise
            finally:
                write_json(self.state_path, self.state, compact=True)
                report['finished_utc'] = datetime.now(timezone.utc).isoformat()
                write_json(directory / 'run.json', report)
                for cached in (self.dgp, self.frame, self.menu_offsets, self.pak, self.atlas_image, self.resource_signature):
                    cached.cache_clear()
                Image.MAX_IMAGE_PIXELS = previous_limit


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original-dir', type=Path, required=True, help='原版安装目录；只读')
    parser.add_argument('--target', nargs='+', default=['media'], choices=['media', 'game'])
    parser.add_argument('--run', action='store_true', help='执行素材构建；默认只检查并列计划')
    parser.add_argument('--force', action='store_true', help='重新提取素材；保留固定规则与调参')
    parser.add_argument('--images-only', action='store_true', help='仅检查／构建图片和现有战斗图集，不计完整首次构建')
    parser.add_argument('--serve', action='store_true', help='完整素材构建成功后启动正式游戏服务')
    parser.add_argument('--port', type=int, default=8767)
    parser.add_argument('--save-dir', type=Path, help='独立存档目录，默认使用正式玩家目录')
    args = parser.parse_args(argv)
    if args.serve and (not args.run or args.images_only):
        parser.error('--serve 需要 --run，且不能与 --images-only 同用')
    try:
        builder = MediaBuilder(RUNTIME, args.original_dir, force=args.force, images_only=args.images_only)
        problems = builder.preflight()
        print(json.dumps(dict(assets=len(builder.selected()), original_files=len(builder.source_hashes),
                              missing_original_files=builder.missing, problems=problems), ensure_ascii=False, indent=2), flush=True)
        if problems:
            return 1
        if args.run:
            report = builder.build()
            print(json.dumps({key: report[key] for key in ('passed','scope','files','counts','definitions_unchanged','report')}, ensure_ascii=False, indent=2), flush=True)
            del builder
            if not args.images_only:
                from incremental import write_json
                validation = Path(report['report']).with_name('validation.json')
                checked = subprocess.run([shutil.which('node'), str(RUNTIME / 'tools/verify_phaser.mjs'),
                                          '--assets', '--report', str(validation)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                validation.with_suffix('.log').write_bytes(checked.stdout)
                report['runtime_validation'] = dict(passed=checked.returncode == 0, report=str(validation))
                report['passed'] = report['passed'] and checked.returncode == 0
                write_json(Path(report['report']), report)
                if checked.returncode:
                    print(checked.stdout.decode('utf-8', 'replace'), file=sys.stderr)
                    return checked.returncode
                print('正式运行代码与完整媒体检查通过：'+str(validation), flush=True)
            if args.serve:
                command = [sys.executable, '-B', str(RUNTIME / 'serve.py'), '--port', str(args.port)]
                if args.save_dir:
                    command += ['--save-dir', str(args.save_dir)]
                os.execv(sys.executable, command)
        return 0
    except (ValueError, OSError, ImportError, RuntimeError) as error:
        print('素材构建失败：' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
