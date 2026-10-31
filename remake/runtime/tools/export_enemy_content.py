"""Build registered enemy inputs using recovered CHR rules and pixel auditors.

Legacy forest view/reaction fixtures remain immutable. Runtime enemy identity,
learned commands, attributes, status blocks, poses and art come from source;
unsupported commands/statuses fail before publishing metadata.
"""
from pathlib import Path
import copy
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
sys.path.insert(0, str(RUNTIME / 'tools'))
from incremental import write_json as incremental_json
from content_registration import role_ids, definition
from source.combat_resources import CHR, GAME_SHA256
from source.dgp import DGP
from export_forest_ai import role_record
import export_combat_sample as combat
from export_party_skills import source_role, export_role_assets, enrich_sequence, extend_status_descriptors, source_status_block, export_effect_assets
from export_battle_view import sequence


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(name):
    return json.loads((WEB / f'data/{name}.json').read_text('utf-8'))


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    incremental_json(path, value)


def player_status_blocks():
    """Read source bindings directly; no generated combat/catalog dependency."""
    blocks = {}
    for ident, binding in definition()['roles'].items():
        if binding['side'] != 'player':
            continue
        character = CHR(ROOT / f'Fight_Role/{ident}.CHR')
        for row in binding['battle_skills']:
            index = row['index']
            blocks[f'{ident}:{index}'] = source_status_block(character, index)
    return blocks


def player_support_blocks():
    """The same status table retains allied +231 application templates."""
    blocks = {}
    for ident, binding in definition()['roles'].items():
        if binding['side'] != 'player':
            continue
        character = CHR(ROOT / f'Fight_Role/{ident}.CHR')
        for row in binding['battle_skills']:
            if row['handler'] not in ('native-support', 'native-revival'):
                continue
            skill = character.skills[row['index']]
            fixed = bytes.fromhex(skill['fixed_raw_hex'])
            effect = fixed[0x231:0x2f7]
            blocks[f'{ident}:{row["index"]}'] = dict(actor_id=ident, original_skill_index=row['index'],
                name=skill['name_cp936'], fixed_raw_hex=fixed.hex(), effect_raw_hex=effect.hex(),
                effect_id_raw=effect[1], mode_raw=effect[0xb],
                source=dict(path=f'Fight_Role/{ident}.CHR', sha256=character.sha256,
                    fixed_offset=skill['offset'], block_offset=skill['offset']+0x231,
                    fixed_bytes=0x41d, effect_bytes=0xc6))
    return blocks


def item_status_blocks():
    """Retain hostile ITM508BB0 templates for the shared status-table owner.

    Source metadata does not enable a menu item. Actual acquisition and item
    handler admission remain in the item catalog, produced after this table.
    """
    path = ROOT / 'SYSTEM/Object.ITM'
    raw = path.read_bytes()
    blocks = {}
    count = struct.unpack_from('<I', raw, 0x20)[0]
    if len(raw) != 0x61c + count * 0x3bf:
        raise ValueError('Invalid original item table boundary')
    for index in range(count):
        at = 0x61c + index * 0x3bf
        record = raw[at:at + 0x3bf]
        effect = record[0x2a8:0x36e]
        if record[0x24:0x26] != b'\x05\x03' or effect[0xb] not in (0, 2) or not effect[1] or effect[1] > 100 or effect[0x10] > 1:
            continue
        blocks[str(index + 1)] = dict(item_id=index + 1, effect_raw_hex=effect.hex(),
            effect_id_raw=effect[1], mode_raw=effect[0xb],
            source=dict(path='SYSTEM/Object.ITM', sha256=sha(path), record_offset=at,
                block_offset=at + 0x2a8, effect_bytes=0xc6))
    return blocks


