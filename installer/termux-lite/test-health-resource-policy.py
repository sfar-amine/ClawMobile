"""Real S24 metric decoding and synthetic pure-policy guards; no runtime recipe."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location("health_resource_policy", Path(__file__).with_name("health-resource-policy.py"))
policy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = policy
spec.loader.exec_module(policy)


class ResourcePolicyTests(unittest.TestCase):
    def setUp(self):
        self.metrics = policy.Metrics(2100, 600, 900, 8)
        self.limits = policy.Thresholds(2000, 500, 1200, 7, 180)
        self.args = dict(now=30000, sustained_since=29000, last_attempt_at=0,
                         idle=policy.IdleProof(29999, True, False, False, False), qualified=True)

    def decision(self, **changes):
        return policy.restart_decision(self.metrics, self.limits, **(self.args | changes))

    def test_real_s24_probes_decode_uptime_without_selinux_denied_sources(self):
        fixture = json.loads((Path(__file__).parents[2] / 'openclaw-plugin-mobile-ui' /
            'fixtures/s24-2026-10-10/p0-4-5/resources-inventory.json').read_text())
        values = policy.metrics_from_owner_observation(fixture['gateway']['procStatus'],
            fixture['meminfo'], fixture['uptime'])
        self.assertEqual(values, policy.Metrics(1286788, 624940, 2816996, 3.57))
        self.assertFalse(fixture['thresholdOwner']['found'])
        # Zero cron runs is not exhaustive idle: Gateway, Bridge and payment
        # remain unknown. Even synthetic qualified pressure cannot authorize it.
        observed = policy.IdleProof(29999, False, None, None, None)
        self.assertEqual(self.decision(idle=observed)['reason'], 'idle_unproven')

    def test_probe_failures_do_not_become_zero_or_healthy(self):
        for value in (None, {}, {'VmRSS': 'PermissionError'}, {'VmRSS': '-1 kB'},
                      {'VmRSS': '128 kB injected'}, {'VmRSS': '128 MB'}):
            self.assertIsNone(policy.metrics_from_owner_observation(value, {}, None).rss_kib)
        valid = {'VmRSS': '128 kB', 'VmSwap': '0 kB'}
        for uptime in (None, '', 'PermissionError', 'load average: 3,57, 4,14, 4,27',
                       'load average: 3.57, 4.14, 4.27 extra', 'x'*4097):
            values = policy.metrics_from_owner_observation(valid, {'MemAvailable': '9 kB'}, uptime)
            self.assertIsNone(values.load_one)
            self.assertEqual(policy.pressure(values, self.limits)['state'], 'unknown')

    def test_unknown_metrics_and_boundaries(self):
        self.assertEqual(policy.pressure(self.metrics, self.limits)["reasons"],
                         ["gateway_rss", "gateway_swap", "memory_available", "load"])
        self.assertEqual(policy.pressure(policy.Metrics(2000, 500, 1200, 7), self.limits)["state"], "healthy")
        for field in ("rss_kib", "swap_kib", "available_kib", "load_one"):
            for invalid in (None, float("nan"), float("inf"), -1, True):
                values = dict(rss_kib=2100, swap_kib=600, available_kib=900, load_one=8)
                values[field] = invalid
                self.assertEqual(policy.pressure(policy.Metrics(**values), self.limits)["state"], "unknown")

    def test_qualified_sustained_idle_only(self):
        self.assertTrue(self.decision()["allowed"])
        self.assertEqual(self.decision(qualified=False)["reason"], "qualification_required")
        self.assertEqual(self.decision(sustained_since=29900)["reason"], "pressure_not_sustained")
        self.assertFalse(self.decision(sustained_since=None)["allowed"])
        self.assertFalse(self.decision(sustained_since=30001)["allowed"])

    def test_all_idle_guards_unknown_and_stale(self):
        for active in (True, None, 0, "false"):
            for index in range(3):
                states = [False, False, False]
                states[index] = active
                self.assertFalse(self.decision(idle=policy.IdleProof(29999, True, *states))["allowed"])
        for proof in (None, policy.IdleProof(29990, True, False, False, False),
                      policy.IdleProof(30001, True, False, False, False),
                      policy.IdleProof(29999, False, False, False, False)):
            self.assertFalse(self.decision(idle=proof)["allowed"])

    def test_six_hours_failed_or_uncertain_attempt_still_counts(self):
        self.assertEqual(self.decision(last_attempt_at=30000-21599)["reason"], "restart_cooldown")
        self.assertTrue(self.decision(last_attempt_at=30000-21600)["allowed"])
        for prior in (None, -1, 30001, float("nan")):
            self.assertEqual(self.decision(last_attempt_at=prior)["reason"], "restart_history_unknown")


if __name__ == "__main__":
    unittest.main()
