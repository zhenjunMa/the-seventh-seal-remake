"""Dependency-ordered, resumable entry point for the existing runtime exporters.

Listing is read-only. --run explicitly runs selected steps; ordinary config
export preserves parameters. Dated evidence is retained verbatim, with newly
generated versions recorded under evidence/builds instead.
"""
from pathlib import Path
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import argparse
import hashlib
import json
import re
import subprocess
import sys
from uuid import uuid4
sys.path.insert(0, str(Path(__file__).resolve().parent))
from content_registration import definition, map_ids, role_ids, program_ids, stage_exports
from export_battle_stages import source_files as stage_source_files

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
EVIDENCE = RUNTIME / 'evidence'
REGISTERED_ROLE_IDS = role_ids()
REGISTERED_PLAYER_IDS = role_ids('player')


@dataclass(frozen=True)
class Step:
    tool: str
    outputs: tuple[str, ...]
    depends: tuple[str, ...] = ()
    reports: tuple[str, ...] = ()
    inputs: tuple[str, ...] = ()
    sources: tuple[str, ...] = ()


STEPS = {
    'opening-seed': Step('export_opening_seed.py', ('data/opening_seed.json',), reports=('opening_seed_export_20261011.json',)),
    'opening-maps': Step('export_opening_maps.py', ('data/opening_map_resources.json', 'data/maps/m72061.json', 'data/maps/m17020.json', 'assets/maps/m72061', 'assets/maps/m17020', 'assets/opening_roles'), reports=('opening_map_export_20261011.json',)),
    'chapter-maps': Step('export_chapter_maps.py', ('data/chapter_map_resources.json', 'data/maps/m17029.json', 'data/maps/m17026.json', 'assets/maps/m17029', 'assets/maps/m17026', 'assets/chapter_roles', 'assets/chapter_objects'), reports=('chapter_map_export.json',)),
    'chapter-story': Step('export_chapter_story.py', ('data/chapter_story.json',), ('chapter-maps',), ('chapter_story_export.json',)),
    'map-effects': Step('export_map_effects.py', ('data/map_effects.json','assets/map_effects'), ('opening-maps','chapter-maps'), ('map_effects_20261021/export.json',), ('data/maps','../evidence/map_effects_20261021/native_retained.json')),
    'party-combat': Step('export_party_combat.py', ('data/party_combat.json',), reports=('party_combat_export.json',)),
    'party-skills': Step('export_party_skills.py', ('data/party_skills.json', 'data/party_reactions.json', 'data/party_battle_view.json', 'assets/party_layers', 'assets/party_roles', 'assets/party_effects'), ('party-combat',), ('party_skills_export.json',)),
    'party-rewards': Step('export_party_rewards.py', ('data/party_rewards.json',), ('party-combat',), ('party_rewards_export.json',)),
    'items': Step('export_chapter_items.py', ('data/items.json',), reports=('chapter_items_export.json',)),
    'item-presentation': Step('export_item_presentation.py', ('data/item_presentation.json', 'assets/item_presentation'), ('items',), ('item_presentation_export.json',)),
    'recovery': Step('export_chapter_recovery.py', ('../evidence/chapter_recovery_export_20261011.json',), reports=('chapter_recovery_export_20261011.json',)),
    'audio': Step('export_audio.py', ('data/audio.json', 'assets/audio'), reports=('audio_export.json',)),
    'forest-stage': Step('export_forest_stage.py', ('data/forest_stage.json', 'assets/forest_stage'), reports=('forest_stage_export.json',)),
    'menu': Step('export_operation_menu.py', ('data/operation_menu.json', 'assets/menu'), ('items','party-skills'), ('operation_menu_resources.json',), ('data/party_battle_view.json',)),
    'battle-ui': Step('export_battle_ui.py', ('data/battle_ui.json', 'assets/battle_ui', '../evidence/battle_ui_native_retained.json'), reports=('battle_ui_resources.json',), inputs=('../evidence/party_native.json','../evidence/operation_menu_native.json')),
    'battle-lifecycle': Step('export_battle_lifecycle.py', ('data/battle_lifecycle.json', *tuple('data/battle_lifecycle_layers_'+i+'.json' for i in REGISTERED_ROLE_IDS), 'assets/battle_lifecycle'), reports=('battle_lifecycle_20261015/export.json',)),
    'skill-test': Step('export_skill_test.py', ('data/skill_test.json','data/skill_test_stage.json','assets/skill_test_stage'), reports=('skill_test_20261020/export.json',), inputs=('../evidence/skill_test_20261020/native_evidence.json','../evidence/forest_stage_native.json','../evidence/menu_technique_native_20261013.json')),
    'battle-result': Step('export_battle_result.py', ('data/battle_result.json','assets/battle_result'), reports=('battle_result_20261020/export.json',), inputs=('../evidence/battle_result_20261020/native_evidence.json',)),
    'battle-packs': Step('export_battle_packs.py', ('data/battle_packs.json','assets/battle_packs'), ('party-skills','item-presentation','forest-stage','battle-ui','battle-lifecycle','skill-test','battle-result'), ('battle_loading_20261021/pack_export.json',), ('battle_view.mjs','forest_stage.mjs','data/battle_view.json','data/forest_full_battle_view.json','data/enemy_battle_view.json','../tools/battle_pack_inventory.mjs')),
    'menu-techniques': Step('export_menu_techniques.py', ('data/operation_techniques.json','assets/menu/techniques','assets/menu/game002d','assets/menu/game002e','assets/menu/game004'), ('menu','party-skills'), ('menu_technique_export_20261013.json',)),
    'menu-fonts': Step('export_menu_text_gdi.py', ('data/menu_fonts.json','assets/menu/fonts'), ('menu-techniques',), ('menu_text_armor_delivery_export_20261014.json',), ('../tools/menu_font_recipe.json','data/items.json','data/party_skills.json','data/maps','data/world_map.json', *tuple(p.name for p in sorted(WEB.glob('operation_*.mjs'))))),
    'startup-media': Step('export_startup_media.py', ('data/startup_media.json', 'assets/video/startup'), reports=('startup_media_export.json',)),
    'startup-menu': Step('export_startup_menu.py', ('data/startup_menu.json', 'assets/startup'), reports=('startup_menu_export_20261020.json',), inputs=('../evidence/startup_menu_native_20261020.json',)),
    'prologue-presentation': Step('export_prologue_presentation.py', ('data/prologue_presentation.json','data/prologue_fonts.json','assets/prologue','assets/prologue_loading'), reports=('prologue_routes_20261020/export.json',), inputs=('../evidence/prologue_sequence_20261020/native_evidence.json','data/opening_program.json','data/chapter_story.json')),
    'dialogue-ui': Step('export_dialogue_ui.py', ('data/dialogue_ui.json','data/dialogue_fonts.json','assets/dialogue_ui'), reports=('dialogue_alignment_20261021/source_audit.json',), inputs=('../evidence/dialogue_alignment_20261021/native_evidence.json','data/opening_program.json','data/chapter_story.json','data/events.json')),
    'world-map-ui': Step('export_world_map_ui.py', ('data/world_map_ui.json','assets/world_map'), reports=('world_map_alignment_20261021/export.json',), inputs=('data/world_map.json','../evidence/route_native_20261011.json','../evidence/operation_menu_native.json')),
    'configuration': Step('export_runtime_config.mjs', ('data/config',), inputs=('data/combat_sample.json', 'data/forest_combat.json', 'data/battle_scheduler.json', 'data/forest_ai.json', 'data/forest_rewards.json', 'data/party_skills.json', 'data/items.json', 'data/config')),
    'catalog': Step('build_catalog.py', ('data/catalog.json', 'data/events.json'), ('configuration',), inputs=('data/maps', 'data/events', '../../prototype/web/manifest.json')),
    'content': Step('export_content_registry.mjs', ('data/runtime_content.mjs',), ('catalog',), inputs=('data/runtime_content.json','data/catalog.json','data/chapter_story.json','data/chapter_map_resources.json','data/party_combat.json','data/party_skills.json','data/forest_combat.json','data/forest_ai.json','data/party_rewards.json','data/party_reactions.json','data/forest_status.json','data/encounters.json','data/party_battle_view.json','data/item_presentation.json','data/battle_lifecycle.json','data/maps')),
}

