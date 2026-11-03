#!/data/data/com.termux/files/usr/bin/python3
"""The root guardian is not stuck behind an AI gate that cannot answer (S24 27/10 reboot)."""
import os
import subprocess
import tempfile
import time
import unittest
import json
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GUARDIAN = ROOT / "samantha-root-guardian.sh"
CAPTURE = ROOT.parent.parent / "openclaw-plugin-mobile-ui/fixtures/s24-2026-11-01-tier0-activation-1009/capture.json"


class RootGuardianGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.name = "fixture-supervisor-" + uuid.uuid4().hex[:8] + ".sh"
        self.script = self.home / self.name
        self.script.write_text("#!/usr/bin/env bash\nwhile :; do sleep 1; done\n")
        self.script.chmod(0o755)
        self.other = self.home / ("old-" + self.name)
        self.other.write_text(self.script.read_text())
        self.other.chmod(0o755)

    def tearDown(self):
        subprocess.run(["pkill", "-f", self.name], check=False)
        self.tmp.cleanup()

    def guardian(self, *, gate_rc, companion_up, rounds=1, root=None):
        # Functions of the real guardian; only the AI gate and the Companion probe are synthetic.
        functions = GUARDIAN.read_text().split("\nrefresh_root\n", 1)[0]
        probe = self.home / "probe.sh"
        probe.write_text(functions + "\n"
            "immune_observe(){ :; }\n"
            f"immune_action(){{ echo gate >>\"$HOME/gate.calls\"; return {gate_rc}; }}\n"
            f"gate_reachable(){{ return {0 if companion_up else 1}; }}\n"
            + (f"ROOT='{root}'\n" if root else "ROOT=$HOME\n")
            + f"ensure_supervisor fixture '[{self.name[0]}]{self.name[1:]}' '{self.script}' \"$D/fixture.stderr.log\"\n" * rounds)
        subprocess.run(["bash", str(probe)], env=dict(os.environ, HOME=str(self.home)),
                       check=True, capture_output=True, text=True, timeout=60)

    def log(self):
        path = self.home / ".openclaw/guardian/guardian.log"
        return path.read_text() if path.exists() else ""

    def running(self, script):
        return subprocess.run(["pgrep", "-f", str(script)], capture_output=True).returncode == 0

    def test_missing_supervisor_starts_when_gate_is_unreachable(self):
        self.guardian(gate_rc=75, companion_up=False)
        self.assertTrue(self.running(self.script))
        self.assertIn("event=fixture-missing action=direct_start reason=ai_gate_unreachable", self.log())
        self.assertIn("event=fixture-start result=ok", self.log())

    def test_reachable_gate_keeps_the_decision_and_refusal_is_logged_once(self):
        self.guardian(gate_rc=75, companion_up=True, rounds=3)
        self.assertFalse(self.running(self.script))
        self.assertEqual(self.log().count("event=fixture-restore action=wait reason=ai_gate_refused"), 1)
        self.assertEqual((self.home / "gate.calls").read_text().count("gate"), 3)

    def test_direct_start_is_bounded_when_the_supervisor_keeps_dying(self):
        self.guardian(gate_rc=75, companion_up=False)
        subprocess.run(["pkill", "-f", self.name], check=False)
        time.sleep(0.5)
        self.guardian(gate_rc=75, companion_up=False)
        self.assertFalse(self.running(self.script))
        self.assertEqual(self.log().count("action=direct_start"), 1)

    def test_gate_probe_targets_the_companion_not_the_gateway(self):
        # S24 27/10 22:27: the Gateway answered while the Companion, the gate's only route to
        # its models, was gone. Reachability must follow the Companion.
        functions = GUARDIAN.read_text().split("\nrefresh_root\n", 1)[0]
        probe = self.home / "reach.sh"
        probe.write_text(functions + "\ntimeout(){ shift; \"$@\"; }\ncurl(){ echo \"$@\" >>\"$HOME/curl.args\"; return 7; }\n"
                         "gate_reachable && echo REACHABLE || echo UNREACHABLE\n")
        out = subprocess.run(["bash", str(probe)], env=dict(os.environ, HOME=str(self.home)),
                             capture_output=True, text=True, timeout=30).stdout
        self.assertIn("UNREACHABLE", out)
        args = (self.home / "curl.args").read_text()
        self.assertIn("127.0.0.1:8765/", args)
        self.assertNotIn("18789", args)

    def test_drifting_supervisor_still_waits_for_the_ai(self):
        drift = subprocess.Popen([str(self.other)], start_new_session=True)
        try:
            # The pattern matches the old release's process too, as on a real release switch.
            self.guardian(gate_rc=75, companion_up=False)
            self.assertIsNone(drift.poll())
            self.assertNotIn("direct_start", self.log())
            self.assertIn("reason=ai_gate_refused", self.log())
        finally:
            drift.kill(); drift.wait()


    # S24 01/11 22:29/22:36: during the tier0 activation the gate refused (its model answers
    # through the Gateway the deploy restarts) and the orchestrator missed the 120 s window.
    def activation(self, *, current="20261101T222851-d3beb769", state="activating", deadline_in=100):
        release = self.home / ".openclaw/releases/20261101T222851-d3beb769/termux-lite"
        release.mkdir(parents=True, exist_ok=True)
        tier0 = self.home / ".openclaw/tier0"
        tier0.mkdir(parents=True, exist_ok=True)
        (tier0 / "state.json").write_text(
            '{"current": "%s", "soak_state": "%s", "activation_deadline_epoch": %d}'
            % (current, state, int(time.time()) + deadline_in))
        return release

    def gate_calls(self):
        path = self.home / "gate.calls"
        return path.read_text().count("gate") if path.exists() else 0

    def test_activation_of_this_release_starts_a_missing_supervisor_without_the_gate(self):
        root = self.activation()
        self.guardian(gate_rc=75, companion_up=True, root=root)
        self.assertTrue(self.running(self.script))
        self.assertEqual(self.gate_calls(), 0)
        self.assertIn("event=fixture-restore action=activation_start reason=tier0_activation", self.log())
        self.assertIn("event=fixture-start result=ok", self.log())

    def test_activation_replaces_the_previous_release_supervisor(self):
        root = self.activation()
        drift = subprocess.Popen([str(self.other)], start_new_session=True)
        try:
            self.guardian(gate_rc=75, companion_up=True, root=root)
            drift.wait(timeout=15)
            self.assertTrue(self.running(self.script))
            self.assertIn("event=fixture-runtime_drift action=replace", self.log())
            self.assertEqual(self.gate_calls(), 0)
        finally:
            if drift.poll() is None:
                drift.kill(); drift.wait()

    def test_activation_bypass_is_bounded_to_this_release_and_its_window(self):
        for kwargs in ({"deadline_in": -1}, {"state": "running"}, {"state": "activation_failed"},
                       {"current": "20261101T223552-d3beb769"}):
            with self.subTest(**kwargs):
                (self.home / ".openclaw/guardian/guardian.log").unlink(missing_ok=True)
                (self.home / "gate.calls").unlink(missing_ok=True)
                root = self.activation(**kwargs)
                self.guardian(gate_rc=75, companion_up=True, root=root)
                self.assertFalse(self.running(self.script))
                self.assertEqual(self.gate_calls(), 1)
                self.assertNotIn("tier0_activation", self.log())

    def test_s24_capture_orchestrator_missed_the_window_behind_a_refusing_gate(self):
        capture = json.loads(CAPTURE.read_text())
        deploy, rollback = capture["promotions"]
        self.assertEqual(rollback["activation_deadline_epoch"] - rollback["activation_started_epoch"],
                         capture["activation_readiness_s"])
        self.assertGreater(rollback["orchestrator_start_ok_epoch"], rollback["activation_deadline_epoch"])
        self.assertGreater(deploy["orchestrator_start_ok_epoch"], deploy["activation_deadline_epoch_lower_bound"])
        for promotion in (deploy, rollback):
            self.assertTrue(any("incident_orchestrator-restore action=wait reason=ai_gate_refused" in row
                                for row in promotion["guardian_rows"]))
        self.assertEqual(rollback["health_at_failure"]["immune.incident_orchestrator"], "down (process missing)")
        # Replayed with the fix: the same refusing gate no longer holds the orchestrator back.
        root = self.activation(current=rollback["release"])
        root = root.parent.parent / rollback["release"] / "termux-lite"
        root.mkdir(parents=True, exist_ok=True)
        self.guardian(gate_rc=75, companion_up=True, root=root)
        self.assertTrue(self.running(self.script))
        self.assertEqual(self.gate_calls(), 0)

    def test_unreadable_tier0_state_keeps_the_gate(self):
        root = self.activation()
        (self.home / ".openclaw/tier0/state.json").write_text("{not json")
        self.guardian(gate_rc=75, companion_up=True, root=root)
        self.assertFalse(self.running(self.script))
        self.assertEqual(self.gate_calls(), 1)


if __name__ == "__main__":
    unittest.main()
