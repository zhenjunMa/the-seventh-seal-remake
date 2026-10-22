"""Exercise incremental exports and evidence preservation in an isolated tree."""
from pathlib import Path
import importlib.util
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOL = Path(__file__).resolve().parents[1] / 'tools/build_runtime.py'
spec = importlib.util.spec_from_file_location('runtime_build_test_module', TOOL)
build = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = build
spec.loader.exec_module(build)


class BuildTests(unittest.TestCase):
    def test_asset_counts_do_not_break_source_ledger_and_aliases_still_resolve(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            evidence = root/'evidence'; evidence.mkdir()
            source = root/'assets/source.dgp'; source.parent.mkdir(); source.write_bytes(b'original')
            ledger = evidence/'export.json'
            step = build.Step('export.py', ('output.json',), reports=('export.json',))
            with patch.multiple(build, ROOT=root, EVIDENCE=evidence):
                for assets in [27, {}, None, []]:
                    ledger.write_text(json.dumps({'source_hashes':{'assets/source.dgp':build.sha(source)}, 'assets':assets}))
                    self.assertEqual(build.source_paths(step), {source})
                ledger.write_text(json.dumps({'source_hashes':{'source.dgp':build.sha(source)},
                    'assets':[{'source':{'path':'assets/source.dgp'}}, {'source':None}]}))
                self.assertEqual(build.source_paths(step), {source})

    def test_first_export_tracks_sources_without_an_existing_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            runtime, web, evidence = root/'runtime', root/'runtime/web', root/'runtime/evidence'
            web.mkdir(parents=True); evidence.mkdir()
            source = root/'new-map.dat'; source.write_bytes(b'original')
            steps = {'new-map': build.Step('map.py', ('map.json',), reports=('map_export.json',), sources=('new-map.dat',))}
            called = []
            def exporter(command, name):
                called.append(name)
                (web/'map.json').write_text('generated')
                (evidence/'map_export.json').write_text(json.dumps({'source_hashes': {'new-map.dat': build.sha(source)}}))
            stamp = build.datetime.now(build.timezone.utc)
            with patch.multiple(build, ROOT=root, RUNTIME=runtime, WEB=web, EVIDENCE=evidence, STEPS=steps), patch.object(build, 'datetime') as clock:
                clock.now.return_value = stamp
                build.execute(['new-map'], run_command=exporter)
                build.execute(['new-map'], run_command=exporter)
                self.assertEqual(called, ['new-map'])
                source.write_bytes(b'updated original')
                build.execute(['new-map'], run_command=exporter)
                self.assertEqual(called, ['new-map', 'new-map'])
                self.assertEqual(len(list((evidence/'builds').iterdir())), 3)

    def test_added_source_inventory_is_allowed_but_input_mutation_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();runtime=root/'runtime';web=runtime/'web';evidence=runtime/'evidence'
            web.mkdir(parents=True);evidence.mkdir()
            first=root/'first.chr';second=root/'second.chr'
            first.write_bytes(b'first');second.write_bytes(b'second')
            ledger=evidence/'export.json'
            ledger.write_text(json.dumps({'source_hashes':{'first.chr':build.sha(first)}}))
            steps={'roles':build.Step('roles.py',('roles.json',),reports=('export.json',))}
            def exporter(command,name):
                (web/'roles.json').write_text('new role')
                ledger.write_text(json.dumps({'source_hashes':{'first.chr':build.sha(first),'second.chr':build.sha(second)}}))
            with patch.multiple(build,ROOT=root,RUNTIME=runtime,WEB=web,EVIDENCE=evidence,STEPS=steps):
                self.assertTrue(build.execute(['roles'],run_command=exporter)['passed'])
                def corrupt(command,name):
                    exporter(command,name);first.write_bytes(b'changed')
                with self.assertRaisesRegex(RuntimeError,'changed original inputs'):
                    build.execute(['roles'],force=True,run_command=corrupt)

    def test_dependency_order_and_cycle(self):
        steps = {'a':build.Step('a.py', ('a.json',)), 'b':build.Step('b.py', ('b.json',), ('a',))}
        self.assertEqual(build.plan(['b', 'a'], steps), ['a', 'b'])
        steps['a'] = build.Step('a.py', ('a.json',), ('b',))
        with self.assertRaisesRegex(ValueError, 'cycle'):
            build.plan(['a'], steps)

    def test_incremental_output_validation_resume_and_old_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.assertTrue(root.is_relative_to(Path(tempfile.gettempdir()).resolve()))
            runtime, web, evidence = root/'runtime', root/'runtime/web', root/'runtime/evidence'
            web.mkdir(parents=True); evidence.mkdir()
            original = root/'original.dat'; original.write_bytes(b'input')
            history = evidence/'export_20261011.json'
            original_report = json.dumps({'source_hashes':{'original.dat':build.sha(original)}}).encode()
            history.write_bytes(original_report)
            steps = {'a':build.Step('a.py', ('a.json',), reports=(history.name,)),
                     'b':build.Step('b.py', ('b.json',), ('a',))}
            called = []
            fail = {'b':True}
            def exporter(command, name):
                called.append(name)
                if fail.get(name):
                    raise RuntimeError('controlled failure')
                (web/f'{name}.json').write_text('new output')
                if name == 'a':
                    history.write_text('new evidence, retained separately')
            with patch.multiple(build, ROOT=root, RUNTIME=runtime, WEB=web, EVIDENCE=evidence, STEPS=steps):
                with self.assertRaisesRegex(RuntimeError, 'controlled failure'):
                    build.execute(['b'], run_command=exporter)
                self.assertEqual(history.read_bytes(), original_report)
                self.assertEqual(set(json.loads((evidence/'build_state.json').read_text())['steps']), {'a'})
                fail['b'] = False
                build.execute(['b'], run_command=exporter)
                self.assertEqual(called, ['a', 'b', 'b'])
                build.execute(['b'], run_command=exporter)
                self.assertEqual(called, ['a', 'b', 'b'])
                (web/'a.json').unlink()
                build.execute(['b'], run_command=exporter)
                self.assertEqual(called, ['a', 'b', 'b', 'a'])
                self.assertEqual(original.read_bytes(), b'input')
                self.assertEqual(history.read_bytes(), original_report)
                generated = list((evidence/'builds').glob('*/a/generated-evidence/export_20261011.json'))
                self.assertTrue(generated)
                self.assertEqual(generated[0].read_text(), 'new evidence, retained separately')


if __name__ == '__main__':
    unittest.main()
