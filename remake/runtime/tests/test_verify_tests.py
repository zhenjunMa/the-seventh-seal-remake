"""验收入口的选择和复用会影响交付结论，使用隔离小项目验证实际行为。"""
from pathlib import Path
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import verify_tests as verify


class VerificationWorkflowTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='seal-test-workflow-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.runtime = self.root / 'remake/runtime'
        self.tests = self.runtime / 'tests'
        self.tests.mkdir(parents=True)
        replacements = dict(ROOT=self.root, RUNTIME=self.runtime, TESTS=self.tests,
                            MANIFEST=self.tests/'suites.json', CACHE=self.runtime/'.cache/results')
        for name, value in replacements.items():
            guard = patch.object(verify, name, value)
            guard.start()
            self.addCleanup(guard.stop)
        self.manifest = dict(version=2, suites={
            'runtime': dict(files=['test_a.mjs', 'test_b.mjs'], layer='component', cache=True),
            'content-full': dict(files=['test_sweep.mjs'], layer='content', cache=True,
                                 regions=['fire-valley'])},
            profiles=dict(task=['runtime'], phase=['runtime', 'content-full']), smoke=[],
            domains={'movement': dict(modules=['web/core/move.mjs'], tests=[])},
            regions={'fire-valley': dict(tests=['test_sweep.mjs']),
                     'ember-city': dict(tests=[])}, requirements={})
        self.write('tests/suites.json', json.dumps(self.manifest))
        self.write('tests/test_a.mjs', "import '../web/core/adapter.mjs';")
        self.write('tests/test_b.mjs', "import '../web/core/other.mjs';")
        self.write('tests/test_sweep.mjs', '')
        self.write('web/core/adapter.mjs', "export {move} from './move.mjs';")
        self.write('web/core/move.mjs', 'export const move=1;')
        self.write('web/core/other.mjs', 'export const other=1;')

    def write(self, name, content):
        path = self.runtime / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
        return path

    def plan(self, *paths, **options):
        return verify.make_plan(self.manifest, changed=['remake/runtime/'+p for p in paths], **options)

    def test_transitive_import_and_deleted_module_select_the_consumer(self):
        self.assertEqual(self.plan('web/core/move.mjs')['files'], ['test_a.mjs'])
        (self.runtime/'web/core/move.mjs').unlink()
        self.assertEqual(self.plan('web/core/move.mjs')['files'], ['test_a.mjs'])
        self.assertEqual(self.plan(domains=['movement'])['files'], ['test_a.mjs'])

    def test_document_only_unknown_code_and_dynamic_content_have_explicit_scopes(self):
        self.assertEqual(self.plan('README.md')['files'], [])
        self.assertEqual(self.plan('web/new_adapter.mjs')['files'], ['test_a.mjs', 'test_b.mjs'])
        plan = self.plan('web/data/maps/m01030.json')
        self.assertTrue(plan['content_check'])
        self.assertEqual(plan['files'], ['test_a.mjs', 'test_b.mjs'])
        with self.assertRaises(ValueError):
            self.plan(patterns=['does-not-exist'])

    def test_phase_keeps_full_traversal_and_respects_region_without_dropping_shared_rules(self):
        all_phase = self.plan(profile='phase')['files']
        self.assertIn('test_sweep.mjs', all_phase)
        self.assertEqual(self.plan(profile='phase', regions=['ember-city'])['files'],
                         ['test_a.mjs', 'test_b.mjs'])
        self.assertEqual(self.plan(profile='phase', regions=['fire-valley'])['files'], all_phase)

    def test_original_inputs_and_decoders_require_source_verification(self):
        self.manifest['suites']['source'] = dict(files=['test_source.mjs'], layer='source', cache=False)
        self.assertIn('test_source.mjs', self.plan('tools/source/format.py')['files'])
        plan = verify.make_plan(self.manifest, changed=['Map/new.dat'])
        self.assertIn('test_source.mjs', plan['files'])

    def runnable(self, *, cache=True, requirement=None, body='self.assertTrue(True)'):
        marker = self.root/'executions.txt'
        self.write('tests/test_sample.py',
                   'import unittest\nfrom pathlib import Path\nclass Sample(unittest.TestCase):\n'
                   ' def test_behavior(self):\n'
                   f'  marker=Path({str(marker)!r})\n'
                   "  marker.write_text(marker.read_text()+'x' if marker.exists() else 'x')\n"
                   f'  {body}\n')
        self.manifest['suites'] = {'runtime': dict(files=['test_sample.py'], layer='rule', cache=cache)}
        self.manifest['requirements'] = {'test_sample.py': [requirement]} if requirement else {}
        self.write('tests/suites.json', json.dumps(self.manifest))
        return marker

    def run_sample(self, **options):
        return verify.run_selected(self.manifest, ['test_sample.py'], jobs=1, **options)

    def test_success_reuse_ignores_docs_but_invalidates_changed_inputs_and_fresh_runs(self):
        marker = self.runnable()
        self.write('web/data/settings.json', '{"value":1}')
        first = self.run_sample()
        self.assertTrue(first['passed'])
        self.write('README.md', '文档变化')
        second = self.run_sample()
        self.assertEqual(second['runs'][0]['reused'], 1)
        self.assertEqual(marker.read_text(), 'x')
        with patch.dict(os.environ, CODEX_TOOL_CALL_ID='another-terminal-invocation'):
            self.assertEqual(self.run_sample()['runs'][0]['reused'], 1)
        self.assertEqual(marker.read_text(), 'x')
        self.write('web/data/settings.json', '{"value":2}')
        self.assertTrue(self.run_sample()['passed'])
        self.assertEqual(marker.read_text(), 'xx')
        self.assertTrue(self.run_sample(reuse=False)['passed'])
        self.assertEqual(marker.read_text(), 'xxx')
        (verify.CACHE/'test_sample.py.json').write_text('{broken')
        self.assertTrue(self.run_sample()['passed'])
        self.assertEqual(marker.read_text(), 'xxxx')

    def test_failed_and_external_cases_are_always_executed(self):
        marker = self.runnable(body='self.fail("deliberate product failure")')
        self.assertFalse(self.run_sample()['passed'])
        self.assertFalse(self.run_sample()['passed'])
        self.assertEqual(marker.read_text(), 'xx')
        marker.unlink()
        self.runnable(cache=False)
        self.assertTrue(self.run_sample()['passed'])
        self.assertTrue(self.run_sample()['passed'])
        self.assertEqual(marker.read_text(), 'xx')

    def test_a_wider_run_reuses_portable_success_while_executing_external_checks(self):
        marker = self.runnable()
        self.manifest['suites']['source'] = dict(files=['test_external.py'], layer='source',
                                                cache=False, requires=['input.dat'])
        (self.root/'input.dat').write_bytes(b'original')
        self.write('tests/test_external.py',
                   'import unittest\nclass External(unittest.TestCase):\n'
                   ' def test_source(self): self.assertEqual(1+1,2)\n')
        self.write('tests/suites.json', json.dumps(self.manifest))
        self.assertTrue(self.run_sample()['passed'])
        wider = verify.run_selected(self.manifest, ['test_sample.py', 'test_external.py'], jobs=1)
        self.assertTrue(wider['passed'])
        self.assertEqual(wider['runs'][0]['reused'], 1)
        self.assertEqual(wider['runs'][0]['executed'], 1)
        self.assertEqual(marker.read_text(), 'x')

    def test_missing_prerequisites_and_mutating_inputs_cannot_produce_a_cached_pass(self):
        marker = self.runnable(cache=False, requirement='Map/missing.dat')
        report = self.run_sample()
        self.assertFalse(report['passed'])
        self.assertIn('Map/missing.dat', report['missing'])
        self.assertFalse(marker.exists())
        target = self.write('web/data/settings.json', '{"value":1}')
        self.runnable(body=f'Path({str(target)!r}).write_text("changed")')
        report = self.run_sample()
        self.assertFalse(report['passed'])
        self.assertIn('remake/runtime/web/data/settings.json', report['changed_inputs'])
        self.assertFalse((verify.CACHE/'test_sample.py.json').exists())


if __name__ == '__main__':
    unittest.main()
