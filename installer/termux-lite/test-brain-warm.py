#!/usr/bin/env python3
"""brain-warm.py: one warm turn per Gateway process, no retry, a receipt; nothing runs a model here."""
import importlib.util, json, tempfile, unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("brain_warm", Path(__file__).with_name("brain-warm.py"))
w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)


class Warm(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.receipt = Path(self.tmp.name) / "health/brain-warm.json"
        self.lock = Path(self.tmp.name) / "health/brain-warm.lock"
        self.turns = []; self.slept = []

    def run_warm(self, pid=25143, open_=True, result=(14.2, None), after_start=False, pids=None):
        pids = list(pids) if pids else None
        def pid_of():
            return pids.pop(0) if pids and len(pids) > 1 else (pids[0] if pids else pid)
        def turn():
            self.turns.append(1); return result
        return w.warm(after_start=after_start, pid_of=pid_of, is_open=lambda: open_, turn=turn,
                      sleep=self.slept.append, clock=lambda: 1793349560.0, receipt=self.receipt, lock=self.lock)

    def test_one_turn_per_gateway_process(self):
        doc, code = self.run_warm()
        self.assertEqual((code, doc["state"], doc["gatewayPid"], doc["seconds"]), (0, "warm", 25143, 14.2))
        self.assertEqual(json.loads(self.receipt.read_text())["state"], "warm")
        again, code = self.run_warm()
        self.assertEqual((code, again.get("reused"), len(self.turns)), (0, True, 1))
        # A restarted Gateway is a new process: it is warmed once more.
        _, code = self.run_warm(pid=31337)
        self.assertEqual((code, len(self.turns)), (0, 2))

    def test_failure_is_recorded_never_retried(self):
        doc, code = self.run_warm(result=(200.0, "TimeoutExpired"))
        self.assertEqual((code, doc["state"], doc["error"], len(self.turns)), (1, "failed", "TimeoutExpired", 1))
        # The next caller (deploy) tries once more for this process, since nothing proved it warm.
        _, code = self.run_warm()
        self.assertEqual((code, len(self.turns)), (0, 2))

    def test_no_gateway_runs_nothing(self):
        doc, code = self.run_warm(pid=None)
        self.assertEqual((code, doc["state"], self.turns), (3, "no_gateway", []))
        doc, code = self.run_warm(open_=False)
        self.assertEqual((code, self.turns), (3, []))

    def test_after_start_waits_for_the_gateway_then_settles(self):
        doc, code = self.run_warm(after_start=True, pids=[None, None, 25143])
        self.assertEqual((code, doc["state"]), (0, "warm"))
        self.assertEqual(self.slept[-1], w.SETTLE_S)
        self.assertGreaterEqual(len(self.slept), 3)

    def test_owner_turn_is_the_main_agent_without_delivery(self):
        seen = {}
        class Done:
            stdout = json.dumps({"status": "ok", "result": {"payloads": [{"text": "OK"}]}}); returncode = 0
        def run(argv, **kwargs):
            seen.update(argv=argv, timeout=kwargs["timeout"]); return Done()
        seconds, error = w.owner_turn(run=run)
        self.assertIsNone(error)
        self.assertEqual(seen["argv"][:6], ["openclaw", "agent", "--agent", "main", "--session-key", w.SESSION])
        self.assertNotIn("--deliver", seen["argv"])
        self.assertEqual(seen["timeout"], w.TURN_TIMEOUT_S)

    def test_usage(self):
        self.assertEqual(w.main(["brain-warm.py", "--now"]), 2)


if __name__ == "__main__":
    unittest.main()
