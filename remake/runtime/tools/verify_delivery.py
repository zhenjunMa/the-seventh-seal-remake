"""Check source identity, resource references and pin this local runtime delivery."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
from migrate_local_materials import relocated_path

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME/'web'
EVIDENCE = RUNTIME/'evidence'

def read(path):
    return json.loads(path.read_text(encoding='utf-8'))

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

catalog = read(WEB/'data/catalog.json')
map_report = read(EVIDENCE/'map_export_20261011.json')
npc_report = read(EVIDENCE/'npc_export_20261011.json')
layer_report = read(EVIDENCE/'yantu_layers_verification_20261011.json')
seed = read(WEB/'data/world_seed.json')
actors = read(EVIDENCE/'turn_actor_verification_20261011.json')
combat_view = read(EVIDENCE/'battle_view_export_20261011.json')
sources = {}
for group in [map_report['input_hashes'], npc_report['source_hashes'],
              layer_report['source_hashes_before'], actors['source_fingerprints'],combat_view['source_hashes'],
              {seed['source']['path']: seed['source']['sha256']}]:
    for path, expected in group.items():
        assert sources.get(path, expected) == expected, ('inconsistent source reference', path)
        sources[path] = expected
for path, expected in sources.items():
    assert sha(ROOT/path) == expected, ('original input changed', path)
for path, expected in layer_report['prototype_hashes_before'].items():
    assert sha(relocated_path(path)) == expected, ('historical relocated dependency changed', path)

assets = set()
for role in catalog['roles']:
    assets.update(action['sheet'] for action in role['actions'] if action['index'] <= 2)
for entry in catalog['maps']:
    path = WEB/entry['path']
    assert sha(path) == entry['sha256']
    data = read(path)
    assets.add(data['background']['image'])
    assets.update(obj['image'] for obj in data['objects'])
events = read(WEB/catalog['events'])
original_event = read(WEB/'data/events/detective.json')
assert len(events) == 1
for key in ['program', 'source', 'commit_policy']:
    assert events[0][key] == original_event[key], ('compiled event differs', key)
assets.update(event['npc']['resource']['sheet'] for event in events)
layers = read(WEB/'data/yantu_layers.json')
assert sha(WEB/'data/yantu_layers.json') == layer_report['manifest_sha256']
for frame in layers['frames']:
    for key in ['main', 'intrinsic']:
        item = frame[key]
        assert sha(WEB/item['path']) == item['sha256'], ('frame hash mismatch', item['path'])
        assets.add(item['path'])
view_tests = read(EVIDENCE/'battle_view_tests_20261011.json')
assert view_tests['passed'] and view_tests['test_count']==10
assert combat_view['original_sources_unchanged'] and combat_view.get('runtime_view_code_unchanged', combat_view.get('prototype_code_unchanged', False))
assert sha(WEB/'data/battle_view.json')==combat_view['metadata_sha256']
assert sha(WEB/'data/combat_sample.json')==actors['sample_sha256']
assert actors['sources_unchanged'] and actors['all_sample_evidence_references_resolve']
assert read(EVIDENCE/'turn_rules_verification_20261011.json')['passed']
for item in view_tests['actual_assets_checked']:
    assets.add(item['path'])
asset_hashes = {}
for url in sorted(assets):
    if url.startswith('/prototype/'):
        path = WEB/url[len('/prototype/'):]
    else:
        path = WEB/url.lstrip('/')
    assert path.is_file(), ('missing runtime asset', url)
    asset_hashes[url] = sha(path)
for item in view_tests['actual_assets_checked']:
    assert asset_hashes[item['path']]==item['sha256']

core = read(EVIDENCE/'core_verification_20261011.json')
assert core['tests'] == core['passed'] == 32 and core['failed'] == 0
for path, expected in core['code_hashes'].items():
    assert sha(RUNTIME/path) == expected, ('core changed after test', path)
assert read(EVIDENCE/'map_verification_20261011.json')['success']
assert read(EVIDENCE/'map_transition_movement_20261011.json')['success']
assert read(EVIDENCE/'http_verification_20261011.json')['success']
assert read(EVIDENCE/'npc_verification_20261011.json')['native_record_vs_program_match']
slice_report = read(EVIDENCE/'slice_verification_20261011.json')
assert len(slice_report['checks']) == 2 and all(check['passed'] for check in slice_report['checks'])
assert slice_report['seed_sha256'] == sha(WEB/'data/world_seed.json')
assert layer_report['original_inputs_unchanged']
browser = read(EVIDENCE/'browser_verification_20261011.json')
assert browser['console_warning_error_count'] == 0
# Earlier browser results are retained as history; current pins come from 0.2.1.
browser_turn = read(EVIDENCE/'turn_browser_verification_20261011.json')
assert browser_turn['success'] and browser_turn['console_warning_error_count']==0
browser_config=read(EVIDENCE/'skill_config_browser_20261011.json')
assert browser_config['success'] and browser_config['console_warning_error_count']==0
for path, expected in browser_config['final_ui_code_sha256'].items():
    assert sha(RUNTIME/path) == expected, ('UI changed after config browser verification', path)
for path, expected in browser_turn['screenshot_sha256'].items():
    assert sha(EVIDENCE/path)==expected
for path,expected in browser_config['screenshot_sha256'].items():
    assert sha(EVIDENCE/path)==expected
config_tests=read(EVIDENCE/'skill_config_verification_20261011.json')
assert config_tests['tests']==config_tests['passed']==8 and config_tests['failed']==0
for path,expected in config_tests['code_hashes'].items():
    assert sha(RUNTIME/path)==expected
suite=read(EVIDENCE/'test_suite_20261011.json')
assert suite['success'] and suite['counts']=={'tests':84,'pass':84,'fail':0}
for path,expected in suite['code_hashes'].items():
    assert sha(RUNTIME/path)==expected,('Code changed after final test suite',path)
for name in browser['screenshots']:
    assert (EVIDENCE/name).is_file(), ('missing browser screenshot', name)

output = EVIDENCE/'runtime_delivery_20261011.json'
files = [path for path in RUNTIME.rglob('*') if path.is_file() and path != output
         and '__pycache__' not in path.parts]
files += [ROOT/name for name in ['remake/start.cmd', 'remake/start_runtime.cmd',
          'remake/start_prototype.cmd', 'remake/README.md', 'remake/prototype/README.md',
          'remake/assessment/validation_design.md', 'remake/assessment/menu_alignment_workflow.md',
          'remake/archive/20261011_before_chapter/assessment/runtime_phase1_20261011.txt',
          'remake/archive/20261011_before_chapter/assessment/runtime_phase2_20261011.txt']]
report = dict(schema='seventh-seal-runtime-delivery', version=1,
              created_utc=datetime.now(timezone.utc).isoformat(), success=True,
              original_inputs_unchanged=True, source_sha256=sources,
              referenced_asset_sha256=asset_hashes,
              output_sha256={path.relative_to(ROOT).as_posix(): sha(path) for path in sorted(files)},
              tests=dict(core=32, real_source_slice=2, turn_lifecycle=14,native_rules=9,actor_adapter=6,
                         battle_view=10,real_turn_sample=3,skill_config=8,total=84,http=14,browser_turn_checks=8,browser_config_checks=5),
              original_game_execution_observed=False,
              scope='Runtime 0.2.1: exploration/event/transition/save, source-backed controlled turns and readable skill config; original gauges/AI/rewards/encounters pending')
output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps(dict(original_source_fingerprints=len(sources), runtime_assets=len(assets),
                      output_fingerprints=len(files), success=True)))
