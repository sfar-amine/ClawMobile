#!/usr/bin/env python3
"""Retro 12/10: a load spike or the Gateway warming up after a restart is not a regression.
Real S24 receipts: companion-20261011T224926 (/agent/config 9.44 s > 9 s), companion-20261011T234147
(metadata 503 cold and warm right after restart), companion-20261011T234815 (/notifications/sources 6.51 s, 503)."""
import importlib.util, json, pathlib, tempfile, unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("companion_acceptance", HERE / "companion-acceptance.py")
acceptance = importlib.util.module_from_spec(spec); spec.loader.exec_module(acceptance)
CONV = json.dumps({"items": [{"sessionId": "samantha-743dbdff-db5b"}]}).encode()


def server(first_slow=(), first_503=(), always_slow=()):
    seen = {}
    def call(method, path, timeout, headers=None):
        if method != "GET":
            return (403, b"{}", 0.01)
        n = seen[path] = seen.get(path, 0) + 1
        budget = dict(acceptance.READS).get(path, 6.0)
        if path in always_slow:
            return (200, b"{}", budget + 0.5)
        if n == 1 and path in first_slow:
            return (200, b"{}", budget + 0.44)
        if n == 1 and any(path.startswith(p) for p in first_503):
            return (503, b"{}", 0.01)
        if path == "/runs?contract=2&view=conversations&limit=20":
            return (200, CONV, 0.02)
        return (200, b'{"items": []}', 0.02)
    return call, seen


class AcceptanceSettle(unittest.TestCase):
    def run_main(self, call, baseline=None):
        with mock.patch.object(acceptance, "call", side_effect=call), mock.patch.object(acceptance.time, "sleep") as slept, \
             mock.patch("builtins.print") as printed:
            rc = acceptance.main(baseline_path=baseline)
        return rc, json.loads(printed.call_args.args[0]), slept

    def baseline(self, seconds):
        handle = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        json.dump({"state": "deployed", "acceptance": {"checks": [
            {"route": path, "seconds": value, "status": "ok"} for path, value in seconds.items()
        ]}}, handle); handle.close(); self.addCleanup(pathlib.Path(handle.name).unlink)
        return handle.name

    def test_one_slow_reading_is_read_again_after_a_pause(self):
        call, seen = server(first_slow=("/agent/config",))
        rc, out, slept = self.run_main(call)
        self.assertEqual(rc, 0, [c for c in out["checks"] if c["status"] == "fail"])
        self.assertEqual(seen["/agent/config"], 2)
        slept.assert_any_call(acceptance.RETRY_PAUSE_S)

    def test_metadata_503_right_after_restart_is_read_again(self):
        call, seen = server(first_503=("/conversations/",))
        rc, out, _ = self.run_main(call)
        self.assertEqual(rc, 0, [c for c in out["checks"] if c["status"] == "fail"])

    def test_a_route_slow_twice_still_fails(self):
        call, _ = server(always_slow=("/agent/config",))
        rc, out, _ = self.run_main(call)
        self.assertEqual(rc, 1)
        self.assertTrue(any(c["route"] == "/agent/config" and c["status"] == "fail" for c in out["checks"]))

    def test_previous_release_separates_variance_from_a_gateway_regression(self):
        jitter, _ = server(always_slow=("/agent/config",))
        rc, out, _ = self.run_main(jitter, self.baseline({"/agent/config": 9.0}))
        row = next(c for c in out["checks"] if c["route"] == "/agent/config" and not c.get("check"))
        self.assertEqual((rc, row["previousSeconds"], row["regression"], row["status"]), (0, 9.0, False, "ok"))

        slow, _ = server()
        def two_to_ten(method, path, timeout, headers=None):
            code, body, took = slow(method, path, timeout, headers)
            return (code, body, 10.0) if path == "/agent/config" else (code, body, took)
        rc, out, _ = self.run_main(two_to_ten, self.baseline({"/agent/config": 2.0}))
        row = next(c for c in out["checks"] if c["route"] == "/agent/config" and not c.get("check"))
        self.assertEqual((rc, row["regression"], row["status"]), (1, True, "fail"))

    def test_catalog_is_prewarmed_before_its_timed_read(self):
        call, seen = server()
        rc, out, _ = self.run_main(call)
        self.assertEqual(rc, 0)
        self.assertGreaterEqual(seen["/catalog"], 2)
        self.assertEqual(out["checks"][0]["check"], "prewarm")

    def test_deploy_waits_for_calm_and_gateway_before_judging(self):
        text = (HERE / "companion-deploy.sh").read_text()
        self.assertIn("gateway_ready ||", text)
        self.assertIn('wait_calm 180 "$MAX_LOAD"', text)
        self.assertIn("COMPANION_DEPLOY_WAIT_CALM_S", text)


if __name__ == "__main__":
    unittest.main()
