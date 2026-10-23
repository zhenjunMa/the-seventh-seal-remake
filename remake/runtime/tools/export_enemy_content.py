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
from content_registration import role_ids
from source.combat_resources import CHR, GAME_SHA256
from source.dgp import DGP
from export_forest_ai import role_record
import export_combat_sample as combat
from export_party_skills import source_role, export_role_assets, enrich_sequence
from export_battle_view import sequence


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(name):
    return json.loads((WEB / f'data/{name}.json').read_text('utf-8'))


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'utf-8')


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
        if effect[0xb] != 0 or effect[1] and effect.hex() != status['status43']['effect_raw_hex']:
            raise ValueError(f'Enemy {ident} skill {index}: unsupported status handler {effect[1]} / mode {effect[0xb]}')
        view = sequence(c, d, index)  # Reject unsupported action commands here.
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
    # Effects not already present are exported by the shared party presentation
    # pass, which scans every selected enemy and player view.
    values = dict(forest_ai=ai, forest_combat=data, forest_status=status,
                  battle_scheduler=scheduler, enemy_reactions=reactions, enemy_battle_view=meta)
    for p, h in sources.items():
        if sha(ROOT / p) != h: raise ValueError(f'Original input changed: {p}')
    outputs = []
    for name, value in values.items():
        path = WEB / f'data/{name}.json'; save(path, value); outputs.append(path)
    outputs += [WEB / f'data/enemy_role_layers_{ident}.json' for ident in ids]
    for group in ('enemy_roles', 'enemy_layers'):
        outputs += list((WEB / f'assets/{group}').rglob('*.png'))
    save(RUNTIME / 'evidence/enemy_content_export.json', dict(schema='seventh-seal-enemy-content-export', version=1,
        passed=True, source_unchanged=True, source_hashes=sources, role_ids=list(ids),
        learned_indices={ident: row[2]['learned_indices'] for ident, row in prepared.items()},
        frame_checks=checks, output_hashes={p.relative_to(RUNTIME).as_posix(): sha(p) for p in outputs},
        original_game_execution_observed=False,
        limits=['Registered learned direct skills using recovered commands/status43 only.',
                'Reward export and encounter selection are separate build steps; export does not enable unregistered mechanics.']))
    print(json.dumps(dict(passed=True, roles=list(ids), frame_checks=len(checks))))


if __name__ == '__main__':
    export()
