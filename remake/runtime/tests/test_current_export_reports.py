"""Current reports follow exact declared ownership; milestone bytes stay intact."""
from pathlib import Path
from types import SimpleNamespace
import hashlib
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
import verify_current as verify
import build_runtime as build


class CurrentExportReportTests(unittest.TestCase):
    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')

    def run(self, result=None):
        with tempfile.TemporaryDirectory() as temporary:
            self.evidence = Path(temporary)
            with patch.object(verify, 'EVIDENCE', self.evidence):
                return super().run(result)

    def ledger(self, name, step, value=None, passed=True, status='exported', report='report_20261011.json'):
        directory = self.evidence / 'builds' / name
        self.write(directory / 'run.json', {'passed': passed, 'steps': [{'name': step, 'status': status}]})
        if value is not None:
            self.write(directory / step / 'generated-evidence' / report, {'value': value})

    def snapshot(self):
        return {path.relative_to(self.evidence): path.read_bytes() for path in self.evidence.rglob('*') if path.is_file()}

    def test_latest_successful_owner_report_wins_without_touching_history(self):
        steps = {'party': SimpleNamespace(reports=('report_20261011.json',))}
        self.write(self.evidence / 'report_20261011.json', {'value': 'milestone'})
        self.ledger('20260101', 'party', 'old')
        self.ledger('20260102', 'party', 'current')
        self.ledger('20260103', 'party', 'failed', passed=False)
        self.ledger('20260104', 'party', 'cached-no-export', status='cached')
        self.ledger('20260105', 'unrelated', 'wrong-owner')
        before = self.snapshot()
        self.assertEqual(verify.current_export('report_20261011.json', steps=steps), {'value': 'current'})
        self.assertEqual(self.snapshot(), before)

    def test_latest_export_without_copy_does_not_resurrect_an_older_changed_report(self):
        steps = {'party': SimpleNamespace(reports=('report_20261011.json',))}
        self.write(self.evidence / 'report_20261011.json', {'value': 'latest-equals-baseline'})
        self.ledger('20260101', 'party', 'previous-different-export')
        self.ledger('20260102', 'party')
        self.assertEqual(verify.current_export('report_20261011.json', steps=steps)['value'], 'latest-equals-baseline')

    def test_nested_report_identity_never_uses_another_same_basename(self):
        steps = {'effects': SimpleNamespace(reports=('effects/export.json', 'shadows/export.json'))}
        self.write(self.evidence / 'effects/export.json', {'value': 'effects'})
        self.write(self.evidence / 'shadows/export.json', {'value': 'shadows'})
        self.ledger('20260101', 'effects', 'unrelated-flat-report', report='export.json')
        self.assertEqual(verify.current_export('effects/export.json', steps=steps)['value'], 'effects')
        self.assertEqual(verify.current_export('shadows/export.json', steps=steps)['value'], 'shadows')
        with self.assertRaisesRegex(ValueError, 'not registered'):
            verify.current_export('export.json', steps=steps)
        with self.assertRaisesRegex(ValueError, 'not registered'):
            verify.current_export('effects/export.json', 'party', steps=steps)

    def test_real_preservation_layout_resolves_nested_reports_only_inside_their_owner(self):
        steps = {'effects': SimpleNamespace(reports=('effects/export_20261011.json',)),
                 'party': SimpleNamespace(reports=('party/export_20261011.json',))}
        report = self.evidence / 'effects/export_20261011.json'
        self.write(report, {'value': 'milestone'})
        original = report.read_bytes()
        self.write(report, {'value': 'current'})
        directory = self.evidence / 'builds/20260101'
        # Use the actual builder's preservation routine, which flattens the
        # destination filename and restores the original report bytes.
        build.preserve_evidence({report: original}, directory / 'effects/generated-evidence')
        self.write(directory / 'run.json', {'passed': True, 'steps': [{'name': 'effects', 'status': 'exported'}]})
        self.assertTrue((directory / 'effects/generated-evidence/export_20261011.json').is_file())
        self.assertEqual(report.read_bytes(), original)
        self.ledger('20260102', 'party', 'wrong-owner', report='export_20261011.json')
        before = self.snapshot()
        self.assertEqual(verify.current_export('effects/export_20261011.json', steps=steps), {'value': 'current'})
        self.assertEqual(self.snapshot(), before)

    def test_relative_layout_is_exact_and_takes_precedence_over_legacy_flat_copy(self):
        steps = {'effects': SimpleNamespace(reports=('effects/export.json',))}
        self.write(self.evidence / 'effects/export.json', {'value': 'live'})
        self.ledger('20260101', 'effects', 'relative', report='effects/export.json')
        self.write(self.evidence / 'builds/20260101/effects/generated-evidence/export.json', {'value': 'flat'})
        self.assertEqual(verify.current_export('effects/export.json', steps=steps), {'value': 'relative'})

    def test_every_live_report_has_one_exact_registered_step(self):
        owners = verify.registered_report_steps()
        for report, step in {'party_skills_export.json': 'party-skills', 'party_combat_export.json': 'party-combat',
                             'audio_export.json': 'audio', 'menu_technique_export_20261013.json': 'menu-techniques',
                             'battle_lifecycle_20261015/export.json': 'battle-lifecycle',
                             'movement_optimization_20261023/shadow_export.json': 'map-effects'}.items():
            self.assertEqual(owners[report], step)
        with self.assertRaisesRegex(ValueError, 'multiple registered owners'):
            verify.registered_report_steps({'a': SimpleNamespace(reports=('same.json',)), 'b': SimpleNamespace(reports=('same.json',))})

    def test_retained_asset_requires_the_exact_declared_before_and_after_hashes(self):
        name = 'remake/runtime/web/data/layers.json'
        path = self.evidence / name
        path.parent.mkdir(parents=True)
        path.write_bytes(b'new source references')
        old = hashlib.sha256(b'old source references').hexdigest()
        row = {'path': name, 'previous_sha256': old, 'sha256': verify.sha(path)}
        migration = {'schema': 'seventh-seal-layout-migration', 'version': 1, 'runtime_manifests': [row]}
        before = self.snapshot()
        self.assertEqual(verify.verify_retained_asset(name, old, root=self.evidence, migration=migration), row)
        self.assertIsNone(verify.verify_retained_asset(name, row['sha256'], root=self.evidence, migration=migration))
        self.assertEqual(self.snapshot(), before)
        with self.assertRaisesRegex(AssertionError, 'without matching migration'):
            verify.verify_retained_asset(name, 'f' * 64, root=self.evidence, migration=migration)
        missing = {**migration, 'runtime_manifests': [{**row, 'path': 'other.json'}]}
        with self.assertRaisesRegex(AssertionError, 'without matching migration'):
            verify.verify_retained_asset(name, old, root=self.evidence, migration=missing)
        with self.assertRaisesRegex(AssertionError, 'without matching migration'):
            verify.verify_retained_asset(name, old, root=self.evidence, migration={**migration, 'runtime_manifests': [row, row]})
        path.write_bytes(b'unrecorded edit')
        with self.assertRaisesRegex(AssertionError, 'migrated asset changed'):
            verify.verify_retained_asset(name, old, root=self.evidence, migration=migration)


if __name__ == '__main__':
    unittest.main()
