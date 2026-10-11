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
# Real post-deploy recipe output on the S24 (companion-deploy.sh receipts, 10 deploys c1ff5e7 -> fe5e5b1).
RECEIPTS = ROOT / 'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/h5-deploy-receipts-acceptance.json'
R6_OWNER_PROBE = 'POST /agent/config (no owner header)'
OPTIMIZATION_RATIO = 0.8  # AGENTS.md: a route above 80 % of its budget in a receipt becomes an optimization task.

def receipt_evidence(receipt, reads, owner_guards):
    """Check one deployment receipt against the canonical recipe; return the per-route budget ratios."""
    if receipt.get('state') != 'deployed' or receipt.get('accepted') is not True:
        raise ValueError('receipt_not_accepted')
    rows = {row['route']: row for row in receipt['checks']}
    ratios = {}
    for route in TARGETS:
        row = rows.get(route)
        if row is None:
            raise ValueError('receipt_missing_read')
        budgets = [budget for path, budget in reads if path == route]
        if not budgets:
            raise ValueError('missing_or_invalid_canonical_budget')
        seconds = row['seconds']
        if row['code'] != 200 or row.get('status') != 'ok':
            raise ValueError('receipt_read_failed')
        if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or seconds < 0:
            raise ValueError('invalid_captured_duration')
        if seconds > min(budgets):
            raise ValueError('receipt_exceeds_canonical_budget')
        ratios[route] = seconds / min(budgets)
    probe = rows.get(R6_OWNER_PROBE)
    if ('POST', '/agent/config') not in owner_guards or probe is None:
        raise ValueError('r6_owner_guard_missing')
    if probe['code'] not in (401, 403) or probe.get('status') != 'ok':
        raise ValueError('r6_owner_guard_not_refused')
    return ratios

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

class DeploymentReceiptTests(unittest.TestCase):
    def setUp(self):
        self.capture = json.loads(RECEIPTS.read_text())
        self.receipts = self.capture['receipts']

    def test_recent_s24_receipts_cover_reads_within_canonical_budgets_and_r6_guard(self):
        self.assertGreaterEqual(len(self.receipts), 10)
        self.assertTrue(self.capture['_capture']['capturedAt'])
        for receipt in self.receipts:
            with self.subTest(receipt=receipt['receipt']):
                ratios = receipt_evidence(receipt, recipe.READS, recipe.OWNER_GUARDS)
                self.assertEqual(set(ratios), TARGETS)

    def test_routes_above_eighty_percent_are_reported_not_hidden(self):
        hot = sorted((receipt['target'][:7], route, round(ratio, 2))
                     for receipt in self.receipts
                     for route, ratio in receipt_evidence(receipt, recipe.READS, recipe.OWNER_GUARDS).items()
                     if ratio > OPTIMIZATION_RATIO)
        # Known optimization task (core #103): /agent/config on the 10/10 deploys only. A new hot route must be added here
        # explicitly (and to the PR as an optimization task), never by raising the budget.
        self.assertEqual(hot, [('f95be8d', '/agent/config', 0.85)])

    def test_regressions_fail(self):
        receipt = json.loads(json.dumps(self.receipts[-1]))
        lowered = [(path, 1.0 if path == '/agent/config' else budget) for path, budget in recipe.READS]
        with self.assertRaisesRegex(ValueError, 'receipt_exceeds_canonical_budget'):
            receipt_evidence(receipt, lowered, recipe.OWNER_GUARDS)
        with self.assertRaisesRegex(ValueError, 'r6_owner_guard_missing'):
            receipt_evidence(receipt, recipe.READS, [g for g in recipe.OWNER_GUARDS if g != ('POST', '/agent/config')])
        missing = dict(receipt, checks=[row for row in receipt['checks'] if row['route'] != '/updates'])
        with self.assertRaisesRegex(ValueError, 'receipt_missing_read'):
            receipt_evidence(missing, recipe.READS, recipe.OWNER_GUARDS)
        opened = json.loads(json.dumps(receipt))
        next(row for row in opened['checks'] if row['route'] == R6_OWNER_PROBE)['code'] = 200
        with self.assertRaisesRegex(ValueError, 'r6_owner_guard_not_refused'):
            receipt_evidence(opened, recipe.READS, recipe.OWNER_GUARDS)
        with self.assertRaisesRegex(ValueError, 'receipt_not_accepted'):
            receipt_evidence(dict(receipt, accepted=False), recipe.READS, recipe.OWNER_GUARDS)

if __name__ == '__main__':
    unittest.main()
