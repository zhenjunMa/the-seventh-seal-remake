"""从只读原版状态 DGP 导出战斗状态动画，独立核对全部可见像素。"""
from pathlib import Path
import argparse
import io
import json

from PIL import Image
from data_recipes import atomic_write
from media_definitions import OriginalFiles, checksum
from source.dgp import DGP, u32
from export_combat_presentation import indexed_contribution
from export_skill_layers import SourceAudit

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]


def export(original_dir, runtime=RUNTIME):
    runtime = Path(runtime)
    original = OriginalFiles(original_dir)
    status = json.loads((runtime / 'web/data/forest_status.json').read_text('utf-8'))
    if checksum(original.path('GAME.exe')) != status['source_hashes']['GAME.exe']:
        raise ValueError('原版程序与已核实的状态规则不一致')
    effects, checks, sources = {}, [], {}
    for ident, timing in sorted(status['effects'].items(), key=lambda row: int(row[0])):
        source = timing['source']
        if source.get('source_exists') is False:
            try:
                original.path(source['path'])
            except FileNotFoundError:
                effects[ident] = dict(id_raw=int(ident), frame_count=0, source=source)
                continue
            raise ValueError('原版缺失状态资源发生变化：' + source['path'])
        path = original.path(source['path'])
        if checksum(path) != source['sha256']:
            raise ValueError('状态来源指纹不符：' + source['path'])
        dgp = DGP(path)
        action = dgp.actions[0]
        if len(dgp.actions) != 1 or action['directions'] != 1 or action['frames_per_direction'] != timing['frame_count'] or dgp.raw_actions[0].hex() != source['action_raw_hex']:
            raise ValueError('状态动画与结算时钟不一致：' + ident)
        audit = SourceAudit(dgp.data)
        first, count = action['first_frame'], timing['frame_count']
        descriptor = dict(id_raw=int(ident), source=source['path'], source_sha256=dgp.sha256,
            frame_width=dgp.width, frame_height=dgp.height, frame_count=count, first_frame=first,
            interval_ms=timing['interval_ms'], anchor=dict(x=dgp.anchor_raw[0], y=dgp.anchor_raw[1]),
            above_head=u32(dgp.raw_actions[0], 9) == 0, native_raw_hex=dgp.raw_actions[0].hex())
        for layer in ['main', *(['intrinsic'] if dgp.indexed_auxiliary else [])]:
            image = Image.new('RGBA', (dgp.width * count, dgp.height))
            for frame in range(count):
                physical = first + frame
                if physical >= dgp.frame_count:
                    # 049 declares16 animation frames but stores15. Native
                    # drawing rejects the absent frame; keep its blank visit.
                    checks.append(dict(id_raw=int(ident), layer=layer, source_frame=physical, missing_source_frame=True))
                    continue
                cell = dgp.decode(physical) if layer == 'main' else indexed_contribution(dgp, physical)[0]
                audited, check = audit.sparse(physical, indexed=layer == 'intrinsic')
                if cell.tobytes() != audited:
                    raise ValueError(f'状态{ident} {layer} 帧{physical}独立像素核对失败')
                checks.append(dict(id_raw=int(ident), layer=layer, source_frame=physical, **check))
                image.paste(cell, (frame * dgp.width, 0))
            output = runtime / f'web/assets/battle_status/{int(ident):03}/{layer}.png'
            stream = io.BytesIO()
            image.save(stream, format='PNG')
            atomic_write(output, stream.getvalue())
            with Image.open(output) as stored:
                if stored.convert('RGBA').tobytes() != image.tobytes():
                    raise ValueError('状态PNG回读像素不一致')
            descriptor[layer + '_sheet'] = '/' + output.relative_to(runtime / 'web').as_posix()
            descriptor[layer + '_sha256'] = checksum(output)
        effects[ident] = descriptor
        sources[source['path']] = dgp.sha256
    value = dict(schema='seventh-seal-battle-status-view', version=1, effects=effects,
        source_hashes=sources, native_display=dict(function='0x509330', head_offset=32,
            animation_frame='native_status_slots C6+0x13', position_mode='DGP action+9: 0=head, other=body'),
        limits=['Static GAME.exe instructions and source pixel audits; original battle execution not observed.',
                'GPU additive composition adapts original RGB565 destination blending.'])
    atomic_write(runtime / 'web/data/battle_status_view.json', (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode())
    if any(checksum(original.path(name)) != digest for name, digest in sources.items()):
        raise ValueError('导出期间原版状态资源发生变化')
    report = dict(passed=True, effects=len(effects), animated=sum(bool(e['frame_count']) for e in effects.values()),
        missing=[int(key) for key, e in effects.items() if not e['frame_count']], source_unchanged=True,
        source_hashes=sources, frame_layer_checks=len(checks), checks=checks)
    atomic_write(runtime / 'evidence/status_visuals_20261108/export.json', (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode())
    return {key: value for key, value in report.items() if key not in ('source_hashes', 'checks')}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original-dir', default=ROOT, type=Path, help='只读原版目录；旧开发布局默认仓库根目录')
    print(json.dumps(export(parser.parse_args().original_dir), ensure_ascii=False, indent=2))
