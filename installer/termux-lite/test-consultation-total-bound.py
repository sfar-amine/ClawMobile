#!/usr/bin/env python3
"""O6 decision (11/10): a guarded Orange consultation is bounded at 60 s in total, inside the 900 s lease.

Real measurements: openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/o6-network-guard-timing.json
(8 guarded Maxit runs, total p50 5.6 s / p95 6.2 s / max 6.3 s; code bounds DNS 8 s, set_wifi 8 s, adb 6 s)."""
import contextlib, importlib.util, io, json, sys, tempfile, time, unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("guard", HERE / "android-network-mutation-guard.py")
guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
TIMING = json.loads((HERE.parents[1] / "openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/o6-network-guard-timing.json").read_text(encoding="utf-8"))
COMMAND = [guard.sys.executable, "-m", "telecom.maxit_guarded_service", "balance", "--mode", "auto"]


class TotalBound(unittest.TestCase):
    def test_bound_matches_decision_and_lease(self):
        self.assertEqual(guard.CONSULTATION_TOTAL_S, TIMING["proposed_total_bound"]["value_s"])
        self.assertLess(guard.CONSULTATION_TOTAL_S, guard.MAX_LEASE_AGE)
        self.assertEqual(TIMING["code_bounds"]["MAX_LEASE_AGE_s"], 900)
        # Reserve covers group stop (0.5 + 1 s), set_wifi (8 s) and one adb verification (6 s).
        self.assertGreaterEqual(guard.CONSULTATION_RESTORE_RESERVE_S, 0.5 + 1.0 + TIMING["code_bounds"]["set_wifi_timeout_s"] + TIMING["code_bounds"]["adb_call_timeout_s"])

    def test_child_budget_covers_every_observed_run_with_margin(self):
        now = time.monotonic()
        budget = guard.consultation_child_budget(now + guard.CONSULTATION_TOTAL_S, now)
        self.assertEqual(budget, guard.CONSULTATION_TOTAL_S - guard.CONSULTATION_RESTORE_RESERVE_S)
        observed_max_s = TIMING["stats_ms"]["entrypoint_total"]["max"] / 1000
        # The whole observed entry (guard overhead included) fits several times in the child budget alone.
        self.assertGreater(budget, 5 * observed_max_s)
        # DNS (8 s) plus a service ceiling of 30 s (27x the observed service max) still fits.
        self.assertGreaterEqual(budget, TIMING["code_bounds"]["MOBILE_READY_TIMEOUT_S"] + 30)

    def test_child_budget_shrinks_with_lock_and_preparation_time(self):
        now = 1000.0
        deadline = now + guard.CONSULTATION_TOTAL_S
        self.assertEqual(guard.consultation_child_budget(deadline, now + 13.0), guard.CONSULTATION_TOTAL_S - 13.0 - guard.CONSULTATION_RESTORE_RESERVE_S)
        self.assertEqual(guard.consultation_child_budget(deadline, deadline), 1.0)

    def test_receipt_passes_remaining_budget_and_names_the_bound_on_timeout(self):
        with tempfile.TemporaryDirectory() as tmp:
            lease = Path(tmp) / ("b" * 32 + ".json"); lease.write_text(json.dumps({"wifi_enabled": True}))
            output = io.StringIO(); seen = {}
            def child(command, env, timeout_s):
                seen["timeout_s"] = timeout_s
                raise guard.ConsultationChildFailure("consultation_total_bound_exceeded", True)
            with patch.object(guard, "mutation_lock", return_value=contextlib.nullcontext()), \
                    patch.object(guard, "canonical_consultation_owner", return_value=True), \
                    patch.object(guard, "create_lease", return_value=lease), patch.object(guard, "write_json"), \
                    patch.object(guard, "process_identity", return_value={"start_ticks": "1", "boot_id": "TEST"}), \
                    patch.object(guard, "set_wifi"), patch.object(guard, "restore_lease") as restore, \
                    patch.object(guard, "write_receipt") as receipt, \
                    patch.object(guard, "collect_consultation_child", side_effect=child), contextlib.redirect_stdout(output):
                self.assertEqual(guard.with_consultation_receipt(COMMAND), 4)
            value = json.loads(output.getvalue())
            self.assertLessEqual(seen["timeout_s"], guard.CONSULTATION_TOTAL_S - guard.CONSULTATION_RESTORE_RESERVE_S)
            self.assertGreater(seen["timeout_s"], 40)
            self.assertEqual(value["state"], "consultation_total_bound_exceeded")
            # The child was stopped, so the exact restoration is still performed and certified.
            restore.assert_called_once(); self.assertTrue(value["network_guard"]["restored"])
            self.assertEqual(receipt.call_args.args[0], "healthy")

    def test_real_child_timeout_is_reported_as_total_bound(self):
        with self.assertRaises(guard.ConsultationChildFailure) as caught:
            guard.collect_consultation_child([sys.executable, "-c", "import time; time.sleep(5)"], {}, timeout_s=0.2)
        self.assertEqual(str(caught.exception), "consultation_total_bound_exceeded")
        self.assertTrue(caught.exception.cleanup_verified)

    def test_payment_guard_keeps_its_own_unbounded_contract(self):
        import ast
        code = (HERE / "android-network-mutation-guard.py").read_text()
        tree = ast.parse(code)
        source = ast.get_source_segment(code, next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "with_wifi_off"))
        self.assertNotIn("CONSULTATION_TOTAL_S", source)


if __name__ == "__main__":
    unittest.main()