# Selection comes from authoring JSON, before generated maps/enemies exist.
enemy_sources = ('GAME.exe', *tuple(f'Fight_Role/{ident}.{suffix}' for ident in role_ids('enemy') for suffix in ('CHR', 'dgp')))
STEPS['enemies'] = Step('export_enemy_content.py',
    ('data/forest_combat.json','data/forest_ai.json','data/forest_status.json','data/battle_scheduler.json',
     'data/enemy_reactions.json','data/enemy_battle_view.json','assets/enemy_roles','assets/enemy_layers',
     *tuple(f'data/enemy_role_layers_{ident}.json' for ident in role_ids('enemy'))),
    reports=('enemy_content_export.json',), inputs=('data/runtime_content.json','data/forest_full_battle_view.json','data/forest_reactions.json'), sources=enemy_sources)
STEPS['enemy-rewards'] = Step('export_forest_rewards.py', ('data/forest_rewards.json',),
    reports=('enemy_rewards_export.json',), inputs=('data/runtime_content.json',), sources=(*enemy_sources, 'SYSTEM/Object.ITM'))
STEPS['encounters'] = Step('export_encounters.py', ('data/encounters.json',),
    reports=('encounter_export.json',), inputs=('data/runtime_content.json',),
    sources=('GAME.exe', *tuple(f'Map/{ident.lower()}.dat' for ident in map_ids()),
             *tuple(f'Map/{ident.lower()}.STG' for ident in map_ids() if (ROOT/f'Map/{ident.lower()}.STG').is_file())))
