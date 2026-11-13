"""Build runtime texture pages directly from verified decoded pixels.

Logical PNG names are identifiers, not required intermediate files. Group caches
bind source recipes and every page hash; a damaged group is rebuilt in isolation.
"""
from collections import defaultdict
import hashlib
import io
import json
from pathlib import PurePosixPath

from incremental import write_bytes, write_json

PAGE = 2048
PADDING = 2


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def independent(row):
    # Font masks and CPU-readable sensor planes keep their dedicated formats.
    return row['kind'] in ('builtin', 'plane') or row.get('channel') in ('mask', 'alpha')


def group_for(name, row):
    parent = PurePosixPath(name).parent.as_posix()
    return parent


def references_images(value):
    if isinstance(value, str):
        return value.lstrip('/').startswith('assets/') and value.lower().endswith('.png')
    if isinstance(value, dict):
        return any(references_images(child) for child in value.values())
    if isinstance(value, list):
        return any(references_images(child) for child in value)
    return False


def publish_runtime_indexes(builder, catalog):
    def publish(path, value):
        target = builder.local(path)
        write_json(target, value, compact=True)
        builder.outputs[path] = sha(target.read_bytes())

    def definition(value):
        raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        digest = sha(raw)
        path = f'/assets/battle_definitions/{digest}.json'
        write_bytes(builder.local(path), raw)
        builder.outputs[path] = digest
        return dict(path=path, sha256=digest)

    documents = builder.plan.documents
    hashes = builder.plan.definition_hashes
    startup = documents['data/startup_menu.json']
    names = {'/' + frame['path'].lstrip('/')
             for asset in startup['assets'].values() for frame in asset['frames']}
    loading = documents['data/prologue_presentation.json']['loading']
    names.update(row['image'] for row in loading['backgrounds'])
    names.update((loading['frame'], loading['fill']))
    images = {name: catalog['images'][name] for name in sorted(names) if name in catalog['images']}
    used = {region[4] for image in images.values() for region in image['regions']}
    # Keep the full index's page numbers so startup images can stay alive.
    pages = [page if i in used else None for i, page in enumerate(catalog['pages']) if i <= max(used, default=-1)]
    publish('/assets/startup_image_catalog.json', dict(
        schema=catalog['schema'], version=1, pages=pages, images=images,
        manifests={f'/data/{name}': hashes[f'data/{name}']
                   for name in ('startup_menu.json', 'prologue_presentation.json')}))

    packs = documents['data/battle_packs.json']
    manifests = {path: {'sha256': row['sha256']} for path, row in packs['manifests'].items()}
    for path, row in manifests.items():
        if hashes.get(path.lstrip('/')) != row['sha256']:
            raise ValueError('战斗图集定义已变化：' + path)
    party = documents['data/party_battle_view.json']
    lifecycle = documents['data/battle_lifecycle.json']
    lifecycle_roles = {row['id']: row for row in lifecycle['roles']}
    banks = {row['path']: documents[row['path'].lstrip('/')]['role_id']
             for row in party.get('extra_layer_banks', [])}
    shared = definition(dict(
        party={key: value for key, value in party.items() if key != 'roles'},
        lifecycle={key: value for key, value in lifecycle.items() if key != 'roles'},
        layer_role=documents[party['layers']['path'].lstrip('/')]['role_id'],
        bank_owners=banks))
    roles = {row['id']: definition(dict(party=row, lifecycle=lifecycle_roles[row['id']]))
             for row in party['roles']}
    publish('/assets/battle_index.json', dict(
        schema=packs['schema'], version=2, pages=packs['pages'], images=packs['images'],
        manifests=manifests, definitions=dict(shared=shared, roles=roles)))