def source_files():
    """Status-table owner fingerprints every selected player/enemy CHR."""
    paths = {'GAME.exe', 'SYSTEM/Object.ITM'}
    for ident in role_ids('enemy'):
        paths.update(f'Fight_Role/{ident}.{suffix}' for suffix in ('CHR', 'dgp'))
        character = CHR(ROOT / f'Fight_Role/{ident}.CHR')
        for index in role_record(character)['learned_indices']:
            for action in character.skills[index]['actions']:
                raw = bytes.fromhex(action['raw_hex'])
                for offset in (9, 0x4e):
                    token = raw[offset:offset + 20].split(b'\0')[0].decode('ascii')
                    if token.lower().endswith('.dgp'):
                        paths.add(f'Fight_Role/Effect/{token}')
            fixed = bytes.fromhex(character.skills[index]['fixed_raw_hex'])
            if fixed[0x16c]:
                paths.add(f'Fight_Role/Status/{fixed[0x16c]:03d}.dgp')
    for block in player_status_blocks().values():
        paths.add(block['source']['path'])
        if block['effect_id_raw']:
            paths.add(f"Fight_Role/Status/{block['effect_id_raw']:03d}.dgp")
    for block in player_support_blocks().values():
        paths.add(block['source']['path'])
        if block['effect_id_raw'] and block['mode_raw'] in (0, 2):
            paths.add(f"Fight_Role/Status/{block['effect_id_raw']:03d}.dgp")
    for block in item_status_blocks().values():
        paths.add(f"Fight_Role/Status/{block['effect_id_raw']:03d}.dgp")
    return tuple(sorted(path for path in paths if (ROOT / path).is_file()
        or not path.startswith(('Fight_Role/Effect/', 'Fight_Role/Status/'))))


def prepare_role(ident, status):
    c, d = CHR(ROOT / f'Fight_Role/{ident}.CHR'), DGP(ROOT / f'Fight_Role/{ident}.dgp')
    if c.parsed_end != len(c.data) or c.header[0x19] != 0:
        raise ValueError(f'Enemy {ident}: invalid source boundary or player-side CHR')
    ai = role_record(c)
    if not ai['learned_indices']:
        raise ValueError(f'Enemy {ident}: no learned native commands')
    views, blocks = [], {}
    for index in ai['learned_indices']:
        skill = c.skills[index]
        fixed = bytes.fromhex(skill['fixed_raw_hex'])
        effect = fixed[0x16b:0x231]
        if effect[0xb] not in (0, 2) or effect[1] > 100 or effect[0x10] not in (0, 1):
            raise ValueError(f'Enemy {ident} skill {index}: unsupported status handler {effect[1]} / mode {effect[0xb]}')
        commands = [(a['type_raw'], a['u32_at_0x01_raw']) for a in skill['actions'] if a['type_raw']]
        carrier = any(a['type_raw'] == 1 and a['u32_at_0x01_raw'] == 4
            and struct.unpack_from('<I', bytes.fromhex(a['raw_hex']), 0x49)[0] for a in skill['actions'])
        if any(kind != 1 or group not in (0, 1, 4, 6, 7, 8, 10, 11) for kind, group in commands):
            raise ValueError(f'Enemy {ident} skill {index}: unsupported native action command')
        handler = 'effect-carrier' if carrier else 'direct'
        retained = ai['skills'][index]
        if carrier or fixed[0x25] and not retained.get('contactless'):
            if fixed[0x32] & 15 not in (2, 3):
                raise ValueError(f'Enemy {ident} skill {index}: unsupported carrier recovery targeting')
            if fixed[0x25]:
                # The same 50FA00 allied contact as player support: dormant
                # +231 ID0/mode0, followed by positive 41E950 recovery.
                hp_low, hp_high = struct.unpack_from('<ii', fixed, 0xab)
                mp_low, mp_high = struct.unpack_from('<ii', fixed, 0xbb)
                if fixed[0x25] != 1 or fixed[0x24] not in (0, 1) or effect[1] or fixed[0x232] or fixed[0x23c] or not (0 <= hp_low <= hp_high and 0 <= mp_low <= mp_high):
                    raise ValueError(f'Enemy {ident} skill {index}: unsupported allied recovery payload')
                handler = 'native-support'
            else:
                retained['effect_context'] = dict(effect_token=1, effect_source_skill_index=index,
                    effect_lookup='same-index-source-table',
                    evidence=['ev_dc019d336cb98549ccba8bab90528f5d4cb8a1d34fea55c99639941e188b6763',
                              'ev_c9bbdef1c8377c5cb768f67c055aa4189564ec176aa68cd9b38b398e47bb0b9b'])
        retained['battle_handler'] = handler
        view = enrich_sequence(c, d, index, handler=handler)
        if retained.get('contactless'):
            view['contactless'] = True
        for segment in view['segments']:
            segment['raw_hex'] = skill['actions'][segment['chr_record_index']]['raw_hex']
            segment['source_skill_index'] = index
        view['runtime_skill_id'] = f'{ident}_skill_{index}'
        views.append(view)
        blocks[f'{ident}:{index}'] = dict(actor_id=ident, original_skill_index=index,
            name=skill['name_cp936'], fixed_raw_hex=fixed.hex(), effect_raw_hex=effect.hex(),
            effect_id_raw=effect[1], mode_raw=effect[0xb],
            nonzero_bytes={f'0x{o:02x}': b for o, b in enumerate(effect) if b},
            source=dict(path=f'Fight_Role/{ident}.CHR', sha256=c.sha256, fixed_offset=skill['offset'],
                        block_offset=skill['offset'] + 0x16b, fixed_bytes=0x41d, effect_bytes=0xc6))
    def pose(index):
        return sequence(c, d, index)['segments'][0]
    responses = [sequence(c, d, index) for index, skill in enumerate(c.skills)
                 if skill['id_raw'] in (1, 2, 3, 9, 12, 18, 19)]
    idle = enrich_sequence(c, d, 0)
    role = dict(id=ident, name=c.name, frame_width=d.width, frame_height=d.height,
        cursor_height_raw=d.cursor_height_raw,
        anchor=dict(x=d.anchor_raw[0], y=d.anchor_raw[1]), mirror=False, direction=0,
        idle=idle['segments'][0], idle_sequence=idle, reaction=pose(1), skill=views[0], alternate_skills=views[1:], response_skills=responses)
    primary = copy.deepcopy(ai['skills'][ai['learned_indices'][0]])
    primary['id'] = f'{ident}_attack'
    actor = combat.actor_record(ident, 'enemy', c.header, c.path, 8,
        {combat.address(n): 0 for n in combat.LINK_FIELDS}, primary)
    return c, d, ai, role, blocks, primary, actor