STEPS['chapter-maps'] = replace(STEPS['chapter-maps'],
    outputs=('data/chapter_map_resources.json','assets/chapter_roles','assets/chapter_objects',
             *tuple(item for ident in map_ids('assets') for item in (f'data/maps/{ident.lower()}.json', f'assets/maps/{ident.lower()}'))),
    sources=('GAME.exe', *tuple(f'Map/{ident.lower()}.dat' for ident in map_ids())))
STEPS['chapter-story'] = replace(STEPS['chapter-story'],
    inputs=('data/runtime_content.json',), sources=('GAME.exe','SYSTEM/Object.ITM',
        *tuple(f'Map/{ident.lower()}{suffix}' for ident in map_ids('story') for suffix in ('.dat','.TLK')),
        *tuple(f'Animate/{ident}.anm' for ident in program_ids()),
        *tuple(f'Fight_Role/{ident}.CHR' for ident in role_ids('player'))))

for target in ['party-combat','party-skills','party-rewards','item-presentation','battle-lifecycle','battle-packs','menu']:
    STEPS[target]=replace(STEPS[target],inputs=(*STEPS[target].inputs,'data/runtime_content.json'))

STEPS['story-check'] = Step('check_content.mjs', (), ('chapter-story','opening-seed','enemies'),
    inputs=('data/runtime_content.json','data/opening_seed.json','data/forest_combat.json',
            'data/chapter_story.json','data/chapter_map_resources.json','data/maps'))
source_stages = {ident: row for ident, row in stage_exports().items() if row['export'] == 'source'}
STEPS['battle-stages'] = Step('export_battle_stages.py',
    tuple(item for row in source_stages.values() for item in (row['path'],row['asset_prefix'])),
    ('forest-stage',), ('battle_stages_export.json',) if source_stages else (),
    ('data/runtime_content.json','data/forest_stage.json'), stage_source_files() if source_stages else ())

# A single content build prepares its source-derived data before compiling the
# final registry. Ordinary parameter-only exports reuse the unchanged assets.
for target, dependencies in {
    'party-combat': ('story-check',),
    'configuration': ('party-skills','enemy-rewards','encounters'),
    'catalog': ('configuration','chapter-maps'),
    'item-presentation': ('items','party-skills'),
    'audio': ('party-skills','item-presentation','chapter-maps','encounters'),
    'content': ('catalog','party-rewards','battle-packs','audio','menu-fonts','dialogue-ui','prologue-presentation','map-effects'),
    'party-rewards': ('party-combat','enemy-rewards'),
}.items():
    STEPS[target]=replace(STEPS[target],depends=dependencies)
