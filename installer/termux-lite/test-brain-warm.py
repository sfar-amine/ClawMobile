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
        self.turns = []

    def run_warm(self, pid=25143, open_=True, result=(14.2, None)):
        def turn():
            self.turns.append(1); return result
        return w.warm(pid_of=lambda: pid, is_open=lambda: open_, turn=turn, clock=lambda: 1793349560.0,
                      receipt=self.receipt, lock=self.lock)

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

    def test_never_launched_at_gateway_start(self):
        # 30/10: the start-time warm turn blocked the Gateway 61 s inside Tier0's 120 s activation readiness
        # window and the promotion failed. Only companion-deploy.sh runs it, after the promotion.
        here = Path(__file__).parent
        self.assertNotIn("brain-warm", (here / "gateway-start.sh").read_text())
        deploy = (here / "companion-deploy.sh").read_text()
        self.assertLess(deploy.index("sync_runtime \"$full\""), deploy.index("brain-warm.py"))

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
        self.assertEqual(w.main(["brain-warm.py", "--after-start"]), 2)


if __name__ == "__main__":
    unittest.main()
