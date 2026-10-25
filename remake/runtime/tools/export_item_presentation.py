"""Export item animation ID17 and ITM recovery effects without exposing skills.

Dedicated manifests/assets only. Original resources and shared party command
manifests are read-only. Every source pixel is independently audited.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
sys.path.insert(0, str(ROOT / "remake/runtime/tools"))
from PIL import Image
from source.combat_resources import CHR, GAME_SHA256
from source.dgp import DGP
from export_party_skills import enrich_sequence, source_skill
from export_combat_presentation import indexed_contribution, native_frame_sequence, NATIVE_IDS
from export_skill_layers import SourceAudit, save_layer
from content_registration import role_ids

def sha(raw): return hashlib.sha256(raw).hexdigest()
def read(path): return json.loads(path.read_text('utf-8'))
def save(path, data):
    assert path.resolve().is_relative_to(RUNTIME)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', 'utf-8')
def token(raw, at): return raw[at:at + 20].split(b'\0')[0].decode('ascii')

def sheet_asset(path, image):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)
    with Image.open(path) as saved:
        assert saved.convert('RGBA').tobytes() == image.tobytes()
    return dict(sheet='/' + path.relative_to(WEB).as_posix(), sha256=sha(path.read_bytes()))

def source_files():
    """Watch native ordinary ID17 effects before generated admission exists.

    This is a cache/source-protection inventory, not permission to use an item.
    Export admission still requires the registered catalog's recovered effect.
    """
    itm = (ROOT / 'SYSTEM/Object.ITM').read_bytes()
    count = struct.unpack_from('<I', itm, 0x20)[0]
    assert len(itm) == 0x61c + count * 0x3bf
    tokens = set()
    for index in range(count):
        raw = itm[0x61c + index * 0x3bf:0x61c + (index + 1) * 0x3bf]
        if raw[0x24:0x26] != b'\x05\x01' or struct.unpack_from('<I', raw, 0x142)[0] != 17 or raw[0x156:0x158] != b'\x00\x01':
            continue
        filename = token(raw, 0x126)
        if filename:
            assert Path(filename).name == filename and filename.lower().endswith('.dgp')
            tokens.add(filename)
    return ('GAME.exe', 'SYSTEM/Object.ITM',
            *tuple(f'Fight_Role/{ident}.{suffix}' for ident in role_ids('player') for suffix in ('CHR', 'dgp')),
            *tuple(f'Fight_Role/Effect/{filename}' for filename in sorted(tokens)))


def item_presentations(data, itm):
    """Registered usable definitions own admission; every visual field stays ITM."""
    assert data['schema'] == 'seventh-seal-chapter-items' and data['version'] == 1
    digest = sha(itm)
    assert data['source_hashes']['SYSTEM/Object.ITM'] == digest
    items = {}
    for key, definition in data['definitions'].items():
        if not isinstance(definition.get('effect'), dict):
            continue
        assert definition.get('behavior', {}).get('status') == 'recovered', 'item behavior is not admitted'
        ident = int(key)
        at = 0x61c + (ident - 1) * 0x3bf
        raw = itm[at:at + 0x3bf]
        assert len(raw) == 0x3bf and struct.unpack_from('<I', raw)[0] == ident
        assert definition['raw_hex'] == raw.hex()
        assert definition['source']['sha256'] == digest and definition['source']['record_offset'] == at
        filename = token(raw, 0x126)
        assert filename and Path(filename).name == filename and filename.lower().endswith('.dgp')
        assert struct.unpack_from('<I', raw, 0x142)[0] == 17, 'item animation is not supported ID17'
        assert raw[0x156] == 0 and raw[0x157] == 1, 'item target scope is not supported single ally'
        items[key] = dict(id=ident, name=definition['name'], animation_skill_id_raw_142=17,
            effect_id=Path(filename).stem, effect_token_raw_126=filename,
            source=dict(path='SYSTEM/Object.ITM', sha256=digest, record_offset=at,
                        record_sha256=sha(raw), effect_field_offset=0x126, effect_field_bytes=20))
    return items


def export_item_effect(filename, checks, generated, preview_cells):
    p = ROOT / f'Fight_Role/Effect/{filename}'
    d = DGP(p)
    audit = SourceAudit(d.data)
    assert len(d.actions) == 1 and d.actions[0]['directions'] == 1
    assert (audit.width, audit.height, audit.count, audit.anchor) == (d.width, d.height, d.frame_count, d.anchor_raw)
    # These effects contain only the indexed additive layer. A newly admitted
    # main/shadow effect requires its native rendering path, never silent loss.
    assert sum(n for f in range(d.frame_count) for _, spans in d.rows(f) for _, n, _ in spans) == 0
    assert sum(n for f in range(d.frame_count) for _, spans in d.shadow_rows(f) for _, n in spans) == 0
    action = d.actions[0]
    assert d.frame_count > 0 and action['frames_per_direction'] == d.frame_count and action['interval_raw'] > 0
    sheet = Image.new('RGBA', (d.width * d.frame_count, d.height))
    for f in range(d.frame_count):
        intrinsic = indexed_contribution(d, f)[0]
        rgba, check = audit.sparse(f, True)
        assert intrinsic.tobytes() == rgba
        sheet.paste(intrinsic, (f * d.width, 0))
        checks.append(dict(effect_id=p.stem, source_frame=f, intrinsic=check))
        if f in [0, d.frame_count // 2, d.frame_count - 1]:
            preview_cells.append((f'{p.stem}: frame{f}', intrinsic))
    out = WEB / f'assets/item_presentation/effects/{p.stem}/action_00.png'
    generated.append(out)
    return dict(id=p.stem, source=p.relative_to(ROOT).as_posix(), source_sha256=d.sha256,
        frame_width=d.width, frame_height=d.height, anchor=dict(x=d.anchor_raw[0], y=d.anchor_raw[1]),
        **sheet_asset(out, sheet), frames=native_frame_sequence(d.raw_actions[0], 0, d.frame_count, 0),
        frame_count=d.frame_count, native_raw_hex=d.raw_actions[0].hex(), interval_raw=action['interval_raw'],
        sound_token_raw_56=token(d.raw_actions[0], 0x56), blend='lighter',
        evidence=[NATIVE_IDS['indexed_draw'], NATIVE_IDS['effect_action']])


def main():
    items = item_presentations(read(WEB / 'data/items.json'), (ROOT / 'SYSTEM/Object.ITM').read_bytes())
    effect_tokens = {item['effect_token_raw_126'] for item in items.values()}
    original_paths = ['GAME.exe', 'SYSTEM/Object.ITM', *[f'Fight_Role/{ident}.{suffix}' for ident in role_ids('player') for suffix in ('CHR','dgp')],
                      *[f'Fight_Role/Effect/{filename}' for filename in sorted(effect_tokens)]]
    before = {p: sha((ROOT / p).read_bytes()) for p in original_paths}
    assert before['GAME.exe'] == GAME_SHA256
    shared = [WEB / f'data/{name}.json' for name in ['party_skills', 'party_battle_view', *[f'party_role_layers_{ident}' for ident in role_ids('player')]]]
    protected = {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in shared}
    native_path = RUNTIME / 'evidence/chapter_items_native.json'
    records = read(native_path)['records']
    proof = {r['parameters'].get('procedure'): r for r in records if r['operation'] == 'procedure_pseudo_code'}
    evidence = {name: dict(procedure=procedure, evidence_id=proof[procedure]['evidence_id'],
                          bundle=native_path.relative_to(ROOT).as_posix())
                for name, procedure in [('native_item_animation', '0x50e808'),
                                        ('native_recovery_effect', '0x41b3e9'),
                                        ('native_animation_selection', '0x50e3a0')]}
    roles, checks, generated = [], [], []
    preview_cells = []
    for ident in role_ids('player'):
        c = CHR(ROOT / f'Fight_Role/{ident}.CHR')
        d = DGP(ROOT / f'Fight_Role/{ident}.dgp')
        matches = [s for s in c.skills if s['id_raw'] == 17]
        assert len(matches) == 1 and c.parsed_end == len(c.data)
        skill = matches[0]
        index = skill['index']
        sequence = enrich_sequence(c, d, index)
        sequence['presentation_only'] = True
        assert len(sequence['segments']) == 1
        segment = sequence['segments'][0]
        action_index = segment['action_index']
        assert segment['event'] and segment['start'] <= segment['event']['frame'] < segment['end_exclusive']
        assert segment['frames'] and segment['interval_raw'] > 0
        assert segment['movement_step_raw'] == 0 and not segment['effects']
        source = source_skill(c, skill)
        plan = dict(kind='single', skill_indices=[index], records=[dict(raw_hex=a['raw_hex'],
            source=source['source'], source_skill_index=index, source_action_index=a['index'],
            source_offset=a['offset'], source_raw_hex=a['raw_hex']) for a in source['actions']])
        audit = SourceAudit(d.data)
        assert (audit.width, audit.height, audit.count, audit.anchor) == (d.width, d.height, d.frame_count, d.anchor_raw)
        action = d.actions[action_index]
        assert action['directions'] == 1
        sheet = Image.new('RGBA', (d.width * action['frames_per_direction'], d.height))
        bank_frames = []
        for f in range(action['frames_per_direction']):
            physical = action['first_frame'] + f
            main = d.decode(physical)
            intrinsic = indexed_contribution(d, physical)[0]
            main_rgba, main_check = audit.sparse(physical, False)
            intrinsic_rgba, intrinsic_check = audit.sparse(physical, True)
            prefix = WEB / f'assets/item_presentation/roles/{ident}/frame_{physical:04}'
            prefix.parent.mkdir(parents=True, exist_ok=True)
            main_path, intrinsic_path = Path(str(prefix) + '_main.png'), Path(str(prefix) + '_intrinsic.png')
            main_asset = save_layer(main, main_path, main_rgba, main_check)
            intrinsic_asset = save_layer(intrinsic, intrinsic_path, intrinsic_rgba, intrinsic_check)
            intrinsic_asset['active'] = bool(d.indexed_auxiliary[physical]['active_raw'])
            bank_frames.append(dict(source_frame=physical, main=main_asset, intrinsic=intrinsic_asset))
            generated += [main_path, intrinsic_path]
            checks.append(dict(role_id=ident, action_frame=f, source_frame=physical,
                               main=main_check, intrinsic=intrinsic_check))
            sheet.paste(main, (f * d.width, 0))
            if f in [0, action['frames_per_direction']//2, action['frames_per_direction']-1]: preview_cells.append((f'{ident}: action{action_index} frame{f}', main))
        action_path = WEB / f'assets/item_presentation/roles/{ident}/action_{action_index:02}.png'
        action_asset = dict(index=action_index, **sheet_asset(action_path, sheet),
                           frame_count=action['frames_per_direction'], directions=1,
                           first_frame=action['first_frame'], native_raw_hex=d.raw_actions[action_index].hex())
        generated.append(action_path)
        bank_path = WEB / f'data/item_role_layers_{ident}.json'
        save(bank_path, dict(schema='seventh-seal-native-layer-bank', version=1,
            role_id=ident, frame_width=d.width, frame_height=d.height,
            anchor=dict(x=d.anchor_raw[0], y=d.anchor_raw[1]), frames=bank_frames,
            source_hashes={p: h for p, h in before.items() if p in ['GAME.exe', f'Fight_Role/{ident}.CHR', f'Fight_Role/{ident}.dgp']},
            evidence=[NATIVE_IDS['range'], NATIVE_IDS['indexed_draw'], NATIVE_IDS['pixel_format']]))
        generated.append(bank_path)
        roles.append(dict(id=ident, name=c.name, animation_skill_id_raw=17,
            chr_skill_index=index, frame_width=d.width, frame_height=d.height,
            anchor=dict(x=d.anchor_raw[0], y=d.anchor_raw[1]), direction=0, mirror=False,
            actions=[action_asset], sequence=sequence, source_plan=plan,
            layer_bank=dict(path='/' + bank_path.relative_to(WEB).as_posix(), sha256=sha(bank_path.read_bytes())),
            sound_token_raw_56=token(d.raw_actions[action_index], 0x56),
            source=dict(chr_path=c.path.relative_to(ROOT).as_posix(), chr_sha256=c.sha256,
                        dgp_path=d.path.relative_to(ROOT).as_posix(), dgp_sha256=d.sha256)))
    for item in items.values():
        item['settlement'] = dict(source_field='0x49', frame_source='acting role CHR sequence', effect_slot='target',
            only_after_accepted_target=True, effect_even_without_native_success=True,
            consume_only_on_native_success=True, evidence=evidence['native_recovery_effect'])
    effects = [export_item_effect(filename, checks, generated, preview_cells) for filename in sorted(effect_tokens)]
    output = WEB / 'data/item_presentation.json'
    save(output, dict(schema='seventh-seal-item-presentation', version=1, roles=roles, items=items, effects=effects,
        source_hashes=before, evidence=evidence,
        native_bundle=dict(path=native_path.relative_to(ROOT).as_posix(), sha256=sha(native_path.read_bytes())),
        integration=dict(sequence='Merge role action23 descriptors into an isolated BattleView metadata copy; compile role.source_plan with compileNativeSequence and the item layer bank.',
            registration='Presentation-only ID17 is not a player command and must not enter party_skills or learned/default skill selection.',
            contact='At source logical frame17, commit controller item restoration once and start the item effect on the accepted target.',
            effect='Effect descriptor matches BattleView effects; its sheet is the independently audited indexed additive layer.',
            timing='CHR/DGP intervals are retained source fields (actor100, effect80); original runtime clocks were not observed. Use an explicitly labelled preview clock if the current adapter has one global frame_ms.'),
        original_game_execution_observed=False,
        limitations=['Static source pixels and frame/event fields; original game was not executed.',
                     'Exact original live-menu, wall-clock and audio scheduling are not claimed.',
                     'No world HP/MP or inventory operation is owned by this manifest.']))
    generated.append(output)
    # Compact visual audit on a dark background; source frames are unchanged.
    from PIL import ImageDraw
    preview = Image.new('RGB', (720, 240 * max(1, (len(preview_cells) + 2) // 3)), '#10131b')
    drawing = ImageDraw.Draw(preview)
    for index, (label, rgba) in enumerate(preview_cells):
        col, row = index % 3, index // 3
        tile = rgba.copy()
        tile.thumbnail((225, 211))
        preview.paste(tile, (col * 240 + (240 - tile.width) // 2, row * 240 + 23), tile)
        drawing.text((col * 240 + 8, row * 240 + 6), label, fill='white')
    preview_path = RUNTIME / 'evidence/item_presentation_preview.png'
    preview.save(preview_path)
    assert before == {p: sha((ROOT / p).read_bytes()) for p in original_paths}
    assert protected == {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in shared}
    report_path = RUNTIME / 'evidence/item_presentation_export.json'
    save(report_path, dict(schema='seventh-seal-item-presentation-export', version=1, passed=True,
        original_sources_unchanged=True, shared_party_manifests_unchanged=True,
        source_hashes=before, protected_manifests=protected, native_evidence=evidence,
        output_hashes={p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in generated},
        roles={r['id']:dict(chr_skill_index=r['chr_skill_index'], action_index=23, source_frames=18,
                            event_logical_frame=17, interval_raw=100) for r in roles},
        effect_ids=[e['id'] for e in effects], independent_source_pixel_checks=len(checks),
        frames=checks, original_game_execution_observed=False))
    print(json.dumps(dict(passed=True, roles=[r['id'] for r in roles], effects=[e['id'] for e in effects],
                         pixel_checks=len(checks), original_sources_unchanged=True, shared_party_manifests_unchanged=True)))

if __name__ == '__main__': main()
