"""Plan media extraction from reconstructed game definitions, without decoding.

Game rules and story packages are inputs to this plan, never export outputs.
The old research exporters remain available independently for developer audits.
"""
from pathlib import Path, PurePosixPath
import hashlib
import io
import json
import re

MEDIA = re.compile(r'^/?assets/.+\.(?:png|mp3|wav|ogg|mp4|webm)$', re.I)
ORIGINAL = re.compile(r'^(?!/|[A-Za-z]:)(?!.*(?:^|/)\.\.(?:/|$)).+\.(?:dgp|dat|chr|itm|anm|tlk|mnu|cap|pak|bik|wav|exe|scn|mag|stg|bmp)$', re.I)
LOADING_BACKGROUND_SOURCE = 'SYSTEM/Progress01.dgp'

# 已筛掉的入场和胜利录音。按内容排除，保留原触发点和同名替换的能力。
OMITTED_VOICES = {
    'sound/os01-01.wav': '571983496a663dc8b914e73875e7e7420cc7d9a7f7b69648e898e68724b18978',
    'sound/os01-02.wav': '1ff9b489620fbf751c2fcc95247469d24230f797451a243d8f2ddbc1a90f022e',
    'sound/os02-01.wav': 'd56a03b32eb929e67b94a4b63ad6da1ced3b740dd62dc4f5e189b42d23ade2e4',
    'sound/os03-1.wav': 'f22732487d585f63c8faf932614183e124c3a5dfeb5ea8845c616657b3967289',
    'sound/os04-1.wav': 'c1b50657551886ae0216fdf0e1fa946f3badebdedd1cbc963a8d3addde8455e2',
    'sound/os05-1.wav': '186ae0ad5e9e46222f36f35f1d82573a982cb5db22ee39139d39912259998f6f',
    'sound/os06-2.wav': 'd91fd29f79ae7e1a0a54abd8fab63773f304608fce5ebfc0b695e381aa96ed7d',
    'sound/os03-2.wav': 'e9bc85292db0a8a235b70a3b4753cff687e9f9d8ffb1deed0a9b27182dc8dd1b',
    'sound/os03-3.wav': '02ff716c1a84fc885088a1a3fa0cbc9c62a1ace9c58220bfa06524ef117f0c37',
    'sound/os04-2.wav': '58df7378fee10c6d4cc042135550de4585dc490205121ce163d60e8705d93287',
}