STEPS['chapter-maps']=replace(STEPS['chapter-maps'],inputs=('data/runtime_content.json','data/opening_map_resources.json'))
STEPS['party-combat']=replace(STEPS['party-combat'],inputs=(*STEPS['party-combat'].inputs,'data/opening_seed.json'))
STEPS['catalog']=replace(STEPS['catalog'],inputs=(*STEPS['catalog'].inputs,'data/chapter_map_resources.json'))
STEPS['party-rewards']=replace(STEPS['party-rewards'],inputs=(*STEPS['party-rewards'].inputs,'../evidence/content_workflow_20261021/growth_native.json'))
STEPS['party-skills']=replace(STEPS['party-skills'],outputs=(*STEPS['party-skills'].outputs,*tuple(f'data/party_role_layers_{ident}.json' for ident in REGISTERED_PLAYER_IDS)))
STEPS['item-presentation']=replace(STEPS['item-presentation'],outputs=(*STEPS['item-presentation'].outputs,*tuple(f'data/item_role_layers_{ident}.json' for ident in REGISTERED_PLAYER_IDS)))
STEPS['content']=replace(STEPS['content'],inputs=(*STEPS['content'].inputs,'data/operation_menu.json'))
STEPS['battle-packs']=replace(STEPS['battle-packs'],depends=(*STEPS['battle-packs'].depends,'battle-stages'))
STEPS['dialogue-ui']=replace(STEPS['dialogue-ui'],depends=('catalog','chapter-story'))
STEPS['prologue-presentation']=replace(STEPS['prologue-presentation'],depends=('chapter-story',))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def hashes(paths):
    result = {}
    for path in paths:
        if not path.exists():
            raise FileNotFoundError(path)
        for file in sorted(path.rglob('*')) if path.is_dir() else [path]:
            if file.is_file() and '__pycache__' not in file.parts:
                result[str(file.resolve())] = sha(file)
    return result


def plan(names, steps=None):
    steps = STEPS if steps is None else steps
    ordered, visiting = [], set()
    def add(name):
        if name not in steps:
            raise ValueError(f'Unknown export step: {name}')
        if name in visiting:
            raise ValueError(f'Export dependency cycle: {name}')
        if name in ordered:
            return
        visiting.add(name)
        for dependency in steps[name].depends:
            add(dependency)
        visiting.remove(name)
        ordered.append(name)
    for name in names:
        add(name)
    return ordered


def source_paths(step):
    paths = {ROOT / name for name in step.sources}
    for report in step.reports:
        path = EVIDENCE / report
        if not path.is_file():
            if step.sources:
                continue  # Registered source paths bootstrap a new export ledger.
            raise FileNotFoundError(f'Run the established initial exporter before adopting its incremental ledger: {path}')
        data = json.loads(path.read_text(encoding='utf-8-sig'))
        source_names = set(data.get('source_hashes', {})) | set(data.get('source_hashes_after_export', {})) | set(data.get('input_sha256', {}))
        for row in data.get('sources', []):
            if isinstance(row, dict) and row.get('path'):
                path = RUNTIME / row['path']
                if not path.is_file():
                    raise FileNotFoundError(f'Exporter source no longer exists: {path}')
                paths.add(path)
        # Some ledgers store an asset count here (startup-menu), while others
        # store descriptors. Only descriptor lists can resolve source aliases.
        assets = data.get('assets', [])
        asset_sources = {Path(row['source']['path']).name.lower():row['source']['path']
                         for row in (assets if isinstance(assets, list) else [])
                         if isinstance(row, dict) and isinstance(row.get('source'), dict) and row['source'].get('path')}
        if data.get('game_source_sha256'):
            source_names.add('GAME.exe')
        for name in source_names:
            source = ROOT / name
            if not source.is_file() and Path(name).name.lower() in asset_sources:
                source = ROOT / asset_sources[Path(name).name.lower()]
            if not source.is_file():
                raise FileNotFoundError(f'Exporter source no longer exists: {source}')
            paths.add(source)
    return paths


