"""Shared identities for exporters; numeric tuning stays in data/config."""
from pathlib import Path
import json
import subprocess
from functools import lru_cache

REGISTRATION = Path(__file__).resolve().parents[1] / 'web/data/runtime_content.json'


def definition():
    """Read authoring choices without requiring any generated map/CHR output."""
    value = json.loads(REGISTRATION.read_text(encoding='utf-8'))
    if value.get('schema') != 'seventh-seal-runtime-content' or value.get('version') != 2:
        raise ValueError('Unsupported content authoring definition')
    return value


def map_exports(value=None):
    value = definition() if value is None else value
    result = {}
    import re
    for ident, row in value['maps'].items():
        if not re.fullmatch(r'M[0-9]{5}', ident):
            raise ValueError(f'Invalid map identity: {ident}')
        policy = row.get('export', {})
        if (set(policy) - {'assets', 'story'} or policy.get('assets', 'chapter') not in ('chapter', 'existing')
                or type(policy.get('story', True)) is not bool):
            raise ValueError(f'Invalid map export policy: {ident}')
        result[ident] = {'assets': policy.get('assets', 'chapter'), 'story': policy.get('story', True)}
    return result


def map_ids(kind=None, value=None):
    return tuple(ident for ident, row in map_exports(value).items()
                 if kind is None or kind == 'assets' and row['assets'] == 'chapter'
                 or kind == 'story' and row['story'])


def program_ids():
    import re
    rows = definition()['programs']
    if len(set(rows)) != len(rows) or any(not re.fullmatch(r'[a-z0-9_-]+', ident) for ident in rows):
        raise ValueError('Invalid or duplicate ANM identity')
    return tuple(rows)


@lru_cache(maxsize=1)
def registration():
    # Use the same source resolver as the JS compiler, before party exports exist.
    result = subprocess.run(['node', str(REGISTRATION.parents[2] / 'tools/resolve_content_definition.mjs')],
                            check=True, capture_output=True, encoding='utf-8')
    value = json.loads(result.stdout)
    assert value['schema'] == 'seventh-seal-runtime-content' and value['version'] == 1
    return value


def role_ids(side=None):
    # Export selection must not depend on its own future output.
    import re
    roles = definition()['roles']
    if any(not re.fullmatch(r'[0-9]{3}', ident) or row.get('side') not in ('player', 'enemy')
           for ident, row in roles.items()):
        raise ValueError('Invalid role export identity')
    return tuple(ident for ident, role in roles.items()
                 if side is None or role['side'] == side)


def skill_bindings(field=False):
    key = 'field_skills' if field else 'battle_skills'
    for role in registration()['roles'].values():
        if role['side'] == 'player':
            assert role.get('battle_skills') and any(row['index'] == role['primary_skill'] for row in role['battle_skills'])
            assert all(row['handler'] in ('direct', 'effect-carrier') for row in role['battle_skills'])
    return {ident: {row['index']: row['id'] for row in role.get(key, [])}
            for ident, role in registration()['roles'].items()
            if role['side'] == 'player' and (not field or role.get(key))}
