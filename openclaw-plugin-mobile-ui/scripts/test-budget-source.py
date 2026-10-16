#!/usr/bin/env python3
"""H3: relocation, explicit missing-source errors and AST-only recipe extraction."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('runtime-contract-report.py')
SPEC = importlib.util.spec_from_file_location('h3_report', SCRIPT)
reporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reporter)

class BudgetSourceTests(unittest.TestCase):
    def test_unreadable_utf8_source_has_fixed_code_without_path(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'unreadable-private-path.py'
            source.write_bytes(b'READS = []\n\xff')
            with self.assertRaisesRegex(reporter.ContractError, '^budget_source_unreadable$'):
                reporter.read_budgets(source)
            output = Path(root) / 'report.json'
            result = subprocess.run([sys.executable, str(SCRIPT), '--acceptance', str(source), '--output', str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stderr, '')
            self.assertEqual(result.stdout.strip(), 'invalid_configuration')
            self.assertEqual(json.loads(output.read_text())['reason'], 'budget_source_unreadable')
            self.assertNotIn(str(source), output.read_text() + result.stdout + result.stderr)

    def test_missing_source_has_fixed_code(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'missing-private-path.py'
            with self.assertRaisesRegex(reporter.ContractError, '^budget_source_missing$'):
                reporter.read_budgets(path)

    def test_import_and_help_work_without_repository_layout(self):
        with tempfile.TemporaryDirectory() as root:
            script = Path(root) / SCRIPT.name
            shutil.copyfile(SCRIPT, script)
            result = subprocess.run([sys.executable, str(script), '--help'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertIn('--acceptance', result.stdout)
            self.assertNotIn('Traceback', result.stderr)

    def test_relocated_cli_missing_source_writes_sanitized_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            script, output = root / SCRIPT.name, root / 'report.json'
            shutil.copyfile(SCRIPT, script)
            result = subprocess.run([sys.executable, str(script), '--output', str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout.strip(), 'invalid_configuration')
            self.assertEqual(result.stderr, '')
            receipt = json.loads(output.read_text())
            self.assertEqual(receipt['reason'], 'budget_source_missing')
            self.assertFalse(receipt['complete'])
            self.assertNotIn(str(root), output.read_text())

    def test_cli_explicit_missing_path_is_not_echoed(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            output = root / 'report.json'
            missing = root / 'sensitive-path.py'
            result = subprocess.run([sys.executable, str(SCRIPT), '--acceptance', str(missing), '--output', str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(output.read_text())['reason'], 'budget_source_missing')
            self.assertNotIn(str(missing), output.read_text() + result.stdout + result.stderr)

    def test_literal_source_never_executes_imports_or_top_level_code(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            marker = root / 'must-not-exist'
            source = root / 'recipe.py'
            source.write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').touch()\nraise RuntimeError("do not execute")\nREADS = [("/updates?x=1", 4), ("/updates", 2)]\n')
            self.assertEqual(reporter.read_budgets(source), {'/v1/updates': 4})
            self.assertFalse(marker.exists())

    def test_invalid_tables_fail_closed_without_traceback_or_evaluation(self):
        values = ['READS = make_table()', 'READS = []', 'READS = [("/x", True)]', 'READS = [("/x", -1)]', 'READS = [("/x", 1e999)]', 'READS = [("x", 1)]', 'READS = [("/x", 1)]\nREADS = [("/x", 2)]', 'broken syntax !!!']
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'recipe.py'
            for value in values:
                source.write_text(value)
                with self.subTest(value=value), self.assertRaisesRegex(reporter.ContractError, '^budget_source_invalid$'):
                    reporter.read_budgets(source)

    def test_report_selects_explicit_recipe_once_before_any_http(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'recipe.py'
            source.write_text('READS = [("/updates", 12)]\n')
            manifest = {'schema': reporter.SCHEMA, 'base': 'a' * 40, 'cases': [{'id': 'update', 'template': '/v1/updates', 'method': 'GET', 'phase': 'active', 'source': 'core@aaaaaaa', 'types': {}}]}
            calls = []
            def fetch(opener, url, timeout):
                calls.append(timeout)
                return ({'endpoints': ['/v1/updates']} if url.endswith('/v1') else {}, 200, None, 0)
            with patch.object(reporter, 'read_budgets', wraps=reporter.read_budgets) as read, patch.object(reporter, 'fetch_json', side_effect=fetch):
                result = reporter.report('http://127.0.0.1:8765', manifest, fixture=True, acceptance=source)
            read.assert_called_once_with(source)
            self.assertEqual(calls, [14, 3])
            self.assertTrue(result['fixtureReadChecksPassed'])
            with patch.object(reporter, 'fetch_json') as fetch:
                with self.assertRaisesRegex(reporter.ContractError, '^budget_source_missing$'):
                    reporter.report('http://127.0.0.1:8765', manifest, fixture=True, acceptance=source.with_name('absent.py'))
                fetch.assert_not_called()

    def test_canonical_captured_route_budgets_are_preserved(self):
        path = SCRIPT.parents[1] / 'fixtures/s24-2026-10-10/p0-3/reads-latency.json'
        captured = json.loads(path.read_text())
        budgets = reporter.read_budgets()
        # Query variants share the largest canonical budget (e.g. runs metadata/list).
        for row in captured['routes']:
            route = row['route'].removeprefix('GET ').split('?')[0]
            self.assertGreaterEqual(budgets[route], row['budgetS'])
        self.assertFalse(reporter.secret_present({'accountEmail': 'owner@example.invalid'}))

if __name__ == '__main__':
    unittest.main()