def signature(step):
    tools = [Path(__file__), *RUNTIME.glob('tools/*.py'), *RUNTIME.glob('tools/*.mjs'),
             *RUNTIME.parent.glob('prototype/tools/*.py'), *WEB.glob('core/*.mjs')]
    dependencies = [WEB / item for name in step.depends for item in STEPS[name].outputs]
    inputs = hashes([*tools, *source_paths(step), *dependencies, *[WEB / name for name in step.inputs]])
    payload = json.dumps({'tool':step.tool, 'inputs':inputs, 'outputs':step.outputs}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def dated_evidence():
    return {p:p.read_bytes() for p in EVIDENCE.iterdir()
            if p.is_file() and re.search(r'20\d{6}', p.name)}


def preserve_evidence(before, destination):
    for path, original in before.items():
        if not path.exists() or path.read_bytes() != original:
            destination.mkdir(parents=True, exist_ok=True)
            if path.exists():
                (destination / path.name).write_bytes(path.read_bytes())
            path.write_bytes(original)


def execute(names, force=False, run_command=None):
    state_path = EVIDENCE / 'build_state.json'
    state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {'version':1, 'steps':{}}
    # Windows clocks can return the same timestamp for consecutive builds.
    # Each invocation owns a separate immutable evidence directory.
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + uuid4().hex
    directory = EVIDENCE / 'builds' / run_id
    directory.mkdir(parents=True)
    report = {'schema':'seventh-seal-export-run', 'version':1, 'started_utc':datetime.now(timezone.utc).isoformat(), 'steps':[], 'passed':False}
    try:
        for name in plan(names):
            step = STEPS[name]
            fingerprint = signature(step)
            previous = state['steps'].get(name)
            try:
                outputs = hashes(WEB / item for item in step.outputs)
            except FileNotFoundError:
                outputs = None
            if not force and previous and previous['signature'] == fingerprint and previous['outputs'] == outputs:
                report['steps'].append({'name':name, 'status':'cached', 'outputs_checked':len(outputs)})
                print(f'{name}: cached ({len(outputs)} files)', flush=True)
                continue
            protected_sources = source_paths(step)
            originals = hashes(protected_sources)
            history = dated_evidence()
            command = ['node', str(RUNTIME/'tools'/step.tool)] if step.tool.endswith('.mjs') else [sys.executable, '-B', str(RUNTIME/'tools'/step.tool)]
            print(f'{name}: exporting', flush=True)
            try:
                if run_command:
                    run_command(command, name)
                else:
                    result = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                    (directory/f'{name}.log').write_bytes(result.stdout)
                    if result.returncode:
                        raise RuntimeError(f'{name} failed; see {directory/name}.log')
            finally:
                preserve_evidence(history, directory/name/'generated-evidence')
            # A new role legitimately adds inputs to the export report. Compare
            # the same protected files, rather than comparing different sets.
            if hashes(protected_sources) != originals:
                raise RuntimeError(f'{name} changed original inputs')
            outputs = hashes(WEB / item for item in step.outputs)
            state['steps'][name] = {'signature':signature(step), 'outputs':outputs}
            state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
            report['steps'].append({'name':name, 'status':'exported', 'outputs_checked':len(outputs)})
        report['passed'] = True
        return report
    except BaseException as error:
        report['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        report['finished_utc'] = datetime.now(timezone.utc).isoformat()
        (directory/'run.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', nargs='+', choices=[*STEPS, 'all'], default=['catalog'])
    parser.add_argument('--run', action='store_true', help='Run the selected exports; omission lists the plan')
    parser.add_argument('--validate', action='store_true', help='Audit selected tools, input sources and existing outputs without regenerating assets')
    parser.add_argument('--force', action='store_true', help='Rebuild selected exports, preserving configuration parameters')
    parser.add_argument('--check', action='store_true', help='Run verify_current.py after successful exports')
    parser.add_argument('--preflight', action='store_true', help='Read-only story capability check using existing exported source records')
    args = parser.parse_args()
    if args.preflight:
        if args.run or args.validate or args.force or args.check:
            parser.error('--preflight cannot be combined with export/validation flags')
        subprocess.run(['node', str(RUNTIME/'tools/check_content.mjs')], cwd=ROOT, check=True)
        return
    names = list(STEPS) if 'all' in args.target else args.target
    if args.validate:
        rows = []
        for name in plan(names):
            step = STEPS[name]
            if not (RUNTIME/'tools'/step.tool).is_file():
                raise FileNotFoundError(step.tool)
            outputs = hashes(WEB/item for item in step.outputs)
            rows.append({'name':name, 'signature':signature(step), 'outputs_checked':len(outputs), 'source_files_checked':len(source_paths(step))})
        report = {'schema':'seventh-seal-export-inventory', 'version':1, 'checked_utc':datetime.now(timezone.utc).isoformat(), 'passed':True, 'steps':rows, 'exporters_executed':False}
        (EVIDENCE/'export_inventory.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'passed':True, 'steps':len(rows), 'exporters_executed':False}))
        return
    if not args.run:
        for name in plan(names):
            print(f'{name}: {STEPS[name].tool}')
        return
    execute(names, args.force)
    if args.check:
        subprocess.run([sys.executable, '-B', str(RUNTIME/'tools/verify_current.py')], cwd=ROOT, check=True)


if __name__ == '__main__':
    main()
