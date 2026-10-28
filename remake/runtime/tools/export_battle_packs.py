"""Lossless, source-checked cropped battle atlases. Existing exports stay untouched."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from collections import defaultdict
import argparse
import hashlib
import json
import subprocess

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
OUT = WEB / 'assets/battle_packs'
REPORT = RUNTIME / 'evidence/battle_loading_20261021/pack_export.json'
PAGE = 2048


def sha(data):
    return hashlib.sha256(data).hexdigest()


def local(url):
    return WEB / url.lstrip('/')


def inventory(arguments=()):
    result = subprocess.run(['node', str(RUNTIME / 'tools/battle_pack_inventory.mjs'), *arguments],
                            cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
    if result.returncode:
        raise RuntimeError('Battle pack inventory failed:\n'+result.stdout+result.stderr)
    return json.loads(result.stdout)


def packing_family(asset):
    return 'effects' if asset['group'].startswith('effect-') else asset['group']


def dependency_groups(families):
    """Share identical effect pixels first, then pack equal user sets together."""
    groups = defaultdict(dict)
    for family, tiles in families.items():
        for key, tile in tiles.items():
            name = family
            if family == 'effects':
                users = sorted(tile['owners'])
                name = 'effects-roles-' + '-'.join(users) if users else 'effects-unreferenced'
            groups[name][key] = tile
    return groups


def layout_pages(tiles):
    """Use the same shelf placement for real pixels and retained-region plans."""
    pending = sorted(tiles, key=lambda tile: (-tile['height'], -tile['width']))
    while pending:
        placed, remaining = [], []
        x = y = 1
        shelf = used_x = used_y = 0
        for tile in pending:
            width, height = tile['width'], tile['height']
            if width + 2 > PAGE or height + 2 > PAGE:
                raise ValueError('Battle frame exceeds atlas page dimensions')
            if x + width + 1 > PAGE:
                x = 1
                y += shelf
                shelf = 0
            if y + height + 1 > PAGE:
                remaining.append(tile)
                continue
            placed.append((tile, x, y))
            used_x = max(used_x, x + width + 1)
            used_y = max(used_y, y + height + 1)
            x += width + 2
            shelf = max(shelf, height + 2)
        if not placed:
            raise ValueError('No battle frame fits atlas page')
        yield placed, used_x, used_y
        pending = remaining


def plan(roles=None, stage=None):
    """Read existing atlas geometry; do not generate PNGs or claim pixel QA."""
    arguments = ['--plan']
    if roles:
        arguments.extend(['--roles', roles, '--stage', stage])
    data = inventory(arguments)
    source_path = WEB / 'data/battle_packs.json'
    retained = json.loads(source_path.read_text(encoding='utf-8'))
    groups = defaultdict(dict)
    for asset in data['assets']:
        image = retained['images'].get(asset['path'])
        if not image or any(image[key] != asset[key] for key in ('sha256', 'width', 'height')):
            raise ValueError('Retained atlas differs from source descriptor: '+asset['path'])
        for _, _, width, height, page, x, y in image['regions']:
            # Old groups already deduplicated identical visible RGBA tiles.
            # Shared coordinates remain one tile within each new dependency group.
            key = (page, x, y, width, height)
            tile = groups[packing_family(asset)].setdefault(key, dict(width=width, height=height, paths=set(), owners=set()))
            tile['paths'].add(asset['path'])
            tile['owners'].update(asset.get('owners', []))
    groups = dependency_groups(groups)
    pages, image_pages = [], defaultdict(set)
    group_reports = {}
    for name, tiles in sorted(groups.items()):
        group_pages = []
        for placed, width, height in layout_pages(tiles.values()):
            index = len(pages)
            pages.append(dict(width=width, height=height))
            group_pages.append(index)
            for tile, _, _ in placed:
                for path in tile['paths']:
                    image_pages[path].add(index)
        group_reports[name] = dict(pages=len(group_pages), rgba_bytes=sum(
            pages[index]['width'] * pages[index]['height'] * 4 for index in group_pages))
    def footprint(indices, bank):
        return dict(pages=len(indices), rgba_bytes=sum(bank[index]['width'] * bank[index]['height'] * 4 for index in indices))
    report = dict(schema='seventh-seal-battle-pack-plan', version=1,
                  retained_manifest_sha256=sha(source_path.read_bytes()), images=len(data['assets']),
                  retained=footprint(set(range(len(retained['pages']))), retained['pages']),
                  planned=footprint(set(range(len(pages))), pages), groups=group_reports,
                  media_decoded=False, pngs_generated=False,
                  limits=['Geometry estimate from retained cropped regions; rebuild with source PNGs and verify pixels before delivery.',
                          'Coordinate-based deduplication can conservatively overestimate new groups when equal pixels lived on different old pages.'])
    if selection := data.get('selection'):
        def existing(paths):
            return {region[4] for path in paths for region in retained['images'][path]['regions']}
        report['battle'] = dict(role_ids=selection['role_ids'], stage_id=selection['stage_id'],
                               selected_images=len(selection['paths']),
                               before=footprint(existing(selection['legacy_paths']), retained['pages']),
                               filtered_existing_atlas=footprint(existing(selection['paths']), retained['pages']),
                               planned=footprint({index for path in selection['paths'] for index in image_pages[path]}, pages))
    return report


def build(repack=False):
    from incremental_atlas import build_atlas
    from incremental import write_json
    data = inventory()
    manifest, sources, output_hashes, counters = build_atlas(data, runtime=RUNTIME, web=WEB, out=OUT,
        layout_pages=layout_pages, packing_family=packing_family, dependency_groups=dependency_groups, repack=repack)
    for name, entry in data['manifests'].items():
        path = local(name)
        if sha(path.read_bytes()) != entry['sha256']:
            raise ValueError('Manifest changed during atlas export: '+name)
        sources[path.relative_to(ROOT).as_posix()] = entry['sha256']
    pages, images = manifest['pages'], manifest['images']
    unique_tiles = len({(region[4],region[5],region[6],region[2],region[3])
                        for image in images.values() for region in image['regions']})
    report = dict(schema='seventh-seal-battle-pack-export', version=1, source_unchanged=True,
        source_hashes=sources, output_hashes=output_hashes, images=len(images), pages=len(pages),
        unique_tiles=unique_tiles, source_rgba_bytes=sum(a['width']*a['height']*4 for a in data['assets']),
        atlas_rgba_bytes=sum(p['width']*p['height']*4 for p in pages),
        png_bytes=sum(p['bytes'] for p in pages), pixel_reconstruction_passed=True,
        **counters, policy='Append verified new tiles; freeze existing pages and coordinates. Explicit --repack compacts the library.')
    write_json(REPORT, report)
    print(json.dumps({k: report[k] for k in ['images','pages','unique_tiles','pixel_reconstruction_passed',*counters]}), flush=True)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repack', action='store_true', help='Explicitly repack all pages instead of appending new tiles')
    parser.add_argument('--plan', action='store_true', help='只用已有清单估算依赖分组，不读媒体或生成图集')
    parser.add_argument('--roles', help='计划中本场角色资源编号，以逗号分隔')
    parser.add_argument('--stage', help='计划中本场舞台编号；与 --roles 同时提供')
    parser.add_argument('--report', type=Path, help='将计划写入 evidence 下的新 JSON 文件')
    args = parser.parse_args()
    if args.repack and args.plan:
        parser.error('--repack cannot be combined with --plan')
    if bool(args.roles) != bool(args.stage) or (args.roles or args.stage or args.report) and not args.plan:
        parser.error('--roles / --stage 必须配对，且仅在 --plan 时使用；--report 也仅用于计划')
    if args.plan:
        report = plan(args.roles, args.stage)
        if args.report:
            target = args.report.resolve()
            if not target.is_relative_to((RUNTIME / 'evidence').resolve()) or target.suffix != '.json' or target.exists():
                parser.error('--report 必须是 evidence 下尚不存在的 JSON 文件')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        build(repack=args.repack)
