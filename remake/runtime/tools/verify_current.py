"""Verify the current workspace without rewriting dated milestone evidence."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone

RUNTIME = Path(__file__).resolve().parents[1]
REMAKE = RUNTIME.parent
ROOT = REMAKE.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
WEB = RUNTIME/'web'
EVIDENCE = RUNTIME/'evidence'
REPORT = EVIDENCE/'current_validation.json'

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def exported_path(name):
    if name.startswith('/'): return WEB/name.lstrip('/')
    if name.startswith('web/'): return RUNTIME/name
    return ROOT/name


def registered_report_steps(steps=None):
    if steps is None:
        from build_runtime import STEPS
        steps = STEPS
    owners = {}
    for step, definition in steps.items():
        for report in definition.reports:
            if report in owners and owners[report] != step:
                raise ValueError(f'Export report has multiple registered owners: {report}')
            owners[report] = step
    return owners


def current_export(filename, step=None, *, steps=None):
    # The build entry keeps dated evidence immutable and writes changed reports
    # under a successful run. Validate against that export, not an old baseline.
    owners = registered_report_steps(steps)
    owner = owners.get(filename)
    if owner is None or step is not None and step != owner:
        raise ValueError(f'Export report/step is not registered: {filename} / {step}')
    step = owner
    for directory in sorted((EVIDENCE/'builds').glob('*'), reverse=True):
        run=directory/'run.json'
        generated = directory/step/'generated-evidence'
        if run.is_file():
            summary=read(run)
            if summary.get('passed') and any(row.get('name')==step and row.get('status')=='exported' for row in summary.get('steps', [])):
                # The latest completed export is authoritative even when its
                # report equals the immutable baseline (and has no copy), or
                # is an undated/nested report written in its live location.
                # preserve_evidence stores each top-level dated report using
                # its basename. Support a relative-path layout too, but only
                # after exact report ownership has been resolved above. An
                # unrelated step's same-basename export is never a candidate.
                report = generated/filename
                flattened = generated/Path(filename).name
                basename_is_unique = sum(1 for name, candidate in owners.items()
                                         if candidate == owner and Path(name).name == Path(filename).name) == 1
                if not report.is_file() and basename_is_unique and flattened.is_file():
                    report = flattened
                return read(report if report.is_file() else EVIDENCE/filename)
    return read(EVIDENCE/filename)


def verify_retained_asset(name, expected, *, root=None, migration=None):
    """Accept an exact historical digest or one explicitly declared migration."""
    root = ROOT if root is None else root
    actual = sha(root/name)
    if actual == expected:
        return None
    if migration is None:
        migration = read(RUNTIME/'tools/layout_migration.json')
    assert migration.get('schema') == 'seventh-seal-layout-migration' and migration.get('version') == 1, 'Layout migration schema changed'
    rows = [row for row in migration.get('runtime_manifests', []) if row.get('path') == name]
    assert len(rows) == 1 and rows[0].get('previous_sha256') == expected, f'Retained source/asset changed without matching migration: {name}'
    row = rows[0]
    assert re.fullmatch(r'[a-f0-9]{64}', row.get('sha256', '')) and actual == row['sha256'], f'Retained migrated asset changed: {name}'
    return dict(row)


def verify():
    baseline = read(EVIDENCE/'forest_combat_four_steps_delivery_20261011.json')
    original_inputs = baseline['source_hashes']
    for name, expected in original_inputs.items():
        assert sha(ROOT/name) == expected, f'Original input changed: {name}'
    opening_export = current_export('opening_map_export_20261011.json','opening-maps')
    opening_seed = current_export('opening_seed_export_20261011.json','opening-seed')
    opening_sources = {**opening_export['source_hashes'], **opening_seed['source_hashes']}
    for name, expected in opening_sources.items():
        assert sha(ROOT/name) == expected, f'Opening input changed: {name}'
    for name, expected in opening_export['output_hashes'].items():
        path = WEB/name.lstrip('/') if name.startswith('/') else ROOT/name
        assert sha(path) == expected, f'Opening asset changed: {name}'
    assert sha(ROOT/opening_seed['seed_path']) == opening_seed['seed_sha256']
    chapter_sources = {}
    chapter_outputs = {}
    for filename in ['chapter_map_export.json', 'chapter_story_export.json']:
        export = current_export(filename,'chapter-maps' if filename=='chapter_map_export.json' else 'chapter-story')
        chapter_sources.update(export['source_hashes'])
        chapter_outputs.update(export.get('output_hashes', {export.get('output_path',''):export.get('output_sha256','')}))
    for name, expected in chapter_sources.items():
        assert sha(ROOT/name) == expected, f'Chapter input changed: {name}'
    for name, expected in chapter_outputs.items():
        path = WEB/name.lstrip('/') if name.startswith('/') else ROOT/name
        assert sha(path) == expected, f'Chapter asset changed: {name}'
    party_sources, party_outputs = {}, {}
    for filename in ['party_combat_export.json', 'party_rewards_export.json', 'party_skills_export.json']:
        export = current_export(filename)
        assert export.get('passed', export.get('source_bytes_unchanged', False))
        party_sources.update(export['source_hashes'])
        party_outputs.update(export.get('output_hashes', {export.get('output_path',''):export.get('output_sha256','')}))
    for name, expected in party_sources.items():
        assert sha(ROOT/name) == expected, f'Party input changed: {name}'
    for name, expected in party_outputs.items():
        path = exported_path(name)
        assert sha(path) == expected, f'Party asset changed: {name}'
    system_sources, system_outputs = {}, {}
    for filename in ['enemy_content_export.json', 'enemy_rewards_export.json', 'encounter_export.json', 'chapter_items_export.json', 'chapter_recovery_export_20261011.json', 'item_presentation_export.json', 'forest_stage_export.json', 'operation_menu_resources.json', 'battle_ui_resources.json','battle_lifecycle_20261015/export.json','skill_test_20261020/export.json','battle_result_20261020/export.json','startup_menu_export_20261020.json','prologue_routes_20261020/export.json','dialogue_alignment_20261021/source_audit.json','battle_loading_20261021/pack_export.json','map_effects_20261021/export.json','movement_optimization_20261023/shadow_export.json']:
        export = current_export(filename)
        assert export.get('passed', export.get('source_bytes_unchanged', export.get('source_unchanged', False)))
        system_sources.update(export['source_hashes'])
        if export.get('output_hashes'): system_outputs.update(export['output_hashes'])
        elif export.get('output_path'): system_outputs[export['output_path']] = export['output_sha256']
    audio = read(WEB/'data/audio.json')
    audio_export = current_export('audio_export.json')
    assert audio_export['success'] and audio_export['original_source_unchanged']
    assert sha(WEB/'data/audio.json') == audio_export['manifest_sha256']
    system_sources.update(audio_export['source_hashes'])
    system_outputs['remake/runtime/web/data/audio.json'] = audio_export['manifest_sha256']
    for clip in audio['clips'].values(): system_outputs['remake/runtime/web'+clip['path']] = clip['sha256']
    for name, expected in audio['native_bundle_hashes'].items(): assert sha(ROOT/name) == expected
    for name, expected in audio['reference_hashes'].items(): assert sha(ROOT/name) == expected, f'Audio reference changed: {name}'
    video = read(EVIDENCE/'gameover_video_export.json')
    assert video['success'] and video['original_source_unchanged'] and video['conversion']['decoded_ssim_all'] > .99
    system_sources[video['source']['path']] = video['source']['sha256']
    system_outputs['remake/runtime/web'+video['output']['path']] = video['output']['sha256']
    for name, expected in system_sources.items(): assert sha(ROOT/name) == expected, f'System input changed: {name}'
    for name, expected in system_outputs.items(): assert sha(exported_path(name)) == expected, f'System asset changed: {name}'
    menu_rules = read(EVIDENCE/'operation_menu_rules.json')
    techniques_export=current_export('menu_technique_export_20261013.json')
    assert techniques_export['original_inputs_unchanged']
    system_sources.update(techniques_export['source_hashes'])
    system_outputs.update(techniques_export['output_hashes'])
    for name,expected in techniques_export['source_hashes'].items():assert sha(ROOT/name)==expected
    for name,expected in techniques_export['output_hashes'].items():assert sha(ROOT/name)==expected
    fonts=read(WEB/'data/menu_fonts.json')
    assert sha(RUNTIME/fonts['export_recipe']['path'])==fonts['export_recipe']['sha256']
    for profile in fonts['fonts'].values():
        path=WEB/profile['image'];assert sha(path)==profile['sha256']
        system_outputs[path.relative_to(ROOT).as_posix()]=profile['sha256']
    system_outputs['remake/runtime/web/data/menu_fonts.json']=sha(WEB/'data/menu_fonts.json')
    for name, expected in menu_rules['source_hashes'].items(): assert sha(ROOT/name) == expected
    for bundle in menu_rules['native_bundles']: assert sha(RUNTIME/bundle['path']) == bundle['sha256']
    crystal_audit = read(EVIDENCE/'crystal_socket_audit_20261014.json')
    assert sha(ROOT/'GAME.exe') == crystal_audit['scope']['sha256']
    assert sha(ROOT/crystal_audit['source']['item_path']) == crystal_audit['source']['sha256']
    crystal_native = read(EVIDENCE/crystal_audit['scope']['native_bundle'])
    crystal_ids = {row['evidence_id'] for row in crystal_native['records']}
    assert len(crystal_ids) == crystal_audit['scope']['native_records']
    assert set(crystal_audit['evidence_links'].values()) <= crystal_ids
    crystal_geometry = read(EVIDENCE/'weapon_socket_ui_geometry_20261014.json')
    native_bundle = crystal_geometry['new_native_bundle']
    assert sha(RUNTIME/native_bundle['path']) == native_bundle['sha256']
    technique_audit = read(EVIDENCE/'technique_interaction_audit_20261014.json')
    for name, expected in technique_audit['fingerprints'].items():
        # Implementation fingerprints belong to their dated observation. Source
        # inputs remain immutable while later code is allowed to evolve.
        if not name.startswith('remake/'):
            assert sha(ROOT/name) == expected, f'Menu interaction input changed: {name}'
    fidelity_rules = read(EVIDENCE/'fidelity_rules.json')
    for name, expected in fidelity_rules['source_hashes'].items(): assert sha(ROOT/name) == expected
    for key in ['native_bundle', 'native_snapshot']:
        bundle = fidelity_rules[key]
        assert sha(RUNTIME/bundle['path']) == bundle['sha256']
    party_commands = read(WEB/'data/party_skills.json')
    native_bundles = [party_commands['native_bundle'], *[skill['magic_native_bundle']
                     for skill in party_commands['skills'].values() if 'magic_native_bundle' in skill]]
    for row in native_bundles:
        assert sha(RUNTIME/row['path']) == row['sha256'], f'Party native evidence changed: {row["path"]}'
    retained_migrations = []
    for name, expected in baseline['asset_hashes'].items():
        migration = verify_retained_asset(name, expected)
        if migration:
            retained_migrations.append(migration)
    extraction_names = ['combat_sample', 'forest_combat', 'forest_ai', 'forest_rewards',
                        'battle_scheduler', 'forest_reactions', 'forest_status', 'skills']
    for name in extraction_names:
        path = f'remake/runtime/web/data/{name}.json'
        if name in ['forest_combat', 'forest_ai', 'forest_rewards', 'battle_scheduler', 'forest_status']:
            retained = EVIDENCE/'export_tools_20261022/legacy_extractions'/f'{name}.json'
            assert sha(retained) == baseline['current_fingerprints'][path], f'Retained extraction baseline changed: {name}'
            expected = next((digest for output, digest in system_outputs.items()
                             if exported_path(output).resolve() == (ROOT/path).resolve()), None)
            assert expected, f'Current extraction missing export ledger: {name}'
            assert sha(ROOT/path) == expected, f'Current extraction changed after export: {name}'
        else:
            assert sha(ROOT/path) == baseline['current_fingerprints'][path], f'Extraction baseline changed: {name}'

    cleanup = read(REMAKE/'archive/20261011_before_chapter/cleanup_record.json')
    assert cleanup['completed'] and cleanup['protected_files_unchanged'] == len(cleanup['protected_files'])
    archived_docs = [*cleanup['moved'], *cleanup['copied_before_rewrite'], *cleanup['archived_obsolete_tools']]
    for row in archived_docs:
        path = (REMAKE/row['archive']).resolve()
        assert path.is_relative_to((REMAKE/'archive').resolve())
        assert sha(path) == row['sha256'], f'Historical document changed: {path}'
    rows = cleanup['compressed_snapshots']
    assert len({row['zip'] for row in rows}) == 1
    zip_path = (REMAKE/rows[0]['zip']).resolve()
    assert zip_path.is_relative_to((REMAKE/'archive').resolve())
    assert sha(zip_path) == cleanup['snapshot_zip_sha256']
    restored = []
    with zipfile.ZipFile(zip_path) as bundle:
        assert sorted(bundle.namelist()) == sorted(row['member'] for row in rows)
        for row in rows:
            assert hashlib.sha256(bundle.read(row['member'])).hexdigest() == row['sha256'], row['member']
            target = (REMAKE/row['old']).resolve()
            assert target.is_relative_to(REMAKE.resolve())
            if target.exists():
                assert sha(target) == row['sha256'], f'Restored snapshot changed: {target}'
                restored.append(row['old'])
    # The cleanup's complete before/after proof is historical; current code is allowed to evolve.
    # Source resources, retained assets and archive members remain checked above.
    assert not (RUNTIME/'tools/update_forest_combat_docs.py').exists(), 'Retired document writer returned'
    docs = ['README.txt', 'AGENTS.md', 'runtime/README.txt', 'runtime/architecture.txt', 'runtime/config_guide.txt', 'runtime/tools/README.txt',
            'prototype/README.md', 'assessment/validation_design.txt', 'assessment/menu_alignment_workflow.txt', 'archive/README.txt']
    assert all((REMAKE/name).is_file() for name in docs)
    prototype_readme = (REMAKE/'prototype/README.md').read_text(encoding='utf-8')
    for ref in re.findall(r'\]\(([^)]+)\)', prototype_readme):
        assert (REMAKE/'prototype'/ref).resolve().is_file(), f'Broken documentation link: {ref}'
    # Python syntax validation does not regenerate __pycache__.
    python_paths = [*RUNTIME.glob('tools/*.py'), *RUNTIME.glob('tools/source/*.py'), *RUNTIME.glob('tests/test_*.py'), REMAKE/'archive/restore_snapshot.py', RUNTIME/'serve.py']
    for path in python_paths: compile(path.read_text(encoding='utf-8-sig'), str(path), 'exec')

    catalog = read(WEB/'data/catalog.json')
    assert catalog['runtime_config'] == 'data/config/index.json'
    checklist = read(WEB/catalog['content_checklist'])
    assert checklist['schema'] == 'seventh-seal-chapter-content-checklist' and checklist['version'] == 1
    assert len({r['id'] for r in checklist['entries']}) == len(checklist['entries'])
    for row in checklist['entries']:
        assert all((ROOT/name).is_file() for name in row['sources']), row['id']
        assert all((RUNTIME/'tests'/name).is_file() for name in row['tests']), row['id']
        if row['kind'].startswith('required'): assert row['status'] == 'implemented' and row['tests'], row['id']
    refs = {path.relative_to(WEB).as_posix() for glob in ['*.html', '*.css', '*.js', '*.mjs', 'controllers/*.mjs', 'core/*.mjs', 'data/config/*.json']
            for path in WEB.glob(glob)}
    refs.add('data/catalog.json')
    refs.update(path.relative_to(WEB).as_posix() for path in (WEB/'phaser').rglob('*.mjs'))
    refs.update(path.relative_to(WEB).as_posix() for path in (WEB/'vendor/phaser').iterdir() if path.is_file())
    refs.update(['data/runtime_content.json','data/runtime_content.mjs'])
    for key in ['seed', 'events', 'combat_sample', 'battle_view', 'runtime_config', 'world_map',
                'route_events', 'encounters', 'forest_combat', 'forest_battle_view', 'opening_program', 'opening_resources', 'chapter_story', 'chapter_resources',
                'party_combat', 'party_skills', 'party_rewards', 'party_reactions', 'party_battle_view', 'items', 'item_presentation', 'audio', 'operation_menu', 'content_checklist','map_shadows']:
        if catalog.get(key): refs.add(catalog[key])
    refs.update(row['path'] for row in catalog['maps'])
    refs.add('core/movement.mjs')
    refs.update(action['sheet'] for role in catalog['roles'] for action in role['actions'])
    opening_resources = read(WEB/catalog['opening_resources'])
    refs.update(a['sheet'].lstrip('/') for r in opening_resources['roles'].values() for a in r['actions'])
    chapter_resources = read(WEB/catalog['chapter_resources'])
    refs.update(a['sheet'].lstrip('/') for r in chapter_resources['roles'].values() for a in r['actions'])
    refs.update(frame['image'].lstrip('/') for rows in chapter_resources['object_animations'].values()
                for item in rows for frame in item['frames'])
    # Export reports enumerate every audited party manifest and PNG, including
    # role-specific layers and effects loaded only after an encounter.
    for name in party_outputs:
        path = exported_path(name)
        if path.is_relative_to(WEB): refs.add(path.relative_to(WEB).as_posix())
    for name in system_outputs:
        path = exported_path(name)
        if path.is_relative_to(WEB): refs.add(path.relative_to(WEB).as_posix())
    for map_id in ['M72061', 'M17020', 'M17026', 'M17029']:
        data = read(WEB/f'data/maps/{map_id.lower()}.json')
        refs.add(data['background'] if isinstance(data['background'], str) else data['background']['image'])
        refs.update(row['image'] for row in data['objects'])
    for ref in sorted(refs):
        path = WEB/ref.lstrip('/')
        with urllib.request.urlopen('http://127.0.0.1:8767/'+ref.lstrip('/'), timeout=10) as response:
            assert response.status == 200
            assert hashlib.sha256(response.read()).hexdigest() == sha(path), f'HTTP resource differs: {ref}'

    content_check = subprocess.run(['node', str(RUNTIME/'tools/export_content_registry.mjs'), '--check'],
                                   cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
    assert content_check.returncode == 0, content_check.stdout + content_check.stderr
    content_summary = json.loads(content_check.stdout)
    tests = sorted((RUNTIME/'tests').glob('test_*.mjs'))
    result = subprocess.run(['node', '--import', (RUNTIME/'tests/preserve_history.mjs').as_uri(),
                             '--test', '--test-reporter=tap', *map(str, tests)],
                            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8')
    (EVIDENCE/'current_validation.tap').write_text(result.stdout, encoding='utf-8')
    assert result.returncode == 0, result.stdout[-12000:]
    counts = {key:int(re.search(r'^# '+key+r' (\d+)', result.stdout, re.M).group(1)) for key in ['tests', 'pass', 'fail', 'skipped']}
    assert counts['tests'] == counts['pass'] >= 196 and counts['fail'] == counts['skipped'] == 0
    python_tests = subprocess.run([sys.executable, '-X', 'utf8', '-B', '-m', 'unittest', 'discover', '-s', str(RUNTIME/'tests'), '-p', 'test_*.py'],
                                  cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8')
    (EVIDENCE/'current_python_tests.log').write_text(python_tests.stdout, encoding='utf-8')
    assert python_tests.returncode == 0, python_tests.stdout
    for name, expected in original_inputs.items(): assert sha(ROOT/name) == expected, f'Original input changed during checks: {name}'
    for name, expected in opening_sources.items(): assert sha(ROOT/name) == expected, f'Opening input changed during checks: {name}'
    for name, expected in party_sources.items(): assert sha(ROOT/name) == expected, f'Party input changed during checks: {name}'
    for name, expected in system_sources.items(): assert sha(ROOT/name) == expected, f'System input changed during checks: {name}'
    current = [*tests, *RUNTIME.glob('tests/test_*.py'), RUNTIME/'tools/build_runtime.py', *WEB.glob('*.html'), *WEB.glob('*.css'), *WEB.glob('*.js'), *WEB.glob('*.mjs'), *WEB.glob('core/*.mjs'), *WEB.glob('controllers/*.mjs'), *WEB.glob('data/config/*.json'),
               *WEB.glob('phaser/**/*.mjs'), *WEB.glob('vendor/phaser/*'), RUNTIME/'tools/verify_phaser.mjs',
               WEB/'data/catalog.json', WEB/'data/runtime_content.json', WEB/'data/runtime_content.mjs',
               RUNTIME/'tools/export_content_registry.mjs', RUNTIME/'tools/content_registration.py', RUNTIME/'tools/layout_migration.json', RUNTIME/'tests/preserve_history.mjs', Path(__file__),
               REMAKE/'archive/restore_snapshot.py', *[REMAKE/name for name in docs], *[exported_path(name) for name in system_outputs if exported_path(name).suffix=='.json']]
    browser_path = next((EVIDENCE/name for name in ['white_forest_20261026/browser_validation.json','fire_valley_20261025/browser_validation.json','battle_loading_browser_validation_20261021.json','dialogue_alignment_browser_validation_20261021.json','prologue_routes_browser_validation_20261021.json','prologue_routes_browser_validation_20261020.json','prologue_sequence_browser_validation_20261020.json','prologue_browser_validation_20261020.json','startup_save_preview_browser_validation_20261020.json','startup_alignment_browser_validation_20261020.json','battle_wheel_closed_browser_validation_20261020.json','battle_result_text_browser_validation_20261020.json','battle_result_browser_validation_20261020.json','skill_test_browser_validation_20261020.json','battle_lifecycle_browser_validation_20261015.json','battle_render_browser_validation_20261015.json','battle_alignment_browser_validation_20261015.json','roster_focus_browser_validation_20261014.json','menu_audio_browser_validation_20261014.json','technique_list_browser_validation_20261014_v2.json','technique_list_browser_validation_20261014.json','menu_focus_browser_validation_20261014.json','technique_replace_browser_validation_20261014.json','menu_finish_browser_validation_20261014.json','menu_socket_browser_validation_20261014.json','menu_detail_browser_validation_20261014.json','refactor_browser_validation.json', 'operation_menu_original_browser_validation.json', 'operation_menu_fidelity_browser_validation.json', 'operation_menu_browser_validation.json', 'chapter_systems_browser_validation.json', 'skill_config_browser_validation.json', 'party_browser_validation.json']
                         if (EVIDENCE/name).is_file()), EVIDENCE/'party_browser_validation.json')
    browser = read(browser_path) if browser_path.exists() else None
    observation_path = ROOT/browser.get('observation_path', 'remake/runtime/evidence/party_browser_observation.json') if browser else EVIDENCE/'party_browser_observation.json'
    browser_matches = bool(browser and browser.get('passed') and browser.get('current_fingerprints')
        and browser.get('evidence_fingerprints') and all(
            (ROOT/name).is_file() and sha(ROOT/name) == expected
            for field in ['current_fingerprints', 'evidence_fingerprints']
            for name, expected in browser.get(field, {}).items())
        and observation_path.resolve().is_relative_to(EVIDENCE.resolve()) and observation_path.is_file()
        and sha(observation_path) == browser.get('observation_sha256'))
    return dict(tests=counts, test_files=len(tests), content_registration=content_summary, python_syntax_checks=len(python_paths), http_checks=sorted(refs),
                original_input_sha256=original_inputs, retained_sources_assets_checked=len(baseline['asset_hashes']),
                retained_layout_migrations=retained_migrations,
                extraction_baselines_checked=extraction_names,
                archive=dict(documents_checked=len(archived_docs), snapshots_checked=len(rows), zip_sha256=sha(zip_path),
                             restored_snapshots=restored, bytes_reclaimed_at_cleanup=cleanup['bytes_reclaimed'],
                             protected_files_unchanged_at_cleanup=cleanup['protected_files_unchanged']),
                current_fingerprints={p.relative_to(ROOT).as_posix():sha(p) for p in current},
                opening_sources_checked=len(opening_sources), opening_assets_checked=len(opening_export['output_hashes']),
                chapter_sources_checked=len(chapter_sources),chapter_assets_checked=len(chapter_outputs),
                party_sources_checked=len(party_sources),party_assets_checked=len(party_outputs),
                party_native_evidence_checked=len(native_bundles),
                menu_crystal_native_records_checked=len(crystal_ids),
                chapter_system_sources_checked=len(system_sources), chapter_system_assets_checked=len(system_outputs),
                separate_browser_evidence=dict(path=browser_path.relative_to(ROOT).as_posix(),
                                               matches_current_files=browser_matches,
                                               checked_utc=browser.get('checked_utc') if browser else None),
                python_regression=dict(passed=True, test_files=len(list((RUNTIME/'tests').glob('test_*.py'))),
                                       tests=int(re.search(r'Ran (\d+) tests?', python_tests.stdout).group(1))),
                actual_browser_flow_checked_this_run=False, original_game_execution_observed=False,
                limits=['This validates the current existing slice and workspace integrity; it does not complete the chapter.',
                        'Historical browser observations are retained and are not claimed as a fresh UI replay.',
                        'New-game party combat, item/equipment/rest/game-over and audio use source rules; exact original rendering and later story branches are still bounded by the content checklist.'])

def main():
    report = dict(schema='seventh-seal-current-validation', version=1,
                  checked_utc=datetime.now(timezone.utc).isoformat(), passed=False)
    try:
        report.update(verify(), passed=True)
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    if not report['passed']:
        print(report['error'])
        raise SystemExit(1)
    print(json.dumps(dict(passed=True, tests=report['tests'], http=len(report['http_checks']),
                          original_inputs=len(report['original_input_sha256']), retained_sources_assets=report['retained_sources_assets_checked'],
                          archived_documents=report['archive']['documents_checked'], archived_snapshots=report['archive']['snapshots_checked']), ensure_ascii=False))

if __name__ == '__main__': main()