def export():
    ids = role_ids('enemy')
    sources = {'GAME.exe': sha(ROOT / 'GAME.exe')}
    if sources['GAME.exe'] != GAME_SHA256:
        raise ValueError('Executable differs from retained rule evidence')
    ai, data, status, scheduler = (read(n) for n in ('forest_ai', 'forest_combat', 'forest_status', 'battle_scheduler'))
    meta, reactions = read('forest_full_battle_view'), read('forest_reactions')
    prepared = {ident: prepare_role(ident, status) for ident in ids}
    # 509E10 gets each status's interval/frame count from its own Status DGP.
    # Preserve the old status43 descriptor while extending the same table.
    status['skills'] = {}
    player_blocks = player_status_blocks()
    extend_status_descriptors(status, {**player_blocks, **{key: block for value in prepared.values() for key, block in value[4].items()}}, sources)
    support_blocks = player_support_blocks()
    for ident, (character, _, source_ai, *_) in prepared.items():
        for index in source_ai['learned_indices']:
            if source_ai['skills'][index]['battle_handler'] != 'native-support':
                continue
            skill = character.skills[index]
            fixed = bytes.fromhex(skill['fixed_raw_hex'])
            effect = fixed[0x231:0x2f7]
            support_blocks[f'{ident}:{index}'] = dict(actor_id=ident, original_skill_index=index,
                name=skill['name_cp936'], fixed_raw_hex=fixed.hex(), effect_raw_hex=effect.hex(),
                effect_id_raw=effect[1], mode_raw=effect[0xb],
                source=dict(path=f'Fight_Role/{ident}.CHR', sha256=character.sha256,
                    fixed_offset=skill['offset'], block_offset=skill['offset']+0x231,
                    fixed_bytes=0x41d, effect_bytes=0xc6))
    extend_status_descriptors(status, {key: block for key, block in support_blocks.items()
        if block['effect_id_raw'] and block['mode_raw'] in (0, 2)}, sources)
    # +231 is a separate contact payload and must not replace +16B records.
    status['skills'].update(player_blocks)
    status['support_skills'] = support_blocks
    item_blocks = item_status_blocks()
    extend_status_descriptors(status, item_blocks, sources, retain_skills=False)
    status['item_effects'] = item_blocks
    sources['SYSTEM/Object.ITM'] = sha(ROOT / 'SYSTEM/Object.ITM')
    sources.update({block['source']['path']: block['source']['sha256'] for block in player_blocks.values()})
    # All source rules above are checked before image writes or metadata changes.
    ai['roles'], data['actors'], data['skills'] = {}, {}, {}
    meta['roles'] = [row for row in meta['roles'] if row['id'] in role_ids('player')]
    reactions['roles'] = {ident: row for ident, row in reactions['roles'].items() if ident in role_ids('player')}
    status['skills'] = {key: row for key, row in status['skills'].items() if row['actor_id'] in role_ids('player')}
    checks, banks = [], []
    for ident, (c, d, source_ai, view, blocks, skill, actor) in prepared.items():
        sources[f'Fight_Role/{ident}.CHR'], sources[f'Fight_Role/{ident}.dgp'] = c.sha256, d.sha256
        ai['roles'][ident], data['actors'][ident], data['skills'][skill['id']] = source_ai, actor, skill
        reactions['roles'][ident] = source_role(c)
        status['skills'].update(blocks)
        raw = bytes.fromhex(c.skills[0]['fixed_raw_hex'])
        first_action = bytes.fromhex(c.skills[0]['actions'][0]['raw_hex'])
        scheduler['idle_skills'][ident] = dict(id=f'{ident}_idle', actor_id=ident, name=c.skills[0]['name_cp936'],
            fixed_raw_hex=raw.hex(), class_raw=first_action[0x24], action_mask_raw=first_action[0x78],
            segments=copy.deepcopy(view['idle_sequence']['segments']),
            source=dict(path=f'Fight_Role/{ident}.CHR', sha256=c.sha256,
                        offset=c.skills[0]['offset'], bytes=0x41d))
        # Use the same independently audited image/layer implementation as players.
        banks.append(export_role_assets(view, c, d, sources, checks, group='enemy'))
        meta['roles'].append(view)
    export_effect_assets(meta, sources, checks, asset_group='enemy')
    for name, value in [('forest_ai', ai), ('forest_combat', data), ('forest_status', status), ('battle_scheduler', scheduler)]:
        # Existing fields/evidence remain, while CHR provenance is refreshed.
        if 'source_hashes' in value:
            value['source_hashes'].update({p: h for p, h in sources.items() if not p.lower().endswith('.dgp')})
    reactions['source_hashes'].update({p: h for p, h in sources.items() if p.endswith('.CHR')})
    reactions['policy']['roster'] = 'party-source-group'
    meta['source_hashes'].update(sources)
    meta['extra_layer_banks'] = banks
    meta['policy']['roster'] = 'forest-source-group'
    meta['policy']['complete_contacts'] = True
    # Enemy-owned effects are complete before publishing this manifest.
    # The party pass reuses these references and owns only additional effects.
    values = dict(forest_ai=ai, forest_combat=data, forest_status=status,
                  battle_scheduler=scheduler, enemy_reactions=reactions, enemy_battle_view=meta)
    for p, h in sources.items():
        if sha(ROOT / p) != h: raise ValueError(f'Original input changed: {p}')
    outputs = []
    for name, value in values.items():
        path = WEB / f'data/{name}.json'; save(path, value); outputs.append(path)
    outputs += [WEB / f'data/enemy_role_layers_{ident}.json' for ident in ids]
    for group in ('enemy_roles', 'enemy_layers', 'enemy_effects'):
        outputs += list((WEB / f'assets/{group}').rglob('*.png'))
    save(RUNTIME / 'evidence/enemy_content_export.json', dict(schema='seventh-seal-enemy-content-export', version=1,
        passed=True, source_unchanged=True, source_hashes=sources, role_ids=list(ids),
        learned_indices={ident: row[2]['learned_indices'] for ident, row in prepared.items()},
        frame_checks=checks, output_hashes={p.relative_to(RUNTIME).as_posix(): sha(p) for p in outputs},
        missing_original_files=sorted({row['source'] for row in meta.get('missing_effects', [])}
            | {row['source']['path'] for row in status['effects'].values() if row.get('source', {}).get('source_exists') is False}),
        original_game_execution_observed=False,
        limits=['Registered learned direct/effect-carrier skills use recovered commands and source status clocks.',
                'Reward export and encounter selection are separate build steps; export does not enable unregistered mechanics.']))
    print(json.dumps(dict(passed=True, roles=list(ids), frame_checks=len(checks))))


if __name__ == '__main__':
    export()
