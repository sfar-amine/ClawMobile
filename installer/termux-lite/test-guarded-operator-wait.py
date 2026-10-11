#!/usr/bin/env python3
"""O6 (fichier 37): the fast path never abandons a guarded Orange read while the guard holds Wi-Fi off.

Guard bound 60 s (decision of 11/10 on fixtures/s24-2026-10-11/o6-network-guard-timing.json); the captured
10/10 09:41 resolution (fixtures/s24-2026-10-11/o7-o8-orange-20261010-0941.json) selects the guarded entry."""
import importlib.util, json, unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename); mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod); return mod
fast = load("model_fast_path_o6", "model-fast-path.py")
gemini = load("gemini_request_o6", "gemini-request.py")
FIXTURES = HERE.parents[1] / "openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11"
CAPTURE = json.loads((FIXTURES / "o7-o8-orange-20261010-0941.json").read_text(encoding="utf-8"))
TIMING = json.loads((FIXTURES / "o6-network-guard-timing.json").read_text(encoding="utf-8"))


class GuardedWait(unittest.TestCase):
    def test_constants_follow_the_guard_bound(self):
        self.assertEqual(fast.GUARDED_ENTRY_TOTAL_S, TIMING["proposed_total_bound"]["value_s"])
        self.assertGreaterEqual(fast.GUARDED_ENTRY_WAIT_S, fast.GUARDED_ENTRY_TOTAL_S + 5)
        self.assertLessEqual(fast.GUARDED_ENTRY_WAIT_S, 120)  # CapabilityGraph subprocess ceiling
        # gemini_claw kills the helper only after resolution + the guarded wait + process margin.
        self.assertGreaterEqual(gemini.FAST_PATH_PROCESS_TIMEOUT_S, fast.GUARDED_ENTRY_WAIT_S + 5 + 10)

    def test_captured_guarded_entry_raises_only_the_read_execution_wait(self):
        selected = CAPTURE["resolution_now"]["gemini_claw"]["selected"]
        self.assertEqual(fast.guarded_execution_timeout(30, selected), fast.GUARDED_ENTRY_WAIT_S)
        self.assertEqual(fast.guarded_execution_timeout(75, selected), 75)
        self.assertEqual(fast.guarded_execution_timeout(30, {"entrypoint": "python -m telecom.zain_service balance"}), 30)
        self.assertEqual(fast.guarded_execution_timeout(30, None, CAPTURE["decision_envelope"]["selected"]), fast.GUARDED_ENTRY_WAIT_S)

    def test_captured_fast_path_waits_for_the_guard(self):
        resolved = CAPTURE["resolution_now"]["claw_live"]
        executed = {**resolved, "execution": {"state": "completed", "result": CAPTURE["client_received_result"]}}
        with mock.patch.object(fast, "resolve_capability", return_value=resolved), \
             mock.patch.object(fast, "execute_capability_decision", return_value=executed) as execute:
            out = fast.try_fast_path(CAPTURE["companion_run"]["userText"], timeout=30)
        self.assertEqual(out["status"], "hit")
        self.assertEqual(execute.call_args.kwargs["timeout"], fast.GUARDED_ENTRY_WAIT_S)

    def test_ordinary_route_keeps_its_budget(self):
        resolved = json.loads(json.dumps(CAPTURE["resolution_now"]["claw_live"]))
        for block in (resolved["selected"], resolved["decision"]):
            block.pop("entrypoint", None)
        resolved["selected"]["entrypoint"] = "python -m telecom.zain_service balance"
        executed = {**resolved, "execution": {"state": "completed", "result": {"text": "ok"}}}
        with mock.patch.object(fast, "resolve_capability", return_value=resolved), \
             mock.patch.object(fast, "execute_capability_decision", return_value=executed) as execute:
            fast.try_fast_path("solde zain", timeout=30)
        self.assertEqual(execute.call_args.kwargs["timeout"], 30)

    def test_confirmed_handoff_budget_is_untouched(self):
        resolved = json.loads(json.dumps(CAPTURE["resolution_now"]["claw_live"])); resolved["confirmation_required"] = True
        with mock.patch.object(fast, "resolve_capability", return_value=resolved), \
             mock.patch.object(fast, "_execute_declared_handoff", return_value={"status": "handoff"}) as handoff:
            fast.try_fast_path("recharge", timeout=30)
        self.assertEqual(handoff.call_args.kwargs["timeout"], 30)


if __name__ == "__main__":
    unittest.main()
