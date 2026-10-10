"""Synthetic pure-policy checks, not a S24 fixture or runtime recipe."""
import importlib.util
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