def checksum(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def url(value):
    return '/' + value.lstrip('/')


def original(value):
    return isinstance(value, str) and bool(ORIGINAL.fullmatch(value.replace('\\', '/')))


class OriginalFiles:
    """Resolve the shipped Windows names on case-sensitive hosts as well."""
    def __init__(self, directory):
        self.root = Path(directory).expanduser().resolve()
        if not self.root.is_dir():
            raise ValueError('原版目录不存在：' + str(self.root))
        self.files = {}
        for path in self.root.rglob('*'):
            if path.is_file():
                key = path.relative_to(self.root).as_posix().casefold()
                if key in self.files:
                    raise ValueError('原版目录存在大小写冲突：' + key)
                if not path.resolve().is_relative_to(self.root):
                    raise ValueError('原版文件链接超出安装目录：' + str(path))
                self.files[key] = path

    def path(self, name):
        if not original(name):
            raise ValueError('无效的原版资源路径：' + str(name))
        key = name.replace('\\', '/').casefold()
        path = self.files.get(key)
        # Historical definitions retain the native Map/ prefix, whereas this
        # installation also ships background DGPs at the installation root.
        if path is None and key.startswith('map/') and key.endswith('.dgp'):
            path = self.files.get(PurePosixPath(key).name)
        if path is None:
            raise FileNotFoundError('原版缺少文件：' + name)
        return path


class MediaDefinitions:
    def __init__(self, runtime, generated=None, media_documents=None, fingerprints=None):
        self.runtime = Path(runtime)
        self.web = self.runtime / 'web'
        self.documents = {}
        self.required = set()
        self.recipes = {}
        self.inputs = {}
        self.expected = {}
        self.definition_hashes = {}
        self.audio_updates = {}
        self.unavailable_audio = set()
        self.unavailable_video = set()
        self.loading_frames = {}
        ambience = 'data/map_ambience.json'
        for path in sorted((self.web / 'data').rglob('*.json')):
            relative = path.relative_to(self.web / 'data').as_posix()
            if generated is not None and (relative in generated.manifest['documents'] or 'data/' + relative == ambience):
                continue
            if 'source' in path.relative_to(self.web / 'data').parts:
                continue
            key = path.relative_to(self.web).as_posix()
            if media_documents and key in media_documents:
                continue
            self.definition_hashes[key] = checksum(path)
            self.documents[key] = json.loads(path.read_text('utf-8-sig'))
        if generated is not None:
            for name, row in generated.manifest['documents'].items():
                key = 'data/' + name
                self.definition_hashes[key] = row['sha256']
                self.documents[key] = generated.value(row['root'])
            if generated.map_ambience is not None:
                self.definition_hashes[ambience] = hashlib.sha256(generated.map_ambience).hexdigest()
                self.documents[ambience] = json.loads(generated.map_ambience)
        if media_documents:
            self.documents.update({key: json.loads(raw) for key, raw in media_documents.items()})
            for key, value in media_documents.items():
                self.definition_hashes[key] = hashlib.sha256(value).hexdigest()
        if media_documents and 'data/audio.json' in media_documents:
            self.select_audio(fingerprints)
            self.select_videos(fingerprints.original)
        if media_documents and 'data/prologue_presentation.json' in media_documents:
            self.select_loading_backgrounds(fingerprints)
        for key, data in self.documents.items():
            if key == 'data/battle_packs.json':
                continue
            if key == ambience:
                self.collect(data['clips'])
                for clip in data['clips'].values():
                    self.recipes[clip['path']] = dict(kind='copy', source=clip['source']['path'])
            else:
                self.collect(data)
                self.visit(data)
        packs = self.documents['data/battle_packs.json']
        for name, row in packs['images'].items():
            self.required.add(url(name))
            self.expected[url(name)] = row['sha256']
        self.specials()
        for path in self.audio_updates:
            self.recipes[path]['inspect_audio'] = True
        if media_documents and 'data/audio.json' in media_documents:
            # Some packed definitions keep their original sound reference for
            # provenance. Skip the output without rewriting the packed JSON.
            for path, row in self.recipes.items():
                kind = row['kind']
                if path not in self.required or kind not in ('audio', 'video'):
                    continue
                source = row['source']
                try:
                    fingerprints.original.path(source)
                except FileNotFoundError:
                    self.required.discard(path)
                    unavailable = self.unavailable_audio if kind == 'audio' else self.unavailable_video
                    unavailable.add(source)

    def select_loading_backgrounds(self, fingerprints):
        source = LOADING_BACKGROUND_SOURCE
        try:
            path = fingerprints.original.path(source)
        except FileNotFoundError:
            return  # The ordinary source preflight reports a missing archive.
        if fingerprints.file_hash(path) == fingerprints.expected.get(source.casefold()):
            return

        from source.dgp import DGP, DGPError

        loading = self.documents['data/prologue_presentation.json']['loading']
        known = {row['sha256']: row['image'] for row in loading['backgrounds']}
        try:
            graphics = DGP(path)
            for index, frame in enumerate(graphics.frames):
                if frame.size == 0:
                    continue
                image = graphics.decode(index)
                if not image.getchannel('A').getbbox():
                    continue
                with io.BytesIO() as png:
                    image.save(png, format='PNG')
                    name = known.get(hashlib.sha256(png.getvalue()).hexdigest())
                if name is None:
                    raise ValueError(f'{source} 的第 {index + 1} 张载入背景与已核对素材不一致')
                self.loading_frames.setdefault(name, index)
        except DGPError as error:
            raise ValueError(f'无法读取载入背景 {source}：{error}') from error
        if not self.loading_frames:
            raise ValueError(f'{source} 缺少可用的载入背景图')
        loading['backgrounds'] = [row for row in loading['backgrounds'] if row['image'] in self.loading_frames]

    def select_videos(self, original):
        def available(source):
            try:
                original.path(source)
            except FileNotFoundError:
                self.unavailable_video.add(source)
                return False
            return True

        startup = self.documents['data/startup_media.json']
        story = self.documents['data/story_media.json']
        startup['media'] = {key: row for key, row in startup['media'].items() if available(row['source'])}
        story['videos'] = {key: row for key, row in story['videos'].items() if available(row['source']['path'])}
        if not available('Animate/GO02.bik'):
            startup['game_over'] = False

    def select_audio(self, fingerprints):
        audio = self.documents['data/audio.json']
        story = self.documents['data/story_media.json']
        startup = self.documents['data/startup_menu.json']['audio']['clips']
        ambience = self.documents['data/map_ambience.json']
        original = fingerprints.original

        def select(name, row, target):
            try:
                path = original.path(name)
            except FileNotFoundError:
                self.unavailable_audio.add(name)
                return None
            sha = fingerprints.file_hash(path)
            if not row and OMITTED_VOICES.get(name.casefold()) == sha:
                self.unavailable_audio.add(name)
                return None
            if row and row['source']['sha256'] == sha:
                if row['source'].get('header_hex') == '':
                    with path.open('rb') as stream:
                        row['source']['header_hex'] = stream.read(16).hex()
                return row
            with path.open('rb') as stream:
                header = stream.read(16)
            mpeg = header.startswith(b'ID3') or len(header) > 1 and header[0] == 0xff and header[1] & 0xe0 == 0xe0
            target = str(PurePosixPath(target).with_suffix('.mp3' if mpeg else '.wav'))
            row = {**row, 'path': target, 'source': {**row.get('source', {}), 'path': name}}
            self.audio_updates.setdefault(target, []).append(row)
            return row

        clips = {}
        ids = {}

        def register(ident, row=None):
            name = (row['source']['path'] if row else ident)
            key = name.casefold()
            if key in ids:
                return ids[key]
            target = row['path'] if row else '/assets/audio/' + name.removeprefix('sound/')
            selected = select(name, row or {}, target)
            ids[key] = ident if selected else None
            if selected:
                clips[ident] = selected
            return ids[key]

        for ident, row in audio['clips'].items():
            register(ident, row)
        for ident, row in ambience['clips'].items():
            if ident.casefold() not in ids:
                ids[ident.casefold()] = ident
                clips[ident] = row
        self.unavailable_audio.update(ambience['missing_original_files'])
        candidates = list(audio['missing_original_files'])
        candidates.extend(row['source_path'] for row in story['missing_sounds'].values())
        # 原版测试地图的配乐也随安装目录导出。
        candidates.append('sound/Opening_song.wav')
        for ident in candidates:
            register(ident)

        def bind(ident):
            return ids.get(ident.casefold()) if ident else None

        def bind_rows(value):
            if isinstance(value, list):
                for child in value:
                    bind_rows(child)
            elif isinstance(value, dict):
                if 'clip' in value:
                    source = value.get('source')
                    token = value.get('token')
                    if isinstance(source, dict):
                        token = token or source.get('token')
                        source = source.get('path')
                    ident = value['clip'] or (('sound/' + token) if token else source)
                    value['clip'] = bind(ident)
                if 'pool' in value:
                    pool = [clip for ident in value['pool'] if (clip := bind(ident))]
                    if pool:
                        value['pool'] = pool
                    else:
                        del value['pool']
                for child in value.values():
                    bind_rows(child)

        for key in ('maps', 'battles', 'cues', 'world_map', 'frame_sounds', 'effect_sounds',
                    'object_sounds', 'native_services', 'native_sound_sources'):
            bind_rows(audio.get(key))
        for key in ('action_tokens', 'native_sound_tokens'):
            for token, ident in audio[key].items():
                audio[key][token] = bind(ident or 'sound/' + token)
        audio['clips'] = clips
        for name, row in list(story['missing_sounds'].items()):
            if bind(row['source_path']):
                del story['missing_sounds'][name]
        for name, row in list(story['sounds'].items()):
            selected = select(row['source']['path'], row, row['path'])
            if selected:
                story['sounds'][name] = selected
            else:
                del story['sounds'][name]
                story['missing_sounds'][name] = dict(
                    source_path=row['source']['path'], referenced_by=row['referenced_by'],
                    policy='declared-missing-original-sound; continue-without-substitution')
        for ident, row in list(startup.items()):
            selected = select(row['source']['path'], row, row['path'])
            if selected:
                startup[ident] = selected
            else:
                del startup[ident]
        audio['missing_original_files'] = sorted(self.unavailable_audio, key=str.casefold)

    def source(self, node, inherited=None):
        value = node.get('source')
        if isinstance(value, dict):
            value = value.get('path')
        if original(value):
            return value.replace('\\', '/')
        return inherited

    def input(self, name, digest):
        if original(name) and isinstance(digest, str) and re.fullmatch('[a-f0-9]{64}', digest):
            key = name.replace('\\', '/')
            previous = self.inputs.get(key)
            if previous and previous != digest:
                raise ValueError('固定定义中的原版指纹冲突：' + key)
            self.inputs[key] = digest

    def collect(self, value):
        if isinstance(value, str):
            if MEDIA.fullmatch(value):
                self.required.add(url(value))
        elif isinstance(value, list):
            for child in value:
                self.collect(child)
        elif isinstance(value, dict):
            for name, child in value.items():
                if original(name):
                    self.input(name, child)
            source = self.source(value)
            if source:
                raw = value.get('source')
                digest = (raw.get('sha256') if isinstance(raw, dict) else None)
                digest = digest or value.get('source_sha256') or value.get('resource_sha256')
                if not digest and not any(k in value for k in ('image', 'path', 'sheet')):
                    digest = value.get('sha256')
                self.input(source, digest)
            if original(value.get('path')) and not any(key in value for key in ('offset', 'record_offset', 'block_offset', 'fixed_offset')):
                self.input(value['path'], value.get('sha256'))
            name = value.get('path') or value.get('image') or value.get('sheet')
            if isinstance(name, str) and MEDIA.fullmatch(name):
                digest = value.get('png_sha256') or value.get('image_sha256') or value.get('sheet_sha256') or value.get('sha256')
                sensor_plane = 'source_offset' in value and 'bytes' in value and 'png_sha256' not in value
                if digest and not sensor_plane and not (value.get('sheet') and value.get('source')):
                    self.expected.setdefault(url(name), digest)
            for child in value.values():
                self.collect(child)

    def add(self, name, kind, **fields):
        if not isinstance(name, str) or not MEDIA.fullmatch(name):
            return
        key = url(name)
        if not key.endswith('.png') and kind not in ('audio', 'video', 'copy'):
            return
        row = dict(kind=kind, **fields)
        previous = self.recipes.get(key)
        if previous is not None and previous != row:
            # A frame can also occur in a frozen preview, with less complete
            # provenance. Complete native layer-bank descriptions win.
            return
        self.recipes[key] = row

    def frame(self, node, source, index):
        if isinstance(node, str):
            self.add(node, 'dgp', source=source, frame=index, channel='main')
            return
        if not isinstance(node, dict):
            return
        index = node.get('source_frame', index)
        for key, channel in [('image', 'main'), ('path', 'main'), ('indexed_image', 'intrinsic'),
                             ('mask_image', 'mask'), ('inverse_mask_image', 'inverse-mask')]:
            self.add(node.get(key), 'dgp', source=source, frame=index, channel=channel)
        for channel in ('main', 'intrinsic', 'shadow'):
            layer = node.get(channel)
            if isinstance(layer, dict):
                self.add(layer.get('path'), 'dgp', source=source, frame=index, channel=channel)

    def sheets(self, node, source):
        count = node.get('frame_count', node.get('frames_per_direction'))
        if not isinstance(count, int):
            return
        for key, channel in [('sheet', 'main'), ('main_sheet', 'main'),
                             ('intrinsic_sheet', 'intrinsic'), ('shadow_sheet', 'shadow')]:
            path = node.get(key)
            if key == 'sheet' and (source.casefold().startswith('fight_role/effect/') or '/combat_effects/' in str(path)):
                channel = 'intrinsic'
            crop = node.get('shadow_geometry') if channel == 'shadow' else None
            self.add(path, 'sheet', source=source, first=node.get('first_frame', 0),
                     count=count, directions=node.get('directions', 1), channel=channel, crop=crop)

    def menu(self, node, source):
        if not source or not source.lower().endswith('.mnu') or not node.get('images'):
            return
        images = node['images']
        if not isinstance(images[0], dict) or 'source_offset' not in images[0]:
            return
        for image in images:
            for key, channel in [('image', 'render'), ('primary_image', 'primary'),
                                 ('rgb_image', 'primary'), ('mask_image', 'mask'), ('alpha_image', 'alpha')]:
                self.add(image.get(key), 'mnu-image', source=source, offset=image['source_offset'], channel=channel)
        sensor = node.get('sensor', {})
        self.add(sensor.get('image'), 'plane', source=source, offset=sensor.get('source_offset'),
                 width=node['width'], height=node['height'], raw_sha256=sensor.get('sha256'))
        if node.get('composed'):
            overlays = []
            if node.get('id') == 'game001':
                overlays = [[widget['normal_images'][0], widget['draw_point_raw']['x'], widget['draw_point_raw']['y']]
                            for widget in node['widgets'][1:5]]
            fields = dict(base=images[0]['image'], overlays=overlays,
                          crop=[0, 0, 640, 480] if overlays else None)
            self.add(node['composed'], 'compose', **fields)
            if overlays:
                self.add('assets/menu/main.png', 'compose', **fields)

    def visit(self, node, source=None, hashes=None):
        if isinstance(node, list):
            for child in node:
                self.visit(child, source, hashes)
            return
        if not isinstance(node, dict):
            return
        hashes = node.get('source_hashes', hashes) or {}
        source = self.source(node, source)
        if node.get('role_id') and isinstance(node.get('frames'), list):
            candidates = [name for name in hashes if name.lower().endswith('.dgp')]
            role = node.get('role_id')
            matching = [name for name in candidates if name.casefold() == f'fight_role/{role}.dgp'.casefold()]
            matching = matching or [name for name in candidates if PurePosixPath(name).stem == role]
            if matching or len(candidates) == 1:
                source = (matching or candidates)[0]
        if 'frame_width' in node and 'actions' in node and not (source and source.lower().endswith('.dgp')):
            ident = node.get('id', node.get('role_id'))
            candidates = [name for name in hashes if name.casefold() == f'fight_role/{ident}.dgp'.casefold()]
            if candidates:
                source = candidates[0]
        if source and source.lower().endswith('.dgp'):
            self.sheets(node, source)
            if isinstance(node.get('actions'), list):
                for action in node['actions']:
                    self.sheets(action, source)
            for key in ('frames', 'all_frames', 'images'):
                if key == 'frames' and 'all_frames' in node:
                    continue
                if isinstance(node.get(key), list):
                    for index, frame in enumerate(node[key]):
                        physical = frame.get('source_frame', frame.get('index', index)) if isinstance(frame, dict) else index
                        self.frame(frame, source, physical)
            if isinstance(node.get('image'), str):
                self.frame(node, source, node.get('initial_frame', node.get('frame', node.get('source_frame', 0))))
        self.menu(node, source)
        if source and source.lower().endswith('.pak') and isinstance(node.get('frames'), list):
            for index, frame in enumerate(node['frames']):
                self.add(frame['path'], 'pak', source=source, frame=index)
        elif source and source.lower().endswith('.pak') and isinstance(node.get('source_frame'), int):
            self.add(node.get('image') or node.get('path'), 'pak', source=source, frame=node['source_frame'],
                     **({'transparent_color': node['transparent_color']} if 'transparent_color' in node else {}))
        if source and source.lower().endswith('.bmp'):
            self.add(node.get('image'), 'bitmap', source=source)
        if source and source.lower().endswith('.exe') and isinstance(node.get('source'), dict):
            cursor = node['source']
            if cursor.get('resource_type') == 'RT_CURSOR':
                self.add(node.get('image'), 'pe-cursor', source=source,
                         offset=cursor['offset'], bytes=cursor['bytes'],
                         payload_sha256=cursor['payload_sha256'], width=node['width'],
                         height=node['height'], hotspot=node['hotspot'])
        if source and source.lower().endswith('.wav'):
            self.add(node.get('path'), 'audio', source=source)
        if source and source.lower().endswith('.bik'):
            self.add(node.get('path') or node.get('url'), 'video', source=source,
                     encode_gain=(node.get('audio') or {}).get('encode_gain', 1))
        for key, child in node.items():
            if key not in ('metadata', 'source_hashes', 'reference_hashes'):
                self.visit(child, source, hashes)

    def specials(self):
        for key, data in self.documents.items():
            if key.startswith('data/maps/') and data.get('schema') == 'seventh-seal-runtime-map':
                bg = data['background']
                self.add(bg['image'], 'map', source=data['source']['path'],
                         backgrounds=[row['path'] for row in bg['sources']])
        menu = self.documents['data/operation_menu.json']
        back = menu['item_card_back']
        owner = next(row for row in menu['menus'] if row['source'].casefold() == back['source'].casefold())
        self.add(back['image'], 'crop', image=owner['images'][0]['image'], rect=back['source_rect_exclusive'])
        for role in menu['actor_panels'].values():
            for state in ('normal', 'selected', 'unfocused'):
                self.add(role[state], 'dgp', source=role['source'],
                         frame=role['unfocused_frame'] if state == 'unfocused' else role['source_frame'], channel='main')
        presentation = self.documents['data/prologue_presentation.json']['loading']
        for index, frame in enumerate(presentation['backgrounds']):
            self.add(frame['image'], 'dgp', source=LOADING_BACKGROUND_SOURCE,
                     frame=self.loading_frames.get(frame['image'], index), channel='main')
        # The progress MNU is intentionally represented only by its two
        # runtime images; its source geometry is fixed in the game definition.
        for index, name in enumerate((presentation['frame'], presentation['fill'])):
            self.add(name, 'mnu-index', source='SYSTEM/Progress.mnu', index=index)
        for area in self.documents['data/world_map_ui.json']['areas']:
            paths = [area['background'], *[row[state] for row in area['destinations'] for state in ('normal', 'active', 'selected')]]
            prefix = str(PurePosixPath(area['background']).parent)
            for name in paths:
                self.add(name, 'mnu-index', source=area['source'], index=int(PurePosixPath(name).stem.split('_')[-1]))
            self.add(area['sensor']['image'], 'plane', source=area['source'],
                     offset=area['sensor']['source_offset'], width=641, height=481, raw_sha256=area['sensor']['sha256'])
        for name, row in self.documents['data/audio.json']['clips'].items():
            self.add(row['path'], 'audio', source=row['source']['path'])
        startup = self.documents['data/startup_media.json']
        for row in startup['media'].values():
            self.add(row['url'], 'video', source=row['source'], encode_gain=1)
        story = self.documents['data/story_media.json']
        for row in story['videos'].values():
            self.add(row['path'], 'video', source=row['source']['path'], encode_gain=(row.get('audio') or {}).get('encode_gain', 1))
        for row in story['sounds'].values():
            self.add(row['path'], 'audio', source=row['source']['path'])
        if startup.get('game_over', True):
            self.add('/assets/video/go02.mp4', 'video', source='Animate/GO02.bik', encode_gain=1)
            self.required.add('/assets/video/go02.mp4')
        for role in self.documents['data/battle_lifecycle.json']['roles']:
            shadow = role.get('shadow')
            if shadow:
                self.add(shadow['sheet'], 'shadow-grid', source=f'Fight_Role/{role["id"]}.dgp',
                         columns=shadow['columns'], count=shadow['frames'],
                         rect=[shadow['x'], shadow['y'], shadow['frame_width'], shadow['frame_height']])
        for filename, folder in [('menu_fonts.json', 'menu'), ('dialogue_fonts.json', 'dialogue'), ('prologue_fonts.json', 'prologue')]:
            for key, row in self.documents['data/' + filename]['fonts'].items():
                self.add(row['image'], 'builtin', file=f'fonts/{folder}/{key}.png')
            windows = self.documents.get('data/' + filename.replace('.json', '_windows.json'))
            if windows:
                for key, row in windows['fonts'].items():
                    self.add(row['image'], 'builtin', file=f'fonts/windows/{folder}/{key}.png')
        for data in self.documents.values():
            if 'default_composition' not in data or 'layers' not in data:
                continue
            composition = data['default_composition']
            layers = {row['id']: row for row in data['layers']}
            ground = composition['ground']
            frame = layers[ground['layer_id']]['frames'][ground['frame']]
            source = frame['path']
            x, y, w, h = ground['source_rect']
            asset = ground.get('cropped_asset')
            if asset:
                self.add(asset['path'], 'crop', image=source, rect=[x, y, x+w, y+h])
            self.add(data['default_composite']['path'], 'stage',
                     composition=composition, layers=data['layers'],
                     legacy=data.get('schema') == 'seventh-seal-forest-stage')

    def missing_recipes(self):
        return sorted(self.required - self.recipes.keys())
