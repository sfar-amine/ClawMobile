#!/usr/bin/env python3
"""H5: compare real S24 timings with the canonical recipe, without budget copies.

Capture timings are historical evidence, not a handler replay or deployment
receipt. Budgets from the capture's old budgetS field are deliberately ignored.
"""
import importlib.util
import json
import math
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('h5_production_acceptance', ROOT / 'installer/termux-lite/companion-acceptance.py')
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)
CAPTURE = ROOT / 'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-10/p0-3/reads-latency.json'
TARGETS = {'/agent/config', '/updates', '/control/engineering?limit=20'}

def captured_evidence(row, provenance, reads):
    if not row['route'].startswith('GET /v1/') or not provenance.get('capturedAt'):
        raise ValueError('capture_not_native_read')
    route = row['route'][7:]
    budgets = [budget for path, budget in reads if path == route]
    if not budgets or any(isinstance(budget, bool) or not isinstance(budget, (int, float)) or not math.isfinite(budget) or budget <= 0 for budget in budgets):
        raise ValueError('missing_or_invalid_canonical_budget')
    samples = [row['cold'], row['repeat']]
    timings = [sample['ms'] for sample in samples]
    if any(sample['code'] != 200 for sample in samples):
        raise ValueError('capture_not_successful_read')
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 for value in timings):
        raise ValueError('invalid_captured_duration')
    if max(timings) / 1000 > min(budgets):
        raise ValueError('capture_exceeds_canonical_budget')
    return {'route': route, 'capturedAt': provenance['capturedAt'], 'latencyMs': timings, 'budgetSeconds': min(budgets)}

def selected_rows(capture):
    return [row for row in capture['routes'] if row['route'].startswith('GET /v1/') and row['route'][7:] in TARGETS]

class AcceptanceEvidenceTests(unittest.TestCase):
    def test_three_actual_s24_measurements_fit_existing_recipe(self):
        capture = json.loads(CAPTURE.read_text())
        rows = [captured_evidence(row, capture['_capture'], recipe.READS) for row in selected_rows(capture)]
        self.assertEqual({row['route'] for row in rows}, TARGETS)
        self.assertEqual(len(rows), len(TARGETS))

    def test_r6_owner_probe_already_exists(self):
        self.assertIn(('POST', '/agent/config'), recipe.OWNER_GUARDS)

    def test_missing_recipe_and_reduced_budget_fail(self):
        capture = json.loads(CAPTURE.read_text())
        row = selected_rows(capture)[0]
        route = captured_evidence(row, capture['_capture'], recipe.READS)['route']
        with self.assertRaisesRegex(ValueError, 'missing_or_invalid_canonical_budget'):
            captured_evidence(row, capture['_capture'], [(path, budget) for path, budget in recipe.READS if path != route])
        reduced = [(path, 0.001 if path == route else budget) for path, budget in recipe.READS]
        with self.assertRaisesRegex(ValueError, 'capture_exceeds_canonical_budget'):
            captured_evidence(row, capture['_capture'], reduced)

    def test_capture_budget_copy_is_not_the_policy(self):
        capture = json.loads(CAPTURE.read_text())
        row = selected_rows(capture)[0]
        original = captured_evidence(row, capture['_capture'], recipe.READS)
        row['budgetS'] = 0.000001
        self.assertEqual(captured_evidence(row, capture['_capture'], recipe.READS), original)

if __name__ == '__main__':
    unittest.main()