def build_image_catalog(builder):
    from PIL import Image
    battle = builder.plan.documents['data/battle_packs.json']
    pages = list(battle['pages'])
    images = dict(battle['images'])
    cache_path = builder.cache / 'image_groups.json'
    previous = json.loads(cache_path.read_text('utf-8')) if cache_path.is_file() else {}
    groups = defaultdict(list)
    for name in builder.selected():
        row = builder.plan.recipes[name]
        if name.endswith('.png') and name not in images and not independent(row):
            groups[group_for(name, row)].append(name)
    state = {}
    for number, (group, names) in enumerate(sorted(groups.items())):
        signature = sha(json.dumps([PAGE, PADDING,
            [(name, builder.resource_signature(name)) for name in names]], sort_keys=True).encode())
        old = previous.get(group)
        reused = bool(old and old['signature'] == signature and not builder.force)
        if reused:
            for page in old['pages']:
                path = builder.local(page['path'])
                if not path.is_file() or sha(path.read_bytes()) != page['sha256']:
                    reused = False
                    break
        if reused:
            group_pages, group_images = old['pages'], old['images']
            builder.stats['reused'] += len(names)
        else:
            group_pages, group_images = [], {}
            atlas = Image.new('RGBA', (PAGE, PAGE))
            x = y = PADDING
            shelf = used_x = used_y = 0
            bank = {}
            page_tiles = []

            def flush():
                nonlocal atlas, x, y, shelf, used_x, used_y
                if not used_x:
                    return
                cropped = atlas.crop((0, 0, used_x, used_y))
                stream = io.BytesIO()
                cropped.save(stream, format='PNG', compress_level=6)
                raw = stream.getvalue()
                with Image.open(io.BytesIO(raw)) as decoded:
                    decoded = decoded.convert('RGBA')
                    for key, px, py, w, h in page_tiles:
                        tile = decoded.crop((px, py, px+w, py+h))
                        if sha(w.to_bytes(4, 'little') + h.to_bytes(4, 'little') + tile.tobytes()) != key:
                            raise ValueError('图片图集像素恢复不一致：' + group)
                page_tiles.clear()
                checksum = sha(raw)
                path = '/assets/image_packs/' + checksum[:24] + '.png'
                write_bytes(builder.local(path), raw)
                group_pages.append(dict(path=path, sha256=checksum, width=used_x,
                                        height=used_y, group=group, bytes=len(raw)))
                builder.stats['image_pages'] += 1
                atlas = Image.new('RGBA', (PAGE, PAGE))
                x = y = PADDING
                shelf = used_x = used_y = 0

            def place(tile):
                nonlocal x, y, shelf, used_x, used_y
                key = sha(tile.width.to_bytes(4, 'little') + tile.height.to_bytes(4, 'little') + tile.tobytes())
                if key in bank:
                    return bank[key]
                w, h = tile.size
                if x + w + PADDING > PAGE:
                    x = PADDING
                    y += shelf
                    shelf = 0
                if y + h + PADDING > PAGE:
                    flush()
                location = (len(group_pages), x, y)
                atlas.paste(tile, (x, y))
                page_tiles.append((key, x, y, w, h))
                used_x = max(used_x, x + w + PADDING)
                used_y = max(used_y, y + h + PADDING)
                x += w + 2 * PADDING
                shelf = max(shelf, h + 2 * PADDING)
                bank[key] = location
                return location

            for name in names:
                row = builder.plan.recipes[name]
                image = builder.image(name)
                width, height = image.size
                descriptor = dict(width=width, height=height, sha256=builder.logical[name], regions=[])
                group_images[name] = descriptor
                fw, fh = width, height
                if row['kind'] == 'sheet':
                    fw, fh = width // row['count'], height // row['directions']
                elif row['kind'] == 'shadow-grid':
                    fw, fh = row['rect'][2:]
                # DOM images retain complete rectangles for browser cropping and
                # scaling. Animation cells may trim alpha without moving origins.
                trim = row['kind'] in ('sheet', 'shadow-grid')
                for top in range(0, height, fh):
                    for left in range(0, width, fw):
                        cell = image.crop((left, top, min(left+fw, width), min(top+fh, height)))
                        bounds = cell.getchannel('A').getbbox() if trim else (0, 0, cell.width, cell.height)
                        if bounds is None:
                            continue
                        cell = cell.crop(bounds)
                        ox, oy = left+bounds[0], top+bounds[1]
                        for ty in range(0, cell.height, PAGE-2*PADDING):
                            for tx in range(0, cell.width, PAGE-2*PADDING):
                                tile = cell.crop((tx, ty, min(tx+PAGE-2*PADDING, cell.width), min(ty+PAGE-2*PADDING, cell.height)))
                                page, px, py = place(tile)
                                descriptor['regions'].append([ox+tx, oy+ty, tile.width, tile.height, page, px, py])
            flush()
        state[group] = dict(signature=signature, pages=group_pages, images=group_images)
        offset = len(pages)
        pages.extend(group_pages)
        for name, image in group_images.items():
            images[name] = dict(image, regions=[[x,y,w,h,p+offset,px,py] for x,y,w,h,p,px,py in image['regions']])
        for page in group_pages:
            builder.outputs[page['path']] = page['sha256']
        if (number+1) % 100 == 0:
            write_json(cache_path, state, compact=True)
            print(f'图片分组 {number+1}/{len(groups)}', flush=True)
    write_json(cache_path, state, compact=True)
    # Identical pages may serve several independently built groups. Intern their
    # physical identities so the runtime decodes/uploads the shared page once.
    unique, indices, remap = [], {}, {}
    for index, page in enumerate(pages):
        key = (page['path'], page['sha256'], page['width'], page['height'])
        if key not in indices:
            indices[key] = len(unique)
            unique.append(page)
        remap[index] = indices[key]
    images = {name: dict(image, regions=[[x,y,w,h,remap[p],px,py] for x,y,w,h,p,px,py in image['regions']])
              for name, image in images.items()}
    definitions = getattr(builder.plan, 'definition_hashes', {})
    manifests = {'/'+name: definitions[name] for name, value in builder.plan.documents.items()
                 if name in definitions and name != 'data/battle_packs.json' and references_images(value)}
    catalog = dict(schema='seventh-seal-image-catalog', version=1, pages=unique, images=images, manifests=manifests)
    target = '/assets/image_catalog.json'
    write_json(builder.local(target), catalog, compact=True)
    builder.outputs[target] = sha(builder.local(target).read_bytes())
    return catalog
